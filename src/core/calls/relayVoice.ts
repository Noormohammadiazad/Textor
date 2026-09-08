import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { IRelayPool, PublishOutcome, SubCloser } from '../transport/relayPool'
import { normalizeRelayUrl } from '../transport/relayUrl'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'

const log = createLogger('relay-voice')

/**
 * A walkie-talkie: push-to-talk over the Nostr relays both people use (ADR-069,
 * ADR-070), started from the conversation's header and nowhere else. It has
 * nothing to do with voice and video calls, and a call that fails never turns
 * into one (ADR-071).
 *
 * Opus at 12 kbit/s, forty 20 ms frames to a packet, each packet sealed with
 * XChaCha20-Poly1305 and published as an ephemeral event, which relays pass to
 * whoever is subscribed and keep no copy of. It is a walkie-talkie, not a
 * call: public relays are shared, and measured, they block a steady stream —
 * one blocked this device's address outright after 60 events in 24 seconds,
 * messages and all. So nothing is sent unless the button is held, each
 * packet goes to one relay, and no relay gets more than fifteen events a
 * minute from this side.
 *
 * Getting through both ways is negotiated, not assumed:
 *
 *  - Both sides listen on the relays measured to carry voice, as well as
 *    their own read relays, so there is always somewhere they meet.
 *  - Each side's hellos list where it listens, which relays have delivered
 *    the other side's packets to it, and the last packet it heard — so the
 *    other side sends where it is heard, and knows when it is not.
 *  - A relay that blocks ephemeral events gets the same packet as an expiring
 *    gift-wrap kind, which inbox relays take from anyone; a relay that refuses
 *    for any other reason — throttling, a web of trust — carries nothing more.
 *
 * Nothing new is exchanged to set it up: both sides derive the same keys from
 * what only the two of them hold, and publish under keys made from them, so
 * relays see two throwaway keys and never either person's.
 */

/** An ephemeral kind (NIP-01: 20000–29999): relays forward it and store nothing. Textor's own. */
export const KIND_RELAY_VOICE = 21690
/** For relays that block ephemeral kinds: the gift-wrap kind, which inbox relays take from anyone. */
export const KIND_VOICE_WRAP = 1059
/** How long a relay is asked to keep a packet sent that way (NIP-40). */
export const WRAP_TTL_SEC = 60
/**
 * Relays measured to carry voice from a throwaway key at speaking pace
 * (`npm run voice:probe`). Both sides always listen here, so they meet even
 * when neither's own relays will carry it.
 */
export const VOICE_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
  'wss://purplerelay.com',
]
export const FRAME_MS = 20
/** Forty frames, 800 ms: as few events as relays need, at the cost of a little more delay. */
export const FRAMES_PER_PACKET = 40
/** Every audio packet is padded to this, so the short one ending a phrase looks like the rest. */
export const AUDIO_PACKET_BYTES = 1280
/** Presence, while joined. */
export const HELLO_EVERY_MS = 6_000
/** …sooner when there is something new of theirs to acknowledge, so they learn whether they are heard. */
export const ACK_EVERY_MS = 3_000
/** Heard from within this, the other person is here. */
export const GONE_AFTER_MS = 20_000
/** Audio within this, they are talking. */
const TALKING_FOR_MS = 2_000
/** A press transmits for at most this long, as a radio's time-out timer does. */
export const TALK_LIMIT_MS = 30_000
/**
 * How long a packet that came early waits for one missing ahead of it. Long,
 * because a relay in the middle of a delay spike was measured at 4.1 s while
 * another stayed on time, and in the traces packets came late, not never. On
 * something used one way at a time, late speech beats missing speech.
 */
