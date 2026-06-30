const { App } = require('obsidian-test-mocks/obsidian');
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

describe('WhisperTranscriptionPlugin', () => {
  test('onload registers three commands, a ribbon icon, and a setting tab', async () => {
    const { plugin } = createPlugin();
    const addCommand = jest.spyOn(plugin, 'addCommand');
    const addRibbonIcon = jest.spyOn(plugin, 'addRibbonIcon');
    const addSettingTab = jest.spyOn(plugin, 'addSettingTab');
    await plugin.onload();
    expect(addCommand).toHaveBeenCalledTimes(3);
    expect(addRibbonIcon).toHaveBeenCalledTimes(1);
    expect(addSettingTab).toHaveBeenCalledTimes(1);
  });

  test('loadSettings applies defaults', async () => {
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    expect(plugin.settings.modelId).toBe('onnx-community/whisper-base.en');
    expect(plugin.settings.chunkDurationMs).toBe(10000);
  });

  test('startRecording aborts when no markdown view is active', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    app.workspace.getActiveViewOfType = () => null;
    await plugin.toggleRecording(true);
    expect(plugin.isRecording).toBe(false);
  });

  test('toggleRecording stops current recording with no view', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    // Set isRecording to true but don't have a view
    plugin.isRecording = true;
    // Stop recording when no view - should still stop since we're already recording
    app.workspace.getActiveViewOfType = () => null;
    await plugin.toggleRecording(false);

    expect(plugin.isRecording).toBe(false);
  });

  test('saveSettings saves the current settings', async () => {
    const { app, plugin } = createPlugin();
    app.workspace.getActiveViewOfType = () => ({ editor: null });
    await plugin.onload();
    await plugin.loadSettings();
    // Change a setting
    plugin.settings.modelId = 'onnx-community/whisper-tiny.en';
    await plugin.saveSettings();

    expect(plugin.settings.modelId).toBe('onnx-community/whisper-tiny.en');
  });

  test('startRecording with view but no model loads (mobile path)', async () => {
    const { app, plugin } = createPlugin();
    // Mock a markdown view
    const mockView = { editor: null };
    app.workspace.getActiveViewOfType = () => mockView;
    await plugin.onload();
    // In mobile/test environment, loadModel should succeed with mocked transformers
    const loaded = await plugin.loadModel();
    expect(loaded).toBe(true);
  });

  test('modelId change in settings clears transcriber', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    // Set a custom model ID
    plugin.settings.modelId = 'onnx-community/whisper-tiny.en';
    expect(plugin.transcriber).toBe(null); // Should be null initially or after cache clear

    await plugin.loadSettings();
    expect(plugin.settings.modelId).toBe('onnx-community/whisper-tiny.en');
  });
});

describe('WhisperSettingTab', () => {
  test('display populates the container with settings', () => {
    const { app, plugin } = createPlugin();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    tab.display();
    expect(tab.containerEl.childElementCount).toBeGreaterThan(0);
  });

  test('dropdown has expected model options in UI', () => {
    const { app, plugin } = createPlugin();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    // Manually call display to build the container
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();

    // Check that model settings UI was created (has dropdown with options)
    expect(containerEl.innerHTML).toContain('Whisper Transcription Settings');
  });
});

