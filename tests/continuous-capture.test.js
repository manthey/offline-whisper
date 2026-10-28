const { App } = require('obsidian-test-mocks/obsidian');
const WhisperTranscriptionPlugin = require('../src/main.js');

const SAMPLE_RATE = 16000;

function makeSamples(seconds, amplitude = 0.3, frequency = 220) {
  const count = Math.round(seconds * SAMPLE_RATE);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  }
  return data;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

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

function createMockAudioContext(sampleRate = SAMPLE_RATE) {
  const processorNode = { onaudioprocess: null, connect: jest.fn(), disconnect: jest.fn() };
  const sourceNode = { connect: jest.fn(), disconnect: jest.fn() };
  const gainNode = { gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() };
  const ctx = {
    sampleRate,
    destination: {},
    createMediaStreamSource: jest.fn(() => sourceNode),
    createScriptProcessor: jest.fn(() => processorNode),
    createGain: jest.fn(() => gainNode),
    close: jest.fn(),
  };
  return { ctx, processorNode, sourceNode, gainNode };
}

function makeMockMediaStream() {
  const track = { getSettings: () => ({ sampleRate: SAMPLE_RATE }), stop: jest.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('continuous capture with silence-aligned chunks', () => {
  let inserted;
  let editor;
  let transcriber;
  let plugin;
  let processorNode;

  beforeEach(async () => {
    inserted = [];
    editor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      replaceRange: (text) => inserted.push(text),
      setCursor: () => {},
    };
    const { plugin: createdPlugin } = createPlugin();
    plugin = createdPlugin;
    await plugin.onload();
    transcriber = jest.fn(async () => ({ text: 'segment text' }));
    plugin.transcriber = transcriber;
    plugin.targetEditor = editor;
    plugin.settings.chunkDurationMs = 1000;
    plugin.pendingResults.clear();
    plugin.nextInsertChunk = 1;
    plugin.processingCount = 0;
    plugin.chunkNumber = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, processorNode: node } = createMockAudioContext();
    processorNode = node;
    global.AudioContext = jest.fn(() => ctx);
    global.window.AudioContext = global.AudioContext;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.AudioContext;
    if (global.window) {
      delete global.window.AudioContext;
    }
  });

  async function startCapture() {
    plugin.mediaStream = makeMockMediaStream();
    plugin.isRecording = true;
    await plugin.startContinuousCapture();
    expect(processorNode.onaudioprocess).toBeInstanceOf(Function);
    return (samples) => processorNode.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  }

  test('cuts chunks at speech pauses and inserts them in order', async () => {
    const feed = await startCapture();
    // speech 0.8s + silence 0.4s: the gap midpoint reaches the 1s minimum,
    // producing a ~1s segment ending mid-silence.
    feed(concat(makeSamples(0.8), silence(0.4)));
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(inserted.length).toBe(1);
    expect(inserted[0]).toContain('segment text');
    // Another speech+silence pass yields the second segment.
    feed(concat(makeSamples(0.8), silence(0.4)));
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(2);
    expect(inserted.length).toBe(2);
    expect(transcriber.mock.calls[0][0]).toBeInstanceOf(Float32Array);
    expect(transcriber.mock.calls[0][0].length).toBe(16000);
  });

  test('sends every chunk to the transcriber, including silent ones', async () => {
    const feed = await startCapture();
    // A full maximum-size stretch of silence is still transcribed.
    feed(silence(3.5));
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(transcriber.mock.calls[0][0].length).toBe(16000 * 3.5);
  });

  test('inserts chunks in order even when transcription completes out of order', async () => {
    const feed = await startCapture();
    let resolveFirst;
    transcriber = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve({ text: 'second text' }));
    plugin.transcriber = transcriber;
    feed(concat(makeSamples(0.8), silence(0.4)));
    feed(concat(makeSamples(0.8), silence(0.4)));
    await settle();
    // The first chunk is still being transcribed; serialization means the
    // second has not started and nothing has been inserted yet.
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(inserted.length).toBe(0);
    resolveFirst({ text: 'first text' });
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(2);
    expect(inserted).toEqual(['first text ', 'second text ']);
  });

  test('a failed chunk does not stall later chunks', async () => {
    const feed = await startCapture();
    transcriber = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve({ text: 'recovered' }));
    plugin.transcriber = transcriber;
    feed(concat(makeSamples(0.8), silence(0.4)));
    feed(concat(makeSamples(0.8), silence(0.4)));
    await settle();
    expect(inserted).toEqual(['recovered ']);
    expect(plugin.processingCount).toBe(0);
  });

  test('uses AudioWorkletNode when available and accumulates small messages', async () => {
    class MockAudioWorkletNode {
      constructor(context, name) {
        this.name = name;
        this.port = { onmessage: null, postMessage: jest.fn() };
        this.connect = jest.fn();
        this.disconnect = jest.fn();
        MockAudioWorkletNode.instances.push(this);
      }
    }
    MockAudioWorkletNode.instances = [];
    const createObjectURL = jest.fn(() => 'blob:mock-worklet');
    const revokeObjectURL = jest.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;
    global.AudioWorkletNode = MockAudioWorkletNode;
    global.window.AudioWorkletNode = MockAudioWorkletNode;
    const { ctx, processorNode: scriptNode } = createMockAudioContext();
    ctx.audioWorklet = { addModule: jest.fn(() => Promise.resolve()) };
    global.AudioContext = jest.fn(() => ctx);
    global.window.AudioContext = global.AudioContext;

    plugin.mediaStream = makeMockMediaStream();
    plugin.isRecording = true;
    await plugin.startContinuousCapture();

    expect(ctx.audioWorklet.addModule).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
    expect(MockAudioWorkletNode.instances.length).toBe(1);
    const workletNode = MockAudioWorkletNode.instances[0];
    expect(workletNode.name).toBe('offline-whisper-capture');
    expect(scriptNode.onaudioprocess).toBeNull();

    // AudioWorkletNode delivers 128-sample messages; four of them (buffered
    // to 4096 samples) make up one segmenter push.
    const speech = makeSamples(0.768); // 12288 samples of speech
    for (let i = 0; i < 12; i++) {
      workletNode.port.onmessage({ data: speech.subarray(i * 1024, (i + 1) * 1024) });
    }
    expect(transcriber).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i++) {
      workletNode.port.onmessage({ data: silence(0.064) }); // 1024 silent samples
    }
    await settle();
    // Buffer is 20480 samples; the silence gap midpoint (16400) passes the
    // 1s minimum and produces a single segment.
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(transcriber.mock.calls[0][0].length).toBe(16400);

    delete global.AudioWorkletNode;
    delete global.window.AudioWorkletNode;
    delete global.URL.createObjectURL;
    delete global.URL.revokeObjectURL;
  });

  test('stopRecording transcribes buffered audio even when silent', async () => {
    const feed = await startCapture();
    feed(silence(0.5));
    await settle();
    plugin.stopRecording();
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(transcriber.mock.calls[0][0].length).toBe(8000);
    expect(plugin.mediaStream).toBeNull();
    expect(plugin.captureActive).toBe(false);
    expect(processorNode.onaudioprocess).toBeNull();
  });

  test('audio processing errors do not break the capture pipeline', async () => {
    const feed = await startCapture();
    plugin.segmenter = null; // force an internal error
    expect(() => feed(makeSamples(0.1))).not.toThrow();
  });

  test('resamples segments when the capture context runs at another rate', async () => {
    const { ctx, processorNode: node48k } = createMockAudioContext(48000);
    global.AudioContext = jest.fn(() => ctx);
    global.window.AudioContext = global.AudioContext;
    plugin.mediaStream = makeMockMediaStream();
    plugin.isRecording = true;
    plugin.startContinuousCapture();
    expect(plugin.captureSampleRate).toBe(48000);
    // Speech 2.4s + silence 0.6s at 48kHz: the gap midpoint (2.7s) passes the
    // 1s minimum and the segment ends there.
    const speech = new Float32Array(Math.round(2.4 * 48000));
    for (let i = 0; i < speech.length; i++) {
      speech[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    }
    const quiet = new Float32Array(Math.round(0.6 * 48000));
    node48k.onaudioprocess({ inputBuffer: { getChannelData: () => concat(speech, quiet) } });
    await settle();
    expect(transcriber).toHaveBeenCalledTimes(1);
    // 48000Hz * 2.7s resampled to 16000Hz => 43200 samples (2.7s).
    expect(transcriber.mock.calls[0][0].length).toBe(43200);
  });
});

