globalThis.require = require;

const path = require('path');
const fs = require('fs');
const os = require('os');
const { DesktopTranscriber } = require('../src/desktop-transcriber.js');

const testAudioPath = path.join(__dirname, 'test_audio.wav');
const EXPECTED_PHRASE = 'this is a test';
let lastStatus = 0;

async function run() {
  if (!fs.existsSync(testAudioPath)) {
    console.error('Missing test audio file: ' + testAudioPath);
    process.exit(1);
  }

  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-test-vault-'));
  const pluginRelativeDir = '.obsidian/plugins/whisper-transcription';
  const pluginAbsoluteDir = path.join(tempVault, pluginRelativeDir);
  fs.mkdirSync(pluginAbsoluteDir, { recursive: true });

  const mockPlugin = {
    app: {
      vault: {
        adapter: {
          basePath: tempVault,
        },
      },
    },
    manifest: {
      dir: pluginRelativeDir,
    },
  };

  const modelId = 'Xenova/whisper-tiny.en';
  const transcriber = new DesktopTranscriber(mockPlugin);

  console.log('Initializing desktop transcriber with model: ' + modelId);
  const progressMessages = [];
  await transcriber.initialize(modelId, (progress) => {
    progressMessages.push(progress.message || progress.status);
    if (Date.now() - lastStatus < 1000) {
      return;
    }
    lastStatus = Date.now();
    console.log('  Progress: ' + (progress.message || progress.status));
  });

  console.log('Desktop transcriber initialized');
  console.log('Whisper binary: ' + transcriber.whisperPath);
  console.log('Model path: ' + transcriber.modelPath);

  if (!fs.existsSync(transcriber.whisperPath)) {
    console.error('Whisper binary not found at: ' + transcriber.whisperPath);
    process.exit(1);
  }

  if (!fs.existsSync(transcriber.modelPath)) {
    console.error('Model not found at: ' + transcriber.modelPath);
    process.exit(1);
  }

  const audioData = readWavAsFloat32(testAudioPath);
  console.log('Audio samples: ' + audioData.length + ' (' + (audioData.length / 16000).toFixed(2) + 's)');

  console.log('Transcribing');
  const result = await transcriber.transcribe(audioData);
  console.log('Raw result: ' + JSON.stringify(result));

  const transcribedText = (result.text || '').trim().toLowerCase().replace(/[^a-z\s]/g, '');
  console.log('Transcribed: "' + transcribedText + '"');
  console.log('Expected:    "' + EXPECTED_PHRASE + '"');

  if (!transcribedText.includes(EXPECTED_PHRASE)) {
    console.error('Transcription did not contain expected phrase');
    process.exit(1);
  }

  console.log('PASS: Desktop transcription matched expected phrase');

  // Test cache detection
  const isCached = transcriber.isModelCached(modelId);
  if (!isCached) {
    console.error('isModelCached returned false after download');
    process.exit(1);
  }
  console.log('PASS: Model cache detection works');

  // Test cache clearing
  transcriber.clearCache();
  const isCachedAfterClear = transcriber.isModelCached(modelId);
  if (isCachedAfterClear) {
    console.error('isModelCached returned true after clearCache');
    process.exit(1);
  }
  console.log('PASS: Cache clearing works');

  // Cleanup
  fs.rmSync(tempVault, { recursive: true, force: true });
  console.log('Cleaned up temp vault');
  console.log('All desktop tests passed');
  process.exit(0);
}

function readWavAsFloat32(wavPath) {
  const buffer = fs.readFileSync(wavPath);

  const riffHeader = buffer.toString('ascii', 0, 4);
  if (riffHeader !== 'RIFF') {
    throw new Error('Not a valid WAV file');
  }

  let dataOffset = -1;
  let dataSize = -1;
  let offset = 12;
  let bitsPerSample = 16;
  let numChannels = 1;
  let sampleRate = 16000;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === -1) {
    throw new Error('Could not find data chunk in WAV file');
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const audioData = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample;
    if (bitsPerSample === 16) {
      audioData[i] = buffer.readInt16LE(sampleOffset) / 32768.0;
    } else if (bitsPerSample === 32) {
      audioData[i] = buffer.readFloatLE(sampleOffset);
    }
  }

  console.log('WAV info: ' + sampleRate + 'Hz, ' + numChannels + 'ch, ' + bitsPerSample + 'bit, ' + totalSamples + ' samples');

  return audioData;
}

run().catch((error) => {
  console.error('Test failed with error:', error);
  process.exit(1);
});