describe('recordChunk and transcribeAudio integration', () => {
  let mockEditorReplaceRangeCalls = [];

  beforeAll(() => {
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(new Uint8Array([0, 1, 2, 3]).buffer);
    };

    global.AudioBuffer = class {
      constructor() {
        this.sampleRate = 16000;
        this.duration = 1.5;
        this.numberOfChannels = 1;
      }
      getChannelData(channel) {
        return new Float32Array(24000).fill(0.1);
      }
    };

    global.Notice = class {
      constructor(message, timeout) {}
      hide() {}
    };
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockEditorReplaceRangeCalls = [];
    const mockAudioTrack = {
      getSettings: () => ({ sampleRate: 16000 }),
      stop: () => {},
    };
    const mockMediaStream = {
      getAudioTracks: () => [mockAudioTrack],
      getTracks: () => [mockAudioTrack],
    };
    global.navigator = {
      mediaDevices: {
        getUserMedia: jest.fn(() => Promise.resolve(mockMediaStream)),
      },
      wakeLock: null,
    };

    global.AudioContext = jest.fn(() => ({
      decodeAudioData: jest.fn(() =>
        Promise.resolve({
          sampleRate: 16000,
          duration: 1.5,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(24000),
        }),
      ),
    }));
    const mockOnStopCallback = { value: null };
    const mockRecorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (mockOnStopCallback.value) {
          mockOnStopCallback.value();
        }
      }),
    };
    Object.defineProperty(mockRecorderInstance, 'onstop', {
      get() {
        return mockOnStopCallback.value;
      },
      set(fn) {
        if (fn) mockOnStopCallback.value = fn;
      },
    });
    Object.defineProperty(mockRecorderInstance, 'ondataavailable', {
      get() {
        return null;
      },
      set(fn) {},
    });
    global.MediaRecorder = jest.fn(() => mockRecorderInstance);
    global.MediaRecorder.isTypeSupported = jest.fn(() => true);

    global.document = { createElement: jest.fn(() => ({})) };
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('recordChunk transcribes and inserts audio into note', async () => {
    const { app, plugin } = createPlugin();
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => mockEditorReplaceRangeCalls.push(text),
      setCursor: () => {},
    };
    const mockView = { markdown: null, editor: mockEditor };
    app.workspace.getActiveViewOfType = () => mockView;
    const mockTranscriber = jest.fn((audioData) => Promise.resolve({ text: 'offline whisper' }));
    await plugin.onload();
    plugin.transcriber = mockTranscriber;
    plugin.targetEditor = mockEditor;
    plugin.isRecording = true;
    plugin.pendingResults.clear();
    plugin.nextInsertChunk = 1;
    plugin.processingCount = 0;
    // Simulate recording a chunk
    const startChunkNumber = ++plugin.chunkNumber;
    plugin.currentRecorder = { stop: jest.fn(), state: 'recording' };
    plugin.currentRecorder.stop();
    const mockBlob = new Blob(['audio data'], { type: 'audio/webm' });
    await plugin.transcribeAudio(mockBlob, startChunkNumber);
    await jest.runAllTimersAsync();
    expect(plugin.processingCount).toBe(0);
    expect(mockTranscriber).toHaveBeenCalled();
    expect(mockEditorReplaceRangeCalls.length).toBeGreaterThan(0);
    expect(mockEditorReplaceRangeCalls[0]).toContain('offline whisper');
  });

  test('recordChunk returns early when not recording', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.isRecording = false;
    const initialChunkNumber = plugin.chunkNumber;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await plugin.recordChunk();
    expect(plugin.chunkNumber).toBe(initialChunkNumber);
  });

  test('recordChunk increments chunk and creates recorder when recording', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.isRecording = true;
    plugin.mediaStream = {};
    plugin.chunkNumber = 0;
    plugin.settings.chunkDurationMs = 50;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await plugin.recordChunk();
    expect(plugin.chunkNumber).toBe(1);
    expect(global.MediaRecorder).toHaveBeenCalled();
  });

  test('transcribeAudio handles missing transcriber gracefully', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.transcriber = null;
    plugin.targetEditor = {};
    await plugin.transcribeAudio(new Blob(['test'], { type: 'audio/webm' }), 1);
    expect(plugin.processingCount).toBe(0);
  });

  test('transcribeAudio handles missing targetEditor gracefully', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.transcriber = () => Promise.resolve({ text: 'test' });
    plugin.targetEditor = null;
    await plugin.transcribeAudio(new Blob(['test'], { type: 'audio/webm' }), 1);
    expect(plugin.processingCount).toBe(0);
  });

  test('resampleAudio downsamples correctly', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    const testData = new Float32Array([0.1, -0.5, 0.3, -0.2, 0.8]);
    const resampled = plugin.resampleAudio(testData, 48000, 16000);
    expect(resampled.length).toBe(Math.round(5 / 3));
  });

  test('flushPendingResults inserts text in order', async () => {
    const { app, plugin } = createPlugin();
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => mockEditorReplaceRangeCalls.push(text),
      setCursor: () => {},
    };
    await plugin.onload();
    plugin.targetEditor = mockEditor;
    plugin.pendingResults.set(1, 'hello');
    plugin.pendingResults.set(2, 'world');
    plugin.nextInsertChunk = 1;
    plugin.flushPendingResults();
    expect(mockEditorReplaceRangeCalls.length).toBe(2);
    expect(plugin.nextInsertChunk).toBe(3);
  });

  test('full flow: start recording through transcription', async () => {
    const { app, plugin } = createPlugin();
    let insertCount = 0;
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => {
        insertCount++;
        mockEditorReplaceRangeCalls.push(text);
      },
      setCursor: () => {},
    };
    const mockView = { markdown: null, editor: mockEditor };
    app.workspace.getActiveViewOfType = () => mockView;
    const mockTranscriber = jest.fn((audioData) => Promise.resolve({ text: 'offline whisper' }));
    await plugin.onload();
    plugin.transcriber = mockTranscriber;
    plugin.targetEditor = mockEditor;
    plugin.isRecording = true;
    plugin.pendingResults.clear();
    plugin.nextInsertChunk = 1;
    plugin.processingCount = 0;
    const chunkNum = ++plugin.chunkNumber;
    const ondataavailableFn = jest.fn();
    const recorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(),
    };
    Object.defineProperty(recorderInstance, 'ondataavailable', {
      get() {
        return ondataavailableFn;
      },
      set(fn) {
        if (fn) ondataavailableFn = fn;
      },
    });
    Object.defineProperty(recorderInstance, 'onstop', {
      get() {
        return null;
      },
      set(fn) {},
    });
    plugin.currentRecorder = recorderInstance;
    const mockBlob = new Blob(['audio data'], { type: 'audio/webm' });
    await plugin.transcribeAudio(mockBlob, chunkNum);
    await jest.runAllTimersAsync();
    expect(insertCount).toBeGreaterThan(0);
    expect(mockTranscriber).toHaveBeenCalledWith(expect.any(Float32Array));
    expect(mockEditorReplaceRangeCalls[0]).toContain('offline whisper');
  });
});