export const REORDER_MS = 5_000
/** Longer than this to accept a packet, a relay is used after the others (fast ones took under 0.7 s). */
export const SLOW_RELAY_MS = 1_000
/** Unacknowledged this long, this side's packets are not getting through: send each twice. */
export const UNHEARD_AFTER_MS = 4_000
/** Per relay: ten events at once, then one every four seconds — fifteen a minute. */
export const RELAY_BURST = 10
export const RELAY_REFILL_MS = 4_000
/** Relays a hello goes to; it is the other side's way in. */
const HELLO_RELAYS = 2
/** Relays named in a hello. */
const MAX_LISTED = 8
/** A session ends on its own after this: the relays are shared, and it should not be left on. */
export const MAX_SESSION_MS = 30 * 60_000
const REFRESH_MS = 500
const VERSION = 2
const SALT = 'textor relay voice v1'

export type VoiceRole = 'caller' | 'callee'

export interface VoiceKeys {
  /** Seals and opens every packet, both ways. */
  key: Uint8Array
  /** What this side publishes under. */
  secret: Uint8Array
  /** What the other side publishes under. */
  peer: string
}

/**
 * The keys of one session, the same on both devices. `caller` and `callee`
 * are the nonces each side put into the opening exchange.
 */
export function voiceKeys(input: {
  callId: string
  caller: string
  callee: string
  role: VoiceRole
}): VoiceKeys {
  const ikm = encode(`${input.callId}|${input.caller.toLowerCase()}|${input.callee.toLowerCase()}`)
  const derive = (info: string) => hkdf(sha256, ikm, encode(SALT), encode(info), 32)
  const caller = derive('caller')
  const callee = derive('callee')
  const mine = input.role === 'caller'
  return { key: derive('key'), secret: mine ? caller : callee, peer: getPublicKey(mine ? callee : caller) }
}

/** What a hello says: where its sender listens, where it heard the other side, and the last packet it heard. */
export interface VoiceHello {
  listen: string[]
  heard: string[]
  ack: number
}

export type VoicePacket =
  | { type: 'hello'; seq: number; hello: VoiceHello }
  | { type: 'bye'; seq: number }
  /** `start`: the first packet of a press, which nothing before it needs to be waited for. */
  | { type: 'audio'; seq: number; frames: Uint8Array[]; start?: boolean }

/** Type codes 1–3; 4 is audio that starts a press. */
const TYPES = ['hello', 'audio', 'bye'] as const
const START = 4

/**
 * Seal a packet: version, type, sequence number, frame count, then each frame
 * after its length — or, for a hello, its JSON — with a 24-byte nonce ahead
 * of the ciphertext, in Base64.
 */
export function sealPacket(key: Uint8Array, packet: VoicePacket): string {
  const frames = packet.type === 'audio' ? packet.frames : []
  const body =
    packet.type === 'hello'
      ? encode(JSON.stringify({ l: packet.hello.listen, h: packet.hello.heard, a: packet.hello.ack }))
      : new Uint8Array(frames.reduce((sum, frame) => sum + 1 + frame.length, 0))
  let at = 0
  for (const frame of frames) {
    body[at] = frame.length
    body.set(frame, at + 1)
    at += 1 + frame.length
  }
  const plain = new Uint8Array(Math.max(7 + body.length, packet.type === 'audio' ? AUDIO_PACKET_BYTES : 0))
  plain[0] = VERSION
  plain[1] = packet.type === 'audio' && packet.start ? START : TYPES.indexOf(packet.type) + 1
  new DataView(plain.buffer).setUint32(2, packet.seq)
  plain[6] = frames.length
  plain.set(body, 7)
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const sealed = xchacha20poly1305(key, nonce).encrypt(plain)
  const out = new Uint8Array(24 + sealed.length)
  out.set(nonce)
  out.set(sealed, 24)
  return btoa(String.fromCharCode(...out))
}

