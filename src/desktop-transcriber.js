const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const MODEL_MAP = {
  'Xenova/whisper-tiny.en': 'ggml-tiny.en.bin',
  'Xenova/whisper-base.en': 'ggml-base.en.bin',
  'Xenova/whisper-small.en': 'ggml-small.en.bin',
  'Xenova/whisper-medium.en': 'ggml-medium.en.bin',
  'Xenova/whisper-tiny': 'ggml-tiny.bin',
  'Xenova/whisper-base': 'ggml-base.bin',
  'Xenova/whisper-small': 'ggml-small.bin',
  'Xenova/whisper-medium': 'ggml-medium.bin',
};

const nodeRequire = new Function('moduleName', 'return require(moduleName)');
function getNodeModules() {
  return {
    path: nodeRequire('path'),
    fs: nodeRequire('fs'),
    os: nodeRequire('os'),
    spawn: nodeRequire('child_process').spawn,
    https: nodeRequire('https'),
  };
}

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[WhisperDesktop ${timestamp}] ${message}`, data);
  } else {
    console.log(`[WhisperDesktop ${timestamp}] ${message}`);
  }
}

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  let execNames = ['whisper-cli'];
  let archivePattern = '';

  if (platform === 'win32') {
    execNames = ['whisper-cli.exe'];
    archivePattern = 'whisper-blas-bin-x64.zip';
  } else if (platform === 'darwin') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
    archivePattern = `whisper-bin-${archSuffix}-apple-darwin.zip`;
  } else if (platform === 'linux') {
    archivePattern = 'whisper-bin-x86_64-linux-gnu.zip';
  }

  return { platform, arch, execNames, archivePattern };
}

function downloadFile(url, destPath, progressCallback) {
  const { https, fs } = getNodeModules();
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, { headers: { 'User-Agent': 'ObsidianWhisperPlugin' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          makeRequest(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        const file = fs.createWriteStream(destPath);
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (progressCallback && totalSize) {
            progressCallback(downloadedSize, totalSize);
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    };

    makeRequest(url);
  });
}

async function extractZip(zipPath, destDir, platform) {
  const { spawn } = getNodeModules();
  return new Promise((resolve, reject) => {
    let proc;
    let stdout = '';

    if (platform === 'win32') {
      proc = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`
      ]);
    } else {
      proc = spawn('unzip', ['-o', zipPath, '-d', destDir]);
    }
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Extraction failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

function findExecutable(dir, execNames) {
  const { fs, path } = getNodeModules();
  if (!fs.existsSync(dir)) {
    return null;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findExecutable(fullPath, execNames);
      if (found) return found;
    } else if (entry.isFile()) {
      if (execNames.includes(entry.name)) {
        return fullPath;
      }
    }
  }
  return null;
}

function listDirRecursive(dir, prefix = '') {
  const { fs, path } = getNodeModules();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(relativePath + '/');
      results.push(...listDirRecursive(path.join(dir, entry.name), relativePath));
    } else {
      results.push(relativePath);
    }
  }

  return results;
}

async function getLatestReleaseUrl(archivePattern) {
  const { https } = getNodeModules();
  log('Fetching latest whisper.cpp release info');
  const response = await new Promise((resolve, reject) => {
    let url = 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest';
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, {
        headers: { 'User-Agent': 'ObsidianWhisperPlugin' },
      }, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            makeRequest(res.headers.location);
            return;
          }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }).on('error', reject);
    };
    makeRequest(url);
  });

  if (response.status !== 200) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const releaseInfo = JSON.parse(response.data);
  log('Latest release: ' + releaseInfo.tag_name);

  const asset = releaseInfo.assets.find(a => a.name === archivePattern);

  if (!asset) {
    const availableAssets = releaseInfo.assets.map(a => a.name).join(', ');
    throw new Error(`Could not find ${archivePattern} in release. Available: ${availableAssets}`);
  }

  return asset.browser_download_url;
}

function writeWavFile(filePath, audioData, sampleRate) {
  const { fs } = getNodeModules();
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = audioData.length * 2;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]));
    const intSample = Math.round(sample * 32767);
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

class DesktopTranscriber {
  constructor(plugin) {
    this.plugin = plugin;
    this.whisperPath = null;
    this.modelPath = null;
    this.initialized = false;
  }

  getNodeModules() {
    if (!this.node) {
      this.node = getNodeModules();
    }
    return this.node;
  }

  getPluginDir() {
    const { path } = this.getNodeModules();
    const vaultPath = this.plugin.app.vault.adapter.basePath;
    const pluginDir = this.plugin.manifest.dir;
    return path.join(vaultPath, pluginDir);
  }

