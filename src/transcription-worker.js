// Web Worker entry point for mobile transcription. Hosts the transformers.js
// automatic-speech-recognition pipeline so that inference runs off the WebView
// main thread: the main thread stays responsive for editing and rendering
// while a chunk is being transcribed.
//
// This file is bundled separately by build.js and embedded in main.js as a
// string; on mobile the plugin instantiates it from a blob URL. When no
// Worker is available (for example in the jest test environment), the host
// runs this module in-process through the same message protocol instead.
//
// This file must not require('obsidian'): the worker bundle is loaded outside
// the plugin context, where no Obsidian module exists.

const transformers = require('@huggingface/transformers');

transformers.env.useBrowserCache = true;
transformers.env.allowLocalModels = false;

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[WhisperWorker ${timestamp}] ${message}`, data);
  } else {
    console.log(`[WhisperWorker ${timestamp}] ${message}`);
  }
}

// Per-instance worker state. A real worker is a fresh instance with its own
// pipeline; the in-process fallback creates one api per host for the same
// isolation.
function createWorkerApi() {
  // The ASR pipeline. A load request replaces any previous pipeline: a
  // settings change (model or compute device) reloads through the same
  // protocol.
  let asrPipeline = null;
  let loadedModelId = null;

  // GPU acceleration uses WebGPU when the environment provides it; any
  // failure (unsupported browser, driver issues, out of memory) falls back to
  // the CPU (WASM) path automatically. Mirrors the behavior the main thread
  // had before transcription moved into the worker.
  async function createAsrPipeline(modelId, useWebGpu, emitProgress) {
    const pipelineOptions = {
      dtype: {
        encoder_model: 'fp32',
        decoder_model_merged: 'q4',
      },
      progress_callback: (progress) => emitProgress(progress),
    };
    if (useWebGpu && typeof navigator !== 'undefined' && !!navigator.gpu) {
      pipelineOptions.device = 'webgpu';
      log('Requesting WebGPU for transcription');
    }
    try {
      return await transformers.pipeline('automatic-speech-recognition', modelId, pipelineOptions);
    } catch (error) {
      if (!pipelineOptions.device) {
        throw error;
      }
      log('WebGPU pipeline failed; falling back to WASM', error);
      delete pipelineOptions.device;
      return await transformers.pipeline('automatic-speech-recognition', modelId, pipelineOptions);
    }
  }

  // Requests are handled one at a time, in arrival order. This mirrors how a
  // worker processes queued messages and keeps a slow transcription from
  // interleaving with a load of a different model.
  let handlerChain = Promise.resolve();

  function serialize(task) {
    const run = () => task();
    handlerChain = handlerChain.then(run, run);
    return handlerChain;
  }

  const handlers = {
    async load(payload, emitProgress) {
      const pipeline = await createAsrPipeline(payload.modelId, payload.useWebGpu, emitProgress);
      asrPipeline = pipeline;
      loadedModelId = payload.modelId;
      log(`Model loaded: ${payload.modelId}`);
      return { modelId: payload.modelId };
    },

    async transcribe(payload) {
      if (!asrPipeline) {
        throw new Error('Transcription model is not loaded');
      }
      const result = await asrPipeline(payload.audio);
      if (loadedModelId) {
        log(`Transcribed ${payload.audio.length} samples`);
      }
      return { text: result && result.text ? result.text : '' };
    },
  };

  // Handle one host request. Every reply carries the request id so the host
  // can route it; progress events may arrive any number of times before the
  // final result or error.
  function handleMessage(message, post) {
    return serialize(async () => {
      const handler = handlers[message.type];
      if (!handler) {
        post({ id: message.id, type: 'error', payload: { message: `Unknown request type: ${message.type}` } });
        return;
      }
      try {
        const payload = await handler(message.payload, (progress) =>
          post({ id: message.id, type: 'progress', payload: progress }),
        );
        post({ id: message.id, type: 'result', payload });
      } catch (error) {
        log(`Request ${message.type} FAILED`, error);
        post({
          id: message.id,
          type: 'error',
          payload: { message: error && error.message ? error.message : String(error) },
        });
      }
    });
  }

  return { handleMessage };
}

// Detect a real worker environment: the bundled IIFE runs inside a
// WorkerGlobalScope, while the in-process test mode runs in a normal
// JavaScript context (where self is the window and WorkerGlobalScope does not
// exist).
const runningAsWorker =
  typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

if (runningAsWorker) {
  const api = createWorkerApi();
  self.onmessage = (event) => {
    api.handleMessage(event.data, (reply) => self.postMessage(reply));
  };
}

// Exposed for the host's in-process fallback (test environments without
// Worker): each host creates its own api instance, giving it the same state
// isolation a real worker process would have.
module.exports = { createWorkerApi };