/** Open a packet, or null for anything not sealed with this key in this shape. */
export function openPacket(key: Uint8Array, content: string): VoicePacket | null {
  let plain: Uint8Array
  try {
    const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
    plain = xchacha20poly1305(key, bytes.subarray(0, 24)).decrypt(bytes.subarray(24))
  } catch {
    return null
  }
  const start = plain[1] === START
  const type = start ? 'audio' : TYPES[(plain[1] ?? 0) - 1]
  if (plain.length < 7 || plain[0] !== VERSION || !type) return null
  const seq = new DataView(plain.buffer, plain.byteOffset).getUint32(2)
  if (type === 'bye') return { type, seq }
  if (type === 'hello') {
    const hello = readHello(plain.subarray(7))
    return hello ? { type, seq, hello } : null
  }
  const frames: Uint8Array[] = []
  let at = 7
  for (let i = 0; i < plain[6]!; i++) {
    const size = plain[at]
    if (size === undefined || at + 1 + size > plain.length) return null
    frames.push(plain.slice(at + 1, at + 1 + size))
    at += 1 + size
  }
  return start ? { type, seq, frames, start } : { type, seq, frames }
}

function readHello(bytes: Uint8Array): VoiceHello | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const { l, h, a } = value as Record<string, unknown>
    if (!Array.isArray(l) || !Array.isArray(h) || typeof a !== 'number') return null
    return { listen: relayList(l), heard: relayList(h), ack: a }
  } catch {
    return null
  }
}

/**
 * Relays someone else named, as addresses this device would connect to: only
 * well-formed `wss:` ones, and only a few — the same trust as publishing to
 * their inbox relays, which every message to them already does.
 */
export function relayList(values: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    const url = typeof value === 'string' ? normalizeRelayUrl(value) : null
    if (url?.startsWith('wss://')) out.add(url)
  }
  return [...out].slice(0, MAX_LISTED)
}

/** The microphone, running: 20 ms Opus frames arrive until it is stopped. */
export interface VoiceCapture {
  stop(): void
}

/** The other side's voice, played as its frames arrive. */
export interface VoicePlayer {
  play(frames: Uint8Array[]): void
  /** Silenced while this side talks, so the speaker does not feed the microphone. */
  mute(muted: boolean): void
  close(): void
}

export interface VoicePlatform {
  /** Whether this browser can encode and decode Opus as used here. */
  supported(): Promise<boolean>
  capture(onFrame: (frame: Uint8Array) => void): Promise<VoiceCapture>
  player(): VoicePlayer
}

export interface VoiceTransport {
  pool: Pick<IRelayPool, 'publish' | 'subscribe'>
  /** The relays the other person's description says they listen on. */
  relays: readonly string[]
  /** This side's own read relays in use, which the pool keeps connected. */
  mine: () => readonly string[]
}

/**
 *  listening    subscribed to the other side, not sending
 *  joining      opening the microphone and the decoder
 *  live         joined: hold to talk
 *  unsupported  this browser cannot encode or decode Opus
 *  failed       the microphone or the audio would not start; joining again may work
 *  refused      every relay that could reach them refused
 *  closed       over
 */
export type VoiceState = 'listening' | 'joining' | 'live' | 'unsupported' | 'failed' | 'refused' | 'closed'

export interface VoiceView {
  state: VoiceState
  /** Heard from lately: the other person has joined. */
  peerHere: boolean
  peerTalking: boolean
  talking: boolean
  /**
   * Whether the other side has heard this one: true once it says so, false
   * when it has not for `UNHEARD_AFTER_MS`, null before then and before this
   * side has said anything.
   */
  heard: boolean | null
  /** Every relay has spent its share for now: what is said is not going out. */
  throttled: boolean
  /** Relays that can still reach them. */
  relays: number
}

/**
 * One session of relay voice: listening for the other side from the start,
 * so the screen can say when they join, and sending only once this side has
 * joined and holds the button.
 */
export class RelayVoice {
  readonly events = new Emitter<{ changed: VoiceView }>()

