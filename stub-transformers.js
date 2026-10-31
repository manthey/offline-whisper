// Build-time stub substituted for '@huggingface/transformers' in the main
// bundle (see the alias in build.js). The real transformers.js library ships
// only inside the embedded transcription worker bundle; on mobile all
// inference happens there, and on desktop cleanup uses the llama-server
// process. The one main-thread use of a transformers-based class is the
// desktop Clear Cache button, which only clears the model cache directory
// and never initializes a pipeline, so the stub is sufficient for it.
const env = {};

function pipeline() {
  throw new Error('transformers.js is not available outside the transcription worker');
}

class StoppingCriteria {}

module.exports = { pipeline, env, StoppingCriteria };
