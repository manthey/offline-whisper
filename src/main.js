const { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, setIcon, Menu, Modal, FuzzySuggestModal } = require('obsidian');

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'webm'];
const TRANSCRIBE_PLACEHOLDER = '_Transcribing..._';

function isAudioEmbed(linkpath) {
  const ext = linkpath.split('.').pop().toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

let pipeline, env, DesktopTranscriber;

// Allow testing to override platform detection via globalThis.__desktopOverride
// Set to true in tests to force desktop code path
const _platformOverride = typeof globalThis.__desktopOverride !== 'undefined' ? globalThis.__desktopOverride : undefined;
const isMobilePlatform = _platformOverride !== undefined ? !_platformOverride : (typeof process === 'undefined' || !process.versions || !process.versions.electron);

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
    headingLevel: 2,
  };
  transcriber = null;
  desktopTranscriber = null;
  isRecording = false;
  isFileTranscribing = false;
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

    // File transcription: command palette + sidebar icon open the file picker.
    this.addCommand({
      id: 'transcribe-audio-in-note',
      name: 'Transcribe audio in this note',
      callback: () => this.pickAudioFile(),
    });
    this.addRibbonIcon('file-audio', 'Transcribe audio in this note', () => this.pickAudioFile());

    // Inline Transcribe buttons: post processor for Reading view,
    // MutationObserver for Live Preview (post processor does not run there).
    this.registerMarkdownPostProcessor((el) => this.addTranscribeButtons(el));
    this.embedObserver = new MutationObserver(() => this.addTranscribeButtons(document.body));
    this.embedObserver.observe(document.body, { childList: true, subtree: true });

    // Right-click menu on audio embeds (the player's native menu cannot be extended).
    this.registerDomEvent(document, 'contextmenu', (evt) => {
      const embed = evt.target && evt.target.closest ? evt.target.closest('.internal-embed') : null;
      const src = embed ? embed.getAttribute('src') : null;
      if (src && isAudioEmbed(src)) {
        evt.preventDefault();
        new Menu().addItem((item) => item.setTitle('Transcribe').setIcon('mic').onClick(() => this.transcribeFile(src))).showAtMouseEvent(evt);
      }
    });

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
      await this.acquireWakeLock();
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

  addTranscribeButtons(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    root.querySelectorAll('.internal-embed').forEach((embed) => {
      const src = embed.getAttribute('src');
      if (!src || !isAudioEmbed(src) || embed.querySelector('.transcribe-audio-btn')) {
        return;
      }
      const btn = document.createElement('button');
      btn.textContent = 'Transcribe';
      btn.className = 'transcribe-audio-btn';
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.transcribeFile(src);
      });
      embed.appendChild(btn);
      log('Added transcribe button for: ' + src);
    });
  }

  pickAudioFile() {
    const editor = this.app.workspace.activeEditor ? this.app.workspace.activeEditor.editor : null;
    if (!editor) {
      new Notice('No active note');
      return;
    }
    const regex = new RegExp('\\!\\[\\[([^\\]\\|]+\\.(?:' + AUDIO_EXTENSIONS.join('|') + '))(?:\\|[^\\]]*)?\\]\\]', 'gi');
    const links = [];
    let match;
    while ((match = regex.exec(editor.getValue())) !== null) {
      links.push(match[1]);
    }
    if (!links.length) {
      new Notice('No audio embeds in this note');
      return;
    }
    new AudioSuggestModal(this.app, links, (link) => this.transcribeFile(link)).open();
  }

  async decodeAudioFile(file) {
    log('Reading audio file: ' + file.path);
    const arrayBuffer = await this.app.vault.adapter.readBinary(file.path);
    log('Audio file size: ' + arrayBuffer.byteLength);
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    log('Decoded audio file', { sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration });
    let audioData = audioBuffer.getChannelData(0);
    if (audioBuffer.sampleRate !== 16000) {
      log('Resampling from ' + audioBuffer.sampleRate + ' to 16000');
      audioData = this.resampleAudio(audioData, audioBuffer.sampleRate, 16000);
    }
    for (let i = 0; i < audioData.length; i++) {
      if (audioData[i] > 1) audioData[i] = 1;
      if (audioData[i] < -1) audioData[i] = -1;
    }
    return audioData;
  }

  async transcribeFile(linkpath) {
    if (this.isFileTranscribing) {
      new Notice('A file transcription is already running');
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    const editor = this.app.workspace.activeEditor ? this.app.workspace.activeEditor.editor : null;
    if (!activeFile || !editor) {
      new Notice('No active note');
      return;
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, activeFile.path);
    if (!file) {
      new Notice('File not found: ' + linkpath);
      return;
    }
    let embedLine = -1;
    for (let i = 0; i < editor.lineCount(); i++) {
      if (editor.getLine(i).includes('![[' + linkpath)) {
        embedLine = i;
        break;
      }
    }
    if (embedLine === -1) {
      new Notice('Embed not found in the active note');
      return;
    }

    // Existing transcript check: first non-blank line after the embed.
    let sectionEnd = embedLine;
    let next = embedLine + 1;
    while (next < editor.lineCount() && !editor.getLine(next).trim()) {
      next++;
    }
    if (next < editor.lineCount() && /^#+ Transcription\s*$/.test(editor.getLine(next))) {
      log('Existing transcription found at line ' + next);
      if (!(await confirmReplaceTranscription(this.app))) {
        return;
      }
      sectionEnd = next;
      while (sectionEnd + 1 < editor.lineCount() && !/^#/.test(editor.getLine(sectionEnd + 1))) {
        sectionEnd++;
      }
    }

    const heading = '#'.repeat(this.settings.headingLevel) + ' Transcription';
    const placeholder = '\n\n' + heading + '\n\n' + TRANSCRIBE_PLACEHOLDER;
    const from = { line: embedLine, ch: editor.getLine(embedLine).length };
    const to = { line: sectionEnd, ch: editor.getLine(sectionEnd).length };
    const oldText = editor.getRange(from, to);
    editor.replaceRange(placeholder, from, to);
    log('Inserted placeholder for: ' + linkpath);

    this.isFileTranscribing = true;
    try {
      if (!(await this.loadModel())) {
        throw new Error('Model not available');
      }
      const audioData = await this.decodeAudioFile(file);
      const result = await this.transcriber(audioData);
      const text = result.text ? result.text.trim() : '';
      // Re-locate the placeholder; the note may have been edited meanwhile.
      const placeholderLine = this.findPlaceholderLine(editor);
      if (placeholderLine === -1) {
        throw new Error('Placeholder removed from note');
      }
      if (text && !this.getFilterRegex().test(text)) {
        editor.setLine(placeholderLine, text);
        new Notice('Transcribed');
      } else {
        this.removePlaceholderSection(editor, placeholderLine, oldText);
        new Notice('No speech detected in ' + linkpath);
      }
    } catch (error) {
      log('File transcription FAILED', error);
      const placeholderLine = this.findPlaceholderLine(editor);
      if (placeholderLine !== -1) {
        this.removePlaceholderSection(editor, placeholderLine, oldText);
      }
      new Notice('Transcription failed: ' + error.message);
    } finally {
      this.isFileTranscribing = false;
    }
  }

  getFilterRegex() {
    if (this.settings.regexFilter) {
      try {
        return new RegExp(this.settings.regexFilter);
      } catch (e) {}
    }
    return new RegExp(this.defaultFilter);
  }

  findPlaceholderLine(editor) {
    for (let i = 0; i < editor.lineCount(); i++) {
      if (editor.getLine(i).includes(TRANSCRIBE_PLACEHOLDER)) {
        return i;
      }
    }
    return -1;
  }

  removePlaceholderSection(editor, placeholderLine, oldText) {
    // Placeholder block: embed line, blank, heading, blank, placeholder.
    if (placeholderLine >= 4) {
      const endOfEmbed = { line: placeholderLine - 4, ch: editor.getLine(placeholderLine - 4).length };
      editor.replaceRange(oldText, endOfEmbed, { line: placeholderLine, ch: editor.getLine(placeholderLine).length });
    } else {
      editor.setLine(placeholderLine, '');
    }
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
    if (this.embedObserver) {
      this.embedObserver.disconnect();
    }
  }
}

