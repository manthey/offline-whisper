const { App } = require('obsidian-test-mocks/obsidian');
const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

function createPlugin() {
  const app = App.createConfigured__();
  const manifest = {
    id: 'offline-whisper',
    name: 'Offline Whisper Transcription',
    version: '1.2.3',
    minAppVersion: '1.0.0',
    description: 'Offline speech-to-text using Whisper',
    author: 'David Manthey',
    dir: '.obsidian/plugins/offline-whisper',
  };
  const plugin = new WhisperTranscriptionPlugin(app.asOriginalType__(), manifest);
  return { app, plugin };
}

function makeContainer() {
  const el = document.createElement('div');
  el.empty = () => {
    el.innerHTML = '';
  };
  el.createEl = (tag, attrs) => {
    const child = document.createElement(tag);
    if (attrs && attrs.text) child.textContent = attrs.text;
    el.appendChild(child);
    return child;
  };
  return el;
}

async function displayTab(app, plugin) {
  globalThis._capturedBtns = [];
  globalThis._capturedDropdowns = [];
  globalThis._capturedSliders = [];
  globalThis._capturedTexts = [];
  const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
  const containerEl = makeContainer();
  tab.containerEl = containerEl;
  tab.display();
  return { tab, containerEl };
}

function findDropdown() {
  return globalThis._capturedDropdowns || [];
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

describe('WhisperSettingTab (mobile)', () => {
  let mockCaches;

  beforeEach(() => {
    mockCaches = { keys: jest.fn(() => Promise.resolve([])), delete: jest.fn(() => Promise.resolve(true)) };
    Object.defineProperty(global, 'caches', { value: mockCaches, writable: true, configurable: true });
  });

  test('display renders every settings section', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const { containerEl } = await displayTab(app, plugin);

    for (const section of [
      'Whisper Transcription Settings',
      'Version',
      'Model',
      'Compute device',
      'Chunk duration (seconds)',
      'Regex Filter',
      'Check model cache',
      'Clear Caches',
    ]) {
      expect(containerEl.innerHTML).toContain(section);
    }
  });

  test('display shows the plugin version', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const { containerEl } = await displayTab(app, plugin);

    expect(containerEl.innerHTML).toContain('1.2.3');
  });

  test('display clears the container before populating it', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const { tab, containerEl } = await displayTab(app, plugin);
    const emptySpy = jest.spyOn(containerEl, 'empty');
    tab.display();
    expect(emptySpy).toHaveBeenCalled();
  });

  test('the model dropdown offers all supported models and reflects the current setting', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    await displayTab(app, plugin);

    const modelDropdowns = findDropdown().filter((d) => d.value === plugin.settings.modelId);
    expect(modelDropdowns.length).toBeGreaterThan(0);
    const dropdown = modelDropdowns[0].dropdown;
    expect(dropdown['onnx-community/whisper-tiny.en']).toBe('Tiny English');
    expect(dropdown['onnx-community/whisper-base.en']).toBe('Base English');
    expect(dropdown['onnx-community/whisper-small.en']).toBe('Small English');
    expect(dropdown['onnx-community/whisper-medium.en']).toBe('Medium English');
    expect(dropdown['onnx-community/whisper-tiny']).toBe('Tiny');
    expect(dropdown['onnx-community/whisper-base']).toBe('Base');
    expect(dropdown['onnx-community/whisper-small']).toBe('Small');
    expect(dropdown['onnx-community/whisper-medium']).toBe('Medium');
  });

  test('changing the model saves, clears the transcriber, and notes a cache miss', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    plugin.transcriber = jest.fn();
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    const logSpy = silenceLogs();
    await displayTab(app, plugin);

    const entry = findDropdown().find((d) => d.value === 'onnx-community/whisper-base.en');
    await entry.onChange('onnx-community/whisper-small');

    expect(plugin.settings.modelId).toBe('onnx-community/whisper-small');
    expect(plugin.transcriber).toBeNull();
    expect(saveSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Notice] Model changed. New model loads on next recording.');
    logSpy.mockRestore();
  });

  test('changing the model notes when the new model is already cached', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    mockCaches.keys.mockResolvedValue(['transformers-cache']);
    mockCaches.open = jest.fn(() =>
      Promise.resolve({
        keys: jest.fn(() =>
          Promise.resolve([{ url: 'https://huggingface.co/onnx-community/whisper-small/config.json' }]),
        ),
      }),
    );
    const logSpy = silenceLogs();
    await displayTab(app, plugin);

    const entry = findDropdown().find((d) => d.value === 'onnx-community/whisper-base.en');
    await entry.onChange('onnx-community/whisper-small');

    expect(logSpy).toHaveBeenCalledWith('[Notice] Model changed (already cached).');
    logSpy.mockRestore();
  });

  test('the compute device dropdown offers CPU and GPU and saves changes', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    const logSpy = silenceLogs();
    await displayTab(app, plugin);

    const entry = findDropdown().find((d) => d.value === 'cpu');
    expect(entry).toBeDefined();
    expect(entry.dropdown.cpu).toBe('CPU');
    expect(entry.dropdown.gpu).toBe('GPU if available');

    await entry.onChange('gpu');

    expect(plugin.settings.computeDevice).toBe('gpu');
    expect(plugin.transcriber).toBeNull();
    expect(plugin.desktopTranscriber).toBeNull();
    expect(saveSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Notice] Compute device changed. Takes effect on next recording.');
    logSpy.mockRestore();
  });

  test('the chunk duration slider writes milliseconds and saves', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    await displayTab(app, plugin);

    const sliderEntry = (globalThis._capturedSliders || [])[0];
    expect(sliderEntry).toBeDefined();
    expect(sliderEntry.value).toBe(10);

    await sliderEntry.onChange(15);

    expect(plugin.settings.chunkDurationMs).toBe(15000);
    expect(saveSpy).toHaveBeenCalled();
  });

  test('the regex filter text field writes and saves the pattern', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    await displayTab(app, plugin);

    const textEntry = (globalThis._capturedTexts || [])[0];
    expect(textEntry).toBeDefined();
    expect(textEntry.value).toBe(plugin.settings.regexFilter);

    await textEntry.onChange('^nope$');

    expect(plugin.settings.regexFilter).toBe('^nope$');
    expect(saveSpy).toHaveBeenCalled();
  });

  test('Clear Cache deletes only whisper-related caches', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    mockCaches.keys.mockResolvedValue([
      'transformers-cache',
      'obsidian-linter',
      'xenova-models',
      'huggingface-data',
      'onnx-community-blobs',
    ]);
    const logSpy = silenceLogs();
    await displayTab(app, plugin);

    const clearItem = globalThis._capturedBtns.find((h) => String(h.handler).includes('caches.delete'));
    await clearItem.handler();

    expect(logSpy).toHaveBeenCalledWith('[Notice] Cache cleared');
    expect(mockCaches.delete).toHaveBeenCalledTimes(4);
    expect(mockCaches.delete).toHaveBeenCalledWith('transformers-cache');
    expect(mockCaches.delete).toHaveBeenCalledWith('xenova-models');
    expect(mockCaches.delete).toHaveBeenCalledWith('huggingface-data');
    expect(mockCaches.delete).toHaveBeenCalledWith('onnx-community-blobs');
    expect(mockCaches.delete).not.toHaveBeenCalledWith('obsidian-linter');
    logSpy.mockRestore();
  });

  test('Clear Cache reports failures', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    mockCaches.keys.mockRejectedValue(new Error('storage unavailable'));
    const logSpy = silenceLogs();
    await displayTab(app, plugin);

    const clearItem = globalThis._capturedBtns.find((h) => String(h.handler).includes('caches.delete'));
    await clearItem.handler();

    expect(logSpy).toHaveBeenCalledWith('[Notice] Failed to clear cache: storage unavailable');
    logSpy.mockRestore();
  });
});
