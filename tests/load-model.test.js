const { App } = require('obsidian-test-mocks/obsidian');
const transformersMock = require('@huggingface/transformers');

// Wrap the mock pipeline in a jest.fn before main.js captures it, so tests
// can control resolution timing (needed to observe download tracking).
const originalPipeline = transformersMock.pipeline;
transformersMock.pipeline = jest.fn((...args) => originalPipeline(...args));

const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

function createPlugin() {
  const app = App.createConfigured__();
  const manifest = {
    id: 'offline-whisper',
    name: 'Offline Whisper Transcription',
    version: '1.0.0',
    minAppVersion: '1.0.0',
    description: 'Offline speech-to-text using Whisper',
    author: 'David Manthey',
    dir: '.obsidian/plugins/offline-whisper',
  };
  const plugin = new WhisperTranscriptionPlugin(app.asOriginalType__(), manifest);
  return { app, plugin };
}

function setCacheContents(urls) {
  Object.defineProperty(global, 'caches', {
    value: {
      keys: jest.fn(() => Promise.resolve(urls.length ? ['transformers-cache'] : [])),
      open: jest.fn(() =>
        Promise.resolve({
          keys: jest.fn(() => Promise.resolve(urls.map((url) => ({ url })))),
        }),
      ),
    },
    writable: true,
    configurable: true,
  });
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

describe('loadModel (mobile path)', () => {
  beforeEach(() => {
    originalPipeline.calls.length = 0;
    transformersMock.pipeline.mockClear();
    originalPipeline.failNext = null;
    delete navigator.gpu;
  });

  test('returns true immediately when a model is already loaded', async () => {
    const { plugin } = createPlugin();
    plugin.transcriber = jest.fn();
    const logSpy = silenceLogs();
    await expect(plugin.loadModel()).resolves.toBe(true);
    expect(transformersMock.pipeline).not.toHaveBeenCalled();
    expect(plugin.isModelLoading).toBe(false);
    logSpy.mockRestore();
  });

  test('returns false while a load is already in progress', async () => {
    const { plugin } = createPlugin();
    plugin.isModelLoading = true;
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    await expect(plugin.loadModel()).resolves.toBe(false);
    expect(statusSpy).toHaveBeenCalledWith('Model is already loading', 3000);
  });

  test('loads a cached model and reports loading from cache', async () => {
    setCacheContents(['https://huggingface.co/onnx-community/whisper-base.en/model.onnx']);
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    const logSpy = silenceLogs();

    await expect(plugin.loadModel()).resolves.toBe(true);

    expect(statusSpy).toHaveBeenCalledWith('Loading model from cache', true);
    expect(statusSpy).toHaveBeenCalledWith('Model ready', true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
    expect(originalPipeline.calls[0].model).toBe('onnx-community/whisper-base.en');
    expect(typeof plugin.transcriber).toBe('function');
    expect(plugin.isModelLoading).toBe(false);
    logSpy.mockRestore();
  });

  test('matches a cache keyed with the URL-encoded model id', async () => {
    setCacheContents(['https://huggingface.co/onnx-community%2Fwhisper-base.en/model.onnx']);
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    silenceLogs();

    await expect(plugin.loadModel()).resolves.toBe(true);
    expect(statusSpy).toHaveBeenCalledWith('Loading model from cache', true);
  });

  test('downloads an uncached model and reports download progress', async () => {
    setCacheContents([]);
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    const logSpy = silenceLogs();

    await expect(plugin.loadModel()).resolves.toBe(true);
    expect(statusSpy).toHaveBeenCalledWith(
      'Downloading model: onnx-community/whisper-base.en. This only happens once.',
      true,
    );

    // Exercise the progress callback captured from the pipeline options.
    const progressCallback = originalPipeline.calls[0].options.progress_callback;
    progressCallback({ status: 'progress', loaded: 2 * 1024 * 1024, total: 10 * 1024 * 1024 });
    progressCallback({ status: 'downloading', loaded: 1024, total: 2048 });
    progressCallback({ status: 'progress', loaded: 1024 });
    progressCallback({ status: 'loading' });
    progressCallback({ status: 'ready' });

    expect(statusSpy).toHaveBeenCalledWith('Downloading: 20% (2MB)', true);
    expect(statusSpy).toHaveBeenCalledWith('Downloading: 50% (0MB)', true);
    expect(statusSpy).toHaveBeenCalledWith('Initializing model', true);
    logSpy.mockRestore();
  });

  test('reports a missing network when the pipeline fetch fails', async () => {
    setCacheContents([]);
    originalPipeline.failNext = 'fetch failed: network down';
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    silenceLogs();

    await expect(plugin.loadModel()).resolves.toBe(false);
    expect(statusSpy).toHaveBeenCalledWith('Model not cached and no network available', 5000);
    expect(plugin.isModelLoading).toBe(false);
    expect(plugin.transcriber).toBeNull();
  });

  test('reports a generic pipeline failure and resets the loading flag', async () => {
    setCacheContents([]);
    originalPipeline.failNext = 'unexpected boom';
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    silenceLogs();

    await expect(plugin.loadModel()).resolves.toBe(false);
    expect(statusSpy).toHaveBeenCalledWith('Model load failed: unexpected boom', 5000);
    expect(plugin.isModelLoading).toBe(false);
  });

  test('tracks downloads so the cache Check can report in-progress states', async () => {
    setCacheContents([]);
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    const logSpy = silenceLogs();

    // The pipeline resolves only when the test releases it.
    let resolvePipeline;
    transformersMock.pipeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );

    const loading = plugin.loadModel();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(plugin.downloadCount).toBe(1);

    resolvePipeline(async () => ({ text: '' }));
    await expect(loading).resolves.toBe(true);
    expect(plugin.downloadCount).toBe(0);
    logSpy.mockRestore();
  });

  test('downloadCount returns to zero when the pipeline fails', async () => {
    setCacheContents([]);
    originalPipeline.failNext = 'boom';
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    silenceLogs();

    await plugin.loadModel();
    expect(plugin.downloadCount).toBe(0);
  });
});

describe('isModelCached error handling', () => {
  test('returns false when the cache API rejects', async () => {
    // Do not reuse setCacheContents: a fresh rejecting definition here keeps
    // the test independent of the other cache mocks in this file.
    Object.defineProperty(global, 'caches', {
      value: {
        keys: jest.fn(() => Promise.reject(new Error('storage unavailable'))),
      },
      writable: true,
      configurable: true,
    });
    const { plugin } = createPlugin();
    const logSpy = silenceLogs();
    // isModelCached is not exported; reach it through the loadModel path.
    transformersMock.pipeline.mockImplementationOnce(async () => async () => ({ text: '' }));
    await plugin.loadSettings();
    jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
    await plugin.loadModel();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cache check error'), expect.any(Error));
    logSpy.mockRestore();
  });
});
