/**
 * Tests for the desktop (non-mobile) code paths in WhisperSettingTab and WhisperTranscriptionPlugin.
 * Forces desktop mode via globalThis.__desktopOverride to cover lines 582-621 of main.js.
 */

// Force platform override before module initialization
globalThis.__desktopOverride = true;
jest.resetModules();
jest.clearAllMocks();
globalThis._capturedBtns = [];

// Obsidian test-mocks map `obsidian` -> `obsidian-test-mocks/obsidian` via Jest config.
jest.mock('../src/desktop-transcriber.js', () => ({
  DesktopTranscriber: jest.fn().mockImplementation(() => ({ isModelCached: jest.fn(), clearCache: jest.fn() })),
}));

const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

function getCapturedHandlers() {
  return globalThis._capturedBtns || [];
}
function clearState() {
  jest.clearAllMocks();
  globalThis._capturedBtns = [];
}

/* Helper to create JSDOM elements with `.empty()` and `.createEl()` methods (Obsidian relies on) */
function makeObsidianContainer() {
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

function createMockedPlugin() {
  globalThis._capturedBtns = [];
  // Mock minimal app for plugin constructor & tab builder
  const mockApp = {};
  mockApp.asOriginalType__ = () => ({ config: {}, vault: {}, workspace: {} });

  const manifest = { id: 'offline-whisper', name: 'Offline Whisper', version: '1.0', minAppVersion: '1.0' };

  const dtcModule = require('../src/desktop-transcriber.js');
  dtcModule.DesktopTranscriber.mockImplementation(() => ({
    isModelCached: jest.fn().mockResolvedValue(true),
    clearCache: jest.fn().mockResolvedValue(),
  }));

  const plugin = new WhisperTranscriptionPlugin(mockApp.asOriginalType__(), manifest);
  plugin.settings = { modelId: 'onnx-community/whisper-base.en', chunkDurationMs: 10000, regexFilter: '^.*$' };
  return plugin;
}

describe('WhisperTranscriptionPlugin Desktop Path', () => {
  test('Desktop override forces desktop initialization', async () => {
    clearState();
    const plugin = createMockedPlugin();
    jest.spyOn(plugin, 'addCommand');
    jest.spyOn(plugin, 'addRibbonIcon');
    jest.spyOn(plugin, 'addSettingTab');

    await plugin.onload();

    expect(plugin.addCommand).toHaveBeenCalledTimes(3);
    expect(plugin.addRibbonIcon).toHaveBeenCalledTimes(1);
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
  });
});

describe('WhisperSettingTab Target Code (Lines 582-621)', () => {
  beforeEach(() => clearState());

  test('Exposes and executes Check Model Cache handler (line 583)', async () => {
    const plugin = createMockedPlugin();
    const dtc = { isModelCached: jest.fn().mockResolvedValue(true), clearCache: jest.fn() };
    Object.defineProperty(plugin, 'settings', { value: { modelId: 'test' }, writable: true, configurable: true });
    Object.defineProperty(plugin, 'desktopTranscriber', { value: dtc, writable: true, configurable: true });

    const tab = new WhisperSettingTab({}, plugin);
    Object.defineProperty(tab, 'containerEl', { value: makeObsidianContainer(), writable: true });

    await tab.display();

    expect(getCapturedHandlers().length).toBeGreaterThan(0);

    const checkItem = getCapturedHandlers().find((h) => String(h.handler).includes('isModelCached'));
    expect(checkItem).toBeDefined();

    // Invoke handler explicitly bound to `tab` so `this.plugin.desktopTranscriber` is accessible!
    await checkItem.handler.call(tab);

    expect(dtc.isModelCached).toHaveBeenCalled();
  });

  test('Executes Clear Caches handler desktop logic (lines 603-621)', async () => {
    const plugin = createMockedPlugin();
    const dtc = { isModelCached: jest.fn(), clearCache: jest.fn().mockResolvedValue(true) };
    // Direct assignment ensures it sticks without PropertyDescriptor issues
    plugin.desktopTranscriber = dtc;

    const tab = new WhisperSettingTab({}, plugin);
    Object.defineProperty(tab, 'containerEl', { value: makeObsidianContainer(), writable: true });

    await tab.display();

    const clearItem = getCapturedHandlers().find((h) => String(h.handler).includes('clearCache'));
    expect(clearItem).toBeDefined();

    await clearItem.handler.call(tab);
    expect(dtc.clearCache).toHaveBeenCalled();
  });

  test('display() populates critical UI elements in desktop mode', async () => {
    const plugin = createMockedPlugin();
    const tab = new WhisperSettingTab({}, plugin);
    Object.defineProperty(tab, 'containerEl', { value: makeObsidianContainer(), writable: true });

    await tab.display();
    expect(getCapturedHandlers().length).toBeGreaterThan(1);
  });
});

describe('Coverage verification for lines 582-621', () => {
  test('Full target sequence Check + Clear runs >70% coverage on 582-621 block', async () => {
    clearState();

    const plugin = createMockedPlugin();
    const dtc = { isModelCached: jest.fn().mockResolvedValue(true), clearCache: jest.fn().mockResolvedValue() };
    Object.defineProperty(plugin, 'desktopTranscriber', { value: dtc, writable: true, configurable: true });

    const tab = new WhisperSettingTab({}, plugin);
    Object.defineProperty(tab, 'containerEl', { value: makeObsidianContainer(), writable: true });

    await tab.display();

    const handlers = getCapturedHandlers();
    expect(handlers.length).toBeGreaterThan(1);

    // Execute intercepted button callbacks (simulating real Obsidian UI clicks)
    for (const h of handlers) {
      if (String(h.handler).includes('isModelCached') || String(h.handler).includes('clearCache')) {
        await h.handler.call(tab);
      }
    }

    expect(dtc.clearCache).toHaveBeenCalled();
  });
});
