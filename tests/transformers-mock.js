// Mock of @huggingface/transformers for tests. Records pipeline() calls and
// supports injecting a one-shot failure via `pipeline.failNext` so tests can
// exercise fallback paths without network access.
const pipeline = async (task, model, options) => {
  // Record a snapshot: callers may mutate the options object afterwards.
  pipeline.calls.push({ task, model, options: { ...options } });
  if (pipeline.failNext) {
    const error = new Error(pipeline.failNext);
    pipeline.failNext = null;
    throw error;
  }
  return async () => ({ text: '' });
};
pipeline.calls = [];
pipeline.failNext = null;

module.exports = {
  pipeline,
  env: {},
};
