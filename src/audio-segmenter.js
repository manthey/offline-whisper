/**
 * Splits a continuous stream of PCM audio samples into transcription chunks.
 *
 * Chunks are cut at pauses in speech instead of at fixed timers: once the
 * buffer holds at least `minDurationMs` of audio, the first silence gap
 * (detected with a cheap adaptive RMS energy threshold) is used as the
 * boundary. If speech never pauses, a cut is forced at `maxDurationMs`.
 *
 * The detector only chooses cut locations; it never drops audio. Every
 * sample that enters the segmenter eventually leaves in exactly one chunk,
 * including chunks judged to be silent, so quiet speech is still sent to
 * the model and a misclassification only moves a boundary, never loses
 * data.
 */
function computeFrameRms(pcm, frameSamples) {
  const frameCount = Math.floor(pcm.length / frameSamples);
  const rms = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * frameSamples;
    let sumSquares = 0;
    for (let i = 0; i < frameSamples; i++) {
      const sample = pcm[offset + i];
      sumSquares += sample * sample;
    }
    rms[frame] = Math.sqrt(sumSquares / frameSamples);
  }
  return rms;
}

/**
 * Percentile of a Float32Array, e.g. percentile(values, 0.1) is the 10th
 * percentile, used as an adaptive estimate of the noise floor.
 */
function percentile(values, fraction) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

class AudioSegmenter {
  constructor(options = {}) {
    const frameMs = options.frameMs ?? 10;
    this.sampleRate = options.sampleRate || 16000;
    this.minSamples = Math.round(((options.minDurationMs ?? 10000) / 1000) * this.sampleRate);
    this.maxSamples = Math.round(((options.maxDurationMs ?? 12500) / 1000) * this.sampleRate);
    this.frameSamples = Math.max(1, Math.round((frameMs / 1000) * this.sampleRate));
    this.minSilenceFrames = Math.max(1, Math.ceil((options.silenceMs ?? 250) / frameMs));
    this.thresholdRatio = options.thresholdRatio ?? 3;
    this.minThresholdRms = options.minThresholdRms ?? 0.0015;
    this.buffer = new Float32Array(0);
  }

  get bufferedSamples() {
    return this.buffer.length;
  }

  /**
   * Appends samples and returns any completed segments. A segment is only
   * emitted once its audio ends at a silence gap (or the hard maximum is
   * reached), so the caller may receive zero, one, or several segments per
   * push.
   */
  push(samples) {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
    const segments = [];
    while (true) {
      const analysis = this.analyzeBuffer(this.buffer);
      let cutIndex = -1;
      if (analysis.hasSpeech && this.buffer.length >= this.minSamples) {
        for (const run of analysis.silenceRuns) {
          const mid = Math.round(((run[0] + run[1]) / 2) * this.frameSamples);
          if (mid >= this.minSamples && mid > 0) {
            cutIndex = mid;
            break;
          }
        }
      }
      if (cutIndex < 0 && this.buffer.length >= this.maxSamples) {
        // Speech never paused (or the buffer holds no detectable speech):
        // cut at the hard maximum so silent stretches still produce
        // full-size chunks, matching the old fixed-duration behavior.
        cutIndex = Math.min(this.maxSamples, this.buffer.length);
      }
      if (cutIndex < 0) {
        break;
      }
      segments.push(this.buffer.slice(0, cutIndex));
      this.buffer = this.buffer.slice(cutIndex);
    }
    return segments;
  }

  /**
   * Emits whatever is still buffered (used when recording stops) and clears
   * the buffer.
   */
  flush() {
    const segment = this.buffer.length > 0 ? this.buffer : null;
    this.buffer = new Float32Array(0);
    return segment ? [segment] : [];
  }

  /**
   * Computes the adaptive silence threshold and locates silence runs in the
   * buffer. The noise floor is estimated as the 10th percentile of frame
   * energy, so steady background noise is treated like silence, and a pause
   * only counts once it spans at least `silenceMs`.
   */
  analyzeBuffer(pcm) {
    const frameRms = computeFrameRms(pcm, this.frameSamples);
    const floor = percentile(frameRms, 0.1);
    let peak = 0;
    for (let i = 0; i < frameRms.length; i++) {
      if (frameRms[i] > peak) {
        peak = frameRms[i];
      }
    }
    // The noise floor estimate fails when the buffer holds little or no
    // silence (the percentile then lands inside speech), so cap the adaptive
    // threshold at half the peak level: speech frames always stay above it.
    const threshold = Math.max(this.minThresholdRms, Math.min(floor * this.thresholdRatio, peak / 2));
    const silenceRuns = [];
    let runStart = -1;
    let hasSpeech = false;
    for (let i = 0; i < frameRms.length; i++) {
      if (frameRms[i] < threshold) {
        if (runStart < 0) {
          runStart = i;
        }
      } else {
        hasSpeech = true;
        if (runStart >= 0 && i - runStart >= this.minSilenceFrames) {
          silenceRuns.push([runStart, i]);
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && frameRms.length - runStart >= this.minSilenceFrames) {
      silenceRuns.push([runStart, frameRms.length]);
    }
    return { frameRms, threshold, silenceRuns, hasSpeech };
  }
}

module.exports = { AudioSegmenter, computeFrameRms, percentile };