  #keys: VoiceKeys
  #mine: string
  #transport: VoiceTransport
  #platform: VoicePlatform
  #now: () => number
  #state: VoiceState = 'listening'
  #subscriptions: SubCloser[] = []
  #capture: VoiceCapture | null = null
  #player: VoicePlayer | null = null
  #talking = false
  #talkTimer: ReturnType<typeof setTimeout> | null = null
  #frames: Uint8Array[] = []
  /** The next packet is the first of a press. */
  #pressed = false
  /**
   * Audio packets count up for as long as this session lasts — leaving and
   * joining again included — so the other side never takes a new one for an
   * old one. Each session has keys of its own, so each starts at zero.
   */
  #audioSeq = 0
  #seq = 0
  #sentAudio = -1
  /** Since when this side has sent audio and heard nothing new about it. */
  #unackedSince: number | null = null
  /** The last packet of this side's they have said they heard. */
  #peerAck = -1
  /** They have said they hear this press, whatever is still on its way. */
  #hearing = false
  #throttledAt = 0
  #helloAt = 0
  // What the other side said, and what came from it.
  #peerListen: string[] = []
  #peerHeard: string[] = []
  #peerSeenAt = 0
  #peerAudioAt = 0
  #heardVia = new Set<string>()
  #received = -1
  /** The last packet of theirs a hello of this side acknowledged. */
  #acked = -1
  #played = -1
  #pending = new Map<number, Uint8Array[]>()
  /** Packets waiting that start a press. */
  #starts = new Set<number>()
  #gapTimer: ReturnType<typeof setTimeout> | null = null
  // What each relay has done with this side's packets.
  #wrapped = new Set<string>()
  #refused = new Set<string>()
  #answered = new Set<string>()
  #slow = new Set<string>()
  #budget = new Map<string, { tokens: number; at: number }>()
  #timers: ReturnType<typeof setInterval>[] = []
  #shown = ''

  constructor(
    keys: VoiceKeys,
    transport: VoiceTransport,
    platform: VoicePlatform,
    now: () => number = Date.now,
  ) {
    this.#keys = keys
    this.#mine = getPublicKey(keys.secret)
    this.#transport = transport
    this.#platform = platform
    this.#now = now
  }

  get view(): VoiceView {
    const now = this.#now()
    return {
      state: this.#state,
      peerHere: now - this.#peerSeenAt < GONE_AFTER_MS,
      peerTalking: now - this.#peerAudioAt < TALKING_FOR_MS,
      talking: this.#talking,
      heard:
        this.#sentAudio < 0
          ? null
          : this.#unheard(now)
            ? false
            : this.#unackedSince === null || this.#hearing
              ? true
              : null,
      throttled: now - this.#throttledAt < REFRESH_MS * 4,
      relays: this.#candidates().length,
    }
  }

