// Desktop-only cleanup wiring: the settings page and the native engine
// lifecycle. Runs with the desktop override so main.js takes the desktop
// path, with the engine module mocked out.
globalThis.__desktopOverride = true;

jest.mock('../src/desktop-cleanup.js', () => {
  const instances = [];
  class NativeTextCleaner {
    constructor(plugin) {
      this.plugin = plugin;
      this.modelId = null;
      this.disposed = false;
      this.initializedCount = 0;
      instances.push(this);
    }
    isReady() {
      return this.initializedCount > 0;
    }
    async isCached() {
      return false;
    }
    async initialize(modelId) {
      this.modelId = modelId;
      this.initializedCount++;
      return true;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return {
    NativeTextCleaner,
    instances,
    DESKTOP_CLEANUP_MODELS: [
      { id: 'qwen2.5-0.5b-instruct-q4_k_m', label: 'Qwen 2.5 0.5B (smaller, faster)' },
      { id: 'qwen2.5-1.5b-instruct-q4_k_m', label: 'Qwen 2.5 1.5B (more accurate, slower)' },
    ],
    DEFAULT_DESKTOP_CLEANUP_MODEL_ID: 'qwen2.5-0.5b-instruct-q4_k_m',
  };
});

const { App } = require('obsidian-test-mocks/obsidian');
const mockedEngine = require('../src/desktop-cleanup.js');
const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

function createPlugin() {
  const app = App.createConfigured__();
  const manifest = {
    id: 'offline-whisper',
    name: 'Offline Whisper Transcription',
    version: '1.0.0',
    minAppVersion: '1.0.0',
    description: 'Offline speech-to-text using Whisper',
    author: 'David Manthey',
    dir: '.obsidian/plugins/offline-whisper',
  };
  const plugin = new WhisperTranscriptionPlugin(app.asOriginalType__(), manifest);
  return { app, plugin };
}

async function displayTab(app, plugin) {
  globalThis._capturedToggles = [];
  globalThis._capturedDropdowns = [];
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
  const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
  tab.containerEl = el;
  tab.display();
  return tab;
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

describe('desktop cleanup wiring', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = silenceLogs();
    mockedEngine.instances.length = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('defaults to the desktop GGUF model', async () => {
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    expect(plugin.settings.cleanupModelId).toBe('qwen2.5-0.5b-instruct-q4_k_m');
  });

  test('remaps a stored mobile cleanup model to the desktop default', async () => {
    const { plugin } = createPlugin();
    jest.spyOn(plugin, 'loadData').mockResolvedValue({ cleanupModelId: 'onnx-community/Qwen2.5-0.5B-Instruct' });
    await plugin.loadSettings();
    expect(plugin.settings.cleanupModelId).toBe('qwen2.5-0.5b-instruct-q4_k_m');
  });

  test('loadCleanupModel starts the native engine', async () => {
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    plugin.settings.cleanupText = true;
    await expect(plugin.loadCleanupModel()).resolves.toBe(true);
    expect(mockedEngine.instances).toHaveLength(1);
    expect(mockedEngine.instances[0].modelId).toBe('qwen2.5-0.5b-instruct-q4_k_m');
    expect(plugin.textCleaner.isReady()).toBe(true);
  });

  test('resetCleanupModel disposes the engine process', async () => {
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    plugin.settings.cleanupText = true;
    await plugin.loadCleanupModel();
    const engine = mockedEngine.instances[0];
    plugin.resetCleanupModel();
    expect(engine.disposed).toBe(true);
    expect(plugin.textCleaner).toBe(null);
  });

  test('the settings page offers a cleanup toggle and GGUF model dropdown', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    await displayTab(app, plugin);
    expect(globalThis._capturedToggles).toHaveLength(1);
    expect(globalThis._capturedToggles[0].value).toBe(false);
    const cleanupDropdowns = globalThis._capturedDropdowns.filter((d) => d.value === 'qwen2.5-0.5b-instruct-q4_k_m');
    expect(cleanupDropdowns).toHaveLength(1);
    const dropdown = cleanupDropdowns[0].dropdown;
    expect(dropdown['qwen2.5-0.5b-instruct-q4_k_m']).toContain('Qwen 2.5 0.5B');
    expect(dropdown['qwen2.5-1.5b-instruct-q4_k_m']).toContain('Qwen 2.5 1.5B');
  });

  test('changing the cleanup model saves the setting and resets the engine', async () => {
    const { app, plugin } = createPlugin();
    await plugin.loadSettings();
    plugin.settings.cleanupText = true;
    await plugin.loadCleanupModel();
    const engine = mockedEngine.instances[0];
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    await displayTab(app, plugin);
    const dropdownEntry = globalThis._capturedDropdowns.find((d) => d.value === 'qwen2.5-0.5b-instruct-q4_k_m');
    await dropdownEntry.onChange('qwen2.5-1.5b-instruct-q4_k_m');
    expect(plugin.settings.cleanupModelId).toBe('qwen2.5-1.5b-instruct-q4_k_m');
    expect(saveSpy).toHaveBeenCalled();
    expect(engine.disposed).toBe(true);
    expect(plugin.textCleaner).toBe(null);
  });
});
