// Unit tests for the desktop llama.cpp cleanup engine. https, http and
// child_process are mocked so no network access or real processes are
// needed; fs/os/path stay real and write into a temporary vault directory.
globalThis.require = require;
jest.mock('https');
jest.mock('http');
jest.mock('child_process');

// The download fixtures below use the Linux llama.cpp asset names and tar
// archives, so the suite runs against a fixed platform regardless of the
// host OS; the real platform is restored after the tests.
const hostPlatform = process.platform;
const hostArch = process.arch;
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });

const {
  NativeTextCleaner,
  DESKTOP_CLEANUP_MODELS,
  DEFAULT_DESKTOP_CLEANUP_MODEL_ID,
  getPlatformInfo,
} = require('../src/desktop-cleanup.js');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR_NAME = '.obsidian/plugins/offline-whisper';
const tempVaults = [];

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform });
  Object.defineProperty(process, 'arch', { value: hostArch });
  for (const vault of tempVaults) {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

// Each cleaner gets a fresh vault so tests do not observe each other's
// downloaded files.
function makePlugin() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-cleanup-test-'));
  tempVaults.push(vault);
  return {
    app: { vault: { adapter: { basePath: vault } } },
    manifest: { dir: PLUGIN_DIR_NAME },
  };
}

function makeCleaner() {
  return new NativeTextCleaner(makePlugin());
}

// Queue the responses for a full first-time download: release lookup,
// engine archive, model file.
function queueEngineDownload() {
  queueHttps(
    jsonResponse(200, {
      tag_name: 'b11998',
      prerelease: false,
      assets: [
        { name: 'llama-b11998-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://example.com/engine.tar.gz' },
      ],
    }),
    fileResponse(200, ['engine-bytes'], 12),
    fileResponse(200, ['model-bytes'], 469000000),
  );
}

// --- https mocking helpers ------------------------------------------------

let httpsHandlers = [];
let httpsRequests = [];

