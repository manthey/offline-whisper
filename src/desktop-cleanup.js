// Desktop cleanup of transcribed text with a local language model, run by a
// llama.cpp process outside of Obsidian. This mirrors desktop-transcriber.js:
// a compiled engine binary and a quantized model are downloaded on first use,
// and cleanup runs in a separate OS process, so the editor is never blocked
// by inference. The model server is a llama-server process listening only on
// 127.0.0.1; no network access is needed after the initial downloads.

const {
  CLEANUP_SYSTEM_PROMPT,
  buildUserPrompt,
  extractJsonCleaned,
  isPlausibleCleanup,
  removeArtifacts,
} = require('./text-cleanup.js');
const { getLatestReleaseUrl } = require('./desktop-transcriber.js');

// GGUF quantizations of the same Qwen models offered on the transformers.js
// path for mobile.
const DESKTOP_CLEANUP_MODELS = [
  {
    id: 'qwen2.5-0.5b-instruct-q4_k_m',
    label: 'Qwen 2.5 0.5B (smaller, faster)',
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    label: 'Qwen 2.5 1.5B (more accurate, slower)',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  },
];
const DEFAULT_DESKTOP_CLEANUP_MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m';

const LLAMA_RELEASES_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
const CLEANUP_MODEL_BASE_URL = 'https://huggingface.co';

// Hard cap on a single cleanup request so a wedged engine cannot stall the
// transcription pipeline; the raw transcription is inserted on timeout.
const CLEANUP_HTTP_TIMEOUT_MS = 30000;

const nodeRequire = new Function('moduleName', 'return require(moduleName)');
function getNodeModules() {
  return {
    path: nodeRequire('path'),
    fs: nodeRequire('fs'),
    os: nodeRequire('os'),
    spawn: nodeRequire('child_process').spawn,
    http: nodeRequire('http'),
    https: nodeRequire('https'),
  };
}

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[WhisperDesktopCleanup ${timestamp}] ${message}`, data);
  } else {
    console.log(`[WhisperDesktopCleanup ${timestamp}] ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;
  // Asset names in llama.cpp releases look like
  // llama-b11998-bin-ubuntu-x64.tar.gz or llama-b11998-bin-win-cpu-x64.zip.
  let assetPattern = null;
  let execNames = ['llama-server', 'llama-server.exe'];
  if (platform === 'linux') {
    assetPattern = arch === 'arm64' ? /-bin-ubuntu-arm64\.tar\.gz$/ : /-bin-ubuntu-x64\.tar\.gz$/;
  } else if (platform === 'darwin') {
    assetPattern = arch === 'arm64' ? /-bin-macos-arm64\.tar\.gz$/ : /-bin-macos-x64\.tar\.gz$/;
  } else if (platform === 'win32') {
    assetPattern = arch === 'arm64' ? /-bin-win-cpu-arm64\.zip$/ : /-bin-win-cpu-x64\.zip$/;
  }
  return { platform, arch, assetPattern, execNames };
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
      await sleep(waitSeconds * 1000);
    }
  }
}

