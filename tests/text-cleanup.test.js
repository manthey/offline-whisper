const os = require('os');
const path = require('path');
const fs = require('fs');
// text-cleanup.js accesses Node modules through an indirect require, which
// needs the global in scope under jest.
globalThis.require = require;
const transformersMock = require('@huggingface/transformers');
const {
  TextCleaner,
  DesktopModelCache,
  removeArtifacts,
  introducesNewWords,
  CLEANUP_MODELS,
  DEFAULT_CLEANUP_MODEL_ID,
  CLEANUP_SYSTEM_PROMPT,
  buildUserPrompt,
  extractReplyText,
  extractJsonCleaned,
  overlapScore,
  isPlausibleCleanup,
} = require('../src/text-cleanup.js');

function makePlugin(basePath, dir = 'cleanup-test-plugin') {
  return { app: { vault: { adapter: { basePath } } }, manifest: { dir } };
}

async function readyCleaner(modelId = DEFAULT_CLEANUP_MODEL_ID) {
  const cleaner = new TextCleaner(null);
  await cleaner.initialize(modelId);
  return cleaner;
}

const maybeResponseTest = typeof Response === 'undefined' ? test.skip : test;

describe('TextCleaner.clean', () => {
  beforeEach(() => {
    transformersMock.pipeline.generateCalls = [];
    transformersMock.pipeline.failGenerate = null;
    transformersMock.pipeline.textReply = null;
  });

  test('extracts the cleaned text from the JSON envelope', async () => {
    transformersMock.pipeline.textReply = '{"cleaned": "The quick brown fox."}';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('the quick brown fox')).resolves.toBe('The quick brown fox.');
  });

  test('accepts the JSON object inside fences or prose', async () => {
    transformersMock.pipeline.textReply = '```json\n{"cleaned": "The quick brown fox."}\n```';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('the quick brown fox')).resolves.toBe('The quick brown fox.');
    transformersMock.pipeline.textReply = 'Here you go: {"cleaned": "The quick brown fox."} Hope that helps!';
    await expect(cleaner.clean('the quick brown fox')).resolves.toBe('The quick brown fox.');
  });

  test('discards replies without valid JSON', async () => {
    transformersMock.pipeline.textReply = "Sure! Here's the cleaned version:\n\nOkay, the sky is blue.";
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('okay okay the the sky is blue')).resolves.toBe('okay okay the the sky is blue');
  });

  test('rejects JSON whose cleaned text is implausible', async () => {
    transformersMock.pipeline.textReply = '{"cleaned": "' + 'x'.repeat(500) + '"}';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('some raw text')).resolves.toBe('some raw text');
  });

  test('defaults to the WASM device and q4 dtype without WebGPU', async () => {
    const cleaner = await readyCleaner();
    expect(cleaner.device).toBe('wasm');
    expect(cleaner.dtype).toBe('q4');
  });

  test('passes a generation deadline to the model', async () => {
    jest.useFakeTimers();
    const cleaner = await readyCleaner();
    cleaner.maxCleanupMs = 1000;
    await cleaner.clean('some raw text', '');
    const { kwargs } = transformersMock.pipeline.generateCalls.at(-1);
    expect(kwargs.stopping_criteria).toBeDefined();
    expect(kwargs.stopping_criteria._call([[1, 2]])).toEqual([false]);
    jest.advanceTimersByTime(2000);
    expect(kwargs.stopping_criteria._call([[1, 2]])).toEqual([true]);
    expect(kwargs.stopping_criteria.exceeded).toBe(true);
    jest.useRealTimers();
  });

  test('passes the previous chunk as context and a system prompt to the model', async () => {
    const cleaner = await readyCleaner();
    await cleaner.clean('second segment', 'first segment');
    expect(transformersMock.pipeline.generateCalls).toHaveLength(1);
    const { messages, kwargs } = transformersMock.pipeline.generateCalls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(CLEANUP_SYSTEM_PROMPT);
    expect(messages[1].content).toContain('first segment');
    expect(messages[1].content).toContain('second segment');
    expect(kwargs.do_sample).toBe(false);
  });

  test('omits the context block when there is no previous chunk', async () => {
    const cleaner = await readyCleaner();
    await cleaner.clean('only segment', '');
    const { messages } = transformersMock.pipeline.generateCalls[0];
    expect(messages[1].content).not.toContain('context');
    expect(messages[1].content).toContain('only segment');
  });

  test('scales max_new_tokens with the input length and caps it', async () => {
    const cleaner = await readyCleaner();
    await cleaner.clean('one two three');
    expect(transformersMock.pipeline.generateCalls[0].kwargs.max_new_tokens).toBe(48);
    const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    await cleaner.clean(longText);
    expect(transformersMock.pipeline.generateCalls[1].kwargs.max_new_tokens).toBe(256);
  });

  test('returns the raw text when the reply is empty', async () => {
    transformersMock.pipeline.textReply = '   ';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('some raw text')).resolves.toBe('some raw text');
  });

  test('returns the raw text when the reply is implausibly longer than the input', async () => {
    transformersMock.pipeline.textReply = 'x'.repeat(500);
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('some raw text')).resolves.toBe('some raw text');
  });

  test('returns the raw text when the reply shares no vocabulary with the input', async () => {
    transformersMock.pipeline.textReply = 'completely unrelated hallucinated words about something else entirely';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('some raw text about otters')).resolves.toBe('some raw text about otters');
  });

  test('propagates generation failures to the caller', async () => {
    transformersMock.pipeline.failGenerate = 'generation exploded';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('some raw text')).rejects.toThrow('generation exploded');
  });

  test('returns the raw text for empty input without calling the model', async () => {
    const cleaner = await readyCleaner();
    await expect(cleaner.clean('   ')).resolves.toBe('   ');
    expect(transformersMock.pipeline.generateCalls).toHaveLength(0);
  });

  test('clean throws when the model is not loaded', async () => {
    const cleaner = new TextCleaner(null);
    await expect(cleaner.clean('text')).rejects.toThrow('not loaded');
  });
});

