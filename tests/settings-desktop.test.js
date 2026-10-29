// Desktop-mode settings tab tests. Forces desktop via globalThis.__desktopOverride
// before module load, and pins a non-Windows platform so the Windows-only
// compute device setting is hidden regardless of the host OS. Windows-specific
// behavior lives in settings-windows.test.js.
globalThis.__desktopOverride = true;
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });
jest.mock('../src/desktop-transcriber.js', () => ({
  DesktopTranscriber: jest.fn(),
}));

const WhisperTranscriptionPlugin = require('../src/main.js');
const { WhisperSettingTab } = WhisperTranscriptionPlugin;

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function makeManifest() {
  return {
    id: 'offline-whisper',
    name: 'Offline Whisper Transcription',
    version: '1.0.0',
    minAppVersion: '1.0.0',
    description: 'Offline speech-to-text using Whisper',
    author: 'David Manthey',
    dir: '.obsidian/plugins/offline-whisper',
  };
}

async function createPlugin() {
  const app = { asOriginalType__: () => ({ config: {}, vault: {}, workspace: {} }) };
  const plugin = new WhisperTranscriptionPlugin(app.asOriginalType__(), makeManifest());
  await plugin.loadSettings();
  return plugin;
}

async function displayTab(plugin) {
  globalThis._capturedBtns = [];
  globalThis._capturedDropdowns = [];
  const tab = new WhisperSettingTab({}, plugin);
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
  tab.containerEl = el;
  tab.display();
  return { tab, containerEl: el };
}

function silenceLogs() {
  return jest.spyOn(console, 'log').mockImplementation(() => {});
}

function makeDtc(overrides = {}) {
  return {
    isModelCached: jest.fn(() => true),
    isExecutableCached: jest.fn(() => true),
    clearCache: jest.fn(),
    initialize: jest.fn().mockResolvedValue(undefined),
    transcribe: jest.fn(async () => ({ text: '' })),
    ...overrides,
  };
}

describe('WhisperSettingTab (desktop, non-Windows)', () => {
  let DesktopTranscriber;

  beforeEach(() => {
    ({ DesktopTranscriber } = require('../src/desktop-transcriber.js'));
    DesktopTranscriber.mockImplementation(() => makeDtc());
  });

  test('the compute device setting is hidden where no GPU binary exists', async () => {
    const plugin = await createPlugin();
    const { containerEl } = await displayTab(plugin);
    expect(containerEl.innerHTML).not.toContain('Compute device');
  });

  test('changing the model with a loaded transcriber consults it', async () => {
    const plugin = await createPlugin();
    const dtc = makeDtc();
    plugin.desktopTranscriber = dtc;
    plugin.transcriber = jest.fn();
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const entry = globalThis._capturedDropdowns.find((d) => d.value === plugin.settings.modelId);
    await entry.onChange('onnx-community/whisper-small');

    expect(dtc.isModelCached).toHaveBeenCalledWith('onnx-community/whisper-small');
    expect(plugin.settings.modelId).toBe('onnx-community/whisper-small');
    expect(plugin.transcriber).toBeNull();
    expect(saveSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Notice] Model changed (already cached).');
    logSpy.mockRestore();
  });

  test('changing the model without a transcriber builds a temporary one', async () => {
    const plugin = await createPlugin();
    const dtc = makeDtc({ isModelCached: jest.fn(() => false) });
    DesktopTranscriber.mockImplementation(() => dtc);
    plugin.desktopTranscriber = null;
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const entry = globalThis._capturedDropdowns.find((d) => d.value === plugin.settings.modelId);
    await entry.onChange('onnx-community/whisper-small');

    expect(DesktopTranscriber).toHaveBeenCalledWith(plugin);
    expect(dtc.isModelCached).toHaveBeenCalledWith('onnx-community/whisper-small');
    expect(logSpy).toHaveBeenCalledWith('[Notice] Model changed. New model loads on next recording.');
    logSpy.mockRestore();
  });

  test('Clear Cache uses the loaded transcriber', async () => {
    const plugin = await createPlugin();
    const dtc = makeDtc();
    plugin.desktopTranscriber = dtc;
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const clearItem = globalThis._capturedBtns.find((h) => String(h.handler).includes('clearCache'));
    await clearItem.handler();

    expect(dtc.clearCache).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[Notice] Cache cleared');
    logSpy.mockRestore();
  });

  test('Clear Cache builds a transcriber when none is loaded', async () => {
    const plugin = await createPlugin();
    plugin.desktopTranscriber = null;
    const dtc = makeDtc();
    DesktopTranscriber.mockImplementation(() => dtc);
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const clearItem = globalThis._capturedBtns.find((h) => String(h.handler).includes('clearCache'));
    await clearItem.handler();

    expect(DesktopTranscriber).toHaveBeenCalled();
    expect(dtc.clearCache).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[Notice] Cache cleared');
    logSpy.mockRestore();
  });

  test('Clear Cache reports failures', async () => {
    const plugin = await createPlugin();
    plugin.desktopTranscriber = makeDtc({
      clearCache: jest.fn(() => {
        throw new Error('cannot remove');
      }),
    });
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const clearItem = globalThis._capturedBtns.find((h) => String(h.handler).includes('clearCache'));
    await clearItem.handler();

    expect(logSpy).toHaveBeenCalledWith('[Notice] Failed to clear cache: cannot remove');
    logSpy.mockRestore();
  });
});