function confirmReplaceTranscription(app) {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let resolved = false;
    const finish = (value) => {
      resolved = true;
      resolve(value);
      modal.close();
    };
    modal.contentEl.createEl('p', { text: 'Replace existing transcription?' });
    const row = modal.contentEl.createDiv({ cls: 'transcribe-modal-buttons' });
    const replaceBtn = row.createEl('button', { text: 'Replace' });
    replaceBtn.addEventListener('click', () => finish(true));
    const cancelBtn = row.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => finish(false));
    modal.onClose = () => {
      if (!resolved) {
        resolve(false);
      }
    };
    modal.open();
  });
}

class AudioSuggestModal extends FuzzySuggestModal {
  constructor(app, links, onPick) {
    super(app);
    this.links = links;
    this.onPick = onPick;
  }
  getItems() {
    return this.links;
  }
  getItemText(link) {
    return link.split('/').pop();
  }
  onChooseItem(link) {
    this.onPick(link);
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
    new Setting(containerEl)
      .setName('Transcript heading level')
      .setDesc('Number of # characters in the heading written above each audio file transcript (1-6).')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('1', '1')
          .addOption('2', '2')
          .addOption('3', '3')
          .addOption('4', '4')
          .addOption('5', '5')
          .addOption('6', '6')
          .setValue(String(this.plugin.settings.headingLevel))
          .onChange(async (value) => {
            this.plugin.settings.headingLevel = parseInt(value, 10);
            await this.plugin.saveSettings();
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
