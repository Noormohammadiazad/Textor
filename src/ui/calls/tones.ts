/**
 * Ringtone and ringback, synthesised with Web Audio.
 *
 * Generated rather than shipped as audio files: nothing to download, nothing
 * for the precache, and nothing the Content-Security-Policy has to allow. A
 * browser that will not start audio without a gesture simply stays silent —
 * the screen still says a call is ringing.
 */

export interface Tone {
  stop: () => void
}

const SILENT: Tone = { stop: () => undefined }

type AudioContextConstructor = new () => AudioContext

function audioContext(): AudioContext | null {
  const Constructor = globalThis as {
    AudioContext?: AudioContextConstructor
    webkitAudioContext?: AudioContextConstructor
  }
  const Make = Constructor.AudioContext ?? Constructor.webkitAudioContext
  if (!Make) return null
  try {
    return new Make()
  } catch {
    return null
  }
}

/**
 * Play `pattern` — pairs of frequencies with how long each burst lasts — every
 * `periodMs`, until stopped.
 */
function repeat(
  bursts: readonly { frequencies: readonly number[]; at: number; ms: number }[],
  periodMs: number,
  volume: number,
  vibrate?: readonly number[],
): Tone {
  const context = audioContext()
  if (!context) return SILENT
  const output = context.createGain()
  output.gain.value = volume
  output.connect(context.destination)

  const play = () => {
    const start = context.currentTime + 0.05
    for (const burst of bursts) {
      const begin = start + burst.at / 1000
      const end = begin + burst.ms / 1000
      const envelope = context.createGain()
      envelope.gain.setValueAtTime(0, begin)
      envelope.gain.linearRampToValueAtTime(1, begin + 0.02)
      envelope.gain.setValueAtTime(1, end - 0.03)
      envelope.gain.linearRampToValueAtTime(0, end)
      envelope.connect(output)
      for (const frequency of burst.frequencies) {
        const oscillator = context.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        oscillator.connect(envelope)
        oscillator.start(begin)
        oscillator.stop(end)
      }
    }
    if (vibrate) (navigator as Navigator & { vibrate?: (p: readonly number[]) => boolean }).vibrate?.(vibrate)
  }

  void context.resume().catch(() => undefined)
  play()
  const timer = setInterval(play, periodMs)
  return {
    stop: () => {
      clearInterval(timer)
      try {
        ;(navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(0)
      } catch {
        /* nothing to stop */
      }
      void context.close().catch(() => undefined)
    },
  }
}

/** An incoming call: two bright double chirps, and the phone buzzes with them. */
export function playRingtone(): Tone {
  return repeat(
    [
      { frequencies: [784, 988], at: 0, ms: 380 },
      { frequencies: [784, 988], at: 520, ms: 380 },
    ],
    2800,
    0.12,
    [380, 140, 380],
  )
}

/** Our call is ringing at the other end: the familiar long, low purr. */
export function playRingback(): Tone {
  return repeat([{ frequencies: [440, 480], at: 0, ms: 1800 }], 4800, 0.05)
}
