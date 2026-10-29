// Mock of @huggingface/transformers for tests. Records pipeline() calls and
// supports injecting a one-shot failure via `pipeline.failNext` so tests can
// exercise fallback paths without network access. Text-generation pipelines
// (used by the optional text cleanup stage) return a configurable reply.
const pipeline = async (task, model, options) => {
  // Record a snapshot: callers may mutate the options object afterwards.
  pipeline.calls.push({ task, model, options: { ...options } });
  if (pipeline.failNext) {
    const error = new Error(pipeline.failNext);
    pipeline.failNext = null;
    throw error;
  }
  if (task === 'text-generation') {
    return async (messages, kwargs) => {
      pipeline.generateCalls.push({ messages, kwargs });
      const reply =
        pipeline.textReply !== null && pipeline.textReply !== undefined ? pipeline.textReply : 'Cleaned text.';
      if (pipeline.failGenerate) {
        const error = new Error(pipeline.failGenerate);
        pipeline.failGenerate = null;
        throw error;
      }
      return [{ generated_text: [...messages, { role: 'assistant', content: reply }] }];
    };
  }
  return async () => ({ text: '' });
};
pipeline.calls = [];
pipeline.generateCalls = [];
pipeline.failNext = null;
pipeline.failGenerate = null;
pipeline.textReply = null;

module.exports = {
  pipeline,
  env: {},
  StoppingCriteria: class StoppingCriteria {
    constructor() {}
  },
};
