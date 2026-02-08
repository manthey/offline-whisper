const { Plugin, Notice, PluginSettingTab, Setting, MarkdownView } = require('obsidian');

const { pipeline, env } = require('@xenova/transformers');

try {
  // Method 1: Direct env.backends approach (transformers.js 2.x)
  if (typeof env.backends !== 'undefined') {
    env.backends.onnx = env.backends.onnx || {};
    env.backends.onnx.wasm = env.backends.onnx.wasm || {};
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    log('Configured env.backends.onnx.wasm');
  }

  // Method 2: Direct env.onnx approach (fallback)
  env.onnx = env.onnx || {};
  env.onnx.wasm = env.onnx.wasm || {};
  env.onnx.wasm.numThreads = 1;
  env.onnx.wasm.proxy = false;
  log('Configured env.onnx.wasm');

  // Method 3: Try to access onnxruntime-web directly
  const ort = require('onnxruntime-web');
  if (ort && ort.env) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    log('Configured onnxruntime-web directly');
  }
} catch (e) {
  log('ONNX config note', e.message);
}

// Configure transformers.js to use browser cache and allow local files
env.useBrowserCache = true;
env.allowLocalModels = false;

/*
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
} else {
  // Older transformers.js versions
  env.onnx = env.onnx || {};
  env.onnx.wasm = env.onnx.wasm || {};
  env.onnx.wasm.numThreads = 1;
  env.onnx.wasm.proxy = false;
}
*/