describe('TextCleaner.initialize', () => {
  beforeEach(() => {
    transformersMock.pipeline.calls = [];
    transformersMock.pipeline.failNext = null;
  });

  test('loads a text-generation pipeline with the requested model', async () => {
    await readyCleaner('onnx-community/Qwen2.5-1.5B-Instruct');
    const calls = transformersMock.pipeline.calls.filter((call) => call.task === 'text-generation');
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('onnx-community/Qwen2.5-1.5B-Instruct');
    expect(calls[0].options.dtype).toBe('q4');
  });

  test('memoizes initialization for the same model', async () => {
    const cleaner = new TextCleaner(null);
    await cleaner.initialize(DEFAULT_CLEANUP_MODEL_ID);
    await cleaner.initialize(DEFAULT_CLEANUP_MODEL_ID);
    const calls = transformersMock.pipeline.calls.filter((call) => call.task === 'text-generation');
    expect(calls).toHaveLength(1);
    expect(cleaner.isReady()).toBe(true);
  });

  test('re-initializes when the model changes', async () => {
    const cleaner = new TextCleaner(null);
    await cleaner.initialize(DEFAULT_CLEANUP_MODEL_ID);
    await cleaner.initialize('onnx-community/Qwen2.5-1.5B-Instruct');
    const calls = transformersMock.pipeline.calls.filter((call) => call.task === 'text-generation');
    expect(calls).toHaveLength(2);
  });

  test('allows retrying after a failed load', async () => {
    const cleaner = new TextCleaner(null);
    transformersMock.pipeline.failNext = 'download failed';
    await expect(cleaner.initialize(DEFAULT_CLEANUP_MODEL_ID)).rejects.toThrow('download failed');
    expect(cleaner.isReady()).toBe(false);
    await expect(cleaner.initialize(DEFAULT_CLEANUP_MODEL_ID)).resolves.toBe(true);
    expect(cleaner.isReady()).toBe(true);
  });
});

