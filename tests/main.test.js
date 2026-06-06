const { App } = require('obsidian-test-mocks/obsidian');
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

describe('WhisperTranscriptionPlugin', () => {
  test('onload registers three commands, a ribbon icon, and a setting tab', async () => {
    const { plugin } = createPlugin();
    const addCommand = jest.spyOn(plugin, 'addCommand');
    const addRibbonIcon = jest.spyOn(plugin, 'addRibbonIcon');
    const addSettingTab = jest.spyOn(plugin, 'addSettingTab');
    await plugin.onload();
    expect(addCommand).toHaveBeenCalledTimes(3);
    expect(addRibbonIcon).toHaveBeenCalledTimes(1);
    expect(addSettingTab).toHaveBeenCalledTimes(1);
  });

  test('loadSettings applies defaults', async () => {
    const { plugin } = createPlugin();
    await plugin.loadSettings();
    expect(plugin.settings.modelId).toBe('onnx-community/whisper-base.en');
    expect(plugin.settings.chunkDurationMs).toBe(10000);
  });

  test('startRecording aborts when no markdown view is active', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();
    app.workspace.getActiveViewOfType = () => null;
    await plugin.toggleRecording(true);
    expect(plugin.isRecording).toBe(false);
  });
});

describe('WhisperSettingTab', () => {
  test('display populates the container with settings', () => {
    const { app, plugin } = createPlugin();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    tab.display();
    expect(tab.containerEl.childElementCount).toBeGreaterThan(0);
  });
});
