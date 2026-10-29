const { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon } = require('obsidian');

let pipeline, env, DesktopTranscriber;

const { AudioSegmenter } = require('./audio-segmenter.js');

// Allow testing to override platform detection via globalThis.__desktopOverride
// Set to true in tests to force desktop code path
const _platformOverride = typeof globalThis.__desktopOverride !== 'undefined' ? globalThis.__desktopOverride : undefined;
const isMobilePlatform = _platformOverride !== undefined ? !_platformOverride : (typeof process === 'undefined' || !process.versions || !process.versions.electron);
// GPU acceleration is offered where a GPU-capable backend exists: Windows has
// a downloadable CUDA build, and mobile uses WebGPU. macOS always uses Metal
// already, and no prebuilt GPU binary exists for Linux, so the setting is
// hidden there.
const isWindowsDesktop = !isMobilePlatform && typeof process !== 'undefined' && process.platform === 'win32';

if (isMobilePlatform) {
  const transformers = require('@huggingface/transformers');
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

// Audio worklet that forwards input samples to the main thread. Loaded from a
// blob URL so no extra files are needed. ScriptProcessorNode is used as a
// fallback where AudioWorklet is unavailable.
const CAPTURE_WORKLET_SOURCE = `
class OfflineWhisperCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor('offline-whisper-capture', OfflineWhisperCapture);
`;

async function isModelCached(modelId) {
  try {
    const cacheNames = await caches.keys();
    const transformersCache = cacheNames.find(name =>
      name.includes('transformers') || name.includes('xenova') || name.includes('huggingface') || name.includes('onnx-community')
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
  defaultFilter = '^(?:you|okay)$|^\\[.*\\]$|^\\(.*\\)$';
  settings = {
    modelId: 'onnx-community/whisper-base.en',
    chunkDurationMs: 10000,
    regexFilter: this.defaultFilter,
    computeDevice: 'cpu',
  };
  transcriber = null;
  desktopTranscriber = null;
  isRecording = false;
  isModelLoading = false;
  mediaStream = null;
  currentRecorder = null;
  audioContext = null;
  audioSourceNode = null;
  audioProcessor = null;
  audioMuteGain = null;
  captureActive = false;
  captureSampleRate = 16000;
  segmenter = null;
  transcriptionChain = Promise.resolve();
  pendingInput = [];
  pendingInputLength = 0;
  targetEditor = null;
  statusNotice = null;
  processingCount = 0;
  chunkNumber = 0;
  lastStatus = 0;
  isStopping = false;
  nextInsertChunk = 1;
  pendingResults = new Map();
  wakeLock = null;

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

  async acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      log('Wake lock API not available');
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch (error) {
      this.wakeLock = null;
    }
  }

  async releaseWakeLock() {
    if (!this.wakeLock) {
      return;
    }
    try {
      await this.wakeLock.release();
    } catch (error) {
    }
    this.wakeLock = null;
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
        // Bind the wrapper to a local reference: the settings handlers null
        // this.desktopTranscriber when the device or model changes, which can
        // happen while initialize() is awaiting, and re-reading the property
        // here would wrap null.
        const transcriber = new DesktopTranscriber(this, { useGpu: this.settings.computeDevice === 'gpu' });
        this.desktopTranscriber = transcriber;
        await transcriber.initialize(this.settings.modelId, (progress) => {
          if (progress.message) {
            this.showStatus(progress.message, true);
          }
        });
        this.transcriber = (audioData) => transcriber.transcribe(audioData);
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
      const pipelineOptions = {
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'q4',
        },
        progress_callback: (progress) => {
          if (progress.status === 'downloading' || progress.status === 'progress') {
            if (progress.total) {
              const pct = Math.round((progress.loaded / progress.total) * 100);
              const mb = Math.round(progress.loaded / 1024 / 1024);
              this.showStatus(`${cached? "Loading" : "Downloading"}: ${pct}% (${mb}MB)`, true);
            }
          } else if (progress.status === 'loading') {
            this.showStatus('Initializing model', true);
          } else if (progress.status === 'ready') {
            log('Model ready status received', true);
          }
        },
      };
      // GPU acceleration on mobile uses WebGPU when the browser provides it.
      // Any failure (unsupported browser, driver issues, out of memory) falls
      // back to the CPU (WASM) path automatically.
      const useWebGpu =
        this.settings.computeDevice === 'gpu' && typeof navigator !== 'undefined' && !!navigator.gpu;
      if (useWebGpu) {
        pipelineOptions.device = 'webgpu';
        log('Requesting WebGPU for transcription');
      }
      let mobilePipeline;
      try {
        mobilePipeline = await pipeline('automatic-speech-recognition', this.settings.modelId, pipelineOptions);
      } catch (pipelineError) {
        if (!useWebGpu) {
          throw pipelineError;
        }
        log('WebGPU pipeline failed; falling back to WASM', pipelineError);
        delete pipelineOptions.device;
        mobilePipeline = await pipeline('automatic-speech-recognition', this.settings.modelId, pipelineOptions);
      }
      this.transcriber = mobilePipeline;
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

  // Download whatever is missing for offline use with the current settings:
  // the whisper.cpp binary (CPU or GPU) and the model on desktop, or the
  // transformers.js model on mobile. Unlike loadModel, this never treats an
  // already loaded model as done: a loaded transcriber may predate a settings
  // change (for example switching the compute device mid-download), so the
  // current settings are always verified against the cache.
  async downloadOfflineAssets() {
    if (isMobilePlatform) {
      // On mobile there is no separate binary; the model files are the same
      // for CPU and WebGPU, so an already loaded model means the cache is
      // populated and loadModel returns immediately.
      return this.loadModel();
    }
    const transcriber = new DesktopTranscriber(this, { useGpu: this.settings.computeDevice === 'gpu' });
    await transcriber.initialize(this.settings.modelId, (progress) => {
      if (progress.message) {
        this.showStatus(progress.message, true);
      }
    });
    // Adopt the fresh transcriber only when none is loaded; a loaded one
    // keeps working with the settings it was created with until the next
    // settings change rebuilds it.
    if (!this.transcriber) {
      this.desktopTranscriber = transcriber;
      this.transcriber = (audioData) => transcriber.transcribe(audioData);
      this.showStatus('Model ready', 2000);
    }
    return true;
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
      await this.acquireWakeLock();
	  setIcon(this.ribbonIcon, 'mic');
      this.isRecording = true;
      this.showStatus('Recording started', 2000);
      try {
        await this.startContinuousCapture();
      } catch (error) {
        log('Continuous capture unavailable, falling back to chunked recorder', error);
        this.recordChunk();
      }
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

  async startContinuousCapture() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('AudioContext is not available');
    }
    const context = new AudioContextCtor({ sampleRate: 16000 });
    const sampleRate = context.sampleRate || 16000;
    if (!context.createMediaStreamSource || !context.createGain) {
      throw new Error('Continuous audio capture is not supported');
    }
    const source = context.createMediaStreamSource(this.mediaStream);
    // Keep the capture node connected through a silent gain node: some
    // browsers only pump audio through nodes that reach the destination.
    const mute = context.createGain();
    mute.gain.value = 0;
    let node = null;
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
        await context.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);
        node = new AudioWorkletNode(context, 'offline-whisper-capture');
        node.port.onmessage = (event) => {
          try {
            this.queueAudioInput(event.data);
          } catch (error) {
            log('Audio processing error', error);
          }
        };
        log('Capturing with AudioWorkletNode');
      } catch (error) {
        log('AudioWorklet unavailable, falling back to ScriptProcessorNode', error);
        node = null;
      }
    }
    if (!node) {
      if (!context.createScriptProcessor) {
        throw new Error('No audio capture node available');
      }
      node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        try {
          this.queueAudioInput(event.inputBuffer.getChannelData(0));
        } catch (error) {
          log('Audio processing error', error);
        }
      };
      log('Capturing with ScriptProcessorNode');
    }
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    this.segmenter = new AudioSegmenter({
      sampleRate,
      minDurationMs: this.settings.chunkDurationMs,
      maxDurationMs: this.settings.chunkDurationMs + 2500,
    });
    this.pendingInput = [];
    this.pendingInputLength = 0;
    this.audioContext = context;
    this.audioSourceNode = source;
    this.audioProcessor = node;
    this.audioMuteGain = mute;
    this.captureActive = true;
    this.captureSampleRate = sampleRate;
    log(`Continuous capture started at ${sampleRate}Hz`);
  }

  teardownContinuousCapture() {
    if (this.audioProcessor) {
      this.audioProcessor.onaudioprocess = null;
      try {
        this.audioProcessor.disconnect();
      } catch (error) {
      }
      this.audioProcessor = null;
    }
    if (this.audioSourceNode) {
      try {
        this.audioSourceNode.disconnect();
      } catch (error) {
      }
      this.audioSourceNode = null;
    }
    if (this.audioMuteGain) {
      try {
        this.audioMuteGain.disconnect();
      } catch (error) {
      }
      this.audioMuteGain = null;
    }
    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = null;
      try {
        context.close();
      } catch (error) {
      }
    }
    this.captureActive = false;
  }

  // AudioWorkletNode delivers samples in small 128-sample messages, so
  // incoming audio is accumulated and handed to the segmenter in larger
  // batches to keep buffer copying cheap.
  queueAudioInput(samples) {
    if (!this.isRecording || !this.segmenter) {
      return;
    }
    this.pendingInput.push(samples);
    this.pendingInputLength += samples.length;
    if (this.pendingInputLength >= 4096) {
      this.drainPendingInput();
    }
  }

  drainPendingInput() {
    if (this.pendingInputLength === 0) {
      return;
    }
    const merged = new Float32Array(this.pendingInputLength);
    let offset = 0;
    for (const part of this.pendingInput) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.pendingInput = [];
    this.pendingInputLength = 0;
    this.handleAudioInput(merged);
  }

  handleAudioInput(samples) {
    if (!this.isRecording || !this.segmenter) {
      return;
    }
    const segments = this.segmenter.push(samples);
    for (const segment of segments) {
      this.transcribeSegment(segment);
    }
  }

  transcribeSegment(audioData) {
    this.chunkNumber++;
    const chunkNum = this.chunkNumber;
    let prepared = audioData;
    if (this.captureSampleRate !== 16000) {
      log(`Chunk #${chunkNum} resampling from ${this.captureSampleRate} to 16000`);
      prepared = this.resampleAudio(prepared, this.captureSampleRate, 16000);
    }
    log(`Chunk #${chunkNum} segment ready: ${prepared.length} samples (${(prepared.length / 16000).toFixed(2)}s)`);
    // Transcribe one chunk at a time, in order, so results are inserted in
    // the order the audio was spoken, even across stop/start cycles and
    // regardless of how long each transcription takes.
    const task = () => this.transcribeAudioData(prepared, chunkNum);
    this.transcriptionChain = this.transcriptionChain.then(task, task);
  }

  async transcribeAudioData(audioData, chunkNum) {
    if (!this.transcriber || !this.targetEditor) {
      log(`Chunk #${chunkNum} no transcriber or editor available`);
      // Queue an empty result so chunk ordering cannot stall on this chunk.
      this.queueTranscriptionResult('', chunkNum);
      return;
    }
    this.processingCount++;
    log(`Chunk #${chunkNum} starting transcription, queue size: ${this.processingCount}`);
    if (this.processingCount === 1 && this.isRecording) {
      this.showStatus('Processing speech');
    }
    let text = '';
    try {
      // Clamp audio to valid range [-1, 1]
      const clamped = new Float32Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        clamped[i] = Math.max(-1, Math.min(1, audioData[i]));
      }
      text = await this.transcribePreparedAudio(clamped, chunkNum);
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
    // Always queue a result (empty on failure) so chunk ordering cannot
    // stall waiting for a chunk that will never produce text.
    this.queueTranscriptionResult(text, chunkNum);
  }

  async transcribePreparedAudio(audioData, chunkNum) {
    log(`Chunk #${chunkNum} calling transcriber`);
    const startTime = Date.now();
    let timeoutHandle = null;
    const result = await Promise.race([
      this.transcriber(audioData),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), 180000);
      }),
    ]);
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    const elapsed = Date.now() - startTime;
    log(`Chunk #${chunkNum} transcription complete in ${elapsed}ms`, result);
    const text = result && result.text ? result.text.trim() : '';
    log(`Chunk #${chunkNum} extracted text: "${text}"`);
    return text;
  }

  queueTranscriptionResult(text, chunkNum) {
    log(`Chunk #${chunkNum} queueing text: "${text}"`);
    this.pendingResults.set(chunkNum, text);
    this.flushPendingResults();
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
      const text = await this.transcribePreparedAudio(audioData, chunkNum);
      this.queueTranscriptionResult(text, chunkNum);
    } catch (error) {
      log(`Chunk #${chunkNum} transcription FAILED`, error);
      new Notice('Transcription error: ' + error.message);
      // Queue an empty result so chunk ordering cannot stall on this chunk.
      this.pendingResults.set(chunkNum, '');
      this.flushPendingResults();
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
      let filterRegex = new RegExp(this.defaultFilter);
      if (this.settings.regexFilter) {
        try {
          filterRegex = new RegExp(this.settings.regexFilter);
          console.log(filterRegex); // DWM::
        } catch (e) { }
      }
      if (text && text.length > 0 && !filterRegex.test(text)) {
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
    this.releaseWakeLock();
    const wasCapturing = this.captureActive;
    this.teardownContinuousCapture();
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
    if (wasCapturing) {
      // Hand any remaining captured audio to the segmenter, then transcribe
      // whatever is still buffered when recording ends.
      this.drainPendingInput();
      if (this.segmenter) {
        const remaining = this.segmenter.flush();
        this.segmenter = null;
        for (const segment of remaining) {
          this.transcribeSegment(segment);
        }
      }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
        this.mediaStream = null;
      }
    }
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
      .setName('Version')
      .setDesc(this.plugin.manifest.version || 'unknown');
    new Setting(containerEl)
      .setName('Model')
      .setDesc('Smaller = faster, less accurate. Downloaded on first use.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('onnx-community/whisper-tiny.en', 'Tiny English')
          .addOption('onnx-community/whisper-base.en', 'Base English')
          .addOption('onnx-community/whisper-small.en', 'Small English')
          .addOption('onnx-community/whisper-medium.en', 'Medium English')
          .addOption('onnx-community/whisper-tiny', 'Tiny')
          .addOption('onnx-community/whisper-base', 'Base')
          .addOption('onnx-community/whisper-small', 'Small')
          .addOption('onnx-community/whisper-medium', 'Medium')
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
    if (isWindowsDesktop || isMobilePlatform) {
      new Setting(containerEl)
        .setName('Compute device')
        .setDesc(
          isWindowsDesktop
            ? 'CPU is the default. "GPU if available" downloads a CUDA-enabled whisper binary on first use, uses an NVIDIA GPU when one is present, and falls back to the CPU otherwise.'
            : 'CPU is the default. "GPU if available" uses WebGPU when the browser provides it and falls back to the CPU otherwise.'
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption('cpu', 'CPU')
            .addOption('gpu', 'GPU if available')
            .setValue(this.plugin.settings.computeDevice)
            .onChange(async (value) => {
              this.plugin.settings.computeDevice = value;
              this.plugin.transcriber = null;
              this.plugin.desktopTranscriber = null;
              await this.plugin.saveSettings();
              new Notice('Compute device changed. Takes effect on next recording.');
            })
        );
    }
    new Setting(containerEl)
      .setName('Chunk duration (seconds)')
      .setDesc(
        'Target chunk length. A chunk is transcribed at the first speech pause at or after this length, or forcibly at this length plus 2.5 seconds. 10-15s recommended.'
      )
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
      .setName('Regex Filter')
      .setDesc('Regex pattern for filtering out unwanted transcription fragments. Models often emit incorrect noise, especially during silence.  Default filters "you", "okay", and bracketed text.')
      .addText((text) =>
        text
          .setPlaceholder('Enter regex pattern')
          .setValue(this.plugin.settings.regexFilter)
          .onChange(async (value) => {
            this.plugin.settings.regexFilter = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName('Check model cache')
      .setDesc('See if the current model is cached for offline use, or download it now')
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
      )
      .addButton((button) =>
        button
          .setButtonText('Download')
          .onClick(async () => {
            button.setDisabled(true);
            try {
              // Progress is shown via status notices during the download.
              const success = await this.plugin.downloadOfflineAssets();
              if (success) {
                new Notice('Model downloaded - offline ready');
              }
            } catch (err) {
              log('Download button failed', err);
              new Notice('Download failed: ' + err.message, 5000);
            } finally {
              button.setDisabled(false);
            }
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
                if (!this.plugin.desktopTranscriber) {
                  this.plugin.desktopTranscriber = new DesktopTranscriber(this.plugin);
                }
                this.plugin.desktopTranscriber.clearCache();
                new Notice('Cache cleared');
              } else {
                const cacheNames = await caches.keys();
                for (const name of cacheNames) {
                  if (name.includes('transformers') || name.includes('xenova') || name.includes('huggingface') || name.includes('onnx-community')) {
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
module.exports.WhisperSettingTab = WhisperSettingTab;
