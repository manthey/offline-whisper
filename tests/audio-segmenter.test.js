const { AudioSegmenter, computeFrameRms, percentile } = require('../src/audio-segmenter.js');

const SAMPLE_RATE = 16000;

function makeSamples(seconds, amplitude = 0.3, frequency = 220) {
  const count = Math.round(seconds * SAMPLE_RATE);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  }
  return data;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SAMPLE_RATE));
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function newSegmenter(overrides = {}) {
  return new AudioSegmenter({
    sampleRate: SAMPLE_RATE,
    minDurationMs: 1000,
    maxDurationMs: 3500,
    silenceMs: 200,
    ...overrides,
  });
}

describe('computeFrameRms', () => {
  test('computes the RMS of each frame', () => {
    // 200Hz means each 10ms frame holds exactly 2 cycles, so the frame RMS is
    // amplitude / sqrt(2).
    const pcm = makeSamples(0.1, 0.6, 200);
    const rms = computeFrameRms(pcm, 160);
    expect(rms.length).toBe(10);
    for (const value of rms) {
      expect(value).toBeCloseTo(0.6 / Math.SQRT2, 5);
    }
  });

  test('silence has zero RMS', () => {
    const rms = computeFrameRms(silence(0.1), 160);
    expect(rms.length).toBe(10);
    for (const value of rms) {
      expect(value).toBe(0);
    }
  });
});

describe('percentile', () => {
  test('returns the fraction-sorted value', () => {
    const values = Float32Array.from([5, 1, 9, 3, 7]);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 1)).toBe(9);
  });

  test('handles empty input', () => {
    expect(percentile(new Float32Array(0), 0.5)).toBe(0);
  });
});

describe('AudioSegmenter', () => {
  test('cuts at the first silence gap at or after the minimum duration', () => {
    // speech 0.6s, silence 0.2s, speech 0.6s, silence 0.2s, speech 0.6s, silence 0.2s, speech 0.7s
    const pcm = concat(
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.7),
    );
    const segmenter = newSegmenter();
    const segments = segmenter.push(pcm);
    // First gap midpoint (~0.7s) is before minDuration (1s), so the cut must
    // land at the midpoint of the second gap (~1.5s). The remaining 1.6s does
    // not reach the minimum again, so it stays buffered until flush.
    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(1500 * 16);
    expect(segmenter.bufferedSamples).toBe(1600 * 16);
    const flushed = segmenter.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(1600 * 16);
  });

  test('produces the same segments when audio arrives incrementally', () => {
    const pcm = concat(
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.6),
      silence(0.2),
      makeSamples(0.7),
    );
    const batchSegmenter = newSegmenter();
    const incrementalSegmenter = newSegmenter();
    const batchSegments = batchSegmenter.push(pcm);
    const incrementalSegments = [];
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      incrementalSegments.push(...incrementalSegmenter.push(pcm.subarray(offset, offset + 1600)));
    }
    incrementalSegments.push(...incrementalSegmenter.flush());
    batchSegments.push(...batchSegmenter.flush());
    expect(incrementalSegments.map((s) => s.length)).toEqual(batchSegments.map((s) => s.length));
  });

  test('forces a cut when speech never pauses', () => {
    const segmenter = newSegmenter();
    const segments = segmenter.push(makeSamples(4));
    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(3500 * 16);
    expect(segmenter.bufferedSamples).toBe(500 * 16);
  });

  test('emits fixed-size chunks during pure silence without dropping audio', () => {
    const segmenter = newSegmenter();
    // No detectable speech: chunks are only cut at the hard maximum, but the
    // audio is still sent, matching the old fixed-duration behavior.
    const segments = segmenter.push(silence(5));
    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(3500 * 16);
    expect(segmenter.bufferedSamples).toBe(1500 * 16);
    const flushed = segmenter.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(1500 * 16);
  });

  test('treats steady background noise as silence when choosing cut points', () => {
    // Constant low-level noise, then real speech, then noise again.
    const noise = makeSamples(1, 0.02, 60);
    const pcm = concat(noise, makeSamples(0.5), noise);
    const segmenter = newSegmenter();
    const segments = segmenter.push(pcm);
    // Noise is recognized as the floor, so the gap after the speech becomes
    // the cut point. The segment keeps all of its audio, including the
    // leading noise, and the remainder stays buffered.
    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(2000 * 16);
    expect(segmenter.bufferedSamples).toBe(500 * 16);
  });

  test('does not cut before the minimum duration', () => {
    const segmenter = newSegmenter();
    const segments = segmenter.push(concat(makeSamples(0.3), silence(0.9)));
    expect(segments.length).toBe(0);
    expect(segmenter.bufferedSamples).toBe(1200 * 16);
  });

  test('keeps silent chunks instead of dropping them', () => {
    const segmenter = newSegmenter();
    // 2s of silence then 1.5s of speech. The mid-gap cut at the 1s minimum
    // emits a full second of pure silence as its own chunk (never dropped);
    // the remainder stays buffered until flush.
    const segments = segmenter.push(concat(silence(2), makeSamples(1.5)));
    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(1000 * 16);
    expect(segmenter.bufferedSamples).toBe(2500 * 16);
    const flushed = segmenter.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(2500 * 16);
  });

  test('flush emits any buffered audio, speech or silence', () => {
    const speechSegmenter = newSegmenter();
    expect(speechSegmenter.push(makeSamples(0.5)).length).toBe(0);
    const flushed = speechSegmenter.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(500 * 16);

    const silenceSegmenter = newSegmenter();
    silenceSegmenter.push(silence(0.5));
    const silenceFlushed = silenceSegmenter.flush();
    expect(silenceFlushed.length).toBe(1);
    expect(silenceFlushed[0].length).toBe(500 * 16);
    expect(silenceSegmenter.bufferedSamples).toBe(0);
  });
});
