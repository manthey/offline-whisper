// Main-thread host for the transcription web worker. Wraps the
// request/response protocol spoken by transcription-worker.js behind the same
// interface the plugin used when the pipeline lived in the page.
//
// The worker source is embedded in main.js at build time (see build.js) and
// instantiated from a blob URL, so the plugin stays a single distributable
// file. When Worker is unavailable (the jest test environment), the host
// instead runs the same worker module in-process through the identical
// message protocol, so tests exercise the real protocol code.

// Access Node's require without letting the bundler follow it: in-process
// mode is a test-environment fallback, and a static require here would pull a
// second copy of transformers.js into the production bundle (the first copy
// already lives inside the embedded worker source).
const dynamicRequire = new Function('moduleName', 'return require(moduleName)');

const WORKER_SOURCE = require('./generated-worker-source.js');

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[WhisperWorkerHost ${timestamp}] ${message}`, data);
  } else {
    console.log(`[WhisperWorkerHost ${timestamp}] ${message}`);
  }
}

class MobileTranscriberHost {
  worker = null;
  workerUrl = null;
  inProcessHandle = null;
  pending = new Map();
  nextRequestId = 1;
  disposed = false;
  // Progress events that arrive after their request has already been settled
  // (or replaced) are still worth surfacing: downloads continue in the worker
  // even if the request that started them timed out. The most recent load
  // request's progress handler receives them.
  progressSink = null;

  // Start the worker, or fall back to running the worker module in-process
  // when Worker is unavailable. An empty embedded source means the bundle was
  // not generated (test environment), which also selects in-process mode.
  ensureStarted() {
    if (this.worker || this.inProcessHandle || this.disposed) {
      return;
    }
    if (typeof Worker !== 'undefined' && WORKER_SOURCE) {
      try {
        this.workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = (event) => this.dispatchFromWorker(event.data);
        this.worker.onerror = (event) => this.onWorkerError(event);
        log('Transcription worker started');
        return;
      } catch (error) {
        log('Starting the transcription worker FAILED', error);
        this.worker = null;
        if (this.workerUrl) {
          URL.revokeObjectURL(this.workerUrl);
          this.workerUrl = null;
        }
      }
    }
    // In-process fallback: same module, same protocol. Each host gets its own
    // api instance, so state is isolated the way separate worker processes
    // would be. Replies are dispatched synchronously: the handler itself is
    // asynchronous, and deterministic reply delivery keeps tests simple.
    // In-process fallback: same module, same protocol. Each host gets its own
    // api instance, so state is isolated the way separate worker processes
    // would be. Replies are dispatched synchronously: the handler itself is
    // asynchronous, and deterministic reply delivery keeps tests simple.
    // __dirname does not exist outside a Node module wrapper (mobile Obsidian
    // evaluates the plugin without one), so it is only read on this path,
    // which production never takes.
    const workerModulePath = typeof __dirname !== 'undefined' ? __dirname + '/transcription-worker.js' : null;
    if (!workerModulePath) {
      throw new Error('The transcription worker is unavailable in this environment');
    }
    const workerModule = dynamicRequire(workerModulePath);
    const api = workerModule.createWorkerApi();
    this.inProcessHandle = (message) => {
      return Promise.resolve().then(() => api.handleMessage(message, (reply) => this.dispatchFromWorker(reply)));
    };
    log('Transcription worker unavailable; running in-process');
  }

  dispatchFromWorker(reply) {
    const entry = reply && reply.id !== undefined ? this.pending.get(reply.id) : null;
    if (!entry) {
      if (reply && reply.type === 'progress' && this.progressSink) {
        this.progressSink(reply.payload);
      }
      return;
    }
    if (reply.type === 'progress') {
      if (entry.onProgress) {
        entry.onProgress(reply.payload);
      }
      return;
    }
    this.pending.delete(reply.id);
    if (reply.type === 'result') {
      entry.resolve(reply.payload);
    } else {
      entry.reject(new Error(reply.payload && reply.payload.message ? reply.payload.message : 'Worker request failed'));
    }
  }

  onWorkerError(event) {
    log('Transcription worker ERROR', event && event.message ? event.message : event);
    this.terminateWorker();
    const error = new Error(event && event.message ? event.message : 'The transcription worker crashed');
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
    // The next request starts a fresh worker.
  }

  terminateWorker() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (error) {}
      this.worker = null;
    }
    if (this.workerUrl) {
      try {
        URL.revokeObjectURL(this.workerUrl);
      } catch (error) {}
      this.workerUrl = null;
    }
  }

  request(type, payload, onProgress) {
    this.ensureStarted();
    const id = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    if (onProgress) {
      this.progressSink = onProgress;
    }
    const message = { id, type, payload };
    if (this.inProcessHandle) {
      this.inProcessHandle(message);
    } else if (this.worker) {
      this.worker.postMessage(message);
    } else {
      this.dispatchFromWorker({ id, type: 'error', payload: { message: 'Transcription worker is not running' } });
    }
    return promise;
  }

  // Load (or reload) the ASR pipeline. Mirrors the old in-page pipeline
  // creation: progress objects are forwarded verbatim, and a WebGPU failure
  // falls back to WASM inside the worker.
  load(modelId, useWebGpu, onProgress) {
    return this.request('load', { modelId, useWebGpu: !!useWebGpu }, onProgress);
  }

  // Transcribe one chunk of 16 kHz mono audio. Resolves with the pipeline's
  // result object ({ text }), matching the previous pipeline interface.
  async transcribe(audioData) {
    return await this.request('transcribe', { audio: audioData });
  }

  dispose() {
    this.disposed = true;
    this.terminateWorker();
    this.inProcessHandle = null;
    const error = new Error('Transcription worker disposed');
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { MobileTranscriberHost };
