// Optional cleanup of transcribed text with a small local language model.
// The model is downloaded from Hugging Face on first use and then runs
// entirely offline through transformers.js, which works on both desktop
// (Electron renderer) and mobile (WebView) platforms.

const CLEANUP_SYSTEM_PROMPT =
  'You clean up raw transcripts from an automatic speech-to-text system. The ' +
  'transcript may be in any language; reply in the language of the segment. ' +
  'Fix capitalization and punctuation. Remove transcription artifacts: ' +
  'repeated words or phrases, meaningless stray words, filler sounds such as ' +
  '"um" or their equivalents in any language, and sound-event annotations in ' +
  'brackets or parentheses such as [BLANK_AUDIO], [Music], or (mouse ' +
  'clicking). Keep the wording and meaning of the real content exactly as ' +
  'spoken; do not add, remove, or rephrase real content. If the segment ' +
  'contains only artifacts and no real content, reply with an empty cleaned ' +
  'text. Reply with only a JSON object: {"cleaned": "<the cleaned transcript ' +
  'text>"}. No commentary, no markdown fences, no text outside the JSON ' +
  'object.';

// Sound-event annotations that speech-to-text systems emit during silence
// or noise, for example [BLANK_AUDIO], [Music], or (mouse clicking).
const ARTIFACT_SEGMENT_PATTERN = /\[[^\]]*\]|\([^)]*\)/g;