  async ensureDir(dir) {
  const { fs } = this.getNodeModules();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async initialize(modelId, progressCallback) {
    const { path, fs } = this.getNodeModules();
    const pluginDir = this.getPluginDir();
    const binDir = path.join(pluginDir, 'bin');
    const modelsDir = path.join(pluginDir, 'models');

    await this.ensureDir(binDir);
    await this.ensureDir(modelsDir);

    const platformInfo = getPlatformInfo();
    this.whisperPath = findExecutable(binDir, platformInfo.execNames);

    if (!this.whisperPath) {
      log('Downloading whisper executable');
      progressCallback({ status: 'downloading', message: 'Downloading whisper executable' });
      await this.downloadExecutable(binDir, platformInfo, progressCallback);
      this.whisperPath = findExecutable(binDir, platformInfo.execNames);
      if (!this.whisperPath) {
        const contents = listDirRecursive(binDir);
        throw new Error('Could not find whisper executable after extraction. Contents: ' + contents.join(', '));
      }
    }
    if (platformInfo.platform !== 'win32') {
      fs.chmodSync(this.whisperPath, 0o755);
    }

    log('Using whisper executable: ' + this.whisperPath);
    const modelFileName = MODEL_MAP[modelId] || 'ggml-base.en.bin';
    this.modelPath = path.join(modelsDir, modelFileName);

    if (!fs.existsSync(this.modelPath)) {
      log('Downloading model: ' + modelFileName);
      progressCallback({ status: 'downloading', message: 'Downloading model: ' + modelFileName });
      await this.downloadModel(modelFileName, progressCallback);
    }

    this.initialized = true;
    progressCallback({ status: 'ready' });
    log('Desktop transcriber initialized');
  }

  async downloadExecutable(binDir, platformInfo, progressCallback) {
    const { path, fs } = this.getNodeModules();
    const url = await getLatestReleaseUrl(platformInfo.archivePattern);
    const zipPath = path.join(binDir, 'whisper.zip');

    log('Downloading from: ' + url);

    await downloadFile(url, zipPath, (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      const mb = (loaded / 1024 / 1024).toFixed(1);
      progressCallback({ status: 'progress', loaded, total, message: `Downloading executable: ${pct}% (${mb}MB)` });
    });

    log('Extracting archive');
    progressCallback({ status: 'extracting', message: 'Extracting' });
    await extractZip(zipPath, binDir, platformInfo.platform);

    try {
      fs.unlinkSync(zipPath);
    } catch (e) {
      log('Failed to delete zip file', e);
    }
  }

  async downloadModel(modelFileName, progressCallback) {
    const url = `${MODEL_BASE_URL}/${modelFileName}`;
    log('Downloading model from: ' + url);

    await downloadFile(url, this.modelPath, (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      const mb = (loaded / 1024 / 1024).toFixed(1);
      progressCallback({ status: 'progress', loaded, total, message: `Downloading model: ${pct}% (${mb}MB)` });
    });

    log('Model downloaded: ' + this.modelPath);
  }

  async transcribe(audioData) {
    const { path, fs, os, spawn } = this.getNodeModules();
    if (!this.initialized) {
      throw new Error('Transcriber not initialized');
    }

    const tempDir = os.tmpdir();
    const tempWavPath = path.join(tempDir, `whisper-${Date.now()}.wav`);

    writeWavFile(tempWavPath, audioData, 16000);
    log('Wrote temp WAV: ' + tempWavPath);

    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.modelPath,
        '-f', tempWavPath,
        '-nt',
        '-np',
      ];

      log('Spawning whisper: ' + this.whisperPath + ' ' + args.join(' '));
      const proc = spawn(this.whisperPath, args);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        try {
          fs.unlinkSync(tempWavPath);
        } catch (e) {
          log('Failed to delete temp file', e);
        }

        if (code === 0) {
          const text = stdout.trim();
          log('Transcription result: ' + text);
          resolve({ text });
        } else {
          log('whisper.cpp failed', { code, stderr });
          reject(new Error(`whisper.cpp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        try {
          fs.unlinkSync(tempWavPath);
        } catch (e) {}
        log('whisper.cpp spawn error', error);
        reject(error);
      });
    });
  }

  isModelCached(modelId) {
    const { path, fs } = this.getNodeModules();
    const pluginDir = this.getPluginDir();
    const modelsDir = path.join(pluginDir, 'models');
    const modelFileName = MODEL_MAP[modelId] || 'ggml-base.en.bin';
    const modelPath = path.join(modelsDir, modelFileName);
    return fs.existsSync(modelPath);
  }

  clearCache() {
    const { path, fs } = this.getNodeModules();
    const pluginDir = this.getPluginDir();
    const modelsDir = path.join(pluginDir, 'models');
    if (fs.existsSync(modelsDir)) {
      fs.rmSync(modelsDir, { recursive: true, force: true });
    }
    const binDir = path.join(pluginDir, 'bin');
    if (fs.existsSync(binDir)) {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }
}

module.exports = { DesktopTranscriber };