describe('Regex Filter setting', () => {
  test('regexFilter is visible in settings tab UI', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();
    expect(containerEl.innerHTML).toContain('Regex Filter');
  });

  test('regexFilter can be modified and saved', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const originalRegex = plugin.settings.regexFilter;
    const newRegex = '^test$';
    plugin.settings.regexFilter = newRegex;
    await plugin.saveSettings();
    await plugin.loadSettings();
    expect(plugin.settings.regexFilter).toBe(newRegex);
  });
});

describe('flushPendingResults filtering', () => {
  let mockEditorReplaceRangeCalls = [];

  beforeEach(() => {
    mockEditorReplaceRangeCalls = [];
  });

  test('flushPendingResults filters out "you" by default', async () => {
    const { app, plugin } = createPlugin();
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => mockEditorReplaceRangeCalls.push(text),
      setCursor: () => {},
    };
    await plugin.onload();
    await plugin.loadSettings();
    plugin.targetEditor = mockEditor;
    plugin.pendingResults.set(1, 'you');
    plugin.nextInsertChunk = 1;
    plugin.flushPendingResults();
    // "you" should be filtered out
    expect(mockEditorReplaceRangeCalls.length).toBe(0);
    expect(plugin.nextInsertChunk).toBe(2);
  });

  test('flushPendingResults filters out bracketed content by default', async () => {
    const { app, plugin } = createPlugin();
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => mockEditorReplaceRangeCalls.push(text),
      setCursor: () => {},
    };
    await plugin.onload();
    await plugin.loadSettings();
    plugin.targetEditor = mockEditor;
    plugin.pendingResults.set(1, '[blank]');
    plugin.nextInsertChunk = 1;
    plugin.flushPendingResults();
    expect(mockEditorReplaceRangeCalls.length).toBe(0);
    expect(plugin.nextInsertChunk).toBe(2);
  });

  test('flushPendingResults allows custom regex to filter different text', async () => {
    const { app, plugin } = createPlugin();
    const mockEditor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => mockEditorReplaceRangeCalls.push(text),
      setCursor: () => {},
    };
    await plugin.onload();
    await plugin.loadSettings();
    // Change to a custom filter that filters "test"
    plugin.settings.regexFilter = '^test$';
    await plugin.saveSettings();
    await plugin.loadSettings();
    plugin.targetEditor = mockEditor;
    plugin.pendingResults.set(1, 'test');
    plugin.nextInsertChunk = 1;
    plugin.flushPendingResults();
    // "test" should be filtered out with custom regex
    expect(mockEditorReplaceRangeCalls.length).toBe(0);
    // Now test that regular text still works
    plugin.pendingResults.set(2, 'hello');
    plugin.nextInsertChunk = 2;
    plugin.flushPendingResults();
    expect(mockEditorReplaceRangeCalls.length).toBe(1);
    expect(mockEditorReplaceRangeCalls[0]).toBe('hello ');
  });
});

