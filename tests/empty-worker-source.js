// Test stand-in for the build-time generated worker source. An empty source
// makes the host select in-process mode, where the real transcription-worker
// module runs through the same message protocol. See jest.config.js.
module.exports = '';
