// The cleanup model choices shared by the settings page on every platform.
// Kept free of model-loading code so the settings page does not pull the
// transformers.js bundle into contexts that never load a cleanup model.

// Models offered for cleanup, as [modelId, label] pairs. All are small
// instruct-tuned models exported to ONNX for transformers.js.
const CLEANUP_MODELS = [
  ['onnx-community/Qwen2.5-0.5B-Instruct', 'Qwen 2.5 0.5B (smaller, faster)'],
  ['onnx-community/Qwen2.5-1.5B-Instruct', 'Qwen 2.5 1.5B (more accurate, slower)'],
];
const DEFAULT_CLEANUP_MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

module.exports = { CLEANUP_MODELS, DEFAULT_CLEANUP_MODEL_ID };
