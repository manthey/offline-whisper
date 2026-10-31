// Unit tests for the desktop downloader. https and child_process are mocked
// so no network access or real archives are needed; fs/os/path stay real and
// write into a temporary vault directory.
globalThis.require = require;
jest.mock('https');
jest.mock('child_process');

const { DesktopTranscriber, getPlatformInfo } = require('../src/desktop-transcriber.js');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR_NAME = '.obsidian/plugins/offline-whisper';
const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-transcriber-test-'));
const pluginDir = path.join(tempVault, PLUGIN_DIR_NAME);

function makePlugin() {
  return {
    app: { vault: { adapter: { basePath: tempVault } } },
    manifest: { dir: PLUGIN_DIR_NAME },
  };
}

function makeTranscriber(options = {}) {
  const transcriber = new DesktopTranscriber(makePlugin(), options);
  return transcriber;
}

const originalPlatform = process.platform;

afterAll(() => {
  fs.rmSync(tempVault, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

// --- https mocking helpers

// Queue of handlers; each handler receives (url, callback) and drives the
// mocked response. Requests are recorded so tests can emit request errors.
let httpsHandlers = [];
let httpsRequests = [];

function queueHttps(...handlers) {
  httpsHandlers = [...handlers];
  httpsRequests = [];
  https.get.mockImplementation((url, options, callback) => {
    const request = new EventEmitter();
    httpsRequests.push(request);
    const handler = httpsHandlers.shift();
    setTimeout(() => handler(url, callback, request), 0);
    return request;
  });
}

function jsonResponse(status, data) {
  return (url, callback) => {
    const response = new EventEmitter();
    response.statusCode = status;
    callback(response);
    response.emit('data', Buffer.from(JSON.stringify(data)));
    response.emit('end');
  };
}

function fileResponse(status, chunks, totalSize, headers = {}) {
  return (url, callback) => {
    const response = new EventEmitter();
    response.statusCode = status;
    response.headers = { 'content-length': String(totalSize), ...headers };
    response.pipe = (dest) => {
      for (const chunk of chunks) {
        response.emit('data', Buffer.from(chunk));
        dest.write(Buffer.from(chunk));
      }
      dest.end();
    };
    callback(response);
  };
}

function redirectResponse(location) {
  return (url, callback) => {
    const response = new EventEmitter();
    response.statusCode = 302;
    response.headers = { location };
    callback(response);
  };
}

// --- child_process mocking helpers

function fakeSpawn({ exitCode = 0, stderr = '', beforeClose = null, spawnError = null } = {}) {
  spawn.mockImplementation((command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      if (beforeClose) {
        beforeClose(command, args);
      }
      if (spawnError) {
        proc.emit('error', spawnError);
        return;
      }
      if (stderr) {
        proc.stderr.emit('data', Buffer.from(stderr));
      }
      proc.emit('close', exitCode);
    });
    return proc;
  });
}

function releaseInfo(tagName, assetNames, { prerelease = false, body = '' } = {}) {
  return {
    tag_name: tagName,
    prerelease,
    body,
    assets: assetNames.map((name) => ({ name, browser_download_url: `https://example.com/${tagName}/${name}` })),
  };
}

// --- downloadFile

describe('downloadFile', () => {
  beforeEach(() => {
    https.get.mockReset();
  });

  test('writes the response body to the destination file', async () => {
    const transcriber = makeTranscriber();
    const destPath = path.join(tempVault, 'download-target.bin');
    transcriber.modelPath = destPath;
    queueHttps(fileResponse(200, ['hello ', 'world'], 11));
    const progress = [];
    await transcriber.downloadModel('ggml-tiny.en.bin', (p) => progress.push(p));
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf8')).toBe('hello world');
    expect(progress.some((p) => p.message && p.message.includes('100%'))).toBe(true);
    fs.unlinkSync(destPath);
  });

  test('follows redirects', async () => {
    const transcriber = makeTranscriber();
    const destPath = path.join(tempVault, 'redirect-target.bin');
    transcriber.modelPath = destPath;
    queueHttps(redirectResponse('https://example.com/real'), fileResponse(200, ['moved'], 5));
    await transcriber.downloadModel('ggml-tiny.en.bin', () => {});
    expect(fs.readFileSync(destPath, 'utf8')).toBe('moved');
    fs.unlinkSync(destPath);
  });

  test('retries immediately when rate limited with retry-after 0', async () => {
    const transcriber = makeTranscriber();
    const destPath = path.join(tempVault, 'rate-limit-target.bin');
    transcriber.modelPath = destPath;
    queueHttps(fileResponse(429, [], 0, { 'retry-after': '0' }), fileResponse(200, ['ok'], 2));
    await transcriber.downloadModel('ggml-tiny.en.bin', () => {});
    expect(fs.readFileSync(destPath, 'utf8')).toBe('ok');
    fs.unlinkSync(destPath);
  });

  test('throws when the server returns an unrecoverable status', async () => {
    jest.useFakeTimers();
    const transcriber = makeTranscriber();
    transcriber.modelPath = path.join(tempVault, 'never-written.bin');
    queueHttps(
      fileResponse(404, [], 0),
      fileResponse(404, [], 0),
      fileResponse(404, [], 0),
      fileResponse(404, [], 0),
      fileResponse(404, [], 0),
    );
    const assertion = expect(transcriber.downloadModel('ggml-tiny.en.bin', () => {})).rejects.toThrow('HTTP 404');
    await jest.runAllTimersAsync();
    await assertion;
    jest.useRealTimers();
  });

  test('throws when the request errors on the final attempt', async () => {
    jest.useFakeTimers();
    const transcriber = makeTranscriber();
    transcriber.modelPath = path.join(tempVault, 'never-written.bin');
    const connectionError = (url, callback, request) => {
      request.emit('error', new Error('connection reset'));
    };
    queueHttps(connectionError, connectionError, connectionError, connectionError, connectionError);
    const assertion = expect(transcriber.downloadModel('ggml-tiny.en.bin', () => {})).rejects.toThrow(
      'connection reset',
    );
    await jest.runAllTimersAsync();
    await assertion;
    jest.useRealTimers();
  });
});

// --- extractZip

describe('extractZip', () => {
  beforeEach(() => {
    https.get.mockReset();
    spawn.mockReset();
  });

  test('reports a failing exit code through initialize', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.0', ['whisper-bin-blas-linux-x64.tar.gz'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({ exitCode: 1, stderr: 'archive corrupted' });
    await expect(transcriber.initialize('onnx-community/whisper-base.en', () => {})).rejects.toThrow(
      /archive corrupted/,
    );
  });

  test('reports spawn failures through initialize', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.0', ['whisper-bin-blas-linux-x64.tar.gz'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({ spawnError: new Error('tar not found') });
    await expect(transcriber.initialize('onnx-community/whisper-base.en', () => {})).rejects.toThrow('tar not found');
  });

  test('uses PowerShell to expand archives on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const transcriber = makeTranscriber();
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');
    queueHttps(
      jsonResponse(200, releaseInfo('v1.0', ['whisper-blas-bin-x64.zip'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({
      exitCode: 0,
      beforeClose: (command, args) => {
        expect(command).toBe('powershell');
        // extractZip embeds the paths in a single -Command string.
        const match = args[args.length - 1].match(/-DestinationPath "([^"]+)"/);
        expect(match).toBeTruthy();
        // Simulate extraction side effect so ensureExecutable finds the binary.
        fs.mkdirSync(match[1], { recursive: true });
        fs.writeFileSync(path.join(match[1], 'whisper-cli.exe'), 'x');
      },
    });
    await transcriber.initialize('onnx-community/whisper-base.en', () => {});
    expect(transcriber.whisperPath).toContain('whisper-cli.exe');
    expect(transcriber.initialized).toBe(true);
  });
});

// --- getLatestReleaseUrl (exercised through initialize)

describe('release resolution through initialize', () => {
  beforeEach(() => {
    https.get.mockReset();
    spawn.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  test('uses the asset from the latest release', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.9.0', ['whisper-bin-blas-linux-x64.tar.gz'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    // Extraction is spawned via the mocked child_process; its side effect
    // writes the binary where findExecutable looks for it.
    fakeSpawn({
      exitCode: 0,
      beforeClose: (command, args) => {
        const destDir = args.includes('-C') ? args[args.indexOf('-C') + 1] : args[args.indexOf('-d') + 1];
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'whisper-cli'), 'x');
      },
    });
    // Model already present so its download is skipped.
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');

    await transcriber.initialize('onnx-community/whisper-base.en', () => {});

    expect(transcriber.whisperPath).toContain('whisper-cli');
    expect(transcriber.initialized).toBe(true);
    fs.rmSync(path.join(pluginDir, 'bin'), { recursive: true, force: true });
  });

  test('follows the nightly build link referenced by the release notes', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(
        200,
        releaseInfo('v1.9.0', [], {
          body: '**Nightly build:** [whisper nightly](https://github.com/example/repo/releases/tag/nightly-42)',
        }),
      ),
      jsonResponse(200, releaseInfo('nightly-42', ['whisper-bin-blas-linux-x64.tar.gz'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    const urls = [];
    // Re-queue with URL recording for the second JSON fetch.
    https.get.mockImplementation((url, options, callback) => {
      urls.push(url);
      const request = new EventEmitter();
      const handler = httpsHandlers.shift();
      setTimeout(() => handler(url, callback, request), 0);
      return request;
    });
    fakeSpawn({
      exitCode: 0,
      beforeClose: (command, args) => {
        const destDir = args.includes('-C') ? args[args.indexOf('-C') + 1] : args[args.indexOf('-d') + 1];
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'whisper-cli'), 'x');
      },
    });
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');

    await transcriber.initialize('onnx-community/whisper-base.en', () => {});

    expect(urls.some((u) => u.includes('/tags/nightly-42'))).toBe(true);
    fs.rmSync(path.join(pluginDir, 'bin'), { recursive: true, force: true });
  });

  test('falls back to scanning recent releases when the latest lacks the asset', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.9.0', [])),
      jsonResponse(200, [
        releaseInfo('v1.9.1-rc1', [], { prerelease: true }),
        releaseInfo('v1.8.0', ['whisper-bin-blas-linux-x64.tar.gz']),
      ]),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({
      exitCode: 0,
      beforeClose: (command, args) => {
        const destDir = args.includes('-C') ? args[args.indexOf('-C') + 1] : args[args.indexOf('-d') + 1];
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'whisper-cli'), 'x');
      },
    });
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');

    await transcriber.initialize('onnx-community/whisper-base.en', () => {});
    expect(transcriber.whisperPath).toContain('whisper-cli');
    fs.rmSync(path.join(pluginDir, 'bin'), { recursive: true, force: true });
  });

  test('uses a prerelease asset when no stable release has it', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.9.0', [])),
      jsonResponse(200, [releaseInfo('v1.9.1-rc1', ['whisper-bin-blas-linux-x64.tar.gz'], { prerelease: true })]),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({
      exitCode: 0,
      beforeClose: (command, args) => {
        const destDir = args.includes('-C') ? args[args.indexOf('-C') + 1] : args[args.indexOf('-d') + 1];
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'whisper-cli'), 'x');
      },
    });
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');

    await transcriber.initialize('onnx-community/whisper-base.en', () => {});
    expect(transcriber.whisperPath).toContain('whisper-cli');
    fs.rmSync(path.join(pluginDir, 'bin'), { recursive: true, force: true });
  });

  test('fails with a descriptive error when no release has the asset', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.9.0', [])),
      jsonResponse(200, [releaseInfo('v1.8.0', ['unrelated.zip'])]),
    );
    await expect(transcriber.initialize('onnx-community/whisper-base.en', () => {})).rejects.toThrow(
      /Could not find whisper-bin-blas-linux-x64.tar.gz/,
    );
  });

  test('fails when the GitHub API returns an error status', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(jsonResponse(500, {}));
    await expect(transcriber.initialize('onnx-community/whisper-base.en', () => {})).rejects.toThrow(
      'GitHub API returned 500',
    );
  });

  test('fails when the extracted archive contains no executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const transcriber = makeTranscriber();
    queueHttps(
      jsonResponse(200, releaseInfo('v1.9.0', ['whisper-bin-blas-linux-x64.tar.gz'])),
      fileResponse(200, ['archive-bytes'], 13),
    );
    fakeSpawn({ exitCode: 0 }); // extraction produces nothing
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');
    await expect(transcriber.initialize('onnx-community/whisper-base.en', () => {})).rejects.toThrow(
      /Could not find whisper executable after extraction/,
    );
  });
});