describe('desktop file-system cache', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('sanitizeKey flattens URLs and model paths to safe file names', () => {
    expect(
      DesktopModelCache.sanitizeKey(
        'https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/onnx/model_quantized.onnx',
      ),
    ).toBe('https_huggingface.co_onnx-community_Qwen2.5-0.5B-Instruct_resolve_main_onnx_model_quantized.onnx');
    expect(DesktopModelCache.sanitizeKey('onnx-community/Qwen2.5-0.5B-Instruct/config.json')).toBe(
      'onnx-community_Qwen2.5-0.5B-Instruct_config.json',
    );
  });

  test('isCached reports false before download and true after files appear', async () => {
    const cleaner = new TextCleaner(makePlugin(tmpBase), { useDesktopCache: true });
    await expect(cleaner.isCached(DEFAULT_CLEANUP_MODEL_ID)).resolves.toBe(false);
    const dir = cleaner.getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, DesktopModelCache.sanitizeKey(`${DEFAULT_CLEANUP_MODEL_ID}/onnx/model_quantized.onnx`)),
      'model bytes',
    );
    await expect(cleaner.isCached(DEFAULT_CLEANUP_MODEL_ID)).resolves.toBe(true);
    // A different model is not cached.
    await expect(cleaner.isCached('onnx-community/Qwen2.5-1.5B-Instruct')).resolves.toBe(false);
  });

  test('clearCache removes the cache directory', async () => {
    const cleaner = new TextCleaner(makePlugin(tmpBase), { useDesktopCache: true });
    const dir = cleaner.getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'some-file.onnx'), 'data');
    cleaner.clearCache();
    expect(fs.existsSync(dir)).toBe(false);
  });

  maybeResponseTest('put and match round-trip file contents', async () => {
    const cleaner = new TextCleaner(makePlugin(tmpBase), { useDesktopCache: true });
    const dir = cleaner.getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const cache = new DesktopModelCache(dir);
    const key = 'https://huggingface.co/example/model.onnx';
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.put(key, new Response(body, { headers: { 'Content-Length': '5' } }));
    const matched = await cache.match(key);
    expect(matched.status).toBe(200);
    expect(matched.headers.get('Content-Length')).toBe('5');
    const stored = new Uint8Array(await matched.arrayBuffer());
    expect([...stored]).toEqual([1, 2, 3, 4, 5]);
    expect(await cache.match('https://huggingface.co/example/missing.onnx')).toBeUndefined();
    expect(await cache.delete(key)).toBe(true);
    expect(await cache.match(key)).toBeUndefined();
  });

  test('isCached returns null on mobile-style cleaners', async () => {
    const cleaner = new TextCleaner(makePlugin(tmpBase), { useDesktopCache: false });
    await expect(cleaner.isCached(DEFAULT_CLEANUP_MODEL_ID)).resolves.toBeNull();
  });
});

