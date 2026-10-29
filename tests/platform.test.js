const { DesktopTranscriber, getPlatformInfo, parseBackends } = require('../src/desktop-transcriber.js');

globalThis.require = require;

describe('getPlatformInfo', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  test('uses the BLAS build for CPU on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const info = getPlatformInfo(false);
    expect(info.archivePattern).toBe('whisper-blas-bin-x64.zip');
    expect(info.execNames).toContain('whisper-cli.exe');
    expect(info.repo).toContain('ggml-org/whisper.cpp');
  });

  test('uses the CUDA build for GPU on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const info = getPlatformInfo(true);
    expect(info.archivePattern).toBe('whisper-bin-win-cuda-12.4.0-x64.zip');
    expect(info.repo).toBe(getPlatformInfo(false).repo);
  });

  test('ignores the GPU option on Linux and macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(getPlatformInfo(true).archivePattern).toBe(getPlatformInfo(false).archivePattern);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(getPlatformInfo(true).archivePattern).toBe(getPlatformInfo(false).archivePattern);
  });
});

describe('parseBackends', () => {
  test('extracts unique backend names from ggml init output', () => {
    const stderr = [
      'load_backend: loaded CPU backend from C:\\bin\\libggml-cpu.dll',
      'load_backend: loaded CUDA backend from C:\\bin\\ggml-cuda.dll',
      'load_backend: loaded CUDA backend from C:\\bin\\ggml-cuda.dll',
    ].join('\n');
    expect(parseBackends(stderr)).toEqual(['CPU', 'CUDA']);
  });

  test('returns an empty list when no backend lines are present', () => {
    expect(parseBackends('')).toEqual([]);
    expect(parseBackends('some unrelated output')).toEqual([]);
  });
});

