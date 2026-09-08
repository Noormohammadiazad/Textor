import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserVoice, PLAYOUT_DELAY_S, SAMPLE_RATE } from '@/core/calls/voiceAudio'
import { MICROPHONE, type MediaBackend } from '@/core/calls/media'

/**
 * Relay voice's browser half (ADR-069): microphone samples cut into 20 ms
 * frames for WebCodecs' Opus encoder, and the other side's frames decoded and
 * scheduled back to back, with room ahead of each phrase for late arrivals.
 * Web Audio and WebCodecs are faked to the shape the code uses.
 */

type Output<T> = (value: T) => void

class FakeNode {
  connected: unknown[] = []
  disconnected = false
  connect(target: unknown) {
    this.connected.push(target)
  }
  disconnect() {
    this.disconnected = true
  }
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null
  hear(samples: number) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(0.5) } })
  }
}

class FakeAudioContext {
  static made: FakeAudioContext[] = []
  static rate: number | null = null
  sampleRate: number
  currentTime = 10
  destination = new FakeNode()
  resumed = 0
  processor = new FakeProcessor()
  source = new FakeNode()
  gain = Object.assign(new FakeNode(), { gain: { value: 1 } })
  started: { at: number; duration: number }[] = []

  constructor(opts: { sampleRate: number }) {
    this.sampleRate = FakeAudioContext.rate ?? opts.sampleRate
    FakeAudioContext.made.push(this)
  }
  resume() {
    this.resumed += 1
    return Promise.resolve()
  }
  createMediaStreamSource() {
    return this.source
  }
  createScriptProcessor() {
    return this.processor
  }
  createGain() {
    return this.gain
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      samples: null as Float32Array | null,
      copyToChannel(samples: Float32Array) {
        this.samples = samples
      },
    }
  }
  createBufferSource() {
    const node = Object.assign(new FakeNode(), {
      buffer: null as { duration: number } | null,
      start: (at: number) => this.started.push({ at, duration: node.buffer?.duration ?? 0 }),
    })
    return node
  }
}

class FakeAudioData {
  closed = false
  constructor(
    readonly init: { numberOfFrames: number; sampleRate: number; timestamp: number; data: Float32Array },
  ) {}
  get numberOfFrames() {
    return this.init.numberOfFrames
  }
  get sampleRate() {
    return this.init.sampleRate
  }
  copyTo(target: Float32Array) {
    target.set(this.init.data)
  }
  close() {
    this.closed = true
  }
}

class FakeEncoder {
  static made: FakeEncoder[] = []
  static supported = true
  static isConfigSupported = vi.fn(async () => ({ supported: FakeEncoder.supported }))
  state = 'unconfigured'
  config: unknown = null
  encoded: FakeAudioData[] = []
  constructor(
    readonly init: {
      output: Output<{ byteLength: number; copyTo: (target: Uint8Array) => void }>
      error: Output<Error>
    },
  ) {
    FakeEncoder.made.push(this)
  }
  configure(config: unknown) {
    this.config = config
    this.state = 'configured'
  }
  encode(data: FakeAudioData) {
    this.encoded.push(data)
    const byte = data.init.timestamp / 20_000
    this.init.output({ byteLength: 30, copyTo: (target) => target.fill(byte) })
  }
  close() {
    this.state = 'closed'
  }
}

class FakeDecoder {
  static made: FakeDecoder[] = []
  static supported = true
  static isConfigSupported = vi.fn(async () => ({ supported: FakeDecoder.supported }))
  state = 'unconfigured'
  chunks: { timestamp: number; data: Uint8Array }[] = []
  produced: FakeAudioData[] = []
  constructor(readonly init: { output: Output<FakeAudioData>; error: Output<Error> }) {
    FakeDecoder.made.push(this)
  }
  configure() {
    this.state = 'configured'
  }
  decode(chunk: { timestamp: number; data: Uint8Array }) {
    this.chunks.push(chunk)
    const data = new FakeAudioData({
      numberOfFrames: 960,
      sampleRate: SAMPLE_RATE,
      timestamp: chunk.timestamp,
      data: new Float32Array(960).fill(0.25),
    })
    this.produced.push(data)
    this.init.output(data)
  }
  close() {
    this.state = 'closed'
  }
}

class FakeChunk {
  constructor(init: { timestamp: number; data: Uint8Array }) {
    Object.assign(this, init)
  }
}

const track = () => ({
  stopped: false,
  stop() {
    this.stopped = true
  },
})
let tracks: ReturnType<typeof track>[]
let asked: MediaStreamConstraints[]
const media: MediaBackend = {
  getUserMedia: async (constraints) => {
    asked.push(constraints)
    tracks = [track()]
    return { getTracks: () => tracks } as unknown as MediaStream
  },
  enumerateDevices: async () => [],
}

