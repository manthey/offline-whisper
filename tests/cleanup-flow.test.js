const { App } = require('obsidian-test-mocks/obsidian');
const transformersMock = require('@huggingface/transformers');
const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

const SAMPLE_RATE = 16000;

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

function makeEditor() {
  const inserted = [];
  return {
    inserted,
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: (text) => inserted.push(text),
    setCursor: () => {},
  };
}

function makeFakeCleaner(reply) {
  return {
    modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    isReady: () => true,
    clean: typeof reply === 'function' ? reply : jest.fn(() => reply),
  };
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

describe('transcription text cleanup', () => {
  let plugin;
  let logSpy;

  beforeEach(() => {
    ({ plugin } = createPlugin());
    logSpy = silenceLogs();
    transformersMock.pipeline.calls = [];
    transformersMock.pipeline.generateCalls = [];
    transformersMock.pipeline.failNext = null;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('is off by default and passes text through unchanged', async () => {
    expect(plugin.settings.cleanupText).toBe(false);
    await expect(plugin.cleanTranscription('raw text', 1)).resolves.toBe('raw text');
    expect(transformersMock.pipeline.calls.filter((call) => call.task === 'text-generation')).toHaveLength(0);
  });

  test('returns text unchanged for empty input even when enabled', async () => {
    plugin.settings.cleanupText = true;
    plugin.textCleaner = makeFakeCleaner('cleaned');
    await expect(plugin.cleanTranscription('   ', 1)).resolves.toBe('   ');
    expect(plugin.textCleaner.clean).not.toHaveBeenCalled();
  });

  test('cleans text when the cleaner is ready', async () => {
    plugin.settings.cleanupText = true;
    const cleaner = makeFakeCleaner('Cleaned text');
    plugin.textCleaner = cleaner;
    await expect(plugin.cleanTranscription('raw text', 1)).resolves.toBe('Cleaned text');
    expect(cleaner.clean).toHaveBeenCalledWith('raw text', '');
  });

  test('falls back to raw text when the cleaner fails', async () => {
    plugin.settings.cleanupText = true;
    plugin.textCleaner = makeFakeCleaner(() => {
      throw new Error('model exploded');
    });
    await expect(plugin.cleanTranscription('raw text', 1)).resolves.toBe('raw text');
  });

  test('cleanup is not supported on mobile, even with a stale enabled setting', async () => {
    plugin.settings.cleanupText = true;
    await expect(plugin.loadCleanupModel()).resolves.toBe(false);
    expect(transformersMock.pipeline.calls.filter((call) => call.task === 'text-generation')).toHaveLength(0);
  });

  test('inserts cleaned text into the editor', async () => {
    plugin.settings.cleanupText = true;
    plugin.textCleaner = makeFakeCleaner('Cleaned text');
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'raw text' }));
    plugin.targetEditor = makeEditor();
    await plugin.transcribeAudioData(new Float32Array(100), 1);
    expect(plugin.targetEditor.inserted).toEqual(['Cleaned text ']);
  });

  test('inserts raw text when cleanup fails during transcription', async () => {
    plugin.settings.cleanupText = true;
    plugin.textCleaner = makeFakeCleaner(() => {
      throw new Error('model exploded');
    });
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'raw text' }));
    plugin.targetEditor = makeEditor();
    await plugin.transcribeAudioData(new Float32Array(100), 1);
    expect(plugin.targetEditor.inserted).toEqual(['raw text ']);
  });

  test('passes the previous raw chunk as cleanup context', async () => {
    plugin.settings.cleanupText = true;
    const cleaned = [];
    plugin.textCleaner = {
      modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
      isReady: () => true,
      clean: jest.fn((_text, previous) => {
        cleaned.push(previous);
        return 'cleaned';
      }),
    };
    plugin.transcriber = jest.fn((audioData) =>
      Promise.resolve({ text: audioData[0] === 1 ? 'first chunk' : 'second chunk' }),
    );
    plugin.targetEditor = makeEditor();
    const first = new Float32Array(100);
    first[0] = 1;
    await plugin.transcribeAudioData(first, 1);
    await plugin.transcribeAudioData(new Float32Array(100), 2);
    expect(cleaned).toEqual(['', 'first chunk']);
  });

  test('transcribePreparedAudio records the raw text as context', async () => {
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: '  raw words  ' }));
    await plugin.transcribePreparedAudio(new Float32Array(100), 1);
    expect(plugin.previousRawChunkText).toBe('raw words');
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: '   ' }));
    await plugin.transcribePreparedAudio(new Float32Array(100), 2);
    // Empty transcriptions do not clobber the previous context.
    expect(plugin.previousRawChunkText).toBe('raw words');
  });

  test('resetCleanupModel clears the cleaner and the failure flag', () => {
    plugin.textCleaner = makeFakeCleaner('x');
    plugin.cleanupFailed = true;
    plugin.resetCleanupModel();
    expect(plugin.textCleaner).toBe(null);
    expect(plugin.cleanupFailed).toBe(false);
  });

  test('the blob transcription path cleans text before queueing', async () => {
    plugin.settings.cleanupText = true;
    plugin.textCleaner = makeFakeCleaner('Cleaned text');
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'raw text' }));
    plugin.targetEditor = makeEditor();

    const fakeBuffer = new ArrayBuffer(8);
    const fakeAudioBuffer = {
      sampleRate: SAMPLE_RATE,
      duration: 0.1,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(100),
    };
    global.AudioContext = jest.fn(() => ({
      decodeAudioData: jest.fn(() => Promise.resolve(fakeAudioBuffer)),
    }));
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(fakeBuffer);
    };
    try {
      await plugin.transcribeAudio({ arrayBuffer: () => Promise.resolve(fakeBuffer) }, 1);
    } finally {
      delete global.AudioContext;
    }
    expect(plugin.targetEditor.inserted).toEqual(['Cleaned text ']);
  });
});

describe('cleanup settings on mobile', () => {
  let app;
  let plugin;
  let logSpy;

  beforeEach(() => {
    ({ app, plugin } = createPlugin());
    logSpy = silenceLogs();
    return plugin.loadSettings();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('the settings page does not offer cleanup settings on mobile', async () => {
    globalThis._capturedToggles = [];
    globalThis._capturedDropdowns = [];
    const el = document.createElement('div');
    el.empty = () => {
      el.innerHTML = '';
    };
    el.createEl = (tag, attrs) => {
      const child = document.createElement(tag);
      if (attrs && attrs.text) child.textContent = attrs.text;
      el.appendChild(child);
      return child;
    };
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    tab.containerEl = el;
    tab.display();
    expect(globalThis._capturedToggles).toHaveLength(0);
  });
});