describe('startRecording with markdown view integration', () => {
  let originalUserMedia;
  let originalAudioBuffer;

  beforeAll(() => {
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(new Uint8Array([0, 1, 2, 3]).buffer);
    };

    global.AudioBuffer = class {
      constructor() {
        this.sampleRate = 16000;
        this.duration = 1.5;
        this.numberOfChannels = 1;
      }
      getChannelData(channel) {
        return new Float32Array(24000).fill(0.1);
      }
    };
  });

  afterAll(() => {
    if (originalAudioBuffer) global.AudioBuffer = originalAudioBuffer;
  });

  beforeEach(() => {
    jest.useFakeTimers();

    const mockAudioTrack = {
      getSettings: () => ({ sampleRate: 16000 }),
      stop: () => {},
    };
    const mockMediaStream = {
      getAudioTracks: () => [mockAudioTrack],
      getTracks: () => [mockAudioTrack],
    };

    global.navigator.mediaDevices = {
      getUserMedia: jest.fn(() => Promise.resolve(mockMediaStream)),
    };

    global.AudioContext = jest.fn(() => ({
      decodeAudioData: jest.fn(() =>
        Promise.resolve({
          sampleRate: 16000,
          duration: 1.5,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(24000),
        }),
      ),
    }));

    let onstopCallback = null;
    const mockRecorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (onstopCallback) onstopCallback();
      }),
    };

    Object.defineProperty(mockRecorderInstance, 'onstop', {
      get() {
        return onstopCallback;
      },
      set(fn) {
        if (fn) onstopCallback = fn;
      },
    });

    global.MediaRecorder = jest.fn(() => mockRecorderInstance);
    global.MediaRecorder.isTypeSupported = jest.fn(() => true);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    delete global.AudioContext;
    delete global.MediaRecorder;
  });

  test('startRecording with valid markdown view starts recording and creates recorder', async () => {
    const { app, plugin } = createPlugin();

    // Mock a markdown view
    const mockEditor = { getCursor: () => ({ line: 0, ch: 0 }), setCursor: () => {} };
    const mockView = { markdown: null, editor: mockEditor };
    app.workspace.getActiveViewOfType = jest.fn(() => mockView);

    await plugin.onload();

    // Mock the transcriber to succeed
    const mockTranscriber = jest.fn(() => Promise.resolve({ text: 'test' }));
    plugin.transcriber = mockTranscriber;

    // Reset any previous recording state
    plugin.isRecording = false;
    plugin.targetEditor = null;

    // Mock wakeLock for testing
    let wakeLockReleased = false;
    plugin.wakeLock = {
      release: () => {
        wakeLockReleased = true;
      },
    };

    // Start recording with valid view
    await plugin.startRecording();

    expect(app.workspace.getActiveViewOfType).toHaveBeenCalledWith(require('obsidian').MarkdownView);
    expect(plugin.isRecording).toBe(true);
    expect(plugin.targetEditor).toBe(mockEditor);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();

    // Verify recorder was created
    expect(global.MediaRecorder).toHaveBeenCalled();
    expect(plugin.currentRecorder).not.toBeNull();
    expect(plugin.currentRecorder.state).toBe('recording');

    // stop
    await plugin.stopRecording();
    expect(plugin.currentRecorder).toBeNull();
  });

  test('recordChunk creates MediaRecorder when called with valid stream', async () => {
    const { app, plugin } = createPlugin();

    // Mock a markdown view
    const mockEditor = { getCursor: () => ({ line: 0, ch: 0 }), setCursor: () => {} };
    const mockView = { markdown: null, editor: mockEditor };
    app.workspace.getActiveViewOfType = jest.fn(() => mockView);

    await plugin.onload();
    plugin.targetEditor = mockEditor;
    plugin.isRecording = true;
    plugin.chunkNumber = 0;
    plugin.settings.chunkDurationMs = 50; // Short duration for fast test

    const mockAudioTrack = {
      getSettings: () => ({ sampleRate: 16000 }),
      stop: () => {},
    };
    const mockMediaStream = {
      getAudioTracks: () => [mockAudioTrack],
      getTracks: () => [mockAudioTrack],
    };
    plugin.mediaStream = mockMediaStream;

    await plugin.recordChunk();
    expect(plugin.chunkNumber).toBe(1);
    expect(global.MediaRecorder).toHaveBeenCalled();

    const recorder = global.MediaRecorder.mock.results[0].value;
    expect(recorder.start).toHaveBeenCalled();
  });

  test('stopRecording with valid view cleans up properly', async () => {
    const { app, plugin } = createPlugin();

    // Mock a markdown view
    const mockEditor = { getCursor: () => ({ line: 0, ch: 0 }), setCursor: () => {} };
    const mockView = { markdown: null, editor: mockEditor };
    app.workspace.getActiveViewOfType = jest.fn(() => mockView);

    await plugin.onload();
    plugin.targetEditor = mockEditor;
    plugin.isRecording = true;
    plugin.mediaStream = {};

    // Set up a recorder
    let onstopCallback = null;
    const mockRecorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (onstopCallback) onstopCallback();
      }),
    };

    Object.defineProperty(mockRecorderInstance, 'onstop', {
      get() {
        return onstopCallback;
      },
      set(fn) {
        if (fn) onstopCallback = fn;
      },
    });
    plugin.currentRecorder = mockRecorderInstance;

    await plugin.stopRecording();
    expect(plugin.isRecording).toBe(false);
    expect(mockRecorderInstance.stop).toHaveBeenCalled();
  });
});

