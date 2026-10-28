const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const MODEL_MAP = {
  'onnx-community/whisper-tiny.en': 'ggml-tiny.en.bin',
  'onnx-community/whisper-base.en': 'ggml-base.en.bin',
  'onnx-community/whisper-small.en': 'ggml-small.en.bin',
  'onnx-community/whisper-medium.en': 'ggml-medium.en.bin',
  'onnx-community/whisper-tiny': 'ggml-tiny.bin',
  'onnx-community/whisper-base': 'ggml-base.bin',
  'onnx-community/whisper-small': 'ggml-small.bin',
  'onnx-community/whisper-medium': 'ggml-medium.bin',
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
  let execNames = ['whisper-cli', 'main'];
  let archivePattern = '';
  let repo = '';
  if (platform === 'win32') {
    execNames = ['whisper-cli.exe'];
    archivePattern = 'whisper-blas-bin-x64.zip';
    repo = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
  } else if (platform === 'darwin') {
    repo = 'https://api.github.com/repos/bizenlabs/whisper-cpp-macos-bin/releases/latest';
    archivePattern =
      arch === 'arm64' ? 'whisper-cpp-v1.8.2-macos-arm64-metal.zip' : 'whisper-cpp-v1.8.2-macos-x64-metal.zip';
  } else if (platform === 'linux') {
    archivePattern = 'whisper-bin-blas-linux-x64.tar.gz';
    repo = 'https://api.github.com/repos/dscripka/whisper.cpp_binaries/releases/latest';
  }
  return { platform, arch, execNames, archivePattern, repo };
}

async function downloadFile(url, destPath, progressCallback, maxAttempts = 5) {
  const { https, fs } = getNodeModules();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await new Promise((resolve, reject) => {
        const makeRequest = (requestUrl) => {
          https
            .get(requestUrl, { headers: { 'User-Agent': 'ObsidianWhisperPlugin' } }, (response) => {
              if (response.statusCode === 302 || response.statusCode === 301) {
                makeRequest(response.headers.location);
                return;
              }
              if (response.statusCode === 429) {
                const retryAfter = parseInt(response.headers['retry-after'] || '60', 10);
                reject(new Error(`RATE_LIMIT:${retryAfter}`));
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
            })
            .on('error', reject);
        };
        makeRequest(url);
      });
      return;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err;
      }
      const match = err.message.match(/^RATE_LIMIT:(\d+)$/);
      const waitSeconds = match ? Math.min(parseInt(match[1], 10), 120) : Math.min(30 * Math.pow(2, attempt - 1), 120);
      log(`Download failed (attempt ${attempt}/${maxAttempts}): ${err.message}. Retrying in ${waitSeconds}s...`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    }
  }
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
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ]);
    } else if (zipPath.endsWith('.zip')) {
      proc = spawn('unzip', ['-o', zipPath, '-d', destDir]);
    } else {
      proc = spawn('tar', ['-xzf', zipPath, '-C', destDir]);
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

async function getLatestReleaseUrl(archivePattern, repo) {
  const { https } = getNodeModules();
  log('Fetching latest whisper.cpp release info');
  const baseUrl = repo.replace(/\/latest$/, '');
  const fetchJson = (url) =>
    new Promise((resolve, reject) => {
      const makeRequest = (requestUrl) => {
        https
          .get(
            requestUrl,
            {
              headers: { 'User-Agent': 'ObsidianWhisperPlugin' },
            },
            (res) => {
              if (res.statusCode === 302 || res.statusCode === 301) {
                makeRequest(res.headers.location);
                return;
              }
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => resolve({ status: res.statusCode, data }));
            },
          )
          .on('error', reject);
      };
      makeRequest(url);
    });
  const findAsset = (releaseInfo) => releaseInfo.assets.find((a) => a.name === archivePattern);
  const pick = (releaseInfo) => {
    if (releaseInfo.prerelease) {
      log('No stable release contains ' + archivePattern + '; using prerelease ' + releaseInfo.tag_name);
    }
    log('Latest release with ' + archivePattern + ': ' + releaseInfo.tag_name);
    return findAsset(releaseInfo).browser_download_url;
  };
  // whisper.cpp scheme: the version release announces the version, but the
  // binaries are attached to an associated "Nightly build" tag named in the
  // release notes. Resolve that link so the binary matches the release.
  const latestResponse = await fetchJson(repo);
  if (latestResponse.status !== 200) {
    throw new Error(`GitHub API returned ${latestResponse.status}`);
  }
  const latest = JSON.parse(latestResponse.data);
  if (findAsset(latest)) {
    return pick(latest);
  }
  const nightlyMatch = (latest.body || '').match(
    /\*\*Nightly build:\*\* \[[^\]]*\]\([^)]*\/releases\/tag\/([^)\s]+)\)/,
  );
  if (nightlyMatch) {
    log('Release ' + latest.tag_name + ' points to nightly build ' + nightlyMatch[1]);
    const nightlyResponse = await fetchJson(baseUrl + '/tags/' + nightlyMatch[1]);
    if (nightlyResponse.status !== 200) {
      throw new Error(`GitHub API returned ${nightlyResponse.status}`);
    }
    const nightly = JSON.parse(nightlyResponse.data);
    if (findAsset(nightly)) {
      return pick(nightly);
    }
  }
  // Fall back to scanning recent releases: newest stable release with the
  // wanted asset, then any release with it — a prerelease binary beats a
  // failed download.
  const listResponse = await fetchJson(baseUrl + '?per_page=50');
  if (listResponse.status !== 200) {
    throw new Error(`GitHub API returned ${listResponse.status}`);
  }
  const releases = JSON.parse(listResponse.data);
  const findAssetRelease = (stableOnly) =>
    releases.find((releaseInfo) => (stableOnly ? !releaseInfo.prerelease : true) && findAsset(releaseInfo));
  const releaseInfo = findAssetRelease(true) || findAssetRelease(false);
  if (releaseInfo) {
    return pick(releaseInfo);
  }
  const searched = releases.map((r) => r.tag_name).join(', ');
  throw new Error(
    `Could not find ${archivePattern} in ${releases.length} recent releases (${searched})` +
      `. Newest release assets: ${
        releases.length ? releases[0].assets.map((a) => a.name).join(', ') : '(no releases)'
      }`,
  );
}

function writeWavFile(filePath, audioData, sampleRate) {
  const { fs } = getNodeModules();
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
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
    const url = await getLatestReleaseUrl(platformInfo.archivePattern, platformInfo.repo);
    const zipPath = path.join(binDir, platformInfo.platform !== 'linux' ? 'whisper.zip' : 'whisper.tar.gz');
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
      const args = ['-m', this.modelPath, '-f', tempWavPath, '-nt', '-np'];
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