// Remove sound-event annotations and collapse the whitespace they leave.
function removeArtifacts(text) {
  return (text || '').replace(ARTIFACT_SEGMENT_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

// Models offered for cleanup, as [modelId, label] pairs. All are small
// instruct-tuned models exported to ONNX for transformers.js.
const CLEANUP_MODELS = [
  ['onnx-community/Qwen2.5-0.5B-Instruct', 'Qwen 2.5 0.5B (smaller, faster)'],
  ['onnx-community/Qwen2.5-1.5B-Instruct', 'Qwen 2.5 1.5B (more accurate, slower)'],
];
const DEFAULT_CLEANUP_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[WhisperCleanup ${timestamp}] ${message}`, data);
  } else {
    console.log(`[WhisperCleanup ${timestamp}] ${message}`);
  }
}

// Cleanup runs through transformers.js on both platforms, but only the
// desktop (Electron renderer) path uses a file-system-backed cache. On
// mobile, models are cached in the browser Cache API, as they already are
// for the transcription models.
function isDesktopEnvironment() {
  return typeof process !== 'undefined' && process.versions && !!process.versions.electron;
}

// Allow tests to force the desktop cache path without an Electron process.
function resolveUseDesktopCache(explicit) {
  if (explicit === true || explicit === false) {
    return explicit;
  }
  return isDesktopEnvironment();
}

const CLEANUP_TIMEOUT_MS = 30000;

// Lazily created once transformers.js is loaded; it subclasses the
// library's StoppingCriteria, which is not available at bundle-eval time.
let DeadlineCriteria = null;

// Prefer WebGPU when the environment provides it: it is roughly an order of
// magnitude faster than the WASM CPU backend for this workload, on both
// desktop and mobile. Callers fall back to WASM when WebGPU fails.
function autoDevice() {
  return typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
}

// Access Node.js modules from the bundled browser build on desktop, using
// the same technique as desktop-transcriber.js.
const nodeRequire = new Function('moduleName', 'return require(moduleName)');

// Load the bundled web build of transformers.js. The Obsidian desktop
// renderer is Electron with Node integration, so `process.release.name` is
// 'node' there; transformers.js selects its ONNX backend at module load
// time and would then try to use onnxruntime-node, which is not bundled
// for the browser build, leaving InferenceSession undefined and breaking
// every model load. Temporarily masking `process.release` around the first
// module load makes it take the browser (WASM) path, which is the correct
// one for the renderer. The module initializes once, so only the first
// load needs the mask.
//
// `process.release` is read-only but configurable, so a plain assignment
// silently does nothing and a property redefinition is required.
function requireTransformers() {
  if (typeof process === 'undefined' || !process.release || process.release.name !== 'node') {
    return require('@huggingface/transformers');
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, 'release');
  if (!descriptor) {
    return require('@huggingface/transformers');
  }
  try {
    Object.defineProperty(process, 'release', {
      value: { ...process.release, name: 'electron' },
      configurable: true,
      writable: true,
    });
    return require('@huggingface/transformers');
  } finally {
    Object.defineProperty(process, 'release', descriptor);
  }
}

// CacheInterface implementation backed by the file system, for desktop use
// where the browser Cache API is unreliable on the app:// origin. Keys are
// flattened into single safe file names so the cache works on every platform.
class DesktopModelCache {
  constructor(dir) {
    this.dir = dir;
    this.fs = nodeRequire('fs');
    this.path = nodeRequire('path');
  }

  // Model cache keys are Hugging Face URLs or relative model paths; flatten
  // them to characters that are valid in file names on every platform.
  static sanitizeKey(key) {
    return key.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  filePath(key) {
    return this.path.join(this.dir, DesktopModelCache.sanitizeKey(key));
  }

  async match(key) {
    const filePath = this.filePath(key);
    let buffer;
    try {
      buffer = this.fs.readFileSync(filePath);
    } catch (error) {
      // A missing file is a normal cache miss; anything else (for example
      // running out of memory while reading a large model) is surfaced so
      // it is not masked by a generic transformers.js error.
      if (error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    // transformers.js distinguishes cached values by `instanceof Response`,
    // so a real Response object is required. Available in the Electron
    // renderer, which is the only place this cache is used.
    return new Response(buffer, {
      status: 200,
      headers: { 'Content-Length': String(buffer.byteLength) },
    });
  }

  async put(key, response, progressCallback) {
    const filePath = this.filePath(key);
    const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const total = parseInt((response.headers && response.headers.get('Content-Length')) || '0', 10);
    let loaded = 0;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      const file = this.fs.openSync(tmpPath, 'w');
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          this.fs.writeSync(file, value);
          loaded += value.length;
          if (progressCallback) {
            progressCallback({ progress: total ? (loaded / total) * 100 : 0, loaded, total });
          }
        }
      } finally {
        this.fs.closeSync(file);
      }
      this.fs.renameSync(tmpPath, filePath);
    } catch (error) {
      try {
        this.fs.unlinkSync(tmpPath);
      } catch (cleanupError) {}
      throw error;
    }
  }

  async delete(key) {
    try {
      this.fs.unlinkSync(this.filePath(key));
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Extract the assistant reply from a text-generation pipeline result. Chat
// input produces `[{ generated_text: [...messages, { role: 'assistant', content }] }]`.
function extractReplyText(output) {
  const entry = output && output[0];
  const generated = entry && entry.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return last && typeof last.content === 'string' ? last.content : '';
  }
  return typeof generated === 'string' ? generated : '';
}

// Extract the cleaned text from the structured reply the model is asked
// for: a JSON object like {"cleaned": "..."}. Returns null when the reply
// contains no parseable object with a cleaned field. Prose around the
// object and markdown fences are tolerated; malformed JSON falls back to a
// direct extraction of the field value.
function extractJsonCleaned(reply) {
  if (!reply) {
    return null;
  }
  const withoutFences = reply.replace(/```(?:json)?/g, '');
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  const objectText = withoutFences.slice(start, end + 1);
  try {
    const parsed = JSON.parse(objectText);
    if (parsed && typeof parsed.cleaned === 'string') {
      return parsed.cleaned;
    }
  } catch (error) {
    // Malformed JSON: the reply is unlikely to contain a usable cleaned
    // transcript, so it is discarded.
  }
  return null;
}

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
}