async function extractArchive(archivePath, destDir) {
  const { spawn } = getNodeModules();
  return new Promise((resolve, reject) => {
    let proc;
    if (process.platform === 'win32' && archivePath.endsWith('.zip')) {
      proc = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`,
      ]);
    } else if (archivePath.endsWith('.zip')) {
      proc = spawn('unzip', ['-o', archivePath, '-d', destDir]);
    } else {
      proc = spawn('tar', ['-xzf', archivePath, '-C', destDir]);
    }
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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExecutable(fullPath, execNames);
      if (found) {
        return found;
      }
    } else if (entry.isFile() && execNames.includes(entry.name)) {
      return fullPath;
    }
  }
  return null;
}

class NativeTextCleaner {
  constructor(plugin) {
    this.plugin = plugin;
    this.serverPath = null;
    this.modelPath = null;
    this.modelId = null;
    this.initialized = false;
    this.serverProcess = null;
    this.port = 0;
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
    return path.join(vaultPath, this.plugin.manifest.dir);
  }

  getCleanupDir() {
    const { path } = this.getNodeModules();
    return path.join(this.getPluginDir(), 'cleanup');
  }

  getBinDir() {
    const { path } = this.getNodeModules();
    return path.join(this.getCleanupDir(), 'bin');
  }

  getModelsDir() {
    const { path } = this.getNodeModules();
    return path.join(this.getCleanupDir(), 'models');
  }

  isReady() {
    return !!this.initialized && !!this.serverProcess;
  }

  // Whether the engine binary and the model file are already downloaded.
  async isCached(modelId) {
    const { fs, path } = this.getNodeModules();
    const entry = this.resolveModelEntry(modelId);
    try {
      const binary = findExecutable(this.getBinDir(), getPlatformInfo().execNames);
      const model = path.join(this.getModelsDir(), entry.file);
      return !!binary && fs.existsSync(model);
    } catch (error) {
      log('Cache check failed', error);
      return false;
    }
  }

  resolveModelEntry(modelId) {
    return DESKTOP_CLEANUP_MODELS.find((m) => m.id === modelId) || DESKTOP_CLEANUP_MODELS[0];
  }

  clearCache() {
    this.dispose();
    try {
      const { fs } = this.getNodeModules();
      const dir = this.getCleanupDir();
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      log('Clearing the cleanup cache failed', error);
    }
  }

  dispose() {
    if (this.serverProcess) {
      log('Stopping cleanup engine');
      try {
        this.serverProcess.kill();
      } catch (error) {}
      this.serverProcess = null;
    }
    this.initialized = false;
  }

  async initialize(modelId, progressCallback) {
    if (this.initialized && this.modelId === modelId && this.serverProcess) {
      return true;
    }
    this.dispose();
    this.modelId = modelId;
    await this.ensureBinary(progressCallback);
    await this.ensureModel(modelId, progressCallback);
    await this.startServer();
    this.initialized = true;
    log('Native cleanup ready');
    return true;
  }

  async ensureBinary(progressCallback) {
    const { fs, path } = this.getNodeModules();
    const binDir = this.getBinDir();
    this.serverPath = findExecutable(binDir, getPlatformInfo().execNames);
    if (this.serverPath) {
      log('Using existing cleanup engine: ' + this.serverPath);
      return;
    }
    const { assetPattern } = getPlatformInfo();
    if (!assetPattern) {
      throw new Error(`No llama.cpp cleanup engine is available for ${process.platform}/${process.arch}`);
    }
    const url = await this.getLatestBinaryUrl(assetPattern);
    const archiveName = url.split('/').pop().split('?')[0];
    fs.mkdirSync(binDir, { recursive: true });
    const archivePath = path.join(binDir, archiveName);
    log('Downloading cleanup engine: ' + archiveName);
    if (progressCallback) {
      progressCallback({ status: 'downloading', message: 'Downloading cleanup engine' });
    }
    await downloadFile(url, archivePath, (loaded, total) => {
      if (progressCallback) {
        progressCallback({ status: 'progress', loaded, total });
      }
    });
    await extractArchive(archivePath, binDir);
    try {
      fs.unlinkSync(archivePath);
    } catch (error) {}
    this.serverPath = findExecutable(binDir, getPlatformInfo().execNames);
    if (!this.serverPath) {
      throw new Error('The cleanup engine was not found after extraction');
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(this.serverPath, 0o755);
    }
    log('Using cleanup engine: ' + this.serverPath);
  }

  async getLatestBinaryUrl(assetPattern) {
    // llama.cpp publishes binaries in frequent tagged builds; the release
    // marked latest may be a version announcement without binaries, so the
    // shared resolver scans recent releases for a matching asset.
    return getLatestReleaseUrl(assetPattern, 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  }

  async ensureModel(modelId, progressCallback) {
    const { fs, path } = this.getNodeModules();
    const entry = this.resolveModelEntry(modelId);
    const modelsDir = this.getModelsDir();
    fs.mkdirSync(modelsDir, { recursive: true });
    this.modelPath = path.join(modelsDir, entry.file);
    if (fs.existsSync(this.modelPath)) {
      log('Using existing cleanup model: ' + entry.file);
      return;
    }
    const url = `${CLEANUP_MODEL_BASE_URL}/${entry.repo}/resolve/main/${entry.file}`;
    log('Downloading cleanup model: ' + entry.file);
    if (progressCallback) {
      progressCallback({ status: 'downloading', message: `Downloading cleanup model: ${entry.file}` });
    }
    await downloadFile(url, this.modelPath, (loaded, total) => {
      if (progressCallback) {
        progressCallback({ status: 'progress', loaded, total });
      }
    });
  }

  async startServer() {
    const { path } = this.getNodeModules();
    // The engine serves a small web UI on its port; binding to the loopback
    // interface keeps it entirely local.
    const args = ['-m', this.modelPath, '--host', '127.0.0.1', '--port', 'PLACEHOLDER', '-c', '2048'];
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = 20000 + Math.floor(Math.random() * 25000);
      const spawnArgs = args.map((arg) => (arg === 'PLACEHOLDER' ? String(port) : arg));
      log(`Starting cleanup engine on port ${port}`);
      const proc = this.getNodeModules().spawn(this.serverPath, spawnArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      proc.on('exit', (code) => {
        if (this.serverProcess === proc) {
          log(`Cleanup engine exited with code ${code}`);
          this.serverProcess = null;
        } else if (!this.stopping) {
          log(`Cleanup engine start attempt failed with code ${code}: ${stderr.slice(-400)}`);
        }
      });
      try {
        await this.waitForHealth(port, proc, 60000);
        this.serverProcess = proc;
        this.port = port;
        log(`Cleanup engine ready on port ${port}`);
        return;
      } catch (error) {
        try {
          proc.kill();
        } catch (killError) {}
        log('Cleanup engine start attempt failed', error);
      }
    }
    throw new Error('Could not start the cleanup engine');
  }

  async waitForHealth(port, proc, timeoutMs) {
    const { http } = this.getNodeModules();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (proc.exitCode !== null) {
        throw new Error(`Cleanup engine exited with code ${proc.exitCode} before becoming ready`);
      }
      const healthy = await new Promise((resolve) => {
        const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => resolve(response.statusCode === 200 && data.includes('"ok"')));
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => {
          request.destroy();
          resolve(false);
        });
      });
      if (healthy) {
        return;
      }
      await sleep(300);
    }
    throw new Error('Cleanup engine did not become ready in time');
  }

  // Clean one transcribed chunk. Returns the cleaned text, or the raw text
  // unchanged whenever the result is not trustworthy. Throws on transport
  // failures; callers fall back to the raw transcription.
  async clean(rawText, previousText) {
    if (!this.serverProcess) {
      // The engine may have died (or the machine may have slept); one
      // restart attempt keeps a transient failure from disabling cleanup.
      await this.startServer();
    }
    const trimmed = (rawText || '').trim();
    if (!trimmed) {
      return rawText;
    }
    // Sound-event annotations are removed before the model sees the text,
    // so it cannot echo them. Annotation patterns are typographic and apply
    // in any language; filler words and silence artifacts are linguistic
    // and are left to the multilingual model.
    const strippedRaw = removeArtifacts(trimmed);
    if (!strippedRaw) {
      log('Chunk contains only artifacts; inserting nothing');
      return '';
    }
    const strippedPrevious = removeArtifacts((previousText || '').trim());
    const messages = [
      { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(strippedPrevious, strippedRaw) },
    ];
    log('Cleaning text', { rawText, hasContext: !!(previousText && previousText.trim()) });
    const { http } = this.getNodeModules();
    const body = JSON.stringify({
      messages,
      temperature: 0,
      max_tokens: 256,
      stream: false,
    });
    const startTime = Date.now();
    const reply = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/v1/chat/completions',
          method: 'POST',
          timeout: CLEANUP_HTTP_TIMEOUT_MS,
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error(`Cleanup engine returned HTTP ${response.statusCode}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              resolve(
                parsed.choices && parsed.choices[0] && parsed.choices[0].message
                  ? parsed.choices[0].message.content
                  : '',
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error(`Cleanup engine did not respond within ${CLEANUP_HTTP_TIMEOUT_MS / 1000}s`));
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
    log(`Cleanup generation took ${Date.now() - startTime}ms`);
    log('Cleanup reply', reply);
    const cleaned = extractJsonCleaned(reply);
    if (cleaned === null) {
      // A reply without the requested JSON object is not a cleaned
      // transcript; discard it rather than trying to salvage free text.
      log('Cleanup rejected: reply contained no valid {"cleaned": ...} JSON');
      return strippedRaw;
    }
    // Strip any artifacts the model re-emitted. An empty cleaned text is an
    // explicit model verdict that the segment held only artifacts, and is
    // honored; a non-empty reply must pass the plausibility check, and an
    // implausible one inserts the artifact-stripped raw text instead.
    const text = removeArtifacts(cleaned.trim());
    if (!text) {
      log('Model determined the segment contains only artifacts');
      return '';
    }
    if (!isPlausibleCleanup(text, strippedRaw)) {
      log('Cleanup rejected: implausible cleaned text');
      return strippedRaw;
    }
    return text;
  }
}

module.exports = {
  NativeTextCleaner,
  DESKTOP_CLEANUP_MODELS,
  DEFAULT_DESKTOP_CLEANUP_MODEL_ID,
  getPlatformInfo,
};
