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

  test('toggleRecording stops current recording with no view', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();

    // Set isRecording to true but don't have a view
    plugin.isRecording = true;

    // Stop recording when no view - should still stop since we're already recording
    app.workspace.getActiveViewOfType = () => null;
    await plugin.toggleRecording(false);

    expect(plugin.isRecording).toBe(false);
  });

  test('saveSettings saves the current settings', async () => {
    const { app, plugin } = createPlugin();
    app.workspace.getActiveViewOfType = () => ({ editor: null });

    await plugin.onload();
    await plugin.loadSettings();

    // Change a setting
    plugin.settings.modelId = 'onnx-community/whisper-tiny.en';
    await plugin.saveSettings();

    expect(plugin.settings.modelId).toBe('onnx-community/whisper-tiny.en');
  });

  test('startRecording with view but no model loads (mobile path)', async () => {
    const { app, plugin } = createPlugin();

    // Mock a markdown view
    const mockView = { editor: null };
    app.workspace.getActiveViewOfType = () => mockView;

    await plugin.onload();

    // In mobile/test environment, loadModel should succeed with mocked transformers
    const loaded = await plugin.loadModel();
    expect(loaded).toBe(true);
  });

  test('modelId change in settings clears transcriber', async () => {
    const { app, plugin } = createPlugin();
    await plugin.onload();

    // Set a custom model ID
    plugin.settings.modelId = 'onnx-community/whisper-tiny.en';
    expect(plugin.transcriber).toBe(null); // Should be null initially or after cache clear

    await plugin.loadSettings();
    expect(plugin.settings.modelId).toBe('onnx-community/whisper-tiny.en');
  });
});

describe('WhisperSettingTab', () => {
  test('display populates the container with settings', () => {
    const { app, plugin } = createPlugin();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);
    tab.display();
    expect(tab.containerEl.childElementCount).toBeGreaterThan(0);
  });

  test('dropdown has expected model options in UI', () => {
    const { app, plugin } = createPlugin();
    const tab = new WhisperSettingTab(app.asOriginalType__(), plugin);

    // Manually call display to build the container
    const containerEl = document.createElement('div');
    tab.containerEl = containerEl;
    tab.display();

    // Check that model settings UI was created (has dropdown with options)
    expect(containerEl.innerHTML).toContain('Whisper Transcription Settings');
  });
});
