/**
 * Whether this browser can record a voice note, and in what.
 *
 * Its own module so the composer can decide whether to offer the microphone
 * without shipping the recorder itself in the shell (ADR-060).
 */

/**
 * Container and codec, in order of preference.
 *
 * Opus in WebM everywhere it exists — it is the only codec here that is both
 * royalty-free and good at speech, and 24 kbps of Opus is genuinely
 * intelligible. Safari has historically produced MP4/AAC instead, so that is
 * the fallback rather than a failure.
 */
const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

export function pickAudioMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

export const canRecordVoice = (): boolean =>
  typeof navigator !== 'undefined' &&
  navigator.mediaDevices?.getUserMedia !== undefined &&
  pickAudioMimeType() !== null
