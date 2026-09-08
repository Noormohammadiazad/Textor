import { MAX_VOICE_MS } from '../core/models/attachment'
import { frameLevel, waveformFrom, WAVEFORM_BARS } from './waveform'

/**
 * In-browser voice recording.
 *
 * Two things happen at once and both matter. `MediaRecorder` produces the
 * encoded audio, and an `AnalyserNode` on the same stream samples amplitude so
 * the waveform is built *while* recording rather than by decoding the file
 * afterwards. Decoding afterwards would mean holding the whole clip in an
 * AudioContext, which on a phone is both slow and a memory spike at exactly the
 * moment the user wants to hit send.
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

/** Target bitrate. Speech, not music: higher buys nothing an ear can hear. */
const AUDIO_BITS_PER_SECOND = 24_000

/** How often the analyser is sampled. 20/s gives a readable waveform. */
const SAMPLE_INTERVAL_MS = 50

export interface VoiceRecording {
  bytes: Uint8Array
  mime: string
  durationMs: number
  waveform: number[]
}

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

export type RecorderState = 'idle' | 'recording' | 'stopping'

/**
 * A single recording session.
 *
 * Every path out — stop, cancel, the duration cap, an error — releases the
 * microphone track. A messenger that leaves the recording indicator lit after
 * the user cancels has done something much worse than lose a feature.
 */
export class VoiceRecorder {
  #recorder: MediaRecorder | null = null
  #stream: MediaStream | null = null
  #context: AudioContext | null = null
  #sampler: ReturnType<typeof setInterval> | null = null
  #chunks: Blob[] = []
  #levels: number[] = []
  #startedAt = 0
  #state: RecorderState = 'idle'

  /** Called about 20 times a second with the live level, 0-1, for the meter. */
  onLevel: ((level: number) => void) | null = null
  /** Called when the duration cap stops the recording on its own. */
  onAutoStop: (() => void) | null = null

  get state(): RecorderState {
    return this.#state
  }

  get elapsedMs(): number {
    return this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') return
    const mime = pickAudioMimeType()
    if (!mime) throw new Error('recording is not supported in this browser')

    // Browser-side cleanup helps far more than it costs on a phone speakerphone.
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    try {
      this.#recorder = new MediaRecorder(this.#stream, {
        mimeType: mime,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      })
    } catch {
      // Some browsers accept the type but refuse the bitrate hint.
      this.#recorder = new MediaRecorder(this.#stream, { mimeType: mime })
    }

    this.#chunks = []
    this.#levels = []
    this.#recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data)
    }
    this.#recorder.start()
    this.#startedAt = Date.now()
    this.#state = 'recording'
    this.#startAnalyser(this.#stream)
  }

  /** Stop and return the recording, or `null` if nothing usable was captured. */
  async stop(): Promise<VoiceRecording | null> {
    if (this.#state !== 'recording' || !this.#recorder) {
      this.#teardown()
      return null
    }
    this.#state = 'stopping'
    const recorder = this.#recorder
    const durationMs = this.elapsedMs
    const mime = recorder.mimeType || 'audio/webm'

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.#chunks, { type: mime }))
      recorder.stop()
    })

    const levels = this.#levels.slice()
    this.#teardown()

    if (blob.size === 0) return null
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      // Strip codec parameters: the descriptor carries a MIME type that has to
      // survive a strict validator on the other side.
      mime: mime.split(';')[0] ?? 'audio/webm',
      durationMs,
      waveform: waveformFrom(levels, WAVEFORM_BARS),
    }
  }

  /** Abandon the recording and release the microphone immediately. */
  cancel(): void {
    if (this.#recorder && this.#state === 'recording') {
      this.#recorder.ondataavailable = null
      try {
        this.#recorder.stop()
      } catch {
        // Already stopped; the teardown below is what actually matters.
      }
    }
    this.#teardown()
  }

  #startAnalyser(stream: MediaStream): void {
    try {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const frame = new Float32Array(analyser.fftSize)

      this.#context = context
      this.#sampler = setInterval(() => {
        analyser.getFloatTimeDomainData(frame)
        const level = frameLevel(frame)
        this.#levels.push(level)
        this.onLevel?.(Math.min(1, level * 4))

        if (this.elapsedMs >= MAX_VOICE_MS) this.onAutoStop?.()
      }, SAMPLE_INTERVAL_MS)
    } catch {
      // No analyser means no waveform, which is a cosmetic loss. Recording
      // itself must not depend on it.
    }
  }

  #teardown(): void {
    if (this.#sampler) clearInterval(this.#sampler)
    this.#sampler = null
    void this.#context?.close().catch(() => undefined)
    this.#context = null
    for (const track of this.#stream?.getTracks() ?? []) track.stop()
    this.#stream = null
    this.#recorder = null
    this.#chunks = []
    this.#startedAt = 0
    this.#state = 'idle'
  }
}
