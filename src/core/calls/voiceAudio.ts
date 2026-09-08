import { createLogger } from '../util/log'
import { MICROPHONE, stopTracks, type MediaBackend } from './media'
import { FRAME_MS, type VoicePlatform } from './relayVoice'

const log = createLogger('relay-voice')

/**
 * The browser's half of relay voice (ADR-069): the microphone through
 * WebCodecs' Opus encoder, and the other side's frames through its decoder to
 * the speaker.
 *
 * WebCodecs, because Opus in JavaScript would mean WebAssembly, which the
 * content policy does not allow. A ScriptProcessorNode for the samples,
 * because an AudioWorklet must load a module file of its own, one more asset
 * to keep out of the precache — and at 48 kHz in 2048-sample blocks the main
 * thread has 43 ms for each, which a walkie-talkie does not miss.
 */

export const SAMPLE_RATE = 48_000
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000
/** Constant bitrate, so every frame is the same size and says nothing of what was said. */
const ENCODER: AudioEncoderConfig = {
  codec: 'opus',
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: 12_000,
  bitrateMode: 'constant',
}
const DECODER: AudioDecoderConfig = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 }
/** How far ahead the first frame after a pause is scheduled: the room arrival times need. */
export const PLAYOUT_DELAY_S = 0.3

export function browserVoice(media: MediaBackend | null): VoicePlatform {
  let shared: AudioContext | null = null
  // One context for the microphone and the speaker, made on the tap that
  // joined, which is what lets it start.
  const context = (): AudioContext => {
    shared ??= new AudioContext({ sampleRate: SAMPLE_RATE })
    void shared.resume()
    return shared
  }

  return {
    async supported() {
      if (!media || typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function') return false
      try {
        const [encode, decode] = await Promise.all([
          AudioEncoder.isConfigSupported(ENCODER),
          AudioDecoder.isConfigSupported(DECODER),
        ])
        return !!encode.supported && !!decode.supported
      } catch {
        return false
      }
    },

    async capture(onFrame) {
      const stream = await media!.getUserMedia({ audio: MICROPHONE, video: false })
      const audio = context()
      // A context the browser would not run at 48 kHz cannot feed the encoder.
      if (audio.sampleRate !== SAMPLE_RATE) {
        stopTracks(stream.getTracks())
        throw new Error(`audio runs at ${audio.sampleRate} Hz`)
      }
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const frame = new Uint8Array(chunk.byteLength)
          chunk.copyTo(frame)
          onFrame(frame)
        },
        error: (err) => log.warn('voice encoder failed', err),
      })
      encoder.configure(ENCODER)
      const source = audio.createMediaStreamSource(stream)
      const processor = audio.createScriptProcessor(2048, 1, 1)
      let pending = new Float32Array(0)
      let timestamp = 0
      processor.onaudioprocess = (event) => {
        const block = event.inputBuffer.getChannelData(0)
        const samples = new Float32Array(pending.length + block.length)
        samples.set(pending)
        samples.set(block, pending.length)
        let at = 0
        for (; at + FRAME_SAMPLES <= samples.length; at += FRAME_SAMPLES) {
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: SAMPLE_RATE,
            numberOfFrames: FRAME_SAMPLES,
            numberOfChannels: 1,
            timestamp,
            data: samples.slice(at, at + FRAME_SAMPLES),
          })
          encoder.encode(data)
          data.close()
          timestamp += FRAME_MS * 1000
        }
        pending = samples.slice(at)
      }
      // A processor runs only while connected onward; its output stays silent.
      source.connect(processor)
      processor.connect(audio.destination)
      return {
        stop() {
          processor.onaudioprocess = null
          processor.disconnect()
          source.disconnect()
          if (encoder.state !== 'closed') encoder.close()
          stopTracks(stream.getTracks())
        },
      }
    },

    player() {
      const audio = context()
      const gain = audio.createGain()
      gain.connect(audio.destination)
      let playhead = 0
      let timestamp = 0
      const decoder = new AudioDecoder({
        output: (data) => {
          const samples = new Float32Array(data.numberOfFrames)
          data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
          const buffer = audio.createBuffer(1, samples.length, data.sampleRate)
          buffer.copyToChannel(samples, 0)
          data.close()
          const node = audio.createBufferSource()
          node.buffer = buffer
          node.connect(gain)
          // Back to back within a phrase; after a pause, a little ahead of
          // now, so the next packets have time to arrive behind it.
          if (playhead < audio.currentTime) playhead = audio.currentTime + PLAYOUT_DELAY_S
          node.start(playhead)
          playhead += buffer.duration
        },
        error: (err) => log.warn('voice decoder failed', err),
      })
      decoder.configure(DECODER)
      return {
        play(frames) {
          for (const frame of frames) {
            decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: frame }))
            timestamp += FRAME_MS * 1000
          }
        },
        mute(muted) {
          gain.gain.value = muted ? 0 : 1
        },
        close() {
          if (decoder.state !== 'closed') decoder.close()
          gain.disconnect()
        },
      }
    },
  }
}
