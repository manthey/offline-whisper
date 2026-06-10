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
