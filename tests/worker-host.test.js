// Tests for the transcription worker host: the message protocol, request
// routing, progress forwarding, error propagation, and disposal. These run in
// the host's in-process mode (jsdom has no Worker), which drives the real
// transcription-worker module through the same protocol a real worker uses.

// The in-process fallback resolves the worker module dynamically, so require
// must be reachable from Function-created code (see worker-host.js).
globalThis.require = require;

const { MobileTranscriberHost } = require('../src/worker-host.js');
const transformersMock = require('@huggingface/transformers');

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

describe('MobileTranscriberHost (in-process protocol)', () => {
  beforeEach(() => {
    transformersMock.pipeline.calls.length = 0;
    transformersMock.pipeline.failNext = null;
    delete navigator.gpu;
  });

  test('load resolves and forwards the model id to the pipeline', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    await expect(host.load('onnx-community/whisper-base.en', false)).resolves.toEqual({
      modelId: 'onnx-community/whisper-base.en',
    });
    expect(transformersMock.pipeline.calls).toHaveLength(1);
    expect(transformersMock.pipeline.calls[0].model).toBe('onnx-community/whisper-base.en');
    host.dispose();
    logSpy.mockRestore();
  });

  test('load forwards progress events to the caller', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    const events = [];
    await host.load('onnx-community/whisper-base.en', false, (progress) => events.push(progress));
    // Drive the progress callback captured from the pipeline options, the way
    // transformers.js would while downloading and initializing.
    const progressCallback = transformersMock.pipeline.calls[0].options.progress_callback;
    progressCallback({ status: 'progress', loaded: 2 * 1024 * 1024, total: 10 * 1024 * 1024 });
    progressCallback({ status: 'loading' });
    expect(events.map((event) => event.status)).toEqual(['progress', 'loading']);
    host.dispose();
    logSpy.mockRestore();
  });

  test('load requests WebGPU when asked and falls back to WASM on failure', async () => {
    const logSpy = silenceLogs();
    navigator.gpu = {};
    const host = new MobileTranscriberHost();
    await host.load('onnx-community/whisper-base.en', true);
    expect(transformersMock.pipeline.calls[0].options.device).toBe('webgpu');
    expect(transformersMock.pipeline.calls).toHaveLength(1);
    host.dispose();

    transformersMock.pipeline.calls.length = 0;
    transformersMock.pipeline.failNext = 'webgpu failed';
    const host2 = new MobileTranscriberHost();
    await host2.load('onnx-community/whisper-base.en', true);
    expect(transformersMock.pipeline.calls).toHaveLength(2);
    expect(transformersMock.pipeline.calls[0].options.device).toBe('webgpu');
    expect(transformersMock.pipeline.calls[1].options.device).toBeUndefined();
    host2.dispose();
    delete navigator.gpu;
    logSpy.mockRestore();
  });

  test('transcribe returns the pipeline result text', async () => {
    const logSpy = silenceLogs();
    const original = transformersMock.pipeline;
    transformersMock.pipeline = jest.fn(async () => async () => ({ text: ' hello world ' }));
    const host = new MobileTranscriberHost();
    try {
      await host.load('onnx-community/whisper-base.en', false);
      const audio = new Float32Array(1600);
      await expect(host.transcribe(audio)).resolves.toEqual({ text: ' hello world ' });
      expect(transformersMock.pipeline.mock.calls[0][1]).toBe('onnx-community/whisper-base.en');
    } finally {
      transformersMock.pipeline = original;
    }
    host.dispose();
    logSpy.mockRestore();
  });

  test('transcribe fails when no model is loaded', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    await expect(host.transcribe(new Float32Array(16))).rejects.toThrow('not loaded');
    host.dispose();
    logSpy.mockRestore();
  });

  test('a failing load rejects with the underlying message', async () => {
    const logSpy = silenceLogs();
    transformersMock.pipeline.failNext = 'fetch failed: offline';
    const host = new MobileTranscriberHost();
    await expect(host.load('onnx-community/whisper-base.en', false)).rejects.toThrow('fetch failed: offline');
    host.dispose();
    logSpy.mockRestore();
  });

  test('dispose rejects pending requests and stops serving new ones', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    // A pipeline that never resolves keeps the request pending.
    const original = transformersMock.pipeline;
    transformersMock.pipeline = jest.fn(() => new Promise(() => {}));
    try {
      const pendingLoad = host.load('onnx-community/whisper-base.en', false);
      // The request is registered synchronously; disposing now must reject it.
      host.dispose();
      await expect(pendingLoad).rejects.toThrow('disposed');
    } finally {
      transformersMock.pipeline = original;
    }
    await expect(host.transcribe(new Float32Array(16))).rejects.toThrow();
    logSpy.mockRestore();
  });

  test('late progress events reach the most recent progress handler', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    const events = [];
    await host.load('onnx-community/whisper-base.en', false, (progress) => events.push(progress));
    // After the load request settled, the recorded callback is invoked again
    // (the request id is gone) - it should still reach the load's handler.
    const progressCallback = transformersMock.pipeline.calls[0].options.progress_callback;
    progressCallback({ status: 'progress', loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 });
    expect(events.map((event) => event.status)).toEqual(['progress']);
    host.dispose();
    logSpy.mockRestore();
  });

  test('requests are serialized in arrival order', async () => {
    const logSpy = silenceLogs();
    const host = new MobileTranscriberHost();
    const order = [];
    const original = transformersMock.pipeline;
    transformersMock.pipeline = jest.fn(async () => {
      return async (audio) => {
        // Each transcription takes one macrotask: if requests overlapped, the
        // second would finish first and reverse the order.
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('transcribed ' + audio.length);
        return { text: 'chunk' };
      };
    });
    try {
      await host.load('m', false);
      const first = host.transcribe(new Float32Array(10));
      const second = host.transcribe(new Float32Array(20));
      await Promise.all([first, second]);
      expect(order).toEqual(['transcribed 10', 'transcribed 20']);
    } finally {
      transformersMock.pipeline = original;
    }
    host.dispose();
    logSpy.mockRestore();
  });
});