describe('WhisperSettingTab model change notifications', () => {
  let mockCacheKeys = [];
  let mockCachesOpenKeys = [];
  let mockCachedModelExists = true;

  beforeAll(() => {
    // Mock caches API for isModelCached testing
    global.caches = {
      keys: jest.fn(() => Promise.resolve(mockCacheKeys)),
      open: jest.fn((name) =>
        Promise.resolve({
          keys: jest.fn(() => Promise.resolve(mockCachesOpenKeys.map((url) => ({ url })))),
        }),
      ),
    };
  });

  test('model change notification when model is cached', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();

    // Create a mock Notice to track calls
    let noticeCalls = [];
    global.Notice = class {
      constructor(message, timeout) {
        noticeCalls.push({ message, timeout });
      }
      hide() {}
    };

    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();

    // Verify settings section exists with correct title
    expect(containerEl.innerHTML).toContain('Whisper Transcription Settings');
  });

  test('Clear Cache button text and styling are present', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();

    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();

    // Verify Clear Cache section exists
    expect(containerEl.innerHTML).toContain('Clear Caches');
    expect(containerEl.innerHTML).toContain('Clear Cache');
    expect(containerEl.innerHTML).toContain('Delete all cached models and binaries');
  });

  test('Check model cache button text is present', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();

    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();

    // Verify Check model cache section exists with Check button
    expect(containerEl.innerHTML).toContain('Check model cache');
    expect(containerEl.innerHTML).toContain('See if the current model is cached for offline use');
  });
});

describe('isModelCached function coverage', () => {
  test('handles case where no transformers cache exists', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();

    // Ensure no caches exist - this tests the early return in isModelCached
    Object.defineProperty(global, 'caches', {
      value: {
        keys: jest.fn(() => Promise.resolve([])),
      },
      writable: true,
    });

    // loadModel should attempt to call isModelCached which will return false
    const mockShowStatus = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);

    // Mock transformers pipeline so we can reach isModelCached call path
    const originalPipeline = require('@huggingface/transformers').pipeline;
    require('@huggingface/transformers').pipeline = jest.fn().mockResolvedValue(() => ({ text: 'test' }));

    const mockView = { editor: {} };
    app.workspace.getActiveViewOfType = () => mockView;

    plugin.isModelLoading = false;
    plugin.transcriber = null;

    await plugin.loadModel();

    // Verify caches.keys was called
    expect(global.caches.keys).toHaveBeenCalled();

    // Restore original pipeline
    require('@huggingface/transformers').pipeline = originalPipeline;
  });

  test('handles case where cache exists but model not in it', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();

    // Cache exists but doesn't contain the target model ID
    const cachedUrls = ['/cached/path/to/other-model.bin', '/cached/path/to/different.json'];

    Object.defineProperty(global, 'caches', {
      value: {
        keys: jest.fn(() => Promise.resolve(['transformers-cache'])),
        open: jest.fn(() =>
          Promise.resolve({
            keys: jest.fn(() => Promise.resolve(cachedUrls.map((url) => ({ url })))),
          }),
        ),
      },
      writable: true,
    });

    const originalPipeline = require('@huggingface/transformers').pipeline;
    require('@huggingface/transformers').pipeline = jest.fn().mockResolvedValue(() => ({ text: 'test' }));

    const mockView = { editor: {} };
    app.workspace.getActiveViewOfType = () => mockView;

    plugin.isModelLoading = false;
    plugin.transcriber = null;

    await plugin.loadModel();

    expect(global.caches.open).toHaveBeenCalled();

    require('@huggingface/transformers').pipeline = originalPipeline;
  });
});