describe('startRecording falls back to the chunked recorder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    const track = { getSettings: () => ({ sampleRate: SAMPLE_RATE }), stop: () => {} };
    const mediaStream = { getAudioTracks: () => [track], getTracks: () => [track] };
    global.navigator.mediaDevices = {
      getUserMedia: jest.fn(() => Promise.resolve(mediaStream)),
    };
    global.navigator.wakeLock = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.AudioContext;
    delete global.MediaRecorder;
  });

  test('uses MediaRecorder when continuous capture is unavailable', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    const mockEditor = { getCursor: () => ({ line: 0, ch: 0 }), setCursor: () => {} };
    app.workspace.getActiveViewOfType = () => ({ editor: mockEditor });
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'test' }));
    // An AudioContext without capture methods forces the fallback.
    global.AudioContext = jest.fn(() => ({ decodeAudioData: jest.fn() }));
    global.window.AudioContext = global.AudioContext;

    let onstopCallback = null;
    const mockRecorderInstance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (onstopCallback) {
          onstopCallback();
        }
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
    Object.defineProperty(mockRecorderInstance, 'ondataavailable', {
      get() {
        return null;
      },
      set(fn) {},
    });
    global.MediaRecorder = jest.fn(() => mockRecorderInstance);
    global.MediaRecorder.isTypeSupported = jest.fn(() => true);

    await plugin.startRecording();

    expect(plugin.isRecording).toBe(true);
    expect(global.MediaRecorder).toHaveBeenCalled();
    expect(plugin.currentRecorder).toBe(mockRecorderInstance);
    expect(plugin.captureActive).toBe(false);

    await plugin.stopRecording();
    expect(plugin.currentRecorder).toBeNull();
  });
});
