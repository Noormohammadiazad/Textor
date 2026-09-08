import { MAX_WAVEFORM_BARS } from '../core/models/attachment'

/**
 * Waveform maths for voice notes.
 *
 * Pure and separate from the recorder because this is the part with real edge
 * cases — a recording of pure silence, a single loud clip, a note shorter than
 * one bar — and none of them need a microphone to test.
 *
 * The result is a small array of integers 0-100 that ships inside the message
 * itself, so the recipient sees the shape of what was said before a single byte
 * of audio has transferred.
 */

/** Bars in a rendered waveform. Enough to read a rhythm, small enough to send. */
export const WAVEFORM_BARS = 56

/**
 * Reduce a stream of amplitude samples to a fixed number of bars.
 *
 * Peak within each bucket rather than mean: speech is mostly quiet, and
 * averaging turns a normal sentence into a flat line. The peak is what the eye
 * reads as rhythm.
 */
export function bucketPeaks(samples: readonly number[], bars = WAVEFORM_BARS): number[] {
  const count = Math.max(1, Math.min(bars, MAX_WAVEFORM_BARS))
  if (samples.length === 0) return new Array<number>(count).fill(0)

  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * samples.length) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / count))
    let peak = 0
    for (let j = start; j < end && j < samples.length; j++) {
      const value = Math.abs(samples[j] ?? 0)
      if (value > peak) peak = value
    }
    out.push(peak)
  }
  return out
}

/**
 * Scale peaks to 0-100 against the loudest bar rather than against full scale.
 *
 * Microphone levels vary enormously between devices; a quiet recording
 * normalised against full scale renders as an unreadable flat line. Normalising
 * against the recording's own maximum means every voice note is legible, at the
 * cost of not being comparable between notes — which nobody does.
 *
 * A floor keeps silent stretches visible as a thin line rather than a gap, so
 * the control still reads as a waveform.
 */
export function normalizeBars(peaks: readonly number[], floor = 4): number[] {
  const max = peaks.reduce((hi, value) => (value > hi ? value : hi), 0)
  // A recording with no signal at all: draw the floor, not a division by zero.
  if (max <= 0) return peaks.map(() => floor)
  return peaks.map((value) => {
    const scaled = Math.round((value / max) * 100)
    return Math.max(floor, Math.min(100, scaled))
  })
}

/** Amplitude samples straight from an analyser, reduced to a sendable waveform. */
export const waveformFrom = (samples: readonly number[], bars = WAVEFORM_BARS): number[] =>
  normalizeBars(bucketPeaks(samples, bars))

/**
 * Root-mean-square of one analyser frame.
 *
 * RMS rather than peak per frame: a single sample spike from a click or a knock
 * would otherwise dominate the bar it lands in.
 */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const value = frame[i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum / frame.length)
}

/** `0:07`, `1:23`, `12:04` — never `0:7`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