// Fraction of the raw transcription's substantial words that the candidate
// retains. A faithful cleanup keeps (almost) all real words.
// Letter runs with case folded: punctuation, apostrophes, and hyphens do
// not matter, but merged or split words do.
function subwords(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

// The model may delete, reorder, recase, and repunctuate, but it must never
// introduce new material. In particular it must not merge spelled-out
// letters into words ("P i" becoming "pie") or split words, which changes
// what the speaker said. Any letter run in the cleaned text that is absent
// from the raw transcription is a rewrite and disqualifies the reply.
function introducesNewWords(cleaned, rawText) {
  const rawWords = subwords(rawText);
  for (const word of subwords(cleaned)) {
    if (!rawWords.has(word)) {
      return true;
    }
  }
  return false;
}

function overlapScore(candidate, rawText) {
  const raw = wordSet(rawText);
  if (raw.size === 0) {
    return 0;
  }
  const words = wordSet(candidate);
  let hits = 0;
  for (const word of raw) {
    if (word.length >= 3 && words.has(word)) {
      hits++;
    }
  }
  return hits / raw.size;
}

// The reply is trusted only when it plausibly is a cleaned version of the
// input. Anything empty, suspiciously longer than the input, or sharing no
// vocabulary with it falls back to the raw transcription, so a confused
// model can never replace real content with hallucinated text.
function isPlausibleCleanup(reply, rawText) {
  if (!reply || !reply.trim()) {
    return false;
  }
  if (reply.length > rawText.length * 1.5 + 16) {
    log('Cleanup rejected: reply is implausibly longer than the input');
    return false;
  }
  const rawWords = wordSet(rawText);
  if (rawWords.size === 0) {
    return true;
  }
  if (introducesNewWords(reply, rawText)) {
    log('Cleanup rejected: reply introduces words not present in the input');
    return false;
  }
  if (overlapScore(reply, rawText) === 0) {
    log('Cleanup rejected: reply shares no vocabulary with the input');
    return false;
  }
  return true;
}

function buildUserPrompt(previousText, rawText) {
  const previous = (previousText || '').trim();
  const lines = [];
  if (previous) {
    lines.push('The following was transcribed just before this segment, for context only:');
    lines.push(`"""${previous}"""`);
    lines.push('');
  }
  lines.push('Clean the following new transcript segment. Reply with only the JSON object:');
  lines.push(`"""${rawText.trim()}"""`);
  return lines.join('\n');
}

class TextCleaner {
  // plugin: the plugin instance, used on desktop only to locate the vault
  // plugin directory for the file-system cache.
  // options.device: inference device ('webgpu' or 'wasm'); default is
  //   WebGPU when the browser provides it, otherwise WASM.
  // options.dtype: model quantization; default is q4f16 on WebGPU and q4
  //   on WASM. Note transformers.js v4 has no "quantized" dtype: the q8
  //   dtype maps to the model_quantized.onnx file, and requesting the
  //   invalid name silently falls back to fp32.
  // options.maxCleanupMs: generation time budget per chunk; when it runs
  //   out, the raw transcription is inserted rather than stalling the
  //   pipeline.
  // options.useDesktopCache: override desktop cache detection (tests).
  constructor(plugin, options) {
    this.plugin = plugin;
    this.useDesktopCache = resolveUseDesktopCache(options && options.useDesktopCache);
    this.device = (options && options.device) || autoDevice();
    this.dtype = (options && options.dtype) || (this.device === 'webgpu' ? 'q4f16' : 'q4');
    this.maxCleanupMs = (options && options.maxCleanupMs) || CLEANUP_TIMEOUT_MS;
    this.pipeline = null;
    this.modelId = null;
    this.initPromise = null;
  }

  isReady() {
    return !!this.pipeline;
  }

  getCacheDir() {
    const path = nodeRequire('path');
    const vaultPath = this.plugin.app.vault.adapter.basePath;
    return path.join(vaultPath, this.plugin.manifest.dir, 'cleanup-cache');
  }

  // Whether the model files are already cached. Returns null when cache
  // detection is not applicable (mobile callers use the Cache API instead).
  async isCached(modelId) {
    if (!this.useDesktopCache) {
      return null;
    }
    try {
      const fs = nodeRequire('fs');
      const dir = this.getCacheDir();
      if (!fs.existsSync(dir)) {
        return false;
      }
      const token = DesktopModelCache.sanitizeKey(modelId);
      return fs.readdirSync(dir).some((name) => name.includes(token));
    } catch (error) {
      log('Cache check failed', error);
      return false;
    }
  }

  clearCache() {
    if (!this.useDesktopCache) {
      return;
    }
    try {
      const fs = nodeRequire('fs');
      const dir = this.getCacheDir();
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      log('Clearing the cleanup cache failed', error);
    }
  }

  // Load the pipeline, downloading the model if needed. Initialization is
  // memoized so concurrent callers share one load, and a failure clears the
  // memo so a later settings change can retry.
  async initialize(modelId, progressCallback) {
    if (this.pipeline && this.modelId === modelId) {
      return true;
    }
    if (this.initPromise && this.modelId === modelId) {
      return this.initPromise;
    }
    this.modelId = modelId;
    this.pipeline = null;
    this.initPromise = this.doInitialize(modelId, progressCallback);
    this.initPromise.catch(() => {
      if (this.initPromise) {
        this.initPromise = null;
      }
    });
    return this.initPromise;
  }

  async doInitialize(modelId, progressCallback) {
    const transformers = requireTransformers();
    if (!DeadlineCriteria && transformers.StoppingCriteria) {
      // Generation is stopped once the time budget runs out so a slow
      // backend cannot stall the transcription pipeline indefinitely; the
      // truncated reply fails the plausibility check and the raw text is
      // used instead.
      DeadlineCriteria = class extends transformers.StoppingCriteria {
        constructor(startTime, maxMs) {
          super();
          this.startTime = startTime;
          this.maxMs = maxMs;
          this.exceeded = false;
        }

        _call(input_ids) {
          if (!this.exceeded && Date.now() - this.startTime >= this.maxMs) {
            this.exceeded = true;
            log(`Generation exceeded the ${Math.round(this.maxMs / 1000)}s cleanup budget`);
          }
          return input_ids.map(() => this.exceeded);
        }
      };
    }
    if (this.useDesktopCache) {
      const fs = nodeRequire('fs');
      const dir = this.getCacheDir();
      fs.mkdirSync(dir, { recursive: true });
      transformers.env.allowLocalModels = false;
      transformers.env.useCustomCache = true;
      transformers.env.customCache = new DesktopModelCache(dir);
      log(`Using file-system cleanup cache at ${dir}`);
    }
    log(`Loading cleanup model ${modelId} on ${this.device} (${this.dtype})`);
    const options = { dtype: this.dtype, progress_callback: progressCallback };
    if (this.device === 'webgpu') {
      options.device = 'webgpu';
    }
    try {
      this.pipeline = await transformers.pipeline('text-generation', modelId, options);
    } catch (error) {
      if (this.device !== 'webgpu') {
        throw error;
      }
      // WebGPU can be present but unusable (no adapter, driver issues,
      // unsupported fp16); fall back to the WASM CPU backend.
      log('WebGPU cleanup failed; falling back to WASM', error);
      this.device = 'wasm';
      this.dtype = 'q4';
      delete options.device;
      options.dtype = 'q4';
      this.pipeline = await transformers.pipeline('text-generation', modelId, options);
    }
    log('Cleanup model loaded');
    return true;
  }

  // Clean one transcribed chunk. previousText is the raw transcription of
  // the immediately preceding chunk, provided as context so punctuation and
  // capitalization can stay consistent across chunk boundaries. Returns the
  // cleaned text, or the raw text unchanged whenever the result is not
  // trustworthy.
  async clean(rawText, previousText) {
    if (!this.pipeline) {
      throw new Error('Cleanup model is not loaded');
    }
    const trimmed = (rawText || '').trim();
    if (!trimmed) {
      return rawText;
    }
    const words = trimmed.split(/\s+/).length;
    const maxNewTokens = Math.min(256, Math.max(48, Math.ceil(words * 1.5) + 24));
    const messages = [
      { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(previousText, rawText) },
    ];
    log('Cleaning text', { rawText, maxNewTokens, hasContext: !!(previousText && previousText.trim()) });
    const criteria = DeadlineCriteria ? new DeadlineCriteria(Date.now(), this.maxCleanupMs) : null;
    const generateOptions = { max_new_tokens: maxNewTokens, do_sample: false };
    if (criteria) {
      generateOptions.stopping_criteria = criteria;
    }
    const startTime = Date.now();
    const output = await this.pipeline(messages, generateOptions);
    log(`Cleanup generation took ${Date.now() - startTime}ms`);
    if (criteria && criteria.exceeded) {
      log('Cleanup skipped: generation ran out of time');
      return rawText;
    }
    const reply = extractReplyText(output);
    log('Cleanup reply', reply);
    const cleaned = extractJsonCleaned(reply);
    if (cleaned === null) {
      // A reply without the requested JSON object is not a cleaned
      // transcript; discard it rather than trying to salvage free text.
      log('Cleanup rejected: reply contained no valid {"cleaned": ...} JSON');
      return rawText;
    }
    const text = cleaned.trim();
    if (!isPlausibleCleanup(text, rawText)) {
      log('Cleanup rejected: implausible cleaned text');
      return rawText;
    }
    return text;
  }
}

module.exports = {
  TextCleaner,
  removeArtifacts,
  introducesNewWords,
  DesktopModelCache,
  CLEANUP_MODELS,
  DEFAULT_CLEANUP_MODEL_ID,
  CLEANUP_SYSTEM_PROMPT,
  buildUserPrompt,
  extractReplyText,
  extractJsonCleaned,
  overlapScore,
  isPlausibleCleanup,
};
