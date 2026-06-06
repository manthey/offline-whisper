const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const v8toIstanbul = require('v8-to-istanbul');
const http = require('http');

function parseWavFile(filePath) {
  const buffer = fs.readFileSync(filePath);

  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file format');
  }

  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    }

    if (chunkId === 'data') {
      const dataOffset = offset + 8;
      const bytesPerSample = bitsPerSample / 8;
      const sampleCount = chunkSize / bytesPerSample;
      const samples = [];

      for (let i = 0; i < sampleCount; i++) {
        if (bitsPerSample === 16) {
          const sample = buffer.readInt16LE(dataOffset + i * 2);
          samples.push(sample / 32768);
        }
      }

      return { samples, sampleRate };
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) {
      offset += 1;
    }
  }

  throw new Error('Could not find data chunk in WAV file');
}

function resampleAudio(audioData, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) {
    return audioData;
  }
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = [];
  for (let i = 0; i < newLength; i++) {
    result.push(audioData[Math.floor(i * ratio)]);
  }
  return result;
}

function startServer(rootDir, port) {
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const requestPath = req.url === '/' ? '/test_mobile.html' : req.url;
      const resolved = path.normalize(path.join(rootDir, requestPath));
      if (!resolved.startsWith(rootDir) || !fs.existsSync(resolved)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(resolved);
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(resolved));
    });
    server.listen(port, () => {
      resolve(server);
    });
  });
}

async function runMobileTest() {
  const audioPath = path.join(__dirname, 'test_audio.wav');
  const bundlePath = path.join(__dirname, '..', 'main.js');

  if (!fs.existsSync(audioPath)) {
    throw new Error('Test audio file not found: ' + audioPath);
  }

  console.log('Loading test audio');
  const { samples, sampleRate } = parseWavFile(audioPath);
  const audioData = resampleAudio(samples, sampleRate, 16000);
  console.log('  Loaded ' + audioData.length + ' samples');

  console.log('Starting test server');
  const port = 8765;
  const serveDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'whisper-mobile-'));
  fs.copyFileSync(path.join(__dirname, 'test_mobile.html'), path.join(serveDir, 'test_mobile.html'));
  fs.copyFileSync(path.join(__dirname, 'obsidian-mock.js'), path.join(serveDir, 'obsidian-mock.js'));
  fs.copyFileSync(bundlePath, path.join(serveDir, 'main.js'));
  const server = await startServer(serveDir, port);
  console.log('  Server running on port ' + port);

  let browser;
  try {
    console.log('Launching browser');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.log('  [Browser Error] ' + text);
      } else {
        console.log('  [Browser] ' + text);
      }
    });

    console.log('Loading test page');
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto('http://localhost:' + port, { timeout: 120000 });

    console.log('Waiting for transformers.js to load');
    await page.waitForFunction(() => window.transformersReady === true, { timeout: 300000 });

    console.log('Running transcription in browser');
    const result = await page.evaluate(async (audioSamples) => {
      const audioArray = new Float32Array(audioSamples);
      return await window.runTranscription(audioArray);
    }, Array.from(audioData));

    console.log('  Result: "' + result.text + '"');

    const expectedPhrase = process.env.EXPECTED_PHRASE || 'this is a test';
    const normalizedResult = result.text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const normalizedExpected = expectedPhrase.toLowerCase();

    if (!normalizedResult.includes(normalizedExpected)) {
      throw new Error(
        'Transcription verification failed.\n' +
          '  Expected phrase: "' +
          expectedPhrase +
          '"\n' +
          '  Actual result: "' +
          result.text +
          '"',
      );
    }

    console.log('Mobile test passed.');
    const coverage = await page.coverage.stopJSCoverage();
    const converter = v8toIstanbul(bundlePath);
    for (const entry of coverage) {
      if (entry.url.endsWith('/main.js')) {
        await converter.load();
        converter.applyCoverage(entry.functions);
        break;
      }
    }
    const istanbulCoverage = converter.toIstanbul();
    for (const key of Object.keys(istanbulCoverage)) {
      if (key.includes('desktop-transcriber')) {
        delete istanbulCoverage[key];
      }
    }
    const nycOutput = path.join(process.cwd(), '.nyc_output');
    if (!fs.existsSync(nycOutput)) fs.mkdirSync(nycOutput, { recursive: true });
    fs.writeFileSync(path.join(nycOutput, 'mobile-' + Date.now() + '.json'), JSON.stringify(istanbulCoverage));
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
    fs.rmSync(serveDir, { recursive: true, force: true });
  }
}

runMobileTest().catch((error) => {
  console.error('Mobile test failed: ' + error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