const context = () => FakeAudioContext.made.at(-1) as FakeAudioContext

beforeEach(() => {
  FakeAudioContext.made = []
  FakeAudioContext.rate = null
  FakeEncoder.made = []
  FakeDecoder.made = []
  FakeEncoder.supported = true
  FakeDecoder.supported = true
  asked = []
  tracks = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioEncoder', FakeEncoder)
  vi.stubGlobal('AudioDecoder', FakeDecoder)
  vi.stubGlobal('AudioData', FakeAudioData)
  vi.stubGlobal('EncodedAudioChunk', FakeChunk)
})

afterEach(() => vi.unstubAllGlobals())

describe('whether it can', () => {
  it('needs devices, WebCodecs, and Opus at this rate both ways', async () => {
    expect(await browserVoice(null).supported()).toBe(false)
    expect(await browserVoice(media).supported()).toBe(true)
    FakeDecoder.supported = false
    expect(await browserVoice(media).supported()).toBe(false)
    FakeEncoder.supported = false
    FakeDecoder.supported = true
    expect(await browserVoice(media).supported()).toBe(false)
    FakeEncoder.isConfigSupported.mockRejectedValueOnce(new Error('NotSupportedError'))
    FakeEncoder.supported = true
    expect(await browserVoice(media).supported()).toBe(false)
    vi.stubGlobal('AudioEncoder', undefined)
    expect(await browserVoice(media).supported()).toBe(false)
  })
})

describe('the microphone', () => {
  it('cuts what it hears into 20 ms frames for a constant-bitrate Opus encoder', async () => {
    const frames: Uint8Array[] = []
    const capture = await browserVoice(media).capture((frame) => frames.push(frame))
    expect(asked).toEqual([{ audio: MICROPHONE, video: false }])
    expect(context().sampleRate).toBe(SAMPLE_RATE)
    expect(context().resumed).toBe(1)
    const [encoder] = FakeEncoder.made
    expect(encoder?.config).toMatchObject({ codec: 'opus', bitrate: 12_000, bitrateMode: 'constant' })
    // The processor runs only while connected onward.
    expect(context().source.connected).toEqual([context().processor])
    expect(context().processor.connected).toEqual([context().destination])

    // 2048 samples make two frames of 960, with 128 left for the next block.
    context().processor.hear(2048)
    expect(frames).toHaveLength(2)
    context().processor.hear(2048)
    expect(frames).toHaveLength(4)
    expect(encoder?.encoded.map((data) => data.init.timestamp)).toEqual([0, 20_000, 40_000, 60_000])
    expect(encoder?.encoded.every((data) => data.closed && data.init.data.length === 960)).toBe(true)
    expect(frames.map((frame) => frame[0])).toEqual([0, 1, 2, 3])
    encoder?.init.error(new Error('encoder broke'))

    capture.stop()
    expect(context().processor.onaudioprocess).toBeNull()
    expect(context().processor.disconnected && context().source.disconnected).toBe(true)
    expect(encoder?.state).toBe('closed')
    expect(tracks.every((t) => t.stopped)).toBe(true)
    // Stopping again changes nothing, and does not close what is closed.
    capture.stop()
  })

  it('gives up on an audio context the browser would not run at 48 kHz', async () => {
    FakeAudioContext.rate = 44_100
    await expect(browserVoice(media).capture(() => undefined)).rejects.toThrow('44100')
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })
})

describe('the speaker', () => {
  it('plays frames back to back, a little behind now after a pause, through one shared context', async () => {
    const voice = browserVoice(media)
    await voice.capture(() => undefined)
    const player = voice.player()
    expect(FakeAudioContext.made).toHaveLength(1)
    const audio = context()
    const frame = new Uint8Array(30)
    player.play([frame, frame])
    const [decoder] = FakeDecoder.made
    expect(decoder?.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 20_000])
    expect(decoder?.produced.every((data) => data.closed)).toBe(true)
    expect(audio.started).toEqual([
      { at: 10 + PLAYOUT_DELAY_S, duration: 0.02 },
      { at: 10 + PLAYOUT_DELAY_S + 0.02, duration: 0.02 },
    ])
    // A pause: what comes next is anchored afresh.
    audio.currentTime = 20
    player.play([frame])
    expect(audio.started.at(-1)?.at).toBe(20 + PLAYOUT_DELAY_S)
    decoder?.init.error(new Error('decoder broke'))

    player.mute(true)
    expect(audio.gain.gain.value).toBe(0)
    player.mute(false)
    expect(audio.gain.gain.value).toBe(1)
    player.close()
    expect(decoder?.state).toBe('closed')
    expect(audio.gain.disconnected).toBe(true)
    player.close()
  })
})