function log(message, data) {
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[Whisper ${timestamp}] ${message}`, data);
  } else {
    console.log(`[Whisper ${timestamp}] ${message}`);
  }
}

async function isModelCached(modelId) {
  try {
    const cacheNames = await caches.keys();
    const transformersCache = cacheNames.find(name =>
      name.includes('transformers') || name.includes('xenova')
    );

    if (!transformersCache) {
      log('No transformers cache found');
      return false;
    }

    const cache = await caches.open(transformersCache);
    const keys = await cache.keys();

    // Check if any cached URL contains the model ID
    const modelCached = keys.some(request =>
      request.url.includes(modelId.replace('/', '%2F')) ||
      request.url.includes(modelId)
    );

    log(`Model ${modelId} cached: ${modelCached}`);
    return modelCached;
  } catch (error) {
    log('Cache check error', error);
    return false;
  }
}

class WhisperTranscriptionPlugin extends Plugin {
  settings = {
    modelId: 'Xenova/whisper-tiny.en',
    chunkDurationMs: 10000,
  };

  transcriber = null;
  isRecording = false;
  isModelLoading = false;
  mediaStream = null;
  currentRecorder = null;
  targetEditor = null;
  statusNotice = null;
  processingCount = 0;
  chunkNumber = 0;
  lastStatus = 0;

  async onload() {
    log('Plugin loading');
    await this.loadSettings();

    this.addCommand({
      id: 'toggle-transcription',
      name: 'Toggle Voice Transcription',
      callback: () => this.toggleRecording(),
    });

    this.addCommand({
      id: 'stop-transcription',
      name: 'Stop Voice Transcription',
      callback: () => this.stopRecording(),
    });

    this.addSettingTab(new WhisperSettingTab(this.app, this));
    log('Plugin loaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
    log('Settings loaded', this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  showStatus(message, timeout = 0) {
    if (Date.now() - this.lastStatus < 1000 && timeout === true) {
      return;
    }
    this.lastStatus = Date.now();
    if (timeout === true) {
	  timeout = 0;
    }
    log('Status: ' + message);
    if (this.statusNotice) {
      this.statusNotice.hide();
    }
    this.statusNotice = new Notice(message, timeout);
  }

  async loadModel() {
    if (this.transcriber) {
      log('Model already loaded');
      return true;
    }
    if (this.isModelLoading) {
      log('Model is currently loading, skipping');
      this.showStatus('Model is already loading, please wait...', 3000);
      return false;
    }

    this.isModelLoading = true;

    try {
      const cached = await isModelCached(this.settings.modelId);

      if (cached) {
        this.showStatus('Loading model from cache...', true);
        log('Loading model from cache (offline)');
      } else {
        this.showStatus(`Downloading model: ${this.settings.modelId}. This only happens once.`, true);
        log('Downloading model (online required)');
      }

      this.transcriber = await pipeline(
        'automatic-speech-recognition',
        this.settings.modelId,
        {
          quantized: true,
          progress_callback: (progress) => {
            if (progress.status === 'downloading' || progress.status === 'progress') {
              if (progress.total) {
                const pct = Math.round((progress.loaded / progress.total) * 100);
                const mb = Math.round(progress.loaded / 1024 / 1024);
                this.showStatus(`Downloading: ${pct}% (${mb}MB)`, true);
              }
            } else if (progress.status === 'loading') {
              this.showStatus('Initializing model...', true);
            } else if (progress.status === 'ready') {
              log('Model ready status received', true);
            }
          },
        }
      );

      this.isModelLoading = false;
      log('Model loaded successfully');
      this.showStatus('Model ready', true);
      return true;
    } catch (error) {
      this.isModelLoading = false;
      log('Model load FAILED', error);

      if (error.message && error.message.includes('fetch')) {
        this.showStatus('Model not cached and no network available', 5000);
      } else {
        this.showStatus('Model load failed: ' + error.message, 5000);
      }
      return false;
    }
  }

  async toggleRecording() {
    log('Toggle recording, current state: ' + this.isRecording);
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  async startRecording() {
    if (this.isRecording) {
      log('Already recording, ignoring start');
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      log('No active markdown view');
      new Notice('Open a note first');
      return;
    }
    this.targetEditor = view.editor;
    log('Target editor set');

    if (!(await this.loadModel())) {
      log('Model not available, cannot start');
      return;
    }

    try {
      log('Requesting microphone access...');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const tracks = this.mediaStream.getAudioTracks();
      log('Microphone access granted', {
        trackCount: tracks.length,
        trackSettings: tracks[0] ? tracks[0].getSettings() : null,
      });

      this.isRecording = true;
      this.chunkNumber = 0;
      this.showStatus('Recording started', 2000);
      this.recordChunk();
    } catch (error) {
      log('Microphone access FAILED', error);
      new Notice('Microphone access failed: ' + error.message);
    }
  }

  recordChunk() {
    if (!this.isRecording || !this.mediaStream) {
      log('Not recording or no stream, skipping chunk');
      return;
    }

    this.chunkNumber++;
    const chunkNum = this.chunkNumber;
    log(`Starting chunk #${chunkNum}`);

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/mp4';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = '';
    }
    log(`Using MIME type: "${mimeType || 'default'}"`);

    const recorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : {});
    this.currentRecorder = recorder;
    const audioChunks = [];

    recorder.ondataavailable = (event) => {
      log(`Chunk #${chunkNum} data available`, {
        size: event.data ? event.data.size : 0,
      });
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      log(`Chunk #${chunkNum} recorder stopped`, {
        chunksCollected: audioChunks.length,
        totalSize: audioChunks.reduce((sum, c) => sum + c.size, 0),
      });

      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: recorder.mimeType });
        log(`Chunk #${chunkNum} blob created`, {
          type: audioBlob.type,
          size: audioBlob.size,
        });
        this.transcribeAudio(audioBlob, chunkNum);
      } else {
        log(`Chunk #${chunkNum} NO AUDIO DATA`);
      }

      if (this.isRecording && this.mediaStream) {
        this.recordChunk();
      }
    };

    recorder.onerror = (event) => {
      log(`Chunk #${chunkNum} recorder ERROR`, event.error);
    };

    recorder.start();
    log(`Chunk #${chunkNum} recorder started, state: ${recorder.state}`);

    setTimeout(() => {
      if (recorder.state === 'recording') {
        log(`Chunk #${chunkNum} stopping after timeout`);
        recorder.stop();
      } else {
        log(`Chunk #${chunkNum} not recording at timeout, state: ${recorder.state}`);
      }
    }, this.settings.chunkDurationMs);
  }

  resampleAudio(audioData, fromSampleRate, toSampleRate) {
    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.round(audioData.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
      const t = srcIndex - srcIndexFloor;
      result[i] = audioData[srcIndexFloor] * (1 - t) + audioData[srcIndexCeil] * t;
    }

    return result;
  }

  async transcribeAudio(audioBlob, chunkNum) {
    if (!this.transcriber) {
      log(`Chunk #${chunkNum} no transcriber available`);
      return;
    }
    if (!this.targetEditor) {
      log(`Chunk #${chunkNum} no target editor`);
      return;
    }

    this.processingCount++;
    log(`Chunk #${chunkNum} starting transcription, queue size: ${this.processingCount}`);

    if (this.processingCount === 1 && this.isRecording) {
      this.showStatus('Processing speech...');
    }

    try {
      log(`Chunk #${chunkNum} converting blob to arrayBuffer`);
      const arrayBuffer = await audioBlob.arrayBuffer();
      log(`Chunk #${chunkNum} arrayBuffer size: ${arrayBuffer.byteLength}`);

      log(`Chunk #${chunkNum} decoding audio...`);
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      log(`Chunk #${chunkNum} decoded`, {
        sampleRate: audioBuffer.sampleRate,
        duration: audioBuffer.duration,
        channels: audioBuffer.numberOfChannels,
      });

      let audioData = audioBuffer.getChannelData(0);

      const targetSampleRate = 16000;
      if (audioBuffer.sampleRate !== targetSampleRate) {
        log(`Chunk #${chunkNum} resampling from ${audioBuffer.sampleRate} to ${targetSampleRate}`);
        audioData = this.resampleAudio(audioData, audioBuffer.sampleRate, targetSampleRate);
      }

      // Clamp audio to valid range [-1, 1]
      for (let i = 0; i < audioData.length; i++) {
        if (audioData[i] > 1) audioData[i] = 1;
        if (audioData[i] < -1) audioData[i] = -1;
      }

      log(`Chunk #${chunkNum} audio ready: ${audioData.length} samples (${(audioData.length / 16000).toFixed(2)}s)`);

      log(`Chunk #${chunkNum} calling transcriber...`);
      const startTime = Date.now();

      const result = await this.transcriber(audioData);

      const elapsed = Date.now() - startTime;
      log(`Chunk #${chunkNum} transcription complete in ${elapsed}ms`, result);

      const text = result.text ? result.text.trim() : '';
      log(`Chunk #${chunkNum} extracted text: "${text}"`);

      if (text && text.length > 0 && text !== 'you') {
        if (this.targetEditor) {
          const cursor = this.targetEditor.getCursor();
          log(`Chunk #${chunkNum} inserting at cursor`, cursor);

          const insertText = text + ' ';
          this.targetEditor.replaceRange(insertText, cursor);

          const newPos = {
            line: cursor.line,
            ch: cursor.ch + insertText.length,
          };
          this.targetEditor.setCursor(newPos);
          log(`Chunk #${chunkNum} text inserted successfully`);
        } else {
          log(`Chunk #${chunkNum} targetEditor became null`);
        }
      } else {
        log(`Chunk #${chunkNum} empty transcription, nothing to insert`);
      }
    } catch (error) {
      log(`Chunk #${chunkNum} transcription FAILED`, error);
      new Notice('Transcription error: ' + error.message);
    } finally {
      this.processingCount--;
      log(`Chunk #${chunkNum} done, remaining in queue: ${this.processingCount}`);
      if (this.processingCount === 0 && this.isRecording) {
        this.showStatus('Listening...', 2000);
      }
    }
  }

  stopRecording() {
    log('Stopping recording');
    if (!this.isRecording) {
      log('Was not recording');
      return;
    }

    this.isRecording = false;

    if (this.currentRecorder && this.currentRecorder.state === 'recording') {
      log('Stopping current recorder');
      this.currentRecorder.stop();
    }
    this.currentRecorder = null;

    if (this.mediaStream) {
      log('Stopping media stream tracks');
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.targetEditor = null;
    new Notice('Recording stopped');
    log('Recording stopped completely');
  }

  onunload() {
    log('Plugin unloading');
    this.stopRecording();
    this.transcriber = null;
  }
}

class WhisperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Whisper Transcription Settings' });

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Smaller = faster, less accurate. Downloaded on first use.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('Xenova/whisper-tiny.en', 'Tiny (40MB) - Fastest')
          .addOption('Xenova/whisper-base.en', 'Base (70MB) - Balanced')
          .addOption('Xenova/whisper-small.en', 'Small (170MB) - Best quality')
          .addOption('distil-whisper/distil-small.en', 'Distil Small - Fast and good')
          .setValue(this.plugin.settings.modelId)
          .onChange(async (value) => {
            this.plugin.settings.modelId = value;
            this.plugin.transcriber = null;
            await this.plugin.saveSettings();
            new Notice('Model changed. New model loads on next recording.');
          })
      );

    new Setting(containerEl)
      .setName('Chunk duration (seconds)')
      .setDesc('How often transcription runs. 10-15s recommended.')
      .addSlider((slider) =>
        slider
          .setLimits(5, 30, 5)
          .setValue(this.plugin.settings.chunkDurationMs / 1000)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.chunkDurationMs = value * 1000;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Check model cache')
      .setDesc('See if the current model is cached for offline use')
      .addButton((button) =>
        button
          .setButtonText('Check')
          .onClick(async () => {
            const cached = await isModelCached(this.plugin.settings.modelId);
            new Notice(cached ? 'Model is cached - offline ready' : 'Model not cached - needs download');
          })
      );
  }
}

module.exports = WhisperTranscriptionPlugin;