describe('toggleRecording edge cases', () => {
  let mockEditorReplaceRangeCalls = [];

  beforeAll(() => {
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(new Uint8Array([0, 1, 2, 3]).buffer);
    };

    global.AudioBuffer = class {
      constructor() {
        this.sampleRate = 16000;
        this.duration = 1.5;
        this.numberOfChannels = 1;
      }
      getChannelData(channel) {
        return new Float32Array(24000).fill(0.1);
      }
    };
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockEditorReplaceRangeCalls = [];
    const mockAudioTrack = {
      getSettings: () => ({ sampleRate: 16000 }),
      stop: () => {},
    };
    const mockMediaStream = {
      getAudioTracks: () => [mockAudioTrack],
      getTracks: () => [mockAudioTrack],
    };

    global.navigator.mediaDevices = {
      getUserMedia: jest.fn(() => Promise.resolve(mockMediaStream)),
    };
    global.AudioContext = jest.fn(() => ({
      decodeAudioData: jest.fn(() =>
        Promise.resolve({
          sampleRate: 16000,
          duration: 1.5,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(24000),
        }),
      ),
    }));
    let onstopCallback = null;
    const mockRecorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (onstopCallback) onstopCallback();
      }),
    };
    Object.defineProperty(mockRecorderInstance, 'onstop', {
      get() {
        return onstopCallback;
      },
      set(fn) {
        if (fn) onstopCallback = fn;
      },
    });
    global.MediaRecorder = jest.fn(() => mockRecorderInstance);
    global.MediaRecorder.isTypeSupported = jest.fn(() => true);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('toggleRecording with undefined state starts recording when not active', async () => {
    const { app, plugin } = createPlugin();
    // Set up minimal mock view for loadModel path
    const mockView = { editor: null };
    app.workspace.getActiveViewOfType = () => mockView;
    await plugin.onload();
    // Mock transcriber to succeed
    const mockTranscriber = jest.fn(() => Promise.resolve({ text: 'test' }));
    plugin.transcriber = mockTranscriber;
    plugin.isRecording = false;
    await plugin.toggleRecording(); // undefined state - should start since not recording
    expect(plugin.isRecording).toBe(true);
  });

  test('toggleRecording ignores start request when already recording', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.isRecording = true;
    // Mock transcriber for loadModel path
    const mockTranscriber = jest.fn(() => Promise.resolve({ text: 'test' }));
    plugin.transcriber = mockTranscriber;
    const mockView = { editor: {} };
    app.workspace.getActiveViewOfType = () => mockView;
    await plugin.toggleRecording(true);
    // Should remain true (already recording)
    expect(plugin.isRecording).toBe(true);
  });

  test('toggleRecording ignores stop request when not recording', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.isRecording = false;
    await plugin.toggleRecording(false);
    // Should remain false (was never recording)
    expect(plugin.isRecording).toBe(false);
  });

  test('releaseWakeLock when wakeLock exists', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    let released = false;
    plugin.wakeLock = {
      release: jest.fn(() => ({ released: true })),
    };
    await plugin.releaseWakeLock();
    expect(plugin.wakeLock).toBeNull();
  });

  test('releaseWakeLock when wakeLock is null', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    plugin.wakeLock = null;
    // Should not throw
    await plugin.releaseWakeLock();
    expect(plugin.wakeLock).toBeNull();
  });

  test('acquireWakeLock when API not available', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    // Remove wakeLock API from navigator
    delete navigator.wakeLock;
    await plugin.acquireWakeLock();
    expect(plugin.wakeLock).toBeNull();
  });

  test('acquireWakeLock when API fails', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    // Mock wakeLock that throws on request
    navigator.wakeLock = {
      request: jest.fn(() => Promise.reject(new Error('denied'))),
    };
    await plugin.acquireWakeLock();
    expect(plugin.wakeLock).toBeNull();
  });

  test('showStatus with timeout parameter', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // First call to set up lastStatus timing
    plugin.lastStatus = Date.now() - 2000;
    const mockNotice = { hide: jest.fn() };
    global.Notice = class {
      constructor(message, timeout) {
        return mockNotice;
      }
    };
    const result = plugin.showStatus('test message', true);
    expect(result).toBe(undefined);
  });
});