describe('cleanup helpers', () => {
  test('CLEANUP_MODELS offers the Qwen 0.5B and 1.5B models', () => {
    expect(CLEANUP_MODELS.map((model) => model.id)).toEqual([
      'onnx-community/Qwen2.5-0.5B-Instruct',
      'onnx-community/Qwen2.5-1.5B-Instruct',
    ]);
    expect(DEFAULT_CLEANUP_MODEL_ID).toBe('onnx-community/Qwen2.5-0.5B-Instruct');
  });

  test('buildUserPrompt delimits the segments', () => {
    const prompt = buildUserPrompt('previous words', 'new words');
    expect(prompt).toContain('"""previous words"""');
    expect(prompt).toContain('"""new words"""');
  });

  test('extractReplyText reads the final assistant message', () => {
    const chat = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ];
    expect(extractReplyText([{ generated_text: [...chat, { role: 'assistant', content: 'reply' }] }])).toBe('reply');
    expect(extractReplyText([{ generated_text: 'plain string' }])).toBe('plain string');
    expect(extractReplyText([])).toBe('');
    expect(extractReplyText(undefined)).toBe('');
  });

  test('isPlausibleCleanup accepts cleaned text and rejects empties and hallucinations', () => {
    expect(isPlausibleCleanup('The quick brown fox.', 'the quick, brown fox')).toBe(true);
    expect(isPlausibleCleanup('', 'some text')).toBe(false);
    expect(isPlausibleCleanup('   ', 'some text')).toBe(false);
    expect(isPlausibleCleanup('x'.repeat(500), 'short')).toBe(false);
    expect(isPlausibleCleanup('utterly different words', 'numbers 12345 and such')).toBe(false);
    // Punctuation-only input has no vocabulary to compare, so any nonempty
    // reply is accepted.
    expect(isPlausibleCleanup('...', '...')).toBe(true);
  });

  test('extractJsonCleaned parses the envelope and tolerates prose and fences', () => {
    expect(extractJsonCleaned('{"cleaned": "Hello there."}')).toBe('Hello there.');
    expect(extractJsonCleaned('```json\n{"cleaned": "Hello there."}\n```')).toBe('Hello there.');
    expect(extractJsonCleaned('Sure! {"cleaned": "Hello there."} Done.')).toBe('Hello there.');
    expect(extractJsonCleaned('{"cleaned": "Line one.\\nLine two."}')).toBe('Line one.\nLine two.');
    expect(extractJsonCleaned('no json here')).toBeNull();
    expect(extractJsonCleaned('{"other": "field"}')).toBeNull();
    expect(extractJsonCleaned('{"cleaned": broken')).toBeNull();
    expect(extractJsonCleaned('Sure! {"cleaned": "unterminated')).toBeNull();
  });

  test('removeArtifacts strips bracketed and parenthesized annotations', () => {
    expect(removeArtifacts('[BLANK_AUDIO] I will send the report')).toBe('I will send the report');
    expect(removeArtifacts('(mouse clicking) hello')).toBe('hello');
    expect(removeArtifacts('[Music] [Applause] (typing)')).toBe('');
    expect(removeArtifacts('no artifacts here')).toBe('no artifacts here');
    expect(removeArtifacts('')).toBe('');
  });

  test('introducesNewWords catches merged and split words', () => {
    // Spelled-out letters merged into a word.
    expect(introducesNewWords("That's pi pie not pi e.", "That's pi P i not P i e.")).toBe(true);
    // Word split into pieces.
    expect(introducesNewWords('go to the bed room', 'go to the bedroom')).toBe(true);
    // Pure deletions, recasing, and punctuation changes are fine.
    expect(introducesNewWords('The quick brown fox.', 'the quick, brown fox')).toBe(false);
    expect(introducesNewWords('thank you. does everyone agree?', 'thank you. thank you. does everyone agree')).toBe(
      false,
    );
    // Contractions are conservative rejections; hyphenation is not, since
    // hyphens split into the same letter runs.
    expect(introducesNewWords("It's fine", 'It is fine')).toBe(true);
    expect(introducesNewWords('a state-of-the-art device', 'a state of the art device')).toBe(false);
  });

  test('rejects replies that merge spelled-out letters into words', async () => {
    transformersMock.pipeline.textReply = '{"cleaned": "That\'s pi pie not pi e."}';
    const cleaner = await readyCleaner();
    await expect(cleaner.clean("That's pi P i not P i e.")).resolves.toBe("That's pi P i not P i e.");
  });

  test('overlapScore prefers candidates that retain more of the raw words', () => {
    expect(overlapScore('The quick brown fox.', 'the quick, brown fox')).toBe(1);
    expect(overlapScore('the quick fox', 'the quick brown fox')).toBeGreaterThan(0);
    expect(overlapScore('the quick fox', 'the quick brown fox')).toBeLessThan(1);
    expect(overlapScore('nothing alike', 'the quick brown fox')).toBe(0);
  });
});

describe('transformers.js loading in a Node-like renderer', () => {
  test('masks process.release while loading and restores it afterwards', async () => {
    // jest runs in Node, so process.release.name is 'node' and the masking
    // path in requireTransformers is exercised.
    expect(process.release.name).toBe('node');
    const release = process.release;
    await readyCleaner();
    expect(process.release).toBe(release);
    expect(process.release.name).toBe('node');
  });
});
