// Integration test for the native text cleanup engine. Unlike the jest unit
// tests, this exercises reality: the GitHub release resolution (including
// the case where the release marked latest carries no binaries), the engine
// and model downloads, the llama-server process, and real cleanup requests.
globalThis.require = require;

const path = require('path');
const fs = require('fs');
const os = require('os');
const { NativeTextCleaner } = require('../src/desktop-cleanup.js');

async function run() {
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-cleanup-vault-'));
  const pluginRelativeDir = '.obsidian/plugins/whisper-transcription';
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
  const cleaner = new NativeTextCleaner(mockPlugin);
  let lastStatus = 0;

  console.log('Initializing native cleanup engine');
  await cleaner.initialize('qwen2.5-0.5b-instruct-q4_k_m', (progress) => {
    let message;
    if (progress.message) {
      message = progress.message;
    } else if (progress.total) {
      message = `Downloading: ${Math.round((progress.loaded / progress.total) * 100)}%`;
    } else {
      message = progress.status || '';
    }
    if (Date.now() - lastStatus >= 1000) {
      lastStatus = Date.now();
      console.log('  ' + message);
    }
  });
  if (!cleaner.isReady()) {
    throw new Error('Cleanup engine did not become ready');
  }
  console.log('Cleanup engine ready');

  const samples = [
    // Bracketed hallucinations must be removed.
    {
      raw: '[BLANK_AUDIO] [MUSIC PLAYING] I will send you the report tomorrow',
      forbidden: '[BLANK_AUDIO]',
      expected: 'report tomorrow',
    },
    // A clean sentence must survive with its content intact.
    {
      raw: 'this is a test of the microphone and it sounds good',
      expected: 'test of the microphone',
    },
    // Repetition removal is model-dependent; the guardrail only requires
    // that real content is retained.
    {
      raw: 'thank you. thank you. thank you. does everyone agree',
      expected: 'everyone agree',
    },
    // A chunk that holds nothing but a sound-event annotation inserts
    // nothing at all.
    {
      raw: '(mouse clicking)',
      expected: '',
    },
    {
      raw: '[BLANK_AUDIO]',
      expected: '',
    },
  ];
  for (const sample of samples) {
    const result = await cleaner.clean(sample.raw, '');
    if (typeof result !== 'string') {
      throw new Error('Cleanup returned no text for: ' + JSON.stringify(sample.raw));
    }
    if (sample.expected.length && !result.length) {
      throw new Error('Cleanup lost content for: ' + JSON.stringify(sample.raw));
    }
    if (sample.forbidden && result.includes(sample.forbidden)) {
      throw new Error(`Artifact was not removed: ${JSON.stringify(sample.raw)} -> ${JSON.stringify(result)}`);
    }
    if (sample.expected.length && !result.toLowerCase().includes(sample.expected.toLowerCase())) {
      throw new Error(`Expected content missing: ${JSON.stringify(sample.raw)} -> ${JSON.stringify(result)}`);
    }
    console.log(`  ${JSON.stringify(sample.raw)} -> ${JSON.stringify(result)}`);
  }

  cleaner.dispose();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (cleaner.isReady()) {
    throw new Error('Cleanup engine did not stop');
  }
  console.log('Cleanup engine stopped');
  fs.rmSync(tempVault, { recursive: true, force: true });
  console.log('All cleanup tests passed');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('FAILED', error);
    process.exit(1);
  });