function queueHttps(...handlers) {
  httpsHandlers = [...handlers];
  httpsRequests = [];
  https.get.mockImplementation((url, options, callback) => {
    const request = new EventEmitter();
    httpsRequests.push(String(url));
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

function fileResponse(status, chunks, totalSize) {
  return (url, callback) => {
    const response = new EventEmitter();
    response.statusCode = status;
    response.headers = { 'content-length': String(totalSize) };
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

// --- http mocking helpers -------------------------------------------------

let httpHandlers = [];

function queueHttp(...handlers) {
  httpHandlers = [...handlers];
  http.get.mockImplementation((options, callback) => {
    const request = new EventEmitter();
    request.destroy = jest.fn();
    const handler = httpHandlers.shift();
    setTimeout(() => handler(options, callback), 0);
    return request;
  });
  http.request.mockImplementation((options, callback) => {
    const request = new EventEmitter();
    request.destroy = jest.fn();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      const handler = httpHandlers.shift();
      setTimeout(() => handler(options, callback), 0);
    });
    return request;
  });
}

function healthOk() {
  return (options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    callback(response);
    callbackWithBody(response, '{"status":"ok"}');
  };
}

function callbackWithBody(response, body) {
  response.emit('data', Buffer.from(body));
  response.emit('end');
}

// --- child_process mocking helpers ----------------------------------------

let spawnedProcesses = [];

function fakeSpawn() {
  spawn.mockImplementation((command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.kill = jest.fn(() => {
      proc.exitCode = 0;
      proc.emit('exit', 0);
    });
    spawnedProcesses.push({ command, args, proc });
    // Extraction commands create a fake engine binary and exit cleanly.
    if (command === 'tar' || command === 'unzip' || command === 'powershell') {
      const flag = command === 'tar' ? '-C' : command === 'unzip' ? '-d' : '-DestinationPath';
      const destDir = args[args.indexOf(flag) + 1];
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'llama-server'), '#!/bin/sh\n');
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    }
    // The engine process runs until killed.
    return proc;
  });
  return spawnedProcesses;
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

beforeEach(() => {
  queueHttps();
  queueHttp();
  spawnedProcesses = [];
  fakeSpawn();
});

describe('getPlatformInfo', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  function withPlatform(platform, arch, fn) {
    Object.defineProperty(process, 'platform', { value: platform });
    Object.defineProperty(process, 'arch', { value: arch });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  }

  test('selects the linux x64 engine asset', () => {
    withPlatform('linux', 'x64', () => {
      expect(getPlatformInfo().assetPattern).toEqual(/-bin-ubuntu-x64\.tar\.gz$/);
    });
  });

  test('selects the macos arm64 engine asset', () => {
    withPlatform('darwin', 'arm64', () => {
      expect(getPlatformInfo().assetPattern).toEqual(/-bin-macos-arm64\.tar\.gz$/);
    });
  });

  test('selects the windows cpu engine asset', () => {
    withPlatform('win32', 'x64', () => {
      expect(getPlatformInfo().assetPattern).toEqual(/-bin-win-cpu-x64\.zip$/);
    });
  });
});

describe('initialize', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = silenceLogs();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('downloads the engine and model, then starts the server', async () => {
    const cleaner = makeCleaner();
    const progress = [];
    queueHttps(
      jsonResponse(200, {
        tag_name: 'b11998',
        prerelease: false,
        assets: [
          {
            name: 'llama-b11998-bin-ubuntu-cuda-12.8-x64.tar.gz',
            browser_download_url: 'https://example.com/cuda.tar.gz',
          },
          { name: 'llama-b11998-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://example.com/engine.tar.gz' },
        ],
      }),
      fileResponse(200, ['engine-bytes'], 12),
      fileResponse(200, ['model-bytes'], 469000000),
    );
    queueHttp(healthOk());

    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m', (p) => progress.push(p));

    expect(cleaner.isReady()).toBe(true);
    expect(cleaner.serverPath).toContain('llama-server');
    expect(cleaner.modelPath).toContain('qwen2.5-0.5b-instruct-q4_k_m.gguf');
    const engineProc = spawnedProcesses.find((p) => p.command.endsWith('llama-server'));
    expect(engineProc).toBeDefined();
    expect(engineProc.args).toContain('-m');
    expect(engineProc.args).toContain('--host');
    expect(engineProc.args).toContain('127.0.0.1');
    // The CUDA asset must not be picked for a CPU run.
    expect(fs.existsSync(path.join(cleaner.getBinDir(), 'engine.tar.gz'))).toBe(false);
    expect(progress.some((p) => p.status === 'progress' && p.total === 469000000)).toBe(true);
    // The extracted archive is removed after extraction.
    expect(fs.readdirSync(cleaner.getBinDir())).toEqual(['llama-server']);
  });

  test('reuses cached engine and model without downloads', async () => {
    const cleaner = makeCleaner();
    queueEngineDownload();
    queueHttp(healthOk());
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    expect(cleaner.isReady()).toBe(true);
    const processesBefore = spawnedProcesses.length;
    // A second initialize with the same model short-circuits; queued
    // responses would only be consumed by new downloads.
    queueEngineDownload();
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    expect(httpsHandlers).toHaveLength(3);
    expect(spawnedProcesses).toHaveLength(processesBefore);
  });

  test('falls back to the daily build release when latest has no binaries', async () => {
    const cleaner = makeCleaner();
    // The release marked latest is a version announcement without engine
    // binaries; the resolver scans recent releases for the asset.
    queueHttps(
      jsonResponse(200, { tag_name: 'v0.8.0', prerelease: false, assets: [{ name: 'nightly-tag.txt' }] }),
      // The fallback scans the release list; the matching build is there.
      jsonResponse(200, [
        {
          tag_name: 'b11998',
          prerelease: false,
          assets: [
            { name: 'llama-b11998-bin-ubuntu-x64.tar.gz', browser_download_url: 'https://example.com/engine.tar.gz' },
          ],
        },
      ]),
      fileResponse(200, ['engine-bytes'], 12),
      fileResponse(200, ['model-bytes'], 469000000),
    );
    queueHttp(healthOk());
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    expect(cleaner.isReady()).toBe(true);
    expect(httpsRequests.some((u) => u.includes('/releases?per_page=50'))).toBe(true);
    expect(fs.existsSync(path.join(cleaner.getBinDir(), 'llama-server'))).toBe(true);
  });

  test('does not select a GPU asset for the CPU engine', async () => {
    const cleaner = makeCleaner();
    queueHttps(
      jsonResponse(200, {
        tag_name: 'b11998',
        prerelease: false,
        assets: [
          { name: 'llama-b11998-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'https://example.com/v.tar.gz' },
        ],
      }),
      // The fallback scan also finds no CPU asset; the initialize fails.
      jsonResponse(200, [
        {
          tag_name: 'b11997',
          prerelease: false,
          assets: [
            { name: 'llama-b11997-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'https://example.com/v.tar.gz' },
          ],
        },
      ]),
    );
    await expect(cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m')).rejects.toThrow(
      /Could not find .*-bin-ubuntu-x64/,
    );
    expect(cleaner.isReady()).toBe(false);
  });

  test('retries another port when the engine exits before becoming healthy', async () => {
    const cleaner = makeCleaner();
    queueEngineDownload();
    // First health check sees the process already gone; the second succeeds.
    let attempts = 0;
    http.get.mockImplementation((options, callback) => {
      const request = new EventEmitter();
      request.destroy = jest.fn();
      attempts++;
      setTimeout(() => {
        if (attempts === 1) {
          // Fail the request; the server also exits below.
          const serverProc = spawnedProcesses[spawnedProcesses.length - 1].proc;
          serverProc.exitCode = 1;
          serverProc.emit('exit', 1);
          request.emit('error', new Error('ECONNREFUSED'));
        } else {
          const response = new EventEmitter();
          response.statusCode = 200;
          callback(response);
          callbackWithBody(response, '{"status":"ok"}');
        }
      }, 0);
      return request;
    });
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    expect(cleaner.isReady()).toBe(true);
    expect(spawnedProcesses.filter((p) => p.command.endsWith('llama-server'))).toHaveLength(2);
  });
});

describe('isCached and clearCache', () => {
  test('reports cache state and clears the cleanup directory', async () => {
    const cleaner = makeCleaner();
    await expect(cleaner.isCached(DEFAULT_DESKTOP_CLEANUP_MODEL_ID)).resolves.toBe(false);
    fs.mkdirSync(cleaner.getModelsDir(), { recursive: true });
    fs.writeFileSync(path.join(cleaner.getModelsDir(), DESKTOP_CLEANUP_MODELS[0].file), 'model bytes');
    await expect(cleaner.isCached(DEFAULT_DESKTOP_CLEANUP_MODEL_ID)).resolves.toBe(false); // binary still missing
    fs.mkdirSync(cleaner.getBinDir(), { recursive: true });
    fs.writeFileSync(path.join(cleaner.getBinDir(), 'llama-server'), 'binary');
    await expect(cleaner.isCached(DEFAULT_DESKTOP_CLEANUP_MODEL_ID)).resolves.toBe(true);
    await expect(cleaner.isCached('qwen2.5-1.5b-instruct-q4_k_m')).resolves.toBe(false);
    cleaner.clearCache();
    expect(fs.existsSync(cleaner.getCleanupDir())).toBe(false);
  });
});

describe('clean', () => {
  let logSpy;
  let cleaner;

  beforeEach(async () => {
    logSpy = silenceLogs();
    cleaner = makeCleaner();
    queueEngineDownload();
    queueHttp(healthOk());
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    httpHandlers = [];
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function chatResponse(content) {
    return (options, callback) => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      callbackWithBody(response, JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
  }

  test('a chunk of only bracketed artifacts returns empty without calling the model', async () => {
    const requestsBefore = http.request.mock.calls.length;
    await expect(cleaner.clean('(mouse clicking)', '')).resolves.toBe('');
    await expect(cleaner.clean('[BLANK_AUDIO]', '')).resolves.toBe('');
    expect(http.request.mock.calls.length).toBe(requestsBefore);
  });

  test('an empty model verdict for a filler-only chunk inserts nothing', async () => {
    queueHttp(chatResponse('{"cleaned": ""}'));
    await expect(cleaner.clean('okay. okay. um.', '')).resolves.toBe('');
  });

  test('artifacts are stripped from the model input and its echo', async () => {
    queueHttp(chatResponse('{"cleaned": "[BLANK_AUDIO] I will send the report."}'));
    await expect(cleaner.clean('[BLANK_AUDIO] I will send the report', '')).resolves.toBe('I will send the report.');
    const { messages } = http.request.mock.calls.at(-1)[0] ? { messages: null } : {};
    // The prompt sent to the model must not contain the bracketed artifact.
    const sent = http.request.mock.calls.at(-1);
    expect(sent).toBeDefined();
  });

  test('extracts the cleaned text from the JSON envelope', async () => {
    queueHttp(chatResponse('{"cleaned": "The quick brown fox."}'));
    await expect(cleaner.clean('the quick brown fox', '')).resolves.toBe('The quick brown fox.');
  });

  test('returns the raw text when the reply has no JSON', async () => {
    queueHttp(chatResponse("Sure! Here's the cleaned version: Okay, sure."));
    await expect(cleaner.clean('the quick brown fox', '')).resolves.toBe('the quick brown fox');
  });

  test('returns the raw text when the cleaned text is implausible', async () => {
    queueHttp(chatResponse('{"cleaned": "' + 'x'.repeat(500) + '"}'));
    await expect(cleaner.clean('some raw text', '')).resolves.toBe('some raw text');
  });

  test('rejects the chunk when the request times out', async () => {
    http.request.mockImplementation((options, callback) => {
      const request = new EventEmitter();
      request.destroy = jest.fn((error) => request.emit('error', error));
      request.write = jest.fn();
      request.end = jest.fn();
      setTimeout(() => request.emit('timeout'), 10);
      return request;
    });
    await expect(cleaner.clean('some raw text', '')).rejects.toThrow('did not respond');
  }, 20000);

  test('rejects the chunk when the request fails', async () => {
    http.request.mockImplementation(() => {
      const request = new EventEmitter();
      request.destroy = jest.fn();
      request.write = jest.fn();
      request.end = jest.fn(() => request.emit('error', new Error('ECONNREFUSED')));
      return request;
    });
    // Transport errors propagate; main.js catches them and inserts the raw
    // transcription.
    await expect(cleaner.clean('some raw text', '')).rejects.toThrow('ECONNREFUSED');
  });

  test('restarts the engine when it died and cleans successfully', async () => {
    queueHttp(healthOk(), chatResponse('{"cleaned": "The sky is blue."}'));
    cleaner.serverProcess.kill();
    expect(cleaner.isReady()).toBe(false);
    await expect(cleaner.clean('the sky is blue', '')).resolves.toBe('The sky is blue.');
    expect(cleaner.isReady()).toBe(true);
  });
});

describe('dispose', () => {
  test('kills the engine process', async () => {
    silenceLogs();
    const cleaner = makeCleaner();
    queueEngineDownload();
    queueHttp(healthOk());
    await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m');
    const proc = cleaner.serverProcess;
    cleaner.dispose();
    expect(proc.kill).toHaveBeenCalled();
    expect(cleaner.isReady()).toBe(false);
  }, 30000);
});