  /**
   * Subscribe to the other side: on this side's own read relays, as the pool
   * keeps them, and on the voice relays, kept connected by the subscription.
   */
  listen(): void {
    const since = Math.floor(this.#now() / 1000) - 10
    const handlers = {
      onEvent: (event: NostrEvent, url?: string) => this.#receive(event, url),
      label: 'relay-voice',
    }
    const filters: Filter[] = [
      { kinds: [KIND_RELAY_VOICE], authors: [this.#keys.peer], since },
      // Gift-wrap-kind packets are found by whom they are for, as an inbox is.
      { kinds: [KIND_VOICE_WRAP], '#p': [this.#mine], since },
    ]
    const pool = this.#transport.pool
    for (const filter of filters) {
      this.#subscriptions.push(
        pool.subscribe(filter, handlers),
        pool.subscribe(filter, handlers, [...VOICE_RELAYS]),
      )
    }
    this.#timers.push(setInterval(() => this.#tick(), REFRESH_MS))
  }

  /** Open the microphone and the speaker, and say so. Again after a failure, too. */
  async join(): Promise<void> {
    if (this.#state !== 'listening' && this.#state !== 'failed') return
    this.#set('joining')
    if (!(await this.#platform.supported())) {
      this.#set('unsupported')
      return
    }
    try {
      this.#player = this.#platform.player()
      this.#capture = await this.#platform.capture((frame) => this.#frame(frame))
    } catch (err) {
      log.warn('relay voice could not start', err)
      this.#stopMedia()
      this.#set('failed')
      return
    }
    // Left, or closed, while the microphone prompt was up — read through a
    // method, since the compiler does not know an `await` can change it.
    if (!this.#is('joining')) {
      this.#stopMedia()
      return
    }
    this.#set('live')
    this.#hello()
    this.#timers.push(setTimeout(() => this.leave(), MAX_SESSION_MS))
  }

  /** Hold to talk: frames go out only while this is on, and for at most `TALK_LIMIT_MS` a press. */
  talk(on: boolean): void {
    if (this.#state !== 'live' || on === this.#talking) return
    this.#talking = on
    this.#pressed = on
    if (on) this.#hearing = false
    // Live means joined, and joining opened the speaker.
    this.#player!.mute(on)
    if (this.#talkTimer) clearTimeout(this.#talkTimer)
    this.#talkTimer = on ? setTimeout(() => this.talk(false), TALK_LIMIT_MS) : null
    if (!on) this.#flush()
    this.#changed()
  }

  /** Stop sending, say goodbye, and go back to listening. */
  leave(): void {
    if (this.#state === 'closed' || this.#state === 'listening') return
    if (this.#state === 'live') {
      this.talk(false)
      this.#send({ type: 'bye', seq: this.#seq++ }, HELLO_RELAYS)
    }
    this.#stopMedia()
    this.#clearTimers()
    this.#timers.push(setInterval(() => this.#tick(), REFRESH_MS))
    this.#set('listening')
  }

  /** Over for good: the screen that offered it has closed. */
  close(): void {
    if (this.#state === 'closed') return
    this.leave()
    for (const subscription of this.#subscriptions) subscription.close()
    this.#subscriptions = []
    this.#clearTimers()
    this.#set('closed')
    this.events.clear()
  }

  // --- sending --------------------------------------------------------------

  #frame(frame: Uint8Array): void {
    // A length must fit its byte; Opus at this rate makes 30-byte frames.
    if (!this.#talking || frame.length === 0 || frame.length > 255) return
    this.#frames.push(frame)
    if (this.#frames.length >= FRAMES_PER_PACKET) this.#flush()
  }

  #flush(): void {
    if (this.#frames.length === 0) return
    const now = this.#now()
    const seq = this.#audioSeq++
    this.#sentAudio = seq
    this.#unackedSince ??= now
    const start = this.#pressed
    this.#pressed = false
    // Not heard lately: twice, by two ways, until they say they hear.
    this.#send({ type: 'audio', seq, frames: this.#frames.splice(0), start }, this.#unheard(now) ? 2 : 1, seq)
  }

  #hello(): void {
    this.#helloAt = this.#now()
    const listen = relayList([...VOICE_RELAYS, ...this.#transport.mine()])
    const hello = { listen, heard: [...this.#heardVia].slice(-MAX_LISTED), ack: this.#received }
    this.#acked = this.#received
    this.#send({ type: 'hello', seq: this.#seq++, hello }, HELLO_RELAYS)
  }

  /**
   * Publish a packet to `count` relays that can reach the other side and
   * have budget left, starting at `rotate` around them so the load is shared,
   * and only the relays it goes to pay for it. In the order `#preferred` gives —
   * unless the other side is not hearing, when any of them may be the way through.
   */
  #send(packet: VoicePacket, count: number, rotate = 0, avoid?: string): void {
    const now = this.#now()
    const ring = this.#candidates().filter((url) => url !== avoid)
    if (ring.length === 0) {
      if (this.#state === 'live') this.#set('refused')
      return
    }
    const order = ring.map((_, i) => ring[(rotate + i) % ring.length]!)
    const tried = this.#unheard(now) ? order : this.#preferred(order)
    const targets: string[] = []
    for (const url of tried) {
      if (targets.length < count && this.#take(url, now)) targets.push(url)
    }
    if (targets.length === 0) {
      this.#throttledAt = now
      this.#changed()
      return
    }
    const content = sealPacket(this.#keys.key, packet)
    for (const url of targets) this.#publish(packet, content, url)
  }

  /**
   * Relays the other side says it has heard this side on come first: a relay
   * accepting a packet does not mean it reached them. Then the rest, and last
   * those that are slow or need the gift-wrap kind, which relays store before
   * passing on (one took over five seconds) — unless they are all that has
   * been shown to reach the other side, whose network may allow nothing else.
   */
  #preferred(order: string[]): string[] {
    const proven = (url: string) => this.#peerHeard.includes(url)
    const last = (url: string) => this.#wrapped.has(url) || this.#slow.has(url)
    const onlyLastProven = !order.some((url) => proven(url) && !last(url))
    const rank = (url: string) => (last(url) ? (onlyLastProven && proven(url) ? 0 : 2) : proven(url) ? 0 : 1)
    return [...order].sort((a, b) => rank(a) - rank(b))
  }

  #publish(packet: VoicePacket, content: string, url: string): void {
    const wrap = this.#wrapped.has(url)
    const now = Math.floor(this.#now() / 1000)
    const event = finalizeEvent(
      wrap
        ? {
            kind: KIND_VOICE_WRAP,
            created_at: now,
            tags: [
              ['p', this.#keys.peer],
              ['expiration', String(now + WRAP_TTL_SEC)],
            ],
            content,
          }
        : { kind: KIND_RELAY_VOICE, created_at: now, tags: [], content },
      this.#keys.secret,
    )
    void this.#transport.pool
      .publish(event, [url])
      .then(([outcome]) => this.#outcome(packet, content, outcome!, wrap))
  }

  /** A relay's answer: a refusal of the ephemeral kind tries the other; any other refusal ends that relay's part. */
  #outcome(packet: VoicePacket, content: string, outcome: PublishOutcome, wrapped: boolean): void {
    if (this.#state === 'closed') return
    if (outcome.ok) {
      // A relay's first answer includes opening the connection, so says nothing of it.
      if (this.#answered.has(outcome.url)) {
        if (outcome.ms > SLOW_RELAY_MS) this.#slow.add(outcome.url)
        else this.#slow.delete(outcome.url)
      }
      this.#answered.add(outcome.url)
      return
    }
    if (!wrapped && /ephemeral|kind/i.test(outcome.error)) {
      this.#wrapped.add(outcome.url)
      if (this.#take(outcome.url, this.#now())) this.#publish(packet, content, outcome.url)
      return
    }
    this.#refused.add(outcome.url)
    log.debug(`relay voice: ${outcome.url} refused (${outcome.error})`)
    // Audio lost on the way goes once more, another way.
    if (packet.type === 'audio') this.#send(packet, 1, packet.seq, outcome.url)
    else if (this.#candidates().length === 0 && this.#state === 'live') this.#set('refused')
    this.#changed()
  }

  /**
   * Where the other side can be reached, best first: relays it has heard this
   * side on, then those it says it listens on, then the voice relays, then
   * its inbox — less any that refused.
   */
  #candidates(): string[] {
    const all = new Set([...this.#peerHeard, ...this.#peerListen, ...VOICE_RELAYS, ...this.#transport.relays])
    return [...all].filter((url) => !this.#refused.has(url))
  }

  /** One event's worth of a relay's budget, if it has any left. */
  #take(url: string, now: number): boolean {
    const bucket = this.#budget.get(url) ?? { tokens: RELAY_BURST, at: now }
    bucket.tokens = Math.min(RELAY_BURST, bucket.tokens + (now - bucket.at) / RELAY_REFILL_MS)
    bucket.at = now
    this.#budget.set(url, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  #unheard(now: number): boolean {
    return this.#unackedSince !== null && now - this.#unackedSince >= UNHEARD_AFTER_MS
  }

  // --- receiving ------------------------------------------------------------

  #receive(event: NostrEvent, url?: string): void {
    if (event.pubkey !== this.#keys.peer) return
    const packet = openPacket(this.#keys.key, event.content)
    if (!packet) return
    if (url) this.#heardVia.add(url)
    const now = this.#now()
    // Someone not heard from, now heard: say hello back at once, so they
    // know this side is here without waiting for the next one. Only to
    // someone new, so two sides answering each other stop after one round.
    const arrived = packet.type !== 'bye' && now - this.#peerSeenAt >= GONE_AFTER_MS
    if (packet.type === 'bye') {
      this.#peerSeenAt = 0
      this.#peerAudioAt = 0
    } else if (packet.type === 'hello') {
      this.#peerSeenAt = now
      this.#peerListen = packet.hello.listen
      this.#peerHeard = packet.hello.heard
      const { ack } = packet.hello
      if (ack > this.#peerAck) {
        // They are hearing this press; what they have not mentioned is on its way.
        this.#peerAck = ack
        this.#unackedSince = ack >= this.#sentAudio ? null : now
        this.#hearing = true
      }
    } else {
      this.#peerSeenAt = now
      this.#peerAudioAt = now
      this.#received = Math.max(this.#received, packet.seq)
      if (packet.seq > this.#played && !this.#pending.has(packet.seq)) {
        this.#pending.set(packet.seq, packet.frames)
        if (packet.start) this.#starts.add(packet.seq)
        this.#drain()
      }
    }
    if (arrived && this.#state === 'live') this.#hello()
    this.#changed()
  }

  /**
   * Play what has arrived in order. Each packet comes by one relay of
   * several, each with its own delay, so one may overtake another: it waits a
   * moment for the one ahead of it, and then the gap is passed over. The
   * first packet of a press waits for nothing — nothing before it belongs.
   */
  #drain(): void {
    for (;;) {
      const next = this.#played + 1
      const first = Math.min(...this.#pending.keys())
      if (!this.#pending.has(next) && this.#starts.has(first)) this.#played = first - 1
      if (!this.#pending.has(this.#played + 1)) break
      const seq = this.#played + 1
      this.#player?.play(this.#pending.get(seq)!)
      this.#pending.delete(seq)
      this.#starts.delete(seq)
      this.#played = seq
    }
    if (this.#pending.size === 0 || this.#gapTimer) return
    this.#gapTimer = setTimeout(() => {
      this.#gapTimer = null
      this.#played = Math.min(...this.#pending.keys()) - 1
      this.#drain()
    }, REORDER_MS)
  }

  // --- the rest -------------------------------------------------------------

  #tick(): void {
    // While joined, a hello now and then — sooner when the other side has
    // said something new, which is what tells it whether it is heard.
    const every = this.#received > this.#acked ? ACK_EVERY_MS : HELLO_EVERY_MS
    if (this.#state === 'live' && this.#now() - this.#helloAt >= every) this.#hello()
    this.#changed()
  }

  #stopMedia(): void {
    this.#capture?.stop()
    this.#player?.close()
    this.#capture = null
    this.#player = null
    this.#talking = false
    this.#frames = []
  }

  /** Every timer but the press's, which letting go of the button — first, on leaving — has cleared. */
  #clearTimers(): void {
    for (const timer of this.#timers) clearInterval(timer)
    if (this.#gapTimer) clearTimeout(this.#gapTimer)
    this.#timers = []
    this.#gapTimer = null
    this.#pending.clear()
    this.#starts.clear()
  }

  #is(state: VoiceState): boolean {
    return this.#state === state
  }

  #set(state: VoiceState): void {
    this.#state = state
    this.#changed()
  }

  /** Say what changed, and only when something has. */
  #changed(): void {
    const view = this.view
    const shown = JSON.stringify(view)
    if (shown === this.#shown) return
    this.#shown = shown
    this.events.emit('changed', view)
  }
}

/** A walkie-talkie session's own description, carried where a call's offer and answer carry SDP (ADR-070). */
export interface RadioDescription {
  /** 32 random bytes, hex: what this side puts into the session's keys. */
  nonce: string
  /** Where this side listens. */
  listen: string[]
}

export const describeRadio = (description: RadioDescription): string =>
  JSON.stringify({ radio: 1, nonce: description.nonce, listen: relayList(description.listen) })

export function readRadio(sdp: string): RadioDescription | null {
  try {
    const { radio, nonce, listen } = JSON.parse(sdp) as Record<string, unknown>
    if (radio !== 1 || typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce) || !Array.isArray(listen))
      return null
    return { nonce, listen: relayList(listen) }
  } catch {
    return null
  }
}

const encode = (text: string) => new TextEncoder().encode(text)