describe('DesktopTranscriber GPU option', () => {
  const originalPlatform = process.platform;
  const fs = require('fs');
  const os = require('os');
  const tempDir = fs.mkdtempSync(os.tmpdir() + require('path').sep + 'whisper-gpu-test-');
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  test('enables the GPU option only on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(new DesktopTranscriber({}, { useGpu: true }).useGpu).toBe(true);
    expect(new DesktopTranscriber({}, {}).useGpu).toBe(false);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(new DesktopTranscriber({}, { useGpu: true }).useGpu).toBe(false);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(new DesktopTranscriber({}, { useGpu: true }).useGpu).toBe(false);
  });

  function createGpuTranscriber() {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      { useGpu: true },
    );
    transcriber.initialized = true;
    transcriber.modelPath = 'model.bin';
    transcriber.whisperPath = 'gpu.exe';
    transcriber.runWhisper = jest.fn();
    transcriber.ensureExecutable = jest.fn().mockResolvedValue('cpu.exe');
    transcriber.ensureDir = jest.fn().mockResolvedValue();
    transcriber.getNodeModules = () => ({
      path: require('path'),
      os: { tmpdir: () => tempDir },
      fs: {
        writeFileSync: () => {},
        unlinkSync: () => {},
        chmodSync: () => {},
        existsSync: () => true,
        mkdirSync: () => {},
      },
    });
    return transcriber;
  }

  test('transcribe falls back to the CPU binary when the GPU run fails', async () => {
    const transcriber = createGpuTranscriber();
    transcriber.runWhisper.mockRejectedValueOnce(new Error('gpu failed')).mockResolvedValueOnce({ text: 'cpu result' });
    const result = await transcriber.transcribe(new Float32Array(16000));
    expect(result.text).toBe('cpu result');
    expect(transcriber.runWhisper).toHaveBeenCalledTimes(2);
    expect(transcriber.runWhisper.mock.calls[0][0]).toBe('gpu.exe');
    expect(transcriber.runWhisper.mock.calls[1][0]).toBe('cpu.exe');
  });

  test('transcribe does not retry on the CPU binary when GPU is not requested', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      {},
    );
    transcriber.initialized = true;
    transcriber.modelPath = 'model.bin';
    transcriber.whisperPath = 'cpu.exe';
    transcriber.runWhisper = jest.fn().mockRejectedValue(new Error('failed'));
    transcriber.ensureExecutable = jest.fn();
    transcriber.ensureDir = jest.fn().mockResolvedValue();
    transcriber.getNodeModules = () => ({
      path: require('path'),
      os: { tmpdir: () => tempDir },
      fs: { writeFileSync: () => {}, unlinkSync: () => {}, chmodSync: () => {} },
    });
    await expect(transcriber.transcribe(new Float32Array(16000))).rejects.toThrow('failed');
    expect(transcriber.runWhisper).toHaveBeenCalledTimes(1);
  });

  test('transcribe does not retry again after a GPU failure was already recorded', async () => {
    const transcriber = createGpuTranscriber();
    transcriber.gpuFailed = true;
    transcriber.runWhisper.mockRejectedValue(new Error('gpu failed'));
    await expect(transcriber.transcribe(new Float32Array(16000))).rejects.toThrow('gpu failed');
    expect(transcriber.runWhisper).toHaveBeenCalledTimes(1);
  });

  function createSpawningTranscriber(responses) {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      { useGpu: true },
    );
    transcriber.initialized = true;
    transcriber.modelPath = 'model.bin';
    transcriber.whisperPath = 'gpu.exe';
    transcriber.ensureExecutable = jest.fn().mockResolvedValue('cpu.exe');
    transcriber.ensureDir = jest.fn().mockResolvedValue();
    const spawnCalls = [];
    const spawn = (_path, args) => {
      const response = responses[Math.min(spawnCalls.length, responses.length - 1)];
      spawnCalls.push(args);
      return {
        stdout: { on: (_e, handler) => response.stdout && handler(response.stdout) },
        stderr: { on: (_e, handler) => response.stderr && handler(response.stderr) },
        on: (event, handler) => {
          if (event === 'close' && response.close !== false) {
            handler(response.code === undefined ? 0 : response.code);
          }
          if (event === 'error' && response.error) {
            handler(response.error);
          }
        },
      };
    };
    transcriber.getNodeModules = () => ({
      path: require('path'),
      os: { tmpdir: () => tempDir },
      fs: {
        writeFileSync: () => {},
        unlinkSync: () => {},
        chmodSync: () => {},
        existsSync: () => true,
        mkdirSync: () => {},
      },
      spawn,
    });
    transcriber.spawnCalls = spawnCalls;
    return transcriber;
  }

  test('the first GPU transcription omits -np and reports the active backend', async () => {
    const transcriber = createSpawningTranscriber([
      {
        stdout: ' result. ',
        stderr: 'load_backend: loaded CPU backend from x\nload_backend: loaded CUDA backend from y',
      },
      { stdout: ' result. ', stderr: '' },
    ]);
    const result = await transcriber.transcribe(new Float32Array(16000));
    expect(result.text).toBe('result.');
    expect(transcriber.gpuProbed).toBe(true);
    expect(transcriber.gpuActive).toBe(true);
    expect(transcriber.spawnCalls[0]).not.toContain('-np');
    await transcriber.transcribe(new Float32Array(16000));
    expect(transcriber.spawnCalls[1]).toContain('-np');
  });

  test('a failed first GPU run falls back to the CPU binary and records no GPU', async () => {
    const transcriber = createSpawningTranscriber([
      { stderr: 'CUDA driver error', code: 1 },
      { stdout: 'cpu text', stderr: 'load_backend: loaded CPU backend from x' },
    ]);
    const result = await transcriber.transcribe(new Float32Array(16000));
    expect(result.text).toBe('cpu text');
    expect(transcriber.spawnCalls[0]).not.toContain('-np');
    expect(transcriber.gpuProbed).toBe(true);
    expect(transcriber.gpuActive).toBe(false);
  });

  test('CPU-mode transcriptions always suppress printing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      {},
    );
    transcriber.initialized = true;
    transcriber.modelPath = 'model.bin';
    transcriber.whisperPath = 'cpu.exe';
    const spawnCalls = [];
    transcriber.getNodeModules = () => ({
      path: require('path'),
      os: { tmpdir: () => tempDir },
      fs: { writeFileSync: () => {}, unlinkSync: () => {}, chmodSync: () => {} },
      spawn: (_path, args) => {
        spawnCalls.push(args);
        return {
          stdout: { on: (_e, handler) => handler(' text ') },
          stderr: { on: () => {} },
          on: (event, handler) => {
            if (event === 'close') {
              handler(0);
            }
          },
        };
      },
    });
    const result = await transcriber.transcribe(new Float32Array(16000));
    expect(result.text).toBe('text');
    expect(spawnCalls[0]).toContain('-np');
  });

  test('prepareBinDir replaces stale binaries when the build changes', async () => {
    const fs = require('fs');
    const path = require('path');
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      {},
    );
    transcriber.getNodeModules = () => ({ path, fs, os: { tmpdir: () => tempDir } });
    const binDir = path.join(tempDir, 'bin-test');
    await transcriber.prepareBinDir(binDir, 'a.zip');
    fs.writeFileSync(path.join(binDir, 'stale.exe'), 'x');
    await transcriber.prepareBinDir(binDir, 'a.zip');
    expect(fs.existsSync(path.join(binDir, 'stale.exe'))).toBe(true);
    await transcriber.prepareBinDir(binDir, 'b.zip');
    expect(fs.existsSync(path.join(binDir, 'stale.exe'))).toBe(false);
    expect(fs.readFileSync(path.join(binDir, '.build'), 'utf8')).toBe('b.zip');
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test('prepareBinDir wipes an unmarked GPU directory containing a binary', async () => {
    const fs = require('fs');
    const path = require('path');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      {},
    );
    transcriber.getNodeModules = () => ({ path, fs, os: { tmpdir: () => tempDir } });
    const binDir = path.join(tempDir, 'bin-gpu-test');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'whisper-cli.exe'), 'x');
    await transcriber.prepareBinDir(binDir, 'new.zip', true);
    expect(fs.existsSync(path.join(binDir, 'whisper-cli.exe'))).toBe(false);
    expect(fs.readFileSync(path.join(binDir, '.build'), 'utf8')).toBe('new.zip');
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test('prepareBinDir keeps an unmarked CPU directory', async () => {
    const fs = require('fs');
    const path = require('path');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: '/tmp' } } }, manifest: { dir: 'x' } },
      {},
    );
    transcriber.getNodeModules = () => ({ path, fs, os: { tmpdir: () => tempDir } });
    const binDir = path.join(tempDir, 'bin-cpu-test');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'main'), 'x');
    await transcriber.prepareBinDir(binDir, 'cpu.zip', false);
    expect(fs.existsSync(path.join(binDir, 'main'))).toBe(true);
    expect(fs.readFileSync(path.join(binDir, '.build'), 'utf8')).toBe('cpu.zip');
    fs.rmSync(binDir, { recursive: true, force: true });
  });
});

describe('isExecutableCached', () => {
  const originalPlatform = process.platform;
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tempDir = fs.mkdtempSync(os.tmpdir() + path.sep + 'whisper-exe-cache-');
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function makeTranscriber(useGpu, platform) {
    Object.defineProperty(process, 'platform', { value: platform });
    return new DesktopTranscriber(
      { app: { vault: { adapter: { basePath: tempDir } } }, manifest: { dir: 'plugin' } },
      { useGpu },
    );
  }

  test('reports the CPU binary when present in the bin directory', () => {
    const transcriber = makeTranscriber(false, 'linux');
    expect(transcriber.isExecutableCached()).toBe(false);
    const binDir = path.join(tempDir, 'plugin', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'whisper-cli'), 'x');
    expect(transcriber.isExecutableCached()).toBe(true);
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test('uses the GPU directory for the GPU build', () => {
    const transcriber = makeTranscriber(true, 'win32');
    expect(transcriber.isExecutableCached()).toBe(false);
    const binDir = path.join(tempDir, 'plugin', 'bin-gpu');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'whisper-cli.exe'), 'x');
    expect(transcriber.isExecutableCached()).toBe(true);
    fs.rmSync(binDir, { recursive: true, force: true });
  });
});
