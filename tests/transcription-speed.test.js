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

function displayTab(plugin) {
  globalThis._capturedDropdowns = [];
  const tab = new WhisperSettingTab(plugin.app.asOriginalType__(), plugin);
  const containerEl = makeContainer();
  tab.containerEl = containerEl;
  tab.display();
  return containerEl;
}

function silenceLogs() {
  jest.spyOn(console, 'log').mockImplementation(() => {});
}

// One second of 16kHz mono audio.
function oneSecondChunk() {
  return new Float32Array(16000);
}

describe('transcription speed tracking', () => {
  beforeEach(() => {
    silenceLogs();
  });

  test('starts with no recorded timings', () => {
    const { plugin } = createPlugin();
    expect(plugin.recentTranscriptions).toEqual([]);
    expect(plugin.transcriptionSpeedSummary()).toBeNull();
  });

  test('keeps only the ten most recent chunks', () => {
    const { plugin } = createPlugin();
    for (let i = 0; i < 14; i++) {
      plugin.recordTranscriptionTiming(oneSecondChunk(), 1000 + i);
    }
    expect(plugin.recentTranscriptions).toHaveLength(10);
    expect(plugin.recentTranscriptions[0].transcribeMs).toBe(1004);
    expect(plugin.recentTranscriptions[9].transcribeMs).toBe(1013);
  });

  test('sums audio and transcription time for the ratio', () => {
    const { plugin } = createPlugin();
    // 3 s of audio transcribed in 6 s total: a ratio of 2.
    plugin.recordTranscriptionTiming(oneSecondChunk(), 1000);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2000);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 3000);
    const summary = plugin.transcriptionSpeedSummary();
    expect(summary.chunkCount).toBe(3);
    expect(summary.audioSeconds).toBeCloseTo(3);
    expect(summary.transcribeSeconds).toBeCloseTo(6);
    expect(summary.ratio).toBeCloseTo(2);
  });

  test('handles zero-length audio without dividing by zero', () => {
    const { plugin } = createPlugin();
    plugin.recordTranscriptionTiming(new Float32Array(0), 500);
    expect(plugin.transcriptionSpeedSummary().ratio).toBe(Infinity);
  });

  describe('describeTranscriptionSpeed', () => {
    test('explains that there is no data yet', () => {
      const { plugin } = createPlugin();
      expect(plugin.describeTranscriptionSpeed()).toMatch(/No recent transcriptions/);
    });

    test('reports slower than real time with a plural chunk count', () => {
      const { plugin } = createPlugin();
      for (let i = 0; i < 3; i++) {
        plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
      }
      const message = plugin.describeTranscriptionSpeed();
      expect(message).toMatch(/^The last 3 chunks transcribed at 2\.50x slower than real time\./);
      expect(message).toMatch(/try a smaller model/);
    });

    test('reports faster than real time and uses the singular for one chunk', () => {
      const { plugin } = createPlugin();
      plugin.recordTranscriptionTiming(oneSecondChunk(), 200);
      const message = plugin.describeTranscriptionSpeed();
      expect(message).toMatch(/^The last 1 chunk transcribed at 5\.00x faster than real time\./);
      expect(message).toMatch(/try a bigger, more accurate model/);
    });

    test('reports a speed close to real time in the middle range', () => {
      const { plugin } = createPlugin();
      for (let i = 0; i < 3; i++) {
        plugin.recordTranscriptionTiming(oneSecondChunk(), 800);
      }
      const message = plugin.describeTranscriptionSpeed();
      expect(message).toMatch(/^The last 3 chunks transcribed at 1\.25x faster than real time\./);
    });

    test('always includes the generic model advice', () => {
      const { plugin } = createPlugin();
      expect(plugin.describeTranscriptionSpeed()).not.toMatch(/smaller model/);
      plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
      expect(plugin.describeTranscriptionSpeed()).toMatch(
        /If this is close to or slower than real time, try a smaller model; if substantially faster, try a bigger, more accurate model\./,
      );
    });
  });

  test('transcribePreparedAudio records each completed transcription', async () => {
    const { plugin } = createPlugin();
    plugin.transcriber = jest.fn(() => Promise.resolve({ text: 'hello' }));
    await plugin.transcribePreparedAudio(oneSecondChunk(), 1);
    await plugin.transcribePreparedAudio(oneSecondChunk(), 2);
    expect(plugin.transcriber).toHaveBeenCalledTimes(2);
    expect(plugin.recentTranscriptions).toHaveLength(2);
    for (const entry of plugin.recentTranscriptions) {
      expect(entry.audioSeconds).toBeCloseTo(1);
      expect(entry.transcribeMs).toBeGreaterThanOrEqual(0);
    }
    expect(plugin.transcriptionSpeedSummary().chunkCount).toBe(2);
  });

  test('the settings tab shows the current transcription speed advice', () => {
    const { plugin } = createPlugin();
    const before = displayTab(plugin);
    expect(before.textContent).toContain('Transcription speed');
    expect(before.textContent).toMatch(/No recent transcriptions/);
    for (let i = 0; i < 3; i++) {
      plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    }
    const after = displayTab(plugin);
    expect(after.textContent).toMatch(/try a smaller model/);
  });

  test('changing the model resets the timing history and updates the report', async () => {
    const { plugin } = createPlugin();
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    const containerEl = displayTab(plugin);
    const modelDropdown = globalThis._capturedDropdowns[0];
    await modelDropdown.onChange('onnx-community/whisper-tiny.en');
    expect(plugin.recentTranscriptions).toEqual([]);
    expect(plugin.transcriptionSpeedSummary()).toBeNull();
    // The refreshed description is the last one written to the page.
    const descriptions = containerEl.querySelectorAll('.setting-item-description');
    expect(descriptions[descriptions.length - 1].textContent).toMatch(/No recent transcriptions/);
  });

  test('changing the compute device resets the timing history and updates the report', async () => {
    const { plugin } = createPlugin();
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    plugin.recordTranscriptionTiming(oneSecondChunk(), 2500);
    const containerEl = displayTab(plugin);
    const deviceDropdown = globalThis._capturedDropdowns[1];
    await deviceDropdown.onChange('gpu');
    expect(plugin.recentTranscriptions).toEqual([]);
    expect(plugin.transcriptionSpeedSummary()).toBeNull();
    const descriptions = containerEl.querySelectorAll('.setting-item-description');
    expect(descriptions[descriptions.length - 1].textContent).toMatch(/No recent transcriptions/);
  });
});
