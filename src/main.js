const { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon } = require('obsidian');

let pipeline, env, DesktopTranscriber;

// Conditional imports based on platform
const isMobilePlatform = typeof process === 'undefined' || !process.versions || !process.versions.electron;

if (isMobilePlatform) {
  const transformers = require('@xenova/transformers');
  pipeline = transformers.pipeline;
  env = transformers.env;
  env.useBrowserCache = true;
  env.allowLocalModels = false;
} else {
  const desktopModule = require('./desktop-transcriber.js');
  DesktopTranscriber = desktopModule.DesktopTranscriber;
}

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
    modelId: 'Xenova/whisper-base.en',
    chunkDurationMs: 10000,
  };
  transcriber = null;
  desktopTranscriber = null;
  isRecording = false;
  isModelLoading = false;
  mediaStream = null;
  currentRecorder = null;
  targetEditor = null;
  statusNotice = null;
  processingCount = 0;
  chunkNumber = 0;
  lastStatus = 0;
  isStopping = false;
  nextInsertChunk = 1;
  pendingResults = new Map();

  async onload() {
    log('Plugin loading');
    await this.loadSettings();
    this.addCommand({
      id: 'toggle-transcription',
      name: 'Toggle Voice Transcription',
      callback: () => this.toggleRecording(),
      icon: 'mic',
    });
    this.addCommand({
      id: 'start-transcription',
      name: 'Start Voice Transcription',
      callback: () => this.toggleRecording(true),
      icon: 'mic',
    });
    this.addCommand({
      id: 'stop-transcription',
      name: 'Stop Voice Transcription',
      callback: () => this.toggleRecording(false),
      icon: 'mic-off',
    });
    this.ribbonIcon = this.addRibbonIcon('mic-off', 'Toggle Voice Transcription', (evt) => {
      this.toggleRecording();
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
      this.showStatus('Model is already loading', 3000);
      return false;
    }
    this.isModelLoading = true;
    try {
      // Desktop path: use whisper.cpp
      if (!isMobilePlatform) {
        this.desktopTranscriber = new DesktopTranscriber(this);
        await this.desktopTranscriber.initialize(this.settings.modelId, (progress) => {
          if (progress.message) {
            this.showStatus(progress.message, true);
          }
        });
        this.transcriber = (audioData) => this.desktopTranscriber.transcribe(audioData);
        this.isModelLoading = false;
        log('Desktop transcriber ready');
        this.showStatus('Model ready', 2000);
        return true;
      }
      // Mobile path: use transformers.js
      const cached = await isModelCached(this.settings.modelId);
      if (cached) {
        this.showStatus('Loading model from cache', true);
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
              this.showStatus('Initializing model', true);
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

  async toggleRecording(state) {
    if (state === true) {
      log('Start recording, current state: ' + this.isRecording);
    } else if (state === false) {
      log('Stop recording, current state: ' + this.isRecording);
    } else  {
      log('Toggle recording, current state: ' + this.isRecording);
    }
    if (this.isRecording) {
      if (state !== true) {
        this.stopRecording();
      }
    } else {
      if (state !== false) {
        await this.startRecording();
      }
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
      log('Requesting microphone access');
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
	  setIcon(this.ribbonIcon, 'mic');
      this.isRecording = true;
      this.chunkNumber = 0;
      this.nextInsertChunk = 1;
      this.pendingResults = new Map();
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
      if (this.isStopping) {
        this.isStopping = false;
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach((track) => track.stop());
          this.mediaStream = null;
        }
        // this.targetEditor = null;
        new Notice('Recording stopped');
        log('Recording stopped');
      } else if (this.isRecording && this.mediaStream) {
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
      result[i] = audioData[Math.floor(i * ratio)];
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
      this.showStatus('Processing speech');
    }
    try {
      log(`Chunk #${chunkNum} converting blob to arrayBuffer`);
      const arrayBuffer = await audioBlob.arrayBuffer();
      log(`Chunk #${chunkNum} arrayBuffer size: ${arrayBuffer.byteLength}`);

      log(`Chunk #${chunkNum} decoding audio`);
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
      log(`Chunk #${chunkNum} calling transcriber`);
      const startTime = Date.now();
      const result = await this.transcriber(audioData);
      const elapsed = Date.now() - startTime;
      log(`Chunk #${chunkNum} transcription complete in ${elapsed}ms`, result);
      const text = result.text ? result.text.trim() : '';
      log(`Chunk #${chunkNum} extracted text: "${text}"`);
      this.pendingResults.set(chunkNum, text);
      this.flushPendingResults();
    } catch (error) {
      log(`Chunk #${chunkNum} transcription FAILED`, error);
      new Notice('Transcription error: ' + error.message);
    } finally {
      this.processingCount--;
      log(`Chunk #${chunkNum} done, remaining in queue: ${this.processingCount}`);
      if (this.processingCount === 0 && this.isRecording) {
        this.showStatus('Listening', 2000);
      }
    }
  }

  flushPendingResults() {
    while (this.pendingResults.has(this.nextInsertChunk)) {
      const chunkNum = this.nextInsertChunk;
      const text = this.pendingResults.get(chunkNum);
      this.pendingResults.delete(chunkNum);
      if (text && text.length > 0 && text !== 'you' && !(text.startsWith('[') && text.endsWith(']')) && !(text.startsWith('(')  && text.endsWith(')'))) {
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
      this.nextInsertChunk++;
    }
  }

  stopRecording() {
    log('Stopping recording');
	setIcon(this.ribbonIcon, 'mic-off');
    if (!this.isRecording) {
      log('Was not recording');
      return;
    }
    this.isRecording = false;
    this.isStopping = true;
    if (this.currentRecorder && this.currentRecorder.state === 'recording') {
      log('Stopping current recorder');
      this.currentRecorder.stop();
    }
    this.currentRecorder = null;
    new Notice('Recording stopping');
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
          .addOption('Xenova/whisper-tiny.en', 'Tiny English')
          .addOption('Xenova/whisper-base.en', 'Base English')
          .addOption('Xenova/whisper-small.en', 'Small English')
          .addOption('Xenova/whisper-medium.en', 'Medium English')
          .addOption('Xenova/whisper-tiny', 'Tiny')
          .addOption('Xenova/whisper-base', 'Base')
          .addOption('Xenova/whisper-small', 'Small')
          .addOption('Xenova/whisper-medium', 'Medium')
          .setValue(this.plugin.settings.modelId)
          .onChange(async (value) => {
            this.plugin.settings.modelId = value;
            this.plugin.transcriber = null;
            await this.plugin.saveSettings();
            let cached;
            if (!isMobilePlatform && this.plugin.desktopTranscriber) {
              cached = this.plugin.desktopTranscriber.isModelCached(this.plugin.settings.modelId);
            } else if (!isMobilePlatform) {
              const tempTranscriber = new DesktopTranscriber(this.plugin);
              cached = tempTranscriber.isModelCached(this.plugin.settings.modelId);
            } else {
              cached = await isModelCached(this.plugin.settings.modelId);
            }
            if (!cached) {
              new Notice('Model changed. New model loads on next recording.');
            } else {
              new Notice('Model changed (already cached).');
            }
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
            let cached;
            if (!isMobilePlatform && this.plugin.desktopTranscriber) {
              cached = this.plugin.desktopTranscriber.isModelCached(this.plugin.settings.modelId);
            } else if (!isMobilePlatform) {
              const tempTranscriber = new DesktopTranscriber(this.plugin);
              cached = tempTranscriber.isModelCached(this.plugin.settings.modelId);
            } else {
              cached = await isModelCached(this.plugin.settings.modelId);
            }
            new Notice(cached ? 'Model is cached - offline ready' : 'Model not cached - needs download');
          })
      );
    new Setting(containerEl)
      .setName('Clear Caches')
      .setDesc('Delete all cached models and binaries')
      .addButton((button) =>
        button
          .setButtonText('Clear Cache')
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              if (!isMobilePlatform) {
                if (!this.plugin.destopTransriber) {
                  this.plugin.desktopTranscriber = new DesktopTranscriber(this.plugin);
                }
                this.plugin.desktopTranscriber.clearCache();
                new Notice('Cache cleared');
              } else {
                const cacheNames = await caches.keys();
                for (const name of cacheNames) {
                  if (name.includes('transformers') || name.includes('xenova')) {
                    await caches.delete(name);
                  }
                }
                new Notice('Cache cleared');
              }
            } catch (err) {
              new Notice('Failed to clear cache: ' + err.message);
            } finally {
              button.setDisabled(false);
            }
          })
      );
  }
}

module.exports = WhisperTranscriptionPlugin;