// --- model download and cache queries

describe('model download and cache queries', () => {
  beforeEach(() => {
    https.get.mockReset();
  });

  test('downloads the model when it is missing and reports progress', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    // Earlier release-resolution tests may have left a model behind.
    fs.rmSync(path.join(pluginDir, 'models'), { recursive: true, force: true });
    const transcriber = makeTranscriber();
    const binDir = path.join(pluginDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'whisper-cli'), 'x');
    const progress = [];
    queueHttps(fileResponse(200, ['model-bytes'], 11));
    await transcriber.initialize('onnx-community/whisper-base.en', (progressUpdate) => progress.push(progressUpdate));
    expect(fs.existsSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'))).toBe(true);
    expect(progress.some((p) => /Downloading model/.test(p.message || ''))).toBe(true);
    expect(progress[progress.length - 1]).toEqual({ status: 'ready' });
    fs.rmSync(path.join(pluginDir, 'models'), { recursive: true, force: true });
  });

  test('maps unknown model ids to the default model file', () => {
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');
    const transcriber = makeTranscriber();
    expect(transcriber.isModelCached('totally/unknown-model')).toBe(true);
    expect(transcriber.isModelCached('onnx-community/whisper-tiny')).toBe(false);
    fs.rmSync(path.join(pluginDir, 'models'), { recursive: true, force: true });
  });

  test('clearCache removes the models and binary directories', () => {
    fs.mkdirSync(path.join(pluginDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'models', 'ggml-base.en.bin'), 'model');
    fs.mkdirSync(path.join(pluginDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'bin', 'whisper-cli'), 'x');
    fs.mkdirSync(path.join(pluginDir, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'unrelated', 'keep.txt'), 'keep');

    makeTranscriber().clearCache();

    expect(fs.existsSync(path.join(pluginDir, 'models'))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'bin'))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'unrelated', 'keep.txt'))).toBe(true);
    fs.rmSync(path.join(pluginDir, 'unrelated'), { recursive: true, force: true });
  });
});

