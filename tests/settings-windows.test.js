// Windows-desktop settings tab tests. Forces desktop mode and a win32 platform
// before module load so the Windows-only compute device setting is exercised.
globalThis.__desktopOverride = true;
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32' });
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

describe('WhisperSettingTab (desktop, Windows)', () => {
  test('the compute device setting describes the CUDA build', async () => {
    const plugin = await createPlugin();
    const { containerEl } = await displayTab(plugin);
    expect(containerEl.innerHTML).toContain('Compute device');
    expect(containerEl.innerHTML).toContain('CUDA-enabled whisper binary');
  });

  test('changing the compute device saves and clears both transcribers', async () => {
    const plugin = await createPlugin();
    plugin.transcriber = jest.fn();
    plugin.desktopTranscriber = { clearCache: jest.fn() };
    const saveSpy = jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
    const logSpy = silenceLogs();
    await displayTab(plugin);

    const entry = globalThis._capturedDropdowns.find((d) => d.value === 'cpu');
    expect(entry).toBeDefined();
    await entry.onChange('gpu');

    expect(plugin.settings.computeDevice).toBe('gpu');
    expect(plugin.transcriber).toBeNull();
    expect(plugin.desktopTranscriber).toBeNull();
    expect(saveSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Notice] Compute device changed. Takes effect on next recording.');
    logSpy.mockRestore();
  });
});
