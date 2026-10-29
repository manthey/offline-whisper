const { App } = require('obsidian-test-mocks/obsidian');
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

function makeMockMediaStream() {
  const track = { getSettings: () => ({ sampleRate: SAMPLE_RATE }), stop: jest.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function makeMockAudioContext(sampleRate = SAMPLE_RATE, overrides = {}) {
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
    ...overrides,
  };
  return { ctx, processorNode, sourceNode, gainNode };
}

// Installs a MediaRecorder mock that produces a fresh instance per chunk.
function installMediaRecorder() {
  const instances = [];
  const ctor = jest.fn(() => {
    const instance = {
      state: 'recording',
      mimeType: 'audio/webm',
      start: jest.fn(),
      stop: jest.fn(() => {
        if (instance.onstop) {
          instance.onstop();
        }
      }),
    };
    instances.push(instance);
    return instance;
  });
  ctor.isTypeSupported = jest.fn(() => true);
  ctor.instances = instances;
  global.MediaRecorder = ctor;
  return ctor;
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

function silence() {
  return new Float32Array(Math.round(0.2 * SAMPLE_RATE));
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeAll(() => {
  // jsdom's Blob lacks a usable arrayBuffer for decode tests.
  Blob.prototype.arrayBuffer = function () {
    return Promise.resolve(new Uint8Array([0, 1, 2, 3]).buffer);
  };
});

describe('recording flow error and branch coverage', () => {
  let app;
  let plugin;
  let logSpy;
  let getUserMedia;
  let mediaStream;

  beforeEach(() => {
    jest.useFakeTimers();
    ({ app, plugin } = createPlugin());
    logSpy = silenceLogs();
    const track = { getSettings: () => ({ sampleRate: SAMPLE_RATE }), stop: jest.fn() };
    mediaStream = { getAudioTracks: () => [track], getTracks: () => [track] };
    getUserMedia = jest.fn(() => Promise.resolve(mediaStream));
    Object.defineProperty(global, 'navigator', {
      value: { mediaDevices: { getUserMedia }, wakeLock: null },
      writable: true,
      configurable: true,
    });
    installMediaRecorder();
    return plugin.onload();
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    delete global.navigator;
    delete global.MediaRecorder;
    delete global.AudioContext;
    if (global.window) {
      delete global.window.AudioContext;
    }
  });

  describe('startRecording', () => {
    test('ignores a start request while already recording', async () => {
      plugin.isRecording = true;
      await plugin.startRecording();
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    test('does not request the microphone when the model fails to load', async () => {
      app.workspace.getActiveViewOfType = () => ({ editor: {} });
      jest.spyOn(plugin, 'loadModel').mockResolvedValue(false);
      await plugin.startRecording();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(plugin.isRecording).toBe(false);
    });

    test('reports microphone failures and stays stopped', async () => {
      app.workspace.getActiveViewOfType = () => ({ editor: {} });
      jest.spyOn(plugin, 'loadModel').mockResolvedValue(true);
      getUserMedia.mockImplementation(() => Promise.reject(new Error('denied')));
      await plugin.startRecording();
      expect(logSpy).toHaveBeenCalledWith('[Notice] Microphone access failed: denied');
      expect(plugin.isRecording).toBe(false);
    });
  });

  describe('recordChunk', () => {
    test('falls back to audio/mp4 when webm is unsupported', () => {
      global.MediaRecorder.isTypeSupported = jest.fn((type) => type === 'audio/mp4');
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.recordChunk();
      expect(global.MediaRecorder).toHaveBeenCalled();
      expect(global.MediaRecorder.mock.calls[0][1]).toEqual({ mimeType: 'audio/mp4' });
    });

    test('uses the recorder default when no preferred type is supported', () => {
      global.MediaRecorder.isTypeSupported = jest.fn(() => false);
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.recordChunk();
      expect(global.MediaRecorder.mock.calls[0][1]).toEqual({});
    });

    test('ondataavailable skips empty audio data', () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.recordChunk();
      const recorder = global.MediaRecorder.instances[0];
      recorder.ondataavailable({ data: null });
      recorder.ondataavailable({ data: { size: 0 } });
      // Only the stopping timeout is scheduled; no blob work is queued. The
      // next test verifies the collected-chunks path; here we simply assert
      // the handler did not throw and the recorder is still active.
      expect(recorder.state).toBe('recording');
    });

    test('onstop without collected chunks does not transcribe', () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'never' }));
      plugin.recordChunk();
      const recorder = global.MediaRecorder.instances[0];
      recorder.onstop();
      // No audio data was collected, so nothing reached the transcriber.
      expect(plugin.transcriber).not.toHaveBeenCalled();
    });

    test('onstop while stopping releases the stream and notices', async () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      const track = plugin.mediaStream.getTracks()[0];
      plugin.recordChunk();
      const recorder = global.MediaRecorder.instances[0];
      plugin.isStopping = true;
      recorder.onstop();
      expect(track.stop).toHaveBeenCalled();
      expect(plugin.mediaStream).toBeNull();
      expect(plugin.isStopping).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('[Notice] Recording stopped');
    });

    test('onstop while recording schedules the next chunk', () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.settings.chunkDurationMs = 1000;
      plugin.recordChunk();
      global.MediaRecorder.instances[0].onstop();
      expect(global.MediaRecorder.instances.length).toBe(2);
    });

    test('onerror is logged without throwing', () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.recordChunk();
      const recorder = global.MediaRecorder.instances[0];
      expect(() => recorder.onerror({ error: new Error('recorder blew up') })).not.toThrow();
    });

    test('the chunk timeout stops a still-recording recorder', async () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.settings.chunkDurationMs = 1000;
      plugin.recordChunk();
      const recorder = global.MediaRecorder.instances[0];
      await jest.advanceTimersByTimeAsync(1000);
      expect(recorder.stop).toHaveBeenCalled();
    });

    test('the chunk timeout ignores an already-stopped recorder', async () => {
      plugin.isRecording = true;
      plugin.mediaStream = makeMockMediaStream();
      plugin.settings.chunkDurationMs = 1000;
      plugin.recordChunk();
      const recorder = globalMediaRecorderInstance();
      function globalMediaRecorderInstance() {
        return global.MediaRecorder.instances[0];
      }
      recorder.state = 'inactive';
      await jest.advanceTimersByTimeAsync(1000);
      expect(recorder.stop).not.toHaveBeenCalled();
    });
  });

  describe('startContinuousCapture', () => {
    test('rejects when AudioContext is unavailable', async () => {
      delete global.AudioContext;
      if (global.window) {
        delete global.window.AudioContext;
      }
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;
      await expect(plugin.startContinuousCapture()).rejects.toThrow('AudioContext is not available');
    });

    test('rejects when the context cannot create a media stream source', async () => {
      const { ctx } = makeMockAudioContext(SAMPLE_RATE, { createMediaStreamSource: undefined });
      global.AudioContext = jest.fn(() => ctx);
      global.window.AudioContext = global.AudioContext;
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;
      await expect(plugin.startContinuousCapture()).rejects.toThrow('Continuous audio capture is not supported');
    });

    test('rejects when no capture node is available', async () => {
      const { ctx } = makeMockAudioContext(SAMPLE_RATE, { createScriptProcessor: undefined });
      global.AudioContext = jest.fn(() => ctx);
      global.window.AudioContext = global.AudioContext;
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;
      await expect(plugin.startContinuousCapture()).rejects.toThrow('No audio capture node available');
    });

    test('falls back to ScriptProcessorNode when the worklet module fails', async () => {
      class MockAudioWorkletNode {
        constructor(context, name) {
          this.name = name;
          this.port = { onmessage: null, postMessage: jest.fn() };
          this.connect = jest.fn();
          this.disconnect = jest.fn();
        }
      }
      global.AudioWorkletNode = MockAudioWorkletNode;
      global.window.AudioWorkletNode = MockAudioWorkletNode;
      global.URL.createObjectURL = jest.fn(() => 'blob:mock-worklet');
      global.URL.revokeObjectURL = jest.fn();
      const { ctx, processorNode } = makeMockAudioContext();
      ctx.audioWorklet = { addModule: jest.fn(() => Promise.reject(new Error('no worklets'))) };
      global.AudioContext = jest.fn(() => ctx);
      global.window.AudioContext = global.AudioContext;
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;

      await plugin.startContinuousCapture();

      expect(ctx.audioWorklet.addModule).toHaveBeenCalled();
      expect(processorNode.onaudioprocess).toBeInstanceOf(Function);
      expect(plugin.captureActive).toBe(true);
      // Restore the environment: jsdom has no object URL factory, so remove
      // the stubs when the originals were absent.
      if (typeof URL.createObjectURL !== 'function' || jest.isMockFunction(URL.createObjectURL)) {
        delete global.URL.createObjectURL;
        delete global.URL.revokeObjectURL;
      }
      delete global.AudioWorkletNode;
      delete global.window.AudioWorkletNode;
    });

    test('teardown survives nodes that throw while disconnecting', () => {
      plugin.audioProcessor = {
        onaudioprocess: null,
        disconnect: jest.fn(() => {
          throw new Error('already gone');
        }),
      };
      plugin.audioSourceNode = {
        disconnect: jest.fn(() => {
          throw new Error('already gone');
        }),
      };
      plugin.audioMuteGain = {
        disconnect: jest.fn(() => {
          throw new Error('already gone');
        }),
      };
      plugin.audioContext = {
        close: jest.fn(() => {
          throw new Error('already closed');
        }),
      };
      plugin.captureActive = true;

      plugin.teardownContinuousCapture();

      expect(plugin.audioProcessor).toBeNull();
      expect(plugin.audioSourceNode).toBeNull();
      expect(plugin.audioMuteGain).toBeNull();
      expect(plugin.audioContext).toBeNull();
      expect(plugin.captureActive).toBe(false);
    });
  });

  describe('audio queue plumbing', () => {
    test('queueAudioInput ignores samples while not recording', () => {
      plugin.isRecording = false;
      plugin.segmenter = { push: jest.fn(() => []) };
      plugin.queueAudioInput(new Float32Array(8000));
      expect(plugin.pendingInput.length).toBe(0);
    });

    test('drainPendingInput with no buffered samples is a no-op', () => {
      plugin.pendingInput = [];
      plugin.pendingInputLength = 0;
      plugin.segmenter = { push: jest.fn(() => []) };
      plugin.drainPendingInput();
      expect(plugin.segmenter.push).not.toHaveBeenCalled();
    });

    test('handleAudioInput ignores samples while not recording', () => {
      plugin.isRecording = false;
      plugin.segmenter = { push: jest.fn(() => []) };
      plugin.handleAudioInput(new Float32Array(100));
      expect(plugin.segmenter.push).not.toHaveBeenCalled();
    });
  });

  describe('transcribeAudioData', () => {
    beforeEach(() => {
      plugin.pendingResults.clear();
      plugin.nextInsertChunk = 1;
      plugin.chunkNumber = 0;
      plugin.processingCount = 0;
      plugin.targetEditor = {
        getCursor: () => ({ line: 0, ch: 0 }),
        replaceRange: jest.fn(),
        setCursor: jest.fn(),
      };
    });

    test('queues an empty result when no transcriber is available', async () => {
      plugin.transcriber = null;
      await plugin.transcribeAudioData(new Float32Array(100), 1);
      expect(plugin.nextInsertChunk).toBe(2);
      expect(plugin.targetEditor.replaceRange).not.toHaveBeenCalled();
    });

    test('queues an empty result when no editor is available', async () => {
      plugin.transcriber = jest.fn();
      plugin.targetEditor = null;
      await plugin.transcribeAudioData(new Float32Array(100), 1);
      expect(plugin.transcriber).not.toHaveBeenCalled();
      expect(plugin.nextInsertChunk).toBe(2);
    });

    test('reports transcription failures and still queues an empty result', async () => {
      plugin.transcriber = jest.fn(() => Promise.reject(new Error('model exploded')));
      plugin.isRecording = true;
      await plugin.transcribeAudioData(new Float32Array(100), 1);
      expect(logSpy).toHaveBeenCalledWith('[Notice] Transcription error: model exploded');
      expect(plugin.nextInsertChunk).toBe(2);
      expect(plugin.processingCount).toBe(0);
    });

    test('shows processing and listening statuses around a successful chunk', async () => {
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'hello there' }));
      plugin.isRecording = true;
      const statusSpy = jest.spyOn(plugin, 'showStatus').mockReturnValue(undefined);
      await plugin.transcribeAudioData(new Float32Array(100), 1);
      expect(statusSpy).toHaveBeenCalledWith('Processing speech');
      expect(statusSpy).toHaveBeenCalledWith('Listening', 2000);
      expect(plugin.targetEditor.replaceRange).toHaveBeenCalledWith('hello there ', { line: 0, ch: 0 });
    });

    test('empty transcriptions advance chunk order without inserting text', async () => {
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: '   ' }));
      await plugin.transcribeAudioData(new Float32Array(100), 1);
      expect(plugin.targetEditor.replaceRange).not.toHaveBeenCalled();
      expect(plugin.nextInsertChunk).toBe(2);
    });
  });

  describe('transcribePreparedAudio', () => {
    test('resolves empty when the transcriber exceeds the 180 second timeout', async () => {
      plugin.transcriber = jest.fn(() => new Promise(() => {}));
      const pending = plugin.transcribePreparedAudio(new Float32Array(100), 1);
      await jest.advanceTimersByTimeAsync(180000);
      await expect(pending).resolves.toBe('');
    });

    test('resolves empty when the transcriber returns no text', async () => {
      plugin.transcriber = jest.fn(() => Promise.resolve(null));
      await expect(plugin.transcribePreparedAudio(new Float32Array(100), 1)).resolves.toBe('');
      plugin.transcriber = jest.fn(() => Promise.resolve({}));
      await expect(plugin.transcribePreparedAudio(new Float32Array(100), 2)).resolves.toBe('');
    });
  });

  describe('transcribeAudio (blob path)', () => {
    beforeEach(() => {
      plugin.pendingResults.clear();
      plugin.nextInsertChunk = 1;
      plugin.chunkNumber = 0;
      plugin.processingCount = 0;
      plugin.targetEditor = {
        getCursor: () => ({ line: 0, ch: 0 }),
        replaceRange: jest.fn(),
        setCursor: jest.fn(),
      };
      global.window.AudioContext = jest.fn(() => ({
        decodeAudioData: jest.fn(() =>
          Promise.resolve({
            sampleRate: SAMPLE_RATE,
            duration: 1,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(SAMPLE_RATE).fill(0.5),
          }),
        ),
      }));
    });

    test('resamples decoded audio recorded at another sample rate', async () => {
      global.window.AudioContext = jest.fn(() => ({
        decodeAudioData: jest.fn(() =>
          Promise.resolve({
            sampleRate: 48000,
            duration: 1,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(48000).fill(0.5),
          }),
        ),
      }));
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'resampled' }));
      const blob = new Blob(['x']);
      await plugin.transcribeAudio(blob, 1);
      expect(plugin.transcriber).toHaveBeenCalled();
      const audio = plugin.transcriber.mock.calls[0][0];
      expect(audio.length).toBe(16000);
      expect(plugin.targetEditor.replaceRange).toHaveBeenCalledWith('resampled ', { line: 0, ch: 0 });
    });

    test('decoding failures queue an empty result and show a notice', async () => {
      global.window.AudioContext = jest.fn(() => ({
        decodeAudioData: jest.fn(() => Promise.reject(new Error('undecodable'))),
      }));
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'never' }));
      await plugin.transcribeAudio(new Blob(['x']), 1);
      expect(logSpy).toHaveBeenCalledWith('[Notice] Transcription error: undecodable');
      expect(plugin.nextInsertChunk).toBe(2);
      expect(plugin.transcriber).not.toHaveBeenCalled();
    });
  });

  describe('flushPendingResults', () => {
    beforeEach(() => {
      plugin.pendingResults.clear();
      plugin.nextInsertChunk = 1;
      plugin.targetEditor = {
        getCursor: () => ({ line: 2, ch: 4 }),
        replaceRange: jest.fn(),
        setCursor: jest.fn(),
      };
    });

    test('falls back to the default filter when the custom regex is invalid', () => {
      plugin.settings.regexFilter = '([unclosed';
      plugin.queueTranscriptionResult('you', 1);
      plugin.queueTranscriptionResult('hello world', 2);
      expect(plugin.targetEditor.replaceRange).toHaveBeenCalledTimes(1);
      expect(plugin.targetEditor.replaceRange).toHaveBeenCalledWith('hello world ', { line: 2, ch: 4 });
      expect(plugin.nextInsertChunk).toBe(3);
    });

    test('handles a null editor without throwing', () => {
      plugin.targetEditor = null;
      expect(() => plugin.queueTranscriptionResult('hello', 1)).not.toThrow();
      expect(plugin.nextInsertChunk).toBe(2);
    });
  });

  describe('stopRecording', () => {
    test('returns early when not recording', () => {
      plugin.stopRecording();
      expect(logSpy).not.toHaveBeenCalledWith('[Notice] Recording stopping');
    });

    test('stops a recording recorder and notices', () => {
      plugin.isRecording = true;
      const recorder = { state: 'recording', stop: jest.fn() };
      plugin.currentRecorder = recorder;
      plugin.stopRecording();
      expect(recorder.stop).toHaveBeenCalled();
      expect(plugin.currentRecorder).toBeNull();
      expect(plugin.isRecording).toBe(false);
      expect(logSpy).toHaveBeenCalledWith('[Notice] Recording stopping');
    });

    test('ignores a recorder that is already inactive', () => {
      plugin.isRecording = true;
      const recorder = { state: 'inactive', stop: jest.fn() };
      plugin.currentRecorder = recorder;
      plugin.stopRecording();
      expect(recorder.stop).not.toHaveBeenCalled();
    });

    test('drains, flushes, and releases the stream when capturing', async () => {
      // Real timers are needed: the transcription chain resolves on promises
      // while the fake timer queue would otherwise stall the settle loop.
      jest.useRealTimers();
      const { ctx, processorNode } = makeMockAudioContext();
      global.AudioContext = jest.fn(() => ctx);
      global.window.AudioContext = global.AudioContext;
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'tail' }));
      plugin.targetEditor = {
        getCursor: () => ({ line: 0, ch: 0 }),
        replaceRange: jest.fn(),
        setCursor: jest.fn(),
      };
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;
      plugin.settings.chunkDurationMs = 1000;
      await plugin.startContinuousCapture();
      processorNode.onaudioprocess({ inputBuffer: { getChannelData: () => silence() } });

      plugin.stopRecording();
      await settle();

      expect(plugin.mediaStream).toBeNull();
      expect(plugin.transcriber).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('[Notice] Recording stopping');
    });
  });

  describe('onunload', () => {
    test('stops recording and releases the transcriber', async () => {
      const { ctx, processorNode } = makeMockAudioContext();
      global.AudioContext = jest.fn(() => ctx);
      global.window.AudioContext = global.AudioContext;
      plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'x' }));
      plugin.mediaStream = makeMockMediaStream();
      plugin.isRecording = true;
      plugin.settings.chunkDurationMs = 1000;
      await plugin.startContinuousCapture();

      plugin.onunload();

      expect(plugin.transcriber).toBeNull();
      expect(plugin.isRecording).toBe(false);
      expect(plugin.captureActive).toBe(false);
      expect(processorNode.onaudioprocess).toBeNull();
    });
  });
});