// --- transcription runs

describe('transcription runs', () => {
  beforeEach(() => {
    https.get.mockReset();
    spawn.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // Transcriptions write their temp WAV files into the OS temp directory,
  // which is shared with other runs; point the transcriber at a private
  // directory so leftover detection is deterministic on any host.
  const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-run-tmp-'));
  afterAll(() => {
    fs.rmSync(runTmp, { recursive: true, force: true });
  });

  function makeInitializedTranscriber() {
    const transcriber = makeTranscriber();
    transcriber.initialized = true;
    transcriber.whisperPath = path.join(tempVault, 'fake-whisper-cli');
    transcriber.modelPath = path.join(pluginDir, 'models', 'ggml-base.en.bin');
    const realModules = transcriber.getNodeModules();
    transcriber.getNodeModules = () => ({ ...realModules, os: { tmpdir: () => runTmp } });
    return transcriber;
  }

  test('transcribes audio and parses loaded backends from stderr', async () => {
    const transcriber = makeInitializedTranscriber();
    fakeSpawn({
      exitCode: 0,
      stderr: 'load_backend: loaded CPU backend from libggml-cpu.so\nwhisper_init_from_file_with_params_no_state',
    });
    const { spawn: spawnMock } = require('child_process');
    // Capture stdout/stderr wiring: fakeSpawn above only sets stderr; emit
    // stdout through the process returned to the caller.
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('load_backend: loaded CPU backend from libggml-cpu.so'));
        proc.stdout.emit('data', Buffer.from(' hello world '));
        proc.emit('close', 0);
      });
      return proc;
    });

    const result = await transcriber.transcribe(new Float32Array(16000).fill(0.5));

    expect(result.text).toBe('hello world');
    const args = spawnMock.mock.calls[0][1];
    expect(args).toContain('-m');
    expect(args).toContain(transcriber.modelPath);
    expect(args).toContain('-np');
    // No temp wav files are left behind in the transcription temp directory.
    const leftovers = fs.readdirSync(runTmp).filter((name) => /^whisper-\d+\.wav$/.test(name));
    expect(leftovers).toEqual([]);
  });

  test('rejects when whisper exits with a nonzero code', async () => {
    const transcriber = makeInitializedTranscriber();
    const { spawn: spawnMock } = require('child_process');
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('cuda OOM'));
        proc.emit('close', 1);
      });
      return proc;
    });
    await expect(transcriber.transcribe(new Float32Array(16000))).rejects.toThrow(/cuda OOM/);
  });

  test('rejects when the whisper process cannot be spawned', async () => {
    const transcriber = makeInitializedTranscriber();
    const { spawn: spawnMock } = require('child_process');
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => proc.emit('error', new Error('permission denied')));
      return proc;
    });
    await expect(transcriber.transcribe(new Float32Array(16000))).rejects.toThrow('permission denied');
  });

  test('refuses to transcribe before initialization', async () => {
    const transcriber = makeTranscriber();
    await expect(transcriber.transcribe(new Float32Array(16))).rejects.toThrow('Transcriber not initialized');
  });
});
