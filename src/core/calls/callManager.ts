import { Emitter } from '../util/emitter'
import { bytesToHex } from '../util/bytes'
import { createLogger } from '../util/log'
import { isOpeningOffer, PROTOCOL_VERSION, type CallFrame, type IceCandidateFrame } from '../models/protocol'
import {
  hasTurnServer,
  looksSymmetric,
  type CallEndReason,
  type CallMedia,
  type CallOutcome,
  type CallRecord,
} from '../models/call'
import type { IceServerSetting } from '../models/types'
import { CallSession, type ConnectionPhase, type MediaState, type SessionSignal } from './callSession'
import { diagnoseIce, hasPublicAddress, hasPublicIpv6, type IceDiagnosis } from './diagnose'
import type * as Turn from './turn'
import {
  describeRadio,
  readRadio,
  RelayVoice,
  VOICE_RELAYS,
  voiceKeys,
  type VoicePlatform,
  type VoiceView,
} from './relayVoice'
import type { IRelayPool } from '../transport/relayPool'
import {
  camera,
  classifyMediaError,
  MediaError,
  MICROPHONE,
  stopTracks,
  type Facing,
  type MediaBackend,
  type MediaFailure,
} from './media'

const log = createLogger('calls')

/** How long an outgoing call rings before it is given up as unanswered. */
export const RING_TIMEOUT_MS = 45_000
/** An incoming call stops ringing a little after the caller would have given up. */
export const INCOMING_TIMEOUT_MS = 50_000
/**
 * With no push notifications a call rings only where Textor is open (ADR-007),
 * so silence from the other device is common and says something. After this
 * long without it confirming that it is ringing, the screen says so.
 */
export const NOT_REACHED_MS = 8_000
/** From answer to media flowing. ICE that has not connected by now will not. */
export const CONNECT_TIMEOUT_MS = 25_000
/** A connection that drops is given this long to recover before ICE is restarted. */
export const RECOVER_AFTER_MS = 3_000
/** …and this long in all before the call is given up as lost. */
export const LOST_AFTER_MS = 20_000
export const MAX_ICE_RESTARTS = 2
/**
 * How long direct paths get, once the caller holds the answer, before TURN is
 * brought in (ADR-068). Two devices that can meet directly have by then: the
 * answer carries the callee's candidates, and checks take a round trip.
 */
export const ESCALATE_AFTER_MS = 4_000
/** …or when the candidates already say no direct path across the internet can work. */
export const ESCALATE_SOON_MS = 1_000
/** When a relayed call's round trip and bandwidth are read, once the browser's estimates settle. */
export const SAMPLE_AFTER_MS = 10_000
/** How long an ordinary ending stays on screen before the call view closes itself. */
export const ENDED_LINGER_MS = 2_500
/** Candidates held for a call that is still ringing here. */
const MAX_HELD_CANDIDATES = 64

export type CallPhase =
  'outgoing' | 'ringing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended'

/**
 * Why the call on screen ended, as the screen explains it.
 *
 *  hangup            someone hung up an answered call
 *  cancelled         we stopped calling before they answered
 *  declined / busy   what they said
 *  unanswered        nobody picked up
 *  missed            it rang here and stopped
 *  failed            it could not connect; `diagnosis` says why
 *  lost              it connected, then the connection went and did not come back
 *  media             the camera or microphone could not be opened; `media` says why
 *  relay-needs-turn  "always relay" is on, and there is no TURN server to relay through
 *  radio-unsupported a walkie-talkie, in a browser that cannot encode or decode its voice
 *  error             the signal could not be sent at all
 */
export type CallEndKind =
  | 'hangup'
  | 'cancelled'
  | 'declined'
  | 'busy'
  | 'unanswered'
  | 'missed'
  | 'failed'
  | 'lost'
  | 'media'
  | 'relay-needs-turn'
  | 'radio-unsupported'
  | 'error'

export interface CallEnd {
  kind: CallEndKind
  diagnosis?: IceDiagnosis
  media?: MediaFailure
}

/** What the call manager sends: what the session asks for, and the call's own words. */
type OutgoingSignal = SessionSignal | { kind: 'ringing' } | { kind: 'bye'; reason: CallEndReason }

/** Endings the person needs to read and act on, so they stay until dismissed. */
const STICKY_ENDS: ReadonlySet<CallEndKind> = new Set([
  'failed',
  'media',
  'relay-needs-turn',
  'radio-unsupported',
  'error',
])

export const isStickyEnd = (kind: CallEndKind): boolean => STICKY_ENDS.has(kind)

export type CallNotice = 'camera-unavailable' | 'screen-failed'

export interface LocalMediaView {
  muted: boolean
  camera: boolean
  screen: boolean
  facing: Facing
  canFlip: boolean
  canShare: boolean
  /** The camera or the shared screen, for the preview. */
  stream: MediaStream | null
}

export interface RemoteMediaView extends MediaState {
  /** Everything the other side sends, audio included. */
  stream: MediaStream | null
}

/** A snapshot of the call, for the screen. Replaced, never mutated. */
export interface CallView {
  /** The rumor id of the opening offer; null until that offer has been queued. */
  id: string | null
  peer: string
  direction: 'in' | 'out'
  /** What the call was placed as. */
  media: CallMedia
  phase: CallPhase
  startedAt: number
  connectedAt: number | null
  /** The other device has confirmed it is ringing. */
  reached: boolean
  /** It has not, for long enough to be worth saying. */
  notReached: boolean
  /** Whether media flows directly or through a TURN server, once known. */
  path: 'direct' | 'relay' | null
  /** Direct paths failed, and the call is trying again through TURN. */
  relaying: boolean
  /** Push-to-talk over relays, once every network path has failed. */
  voice: VoiceView | null
  relayOnly: boolean
  local: LocalMediaView
  remote: RemoteMediaView
  ended: CallEnd | null
  notice: CallNotice | null
}

export interface CallEnvironment {
  /** This identity's public key: the lower key of the two is the polite peer. */
  self: string
  /** Send a call signal; resolves to the id of the rumor that carried it. */
  signal: (peer: string, frame: CallFrame) => Promise<string>
  /** Write a call into its conversation. */
  record: (peer: string, id: string, direction: 'in' | 'out', record: CallRecord, at: number) => Promise<void>
  /** Tell this identity's other devices a call has been picked up or turned down here. */
  handled: (peer: string, id: string) => void
  config: () => { iceServers: IceServerSetting[]; relayOnly: boolean }
  /** Where what calls learn about TURN servers is kept between them. */
  store: Turn.TurnStore
  /** TURN selection, loaded when a call needs it (ADR-068). */
  turn: () => Promise<typeof Turn>
  /** A walkie-talkie's push-to-talk over relays (ADR-070). */
  voice: {
    pool: Pick<IRelayPool, 'publish' | 'subscribe' | 'rankedReadRelays'>
    platform: VoicePlatform
  }
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection
  createStream: (tracks: MediaStreamTrack[]) => MediaStream
  media: MediaBackend | null
  gatherGraceMs?: number
}

export type CallManagerEvents = {
  changed: CallView | null
}

export type CallControl =
  | { type: 'accept'; media?: CallMedia }
  | { type: 'decline' }
  | { type: 'hangup' }
  | { type: 'mute'; muted: boolean }
  | { type: 'camera'; on: boolean }
  | { type: 'flip' }
  | { type: 'screen'; on: boolean }
  | { type: 'dismiss' }
  | { type: 'talk'; on: boolean }

interface Call {
  id: string | null
  peer: string
  direction: 'in' | 'out'
  media: CallMedia
  phase: CallPhase
  startedAt: number
  answered: boolean
  connectedAt: number | null
  endedAt: number
  reached: boolean
  notReached: boolean
  path: 'direct' | 'relay' | null
  relayOnly: boolean
  /** The TURN servers this call may bring in, best first, with its credentials. */
  turn: RTCIceServer[]
  /** What is known about them, read when the call began. */
  health: Turn.TurnHealthMap
  /** TURN selection, once loaded; null should it fail to. */
  selection: typeof Turn | null
  /** A walkie-talkie's whole session. A voice or video call never has one (ADR-071). */
  voice: RelayVoice | null
  /** What this side put into a walkie-talkie's keys. */
  nonce: string | null
  /** The other side's fingerprint did not match its description. */
  session: CallSession | null
  /** An incoming call's offer, until it is answered. */
  offer: { sdp: string; fingerprint?: string } | null
  /** Candidates that arrived while it was still ringing here. */
  held: IceCandidateFrame[]
  /** Signals made before the opening offer had an id to name the call by. */
  queued: OutgoingSignal[]
  mic: MediaStreamTrack | null
  camera: MediaStreamTrack | null
  screen: MediaStreamTrack | null
  muted: boolean
  facing: Facing
  canFlip: boolean
  remoteTracks: MediaStreamTrack[]
  remote: MediaState
  restarts: number
  timers: Map<string, ReturnType<typeof setTimeout>>
  ended: CallEnd | null
  outcome: CallOutcome
  /** The bye to send once the call has an id to put on it. */
  bye: CallEndReason | null
  /** Recorded and said goodbye to. */
  settled: boolean
  /** Given up in favour of the other side's call when both called at once. Leaves no trace. */
  abandoned: boolean
  notice: CallNotice | null
  views: { local?: [string, MediaStream | null]; remote?: [string, MediaStream | null] }
}

/**
 * The call state machine: at most one call at a time, one person at a time.
 *
 *   out:  outgoing → ringing → connecting → connected ⇄ reconnecting → ended
 *   in:   incoming ────────→ connecting → connected ⇄ reconnecting → ended
 *
 * Privacy is decided by when things happen. Nothing is sent and no peer
 * connection exists on the receiving side until the person accepts, so an
 * incoming call learns nothing about this device — not its IP address, not
 * even a STUN server's view of it — beyond the `ringing` that says the app is
 * open. The caller's candidates reach the callee with the offer; that is the
 * caller's choice, made by calling.
 */
export class CallManager {
  readonly events = new Emitter<CallManagerEvents>()

  #env: CallEnvironment
  #call: Call | null = null
  #disposed = false

  constructor(env: CallEnvironment) {
    this.#env = env
  }

  get view(): CallView | null {
    return this.#call ? this.#view(this.#call) : null
  }

  control(action: CallControl): Promise<void> {
    switch (action.type) {
      case 'accept':
        return this.accept(action.media)
      case 'decline':
        this.decline()
        break
      case 'hangup':
        this.hangup()
        break
      case 'mute':
        this.setMuted(action.muted)
        break
      case 'camera':
        return this.setCamera(action.on)
      case 'flip':
        return this.flipCamera()
      case 'screen':
        return this.setScreenShare(action.on)
      case 'dismiss':
        this.dismiss()
        break
      case 'talk':
        this.talk(action.on)
        break
    }
    return Promise.resolve()
  }

  // --- placing ----------------------------------------------------------------

  async place(peer: string, media: CallMedia): Promise<void> {
    if (this.#disposed) return
    if (this.#live(this.#call)) throw new Error('already in a call')
    const call = this.#begin({ peer, direction: 'out', media, phase: 'outgoing', startedAt: Date.now() })
    if (media === 'radio') return this.#placeRadio(call)
    if (!(await this.#prepare(call, media))) return

    const session = this.#openSession(call)
    await this.#attach(call, session)
    let description: { sdp: string; fingerprint?: string }
    try {
      description = await session.offer()
    } catch (err) {
      log.warn('could not make an offer', err)
      this.#finish(call, { kind: 'error' })
      return
    }
    // Hung up while candidates were gathering: nothing has been sent yet.
    if (call.phase === 'ended' || !this.#current(call)) return

    let id: string
    try {
      id = await this.#env.signal(call.peer, {
        v: PROTOCOL_VERSION,
        t: 'rtc',
        kind: 'offer',
        media,
        ...description,
      })
    } catch (err) {
      log.warn('could not send the offer', err)
      this.#finish(call, { kind: 'error' })
      return
    }
    this.#ringOut(call, id)
  }

  /**
   * A walkie-talkie (ADR-070): no peer connection, and no network path to
   * find — just an offer saying where this side listens, and relay voice the
   * moment it is answered.
   */
  async #placeRadio(call: Call): Promise<void> {
    if (!(await this.#radioReady(call)) || hasEnded(call)) return
    let id: string
    try {
      id = await this.#env.signal(call.peer, {
        v: PROTOCOL_VERSION,
        t: 'rtc',
        kind: 'offer',
        media: 'radio',
        sdp: this.#describeRadio(call),
      })
    } catch (err) {
      log.warn('could not send the offer', err)
      this.#finish(call, { kind: 'error' })
      return
    }
    this.#ringOut(call, id)
  }

  /** The offer is on its way: the call has its id, and rings until answered or given up. */
  #ringOut(call: Call, id: string): void {
    call.id = id
    // Hung up while the offer was on its way to the outbox: the call now has
    // an id to say goodbye with, and a record to write.
    if (hasEnded(call)) {
      this.#settle(call)
      return
    }
    for (const signal of call.queued.splice(0)) this.#send(call, signal)
    this.#arm(call, 'ring', RING_TIMEOUT_MS, () => this.#finish(call, { kind: 'unanswered' }, 'unanswered'))
    this.#arm(call, 'reach', NOT_REACHED_MS, () => {
      if (call.reached || call.phase === 'ended') return
      call.notReached = true
      this.#emit()
    })
    this.#emit()
  }

  // --- receiving --------------------------------------------------------------

  /**
   * A signal from the engine. Only accepted contacts get this far, and only
   * offers recent enough to ring (see `Messenger.#routeCall`).
   */
  async handleSignal(peer: string, frame: CallFrame, callId: string, at: number): Promise<void> {
    if (this.#disposed) return
    const call = this.#call
    if (isOpeningOffer(frame)) {
      await this.#offered(peer, frame, callId, at)
      return
    }
    if (!call || call.id !== callId || call.peer !== peer || call.phase === 'ended') return

    switch (frame.kind) {
      case 'ringing':
        if (call.direction !== 'out' || call.reached) return
        call.reached = true
        call.notReached = false
        if (call.phase === 'outgoing') call.phase = 'ringing'
        this.#emit()
        return

      case 'answer':
        if (call.direction === 'out' && !call.answered) await this.#answered(call, frame)
        else if (frame.sdp) await call.session?.receive('answer', frame.sdp, frame.fingerprint)
        return

      case 'offer': {
        // Renegotiation, once the call is up: a camera turned on, a screen
        // shared, ICE restarted after a network change.
        if (!call.session || !call.answered || !frame.sdp) return
        const answer = await call.session.receive('offer', frame.sdp, frame.fingerprint)
        if (answer) this.#send(call, { kind: 'answer', ...answer })
        return
      }

      case 'candidate':
        if (!frame.candidate) return
        if (call.session) {
          await call.session.addCandidate(frame.candidate)
        } else if (call.held.length < MAX_HELD_CANDIDATES) {
          call.held.push(frame.candidate)
        }
        return

      case 'bye':
        this.#remoteBye(call, frame.reason ?? 'hangup')
        return
    }
  }

  async #offered(
    peer: string,
    frame: CallFrame & { media: CallMedia; sdp: string },
    callId: string,
    at: number,
  ): Promise<void> {
    const current = this.#call
    if (current?.id === callId) return // the same offer, delivered twice

    if (this.#live(current) && current) {
      if (current.peer !== peer) {
        // One call at a time. Say so, so they are not left listening to it
        // ring, and keep the missed call for later.
        void this.#env
          .signal(peer, { v: PROTOCOL_VERSION, t: 'rtc', kind: 'bye', call: callId, reason: 'busy' })
          .catch((err: unknown) => log.warn('could not send busy', err))
        void this.#env
          .record(peer, callId, 'in', { media: frame.media, outcome: 'missed' }, at)
          .catch((err: unknown) => log.warn('could not record a missed call', err))
        return
      }
      if (current.direction === 'out' && !current.answered) {
        // Both called each other at once. The polite side — the lower key —
        // gives up its own call and answers the other's with the media it
        // already has open; the impolite side ignores this offer, because
        // its own is about to be answered. Nobody hears a busy signal.
        if (this.#env.self > peer) return
        await this.#takeOver(current, peer, frame, callId, at)
        return
      }
      // The same person, starting over — they reloaded mid-call, say. Their
      // new call replaces the one that is no longer on their side.
      this.#finish(current, { kind: current.answered ? 'hangup' : 'missed' })
    }

    this.#ring(peer, frame, callId, at)
  }

  #ring(
    peer: string,
    frame: CallFrame & { media: CallMedia; sdp: string },
    callId: string,
    at: number,
  ): Call {
    const call = this.#begin({
      peer,
      direction: 'in',
      media: frame.media,
      phase: 'incoming',
      startedAt: Math.min(at, Date.now()),
    })
    call.id = callId
    call.offer = frame.fingerprint ? { sdp: frame.sdp, fingerprint: frame.fingerprint } : { sdp: frame.sdp }
    this.#arm(call, 'ring', INCOMING_TIMEOUT_MS, () => this.#finish(call, { kind: 'missed' }, 'unanswered'))
    // Tell the caller it is ringing, so their screen can say so. This is all
    // an unanswered call learns about this device: that the app is open.
    this.#send(call, { kind: 'ringing' })
    this.#emit()
    return call
  }

  async #takeOver(
    mine: Call,
    peer: string,
    frame: CallFrame & { media: CallMedia; sdp: string },
    callId: string,
    at: number,
  ): Promise<void> {
    // The devices move across rather than being closed and reopened, so the
    // camera light does not blink and no second permission prompt appears.
    const { mic, camera: cam, muted, facing, canFlip } = mine
    mine.mic = null
    mine.camera = null
    mine.abandoned = true
    mine.phase = 'ended'
    this.#clearAll(mine)
    const call = this.#ring(peer, frame, callId, at)
    Object.assign(call, { mic, camera: cam, muted, facing, canFlip })
    await this.accept(mine.media)
  }

  // --- answering --------------------------------------------------------------

  async accept(media?: CallMedia): Promise<void> {
    const call = this.#call
    if (!call || call.phase !== 'incoming' || !call.offer) return
    const offer = call.offer
    call.offer = null
    call.answered = true
    call.phase = 'connecting'
    this.#clear(call, 'ring')
    this.#emit()
    this.#env.handled(call.peer, call.id!)

    if (call.media === 'radio') return this.#acceptRadio(call, offer.sdp)
    if (!(await this.#prepare(call, media ?? call.media))) return
    const session = this.#openSession(call)
    await this.#attach(call, session)

    let answer: { sdp: string; fingerprint?: string } | null
    try {
      answer = await session.receive('offer', offer.sdp, offer.fingerprint)
    } catch (err) {
      log.warn('could not answer', err)
      this.#fail(call)
      return
    }
    if (hasEnded(call)) return
    if (!answer) {
      this.#fail(call)
      return
    }
    for (const candidate of call.held.splice(0)) await session.addCandidate(candidate)
    this.#send(call, { kind: 'answer', ...answer })
    this.#arm(call, 'connect', CONNECT_TIMEOUT_MS, () => this.#fail(call))
  }

  decline(): void {
    const call = this.#call
    if (!call || call.phase !== 'incoming') return
    this.#env.handled(call.peer, call.id!)
    this.#finish(call, { kind: 'declined' }, 'declined')
  }

  /**
   * Picked up or turned down on another device of this identity (ADR-073). This
   * one stops ringing, says nothing to the caller, and writes nothing: the
   * device that took it holds the record.
   */
  elsewhere(callId: string): void {
    const call = this.#call
    if (call?.id !== callId || call.phase !== 'incoming') return
    this.#clearAll(call)
    call.abandoned = true
    call.phase = 'ended'
    this.#call = null
    this.#emit()
  }

  hangup(): void {
    const call = this.#call
    if (!call || call.phase === 'ended') return
    if (call.phase === 'incoming') {
      this.decline()
      return
    }
    this.#finish(call, { kind: call.answered ? 'hangup' : 'cancelled' }, 'hangup')
  }

  /** Close an ending that stayed on screen for the person to read. */
  dismiss(): void {
    if (this.#call?.phase !== 'ended') return
    this.#call = null
    this.#emit()
  }

  /** Hold to talk, on a walkie-talkie. */
  talk(on: boolean): void {
    this.#call?.voice?.talk(on)
  }

  /** The vault is locking or the engine stopping: end whatever is happening. */
  dispose(): void {
    if (this.#disposed) return
    const call = this.#call
    if (call && call.phase !== 'ended') {
      if (call.phase === 'incoming') this.decline()
      else this.hangup()
    }
    if (call) this.#clearAll(call)
    this.#disposed = true
    this.#call = null
    this.events.emit('changed', null)
    this.events.clear()
  }

  /** The answer to our call: it has been picked up. */
  async #answered(call: Call, frame: CallFrame): Promise<void> {
    if (call.media === 'radio') return this.#radioAnswered(call, frame.sdp!)
    if (!call.session || !frame.sdp) return
    await call.session.receive('answer', frame.sdp, frame.fingerprint)
    if (hasEnded(call)) return
    call.answered = true
    call.reached = true
    call.notReached = false
    this.#clear(call, 'ring')
    this.#clear(call, 'reach')
    // Checks can connect the call while the answer is still being applied —
    // the browser runs them as soon as it has the description — and a call
    // already connected must not be timed out, or restarted, as one that is not.
    if (call.connectedAt === null) {
      call.phase = 'connecting'
      this.#arm(call, 'connect', CONNECT_TIMEOUT_MS, () => this.#fail(call))
      if (!call.relayOnly) {
        const { local, remote } = call.session.candidates()
        this.#arm(call, 'escalate', escalateAfter(local, remote), () => this.#escalate(call))
      }
    }
    this.#emit()
  }

  #remoteBye(call: Call, reason: CallEndReason): void {
    if (reason === 'failed' && !call.connectedAt) {
      // Once both sides were trying to connect, our own candidates say why it
      // did not work. Before that, the other side failed on its own — its
      // microphone would not open, say — and there is nothing to diagnose.
      if (call.answered) this.#fail(call, false)
      else this.#finish(call, { kind: 'failed' })
      return
    }
    if (call.answered) {
      this.#finish(call, { kind: 'hangup' })
      return
    }
    if (call.direction === 'in') {
      this.#finish(call, { kind: 'missed' })
      return
    }
    const kind: CallEndKind = reason === 'busy' ? 'busy' : reason === 'unanswered' ? 'unanswered' : 'declined'
    this.#finish(call, { kind })
  }

  // --- in-call controls -------------------------------------------------------

  setMuted(muted: boolean): void {
    const call = this.#call
    if (!call || call.phase === 'ended') return
    call.muted = muted
    if (call.mic) call.mic.enabled = !muted
    this.#publish(call)
    this.#emit()
  }

  /** Turn the camera on or off. Off means off: the track is stopped and its light goes out. */
  async setCamera(on: boolean): Promise<void> {
    const call = this.#call
    if (!call || call.phase === 'ended' || call.phase === 'incoming' || on === !!call.camera) return
    if (!on) {
      stopTracks([call.camera])
      call.camera = null
      if (!call.screen) await call.session?.setTrack('video', null)
      this.#publish(call)
      this.#emit()
      return
    }
    const track = await this.#openCamera(call, call.facing, false)
    if (!track) {
      this.#notify(call, 'camera-unavailable')
      return
    }
    if (!this.#current(call)) {
      stopTracks([track])
      return
    }
    call.camera = track
    if (!call.screen) await call.session?.setTrack('video', track)
    this.#publish(call)
    this.#emit()
  }

  /**
   * Switch between front and back camera on a phone, or to the next camera on
   * a computer with several. Phones cannot hold both cameras open at once, so
   * the old one is released first — and reopened if the new one will not open.
   */
  async flipCamera(): Promise<void> {
    const call = this.#call
    if (!call || call.phase === 'ended' || !call.camera) return
    const previous = call.camera
    const facing = previous.getSettings?.().facingMode
    stopTracks([previous])
    call.camera = null

    let track: MediaStreamTrack | null
    if (facing === 'user' || facing === 'environment') {
      const next: Facing = facing === 'user' ? 'environment' : 'user'
      track = await this.#openCamera(call, next, true)
      if (track) call.facing = next
    } else {
      track = await this.#nextCamera(previous.getSettings?.().deviceId)
    }
    track ??= await this.#openCamera(call, call.facing, false)
    if (!this.#current(call)) {
      stopTracks([track])
      return
    }
    call.camera = track
    if (!track) this.#notify(call, 'camera-unavailable')
    if (!call.screen) await call.session?.setTrack('video', track)
    this.#publish(call)
    this.#emit()
  }

  async setScreenShare(on: boolean): Promise<void> {
    const call = this.#call
    const share = this.#env.media?.getDisplayMedia
    if (!call || call.phase === 'ended' || call.phase === 'incoming' || on === !!call.screen) return
    if (!on) {
      stopTracks([call.screen])
      call.screen = null
      await call.session?.setTrack('video', call.camera)
      this.#publish(call)
      this.#emit()
      return
    }
    if (!share) return
    let track: MediaStreamTrack | undefined
    try {
      track = (
        await share({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })
      ).getVideoTracks()[0]
    } catch (err) {
      // Closing the browser's picker is a refusal, not a failure.
      if (classifyMediaError(err) !== 'denied') this.#notify(call, 'screen-failed')
      return
    }
    if (!track) return
    if (!this.#current(call)) {
      stopTracks([track])
      return
    }
    const shared = track
    // Text and diagrams, not faces: keep it sharp and drop frames instead.
    if ('contentHint' in shared) shared.contentHint = 'detail'
    // The browser's own "stop sharing" button ends the track under us.
    shared.addEventListener('ended', () => {
      if (call.screen === shared) void this.setScreenShare(false)
    })
    call.screen = shared
    await call.session?.setTrack('video', shared)
    this.#publish(call)
    this.#emit()
  }

  // --- internals --------------------------------------------------------------

  #begin(init: Pick<Call, 'peer' | 'direction' | 'media' | 'phase' | 'startedAt'>): Call {
    const previous = this.#call
    if (previous) this.#clearAll(previous)
    const config = this.#env.config()
    const call: Call = {
      ...init,
      id: null,
      answered: false,
      connectedAt: null,
      endedAt: 0,
      reached: false,
      notReached: false,
      path: null,
      relayOnly: config.relayOnly,
      turn: [],
      health: {},
      selection: null,
      voice: null,
      nonce: null,
      session: null,
      offer: null,
      held: [],
      queued: [],
      mic: null,
      camera: null,
      screen: null,
      muted: false,
      facing: 'user',
      canFlip: false,
      remoteTracks: [],
      remote: { audio: true, video: false, screen: false },
      restarts: 0,
      timers: new Map(),
      ended: null,
      outcome: 'failed',
      bye: null,
      settled: false,
      abandoned: false,
      notice: null,
      views: {},
    }
    this.#call = call
    return call
  }

  /**
   * Check the relay policy, open the camera and microphone — unless they came
   * across from a call given up for this one — and pick the TURN servers. Ends
   * the call and returns false when anything stands in the way.
   */
  async #prepare(call: Call, media: CallMedia): Promise<boolean> {
    await this.#chooseTurn(call)
    // "Always relay" without a relay would either fail every call or quietly
    // go direct — which is the one thing the setting exists to prevent.
    if (call.relayOnly && call.turn.length === 0) {
      this.#finish(call, { kind: 'relay-needs-turn' }, 'failed')
      return false
    }
    try {
      if (!call.mic) await this.#acquire(call, media)
    } catch (err) {
      this.#finish(
        call,
        { kind: 'media', media: err instanceof MediaError ? err.failure : 'failed' },
        'failed',
      )
      return false
    }
    // Hung up, or overtaken by another call, while the permission prompt was up.
    if (hasEnded(call) || !this.#current(call)) {
      stopTracks([call.mic, call.camera])
      call.mic = null
      call.camera = null
      return false
    }
    return true
  }

  /**
   * The TURN servers this call may bring in, best first, with this call's
   * credentials. TURN selection is a lazy chunk; a page left running across
   * a deployment may find it gone, and the call then goes ahead without TURN.
   */
  async #chooseTurn(call: Call): Promise<void> {
    const { iceServers } = this.#env.config()
    if (!hasTurnServer(iceServers)) return
    const turn = await this.#env.turn().catch((err: unknown) => {
      log.warn('TURN selection did not load', err)
      return null
    })
    if (!turn) return
    const now = Date.now()
    call.selection = turn
    call.health = await turn.loadTurnHealth(this.#env.store)
    call.turn = await turn.withCredentials(turn.rankTurn(iceServers, call.health, now), now)
  }

  async #acquire(call: Call, media: CallMedia): Promise<void> {
    const backend = this.#env.media
    if (!backend) throw new MediaError('missing')
    let stream: MediaStream
    try {
      stream = await backend.getUserMedia({
        audio: MICROPHONE,
        video: media === 'video' ? camera(call.facing) : false,
      })
    } catch (err) {
      if (media !== 'video') throw new MediaError(classifyMediaError(err))
      // No camera, or another app has it: the call still goes ahead, as a
      // voice call, and the screen says why the picture is missing.
      try {
        stream = await backend.getUserMedia({ audio: MICROPHONE, video: false })
      } catch (fallback) {
        throw new MediaError(classifyMediaError(fallback))
      }
      call.notice = 'camera-unavailable'
    }
    call.mic = stream.getAudioTracks()[0] ?? null
    call.camera = stream.getVideoTracks()[0] ?? null
    if (!call.mic) {
      stopTracks([call.camera])
      call.camera = null
      throw new MediaError('missing')
    }
    // Device labels and counts are only reliable once permission is granted.
    try {
      const devices = await backend.enumerateDevices()
      call.canFlip = devices.filter((device) => device.kind === 'videoinput').length > 1
    } catch {
      call.canFlip = false
    }
  }

  /** Open a camera mid-call: a call is under way, so there are devices. */
  async #openCamera(call: Call, facing: Facing, exact: boolean): Promise<MediaStreamTrack | null> {
    try {
      const stream = await this.#env.media!.getUserMedia({ audio: false, video: camera(facing, exact) })
      return stream.getVideoTracks()[0] ?? null
    } catch (err) {
      log.debug(`camera did not open (${classifyMediaError(err)})`, call.peer.slice(0, 8))
      return null
    }
  }

  async #nextCamera(currentId: string | undefined): Promise<MediaStreamTrack | null> {
    // There is a camera to flip, so there are devices.
    const backend = this.#env.media!
    try {
      const cameras = (await backend.enumerateDevices()).filter((device) => device.kind === 'videoinput')
      if (cameras.length < 2) return null
      const index = cameras.findIndex((device) => device.deviceId === currentId)
      const next = cameras[(index + 1) % cameras.length] as MediaDeviceInfo
      const stream = await backend.getUserMedia({
        audio: false,
        video: { deviceId: { exact: next.deviceId } },
      })
      return stream.getVideoTracks()[0] ?? null
    } catch {
      return null
    }
  }

  #openSession(call: Call): CallSession {
    const stun = this.#env.config().iceServers.filter((server) => !hasTurnServer([server]))
    const pc = this.#env.createPeerConnection({
      // Direct first, on STUN alone: TURN is held back until direct paths
      // fail, so a TURN server never learns of a call that did not need it.
      // Relay-only hides this device's address from the other person: only
      // the TURN server's address is ever offered as a candidate.
      iceServers: call.relayOnly ? [...stun, ...call.turn] : stun,
      iceTransportPolicy: call.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    const session = new CallSession(pc, {
      polite: this.#env.self < call.peer,
      gatherGraceMs: this.#env.gatherGraceMs,
      fallback: call.relayOnly ? [] : call.turn,
    })
    session.events.on('signal', (signal) => this.#send(call, signal))
    session.events.on('connection', (phase) => this.#connection(call, phase))
    session.events.on('track', (track) => {
      call.remoteTracks = [...call.remoteTracks.filter((t) => t.id !== track.id), track]
      this.#emit()
    })
    session.events.on('remoteState', (state) => {
      call.remote = state
      this.#emit()
    })
    session.events.on('mismatch', () => this.#fail(call))
    session.events.on('restarted', () => this.#emit())
    call.session = session
    return session
  }

  /** Put the microphone, and the camera or screen, on a session just opened. `#prepare` saw to the microphone. */
  async #attach(call: Call, session: CallSession): Promise<void> {
    call.mic!.enabled = !call.muted
    await session.setTrack('audio', call.mic)
    await session.setTrack('video', call.screen ?? call.camera)
    this.#publish(call)
  }

  #publish(call: Call): void {
    call.session?.sendState({
      audio: !!call.mic && !call.muted,
      video: !!(call.screen ?? call.camera),
      screen: !!call.screen,
    })
  }

  /**
   * The connection changed. Only ever for the call on screen and not yet
   * ended: a call's session is closed, and stops reporting, the moment the
   * call ends or another takes its place.
   */
  #connection(call: Call, phase: ConnectionPhase): void {
    switch (phase) {
      case 'connected':
        this.#clear(call, 'connect')
        this.#clear(call, 'escalate')
        this.#clear(call, 'recover')
        this.#clear(call, 'lost')
        call.phase = 'connected'
        call.connectedAt ??= Date.now()
        void call.session?.selectedPath().then((path) => {
          if (!this.#current(call) || call.phase === 'ended') return
          call.path = path
          if (path === 'relay') this.#arm(call, 'sample', SAMPLE_AFTER_MS, () => void this.#sample(call))
          this.#emit()
        })
        this.#emit()
        return

      case 'disconnected':
        // Before it ever connected, the connect timeout is what decides.
        if (call.connectedAt === null) return
        call.phase = 'reconnecting'
        this.#arm(call, 'recover', RECOVER_AFTER_MS, () => this.#restart(call))
        this.#armLost(call)
        this.#emit()
        return

      case 'failed':
        if (call.connectedAt === null) {
          // Direct paths failed before the call ever connected. The caller
          // tries once more with TURN; the callee waits for that attempt, and
          // the connect timeout ends the wait should it never come.
          if (call.relayOnly || call.session!.restarted) this.#fail(call)
          else if (call.direction === 'out') this.#escalate(call)
          return
        }
        call.phase = 'reconnecting'
        this.#restart(call)
        this.#armLost(call)
        this.#emit()
        return

      default:
        return
    }
  }

  /**
   * Direct paths have not connected: restart ICE with the TURN servers in
   * (ADR-068). Only the caller does, once — see `CallSession.restartIce` —
   * and the callee brings its own in when the restart reaches it. The caller
   * restarts even with no TURN server of its own, since the callee may have
   * one.
   */
  #escalate(call: Call): void {
    this.#clear(call, 'escalate')
    call.session!.restartIce()
  }

  /** How the relay is holding up, for ranking TURN servers on later calls. */
  async #sample(call: Call): Promise<void> {
    const use = await call.session!.relayUse()
    if (!use) return
    // A relay this side asked for: TURN selection chose it, so it is loaded.
    const turn = call.selection!
    turn.recordRelayUse(call.health, use)
    this.#keep(turn, call.health)
  }

  /** Keep what this call found out about each TURN server it asked for a relay. */
  #learn(call: Call): void {
    const { session, selection: turn } = call
    if (!session || !turn || !(call.relayOnly || session.restarted)) return
    const now = Date.now()
    const silent = now - session.askedAt >= turn.NO_ANSWER_MS
    const outcomes = turn.outcomesFor(call.turn, session.turnOutcomes(), silent)
    if (outcomes.length === 0) return
    for (const outcome of outcomes) turn.recordTurn(call.health, outcome, now)
    this.#keep(turn, call.health)
  }

  #keep(turn: typeof Turn, health: Turn.TurnHealthMap): void {
    void this.#env.store
      .putState(turn.TURN_HEALTH, health)
      .catch((err: unknown) => log.warn('could not keep what was learnt about TURN', err))
  }

  /** Called only while reconnecting: a reconnected or ended call has had its timers cleared. */
  #restart(call: Call): void {
    if (call.restarts >= MAX_ICE_RESTARTS) {
      this.#finish(call, { kind: 'lost' }, 'failed')
      return
    }
    call.restarts += 1
    call.session?.restartIce()
  }

  #armLost(call: Call): void {
    if (call.timers.has('lost')) return
    this.#arm(call, 'lost', LOST_AFTER_MS, () => this.#finish(call, { kind: 'lost' }, 'failed'))
  }

  /** Could not connect: work out why from the candidates, and tell the other side. */
  #fail(call: Call, tellPeer = true): void {
    if (call.phase === 'ended') return
    const candidates = call.session?.candidates() ?? { local: [], remote: [] }
    // A TURN server that was never asked — the call failed before direct
    // paths gave up — says nothing about whether it works.
    const turnTried = call.turn.length > 0 && (call.relayOnly || !!call.session?.restarted)
    const diagnosis = diagnoseIce({ ...candidates, turnConfigured: turnTried })
    this.#finish(call, { kind: 'failed', diagnosis }, tellPeer ? 'failed' : undefined)
  }

  #finish(call: Call, end: CallEnd, bye?: CallEndReason): void {
    if (call.phase === 'ended') return
    this.#learn(call)
    this.#clearAll(call)
    call.phase = 'ended'
    call.ended = end
    call.endedAt = Date.now()
    call.outcome = outcomeOf(call, end.kind)
    call.bye = bye ?? null
    this.#settle(call)
    this.#emit()
    if (!STICKY_ENDS.has(end.kind)) {
      // Cleared with the call's other timers should another call replace it first.
      this.#arm(call, 'linger', ENDED_LINGER_MS, () => {
        this.#call = null
        this.#emit()
      })
    }
  }

  // --- walkie-talkies (ADR-070) -----------------------------------------------

  /** Whether this browser can do a walkie-talkie; ends the call saying so when it cannot. */
  async #radioReady(call: Call): Promise<boolean> {
    if (await this.#env.voice.platform.supported()) return true
    this.#finish(call, { kind: 'radio-unsupported' }, 'failed')
    return false
  }

  /** This side's half of a walkie-talkie's opening exchange: a fresh nonce, and where it listens. */
  #describeRadio(call: Call): string {
    call.nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    return describeRadio({
      nonce: call.nonce,
      listen: [...VOICE_RELAYS, ...this.#env.voice.pool.rankedReadRelays()],
    })
  }

  async #acceptRadio(call: Call, sdp: string): Promise<void> {
    const theirs = readRadio(sdp)
    if (!theirs) {
      this.#finish(call, { kind: 'failed' }, 'failed')
      return
    }
    if (!(await this.#radioReady(call)) || hasEnded(call)) return
    const answer = this.#describeRadio(call)
    this.#startRadio(call, theirs.nonce, call.nonce!, theirs.listen)
    // Answered only once this side can talk: a microphone that will not open
    // is then a call that could not be set up, not one hung up.
    if (await this.#joinRadio(call)) this.#send(call, { kind: 'answer', sdp: answer })
  }

  async #radioAnswered(call: Call, sdp: string): Promise<void> {
    const theirs = readRadio(sdp)
    if (!theirs) {
      this.#finish(call, { kind: 'failed' }, 'failed')
      return
    }
    call.answered = true
    call.reached = true
    call.notReached = false
    call.phase = 'connecting'
    this.#clear(call, 'ring')
    this.#clear(call, 'reach')
    this.#startRadio(call, call.nonce!, theirs.nonce, theirs.listen)
    await this.#joinRadio(call)
  }

  #startRadio(call: Call, caller: string, callee: string, listen: readonly string[]): void {
    const role = call.direction === 'out' ? 'caller' : 'callee'
    const pool = this.#env.voice.pool
    const voice = new RelayVoice(
      voiceKeys({ callId: call.id!, caller, callee, role }),
      { pool, relays: listen, mine: () => pool.rankedReadRelays() },
      this.#env.voice.platform,
    )
    voice.events.on('changed', () => this.#emit())
    voice.listen()
    call.voice = voice
    this.#emit()
  }

  /** Open the microphone and speaker: then the walkie-talkie is on, as a call is once connected. */
  async #joinRadio(call: Call): Promise<boolean> {
    const voice = call.voice!
    await voice.join()
    if (hasEnded(call)) return false
    if (voice.view.state !== 'live') {
      this.#finish(call, { kind: 'media', media: 'failed' }, 'failed')
      return false
    }
    call.phase = 'connected'
    call.connectedAt = Date.now()
    this.#emit()
    return true
  }

  /** Say goodbye and write the record, once the call has an id to do both with. */
  #settle(call: Call): void {
    if (!call.id || call.settled || call.phase !== 'ended' || call.abandoned) return
    call.settled = true
    if (call.bye) this.#send(call, { kind: 'bye', reason: call.bye })
    const record: CallRecord = { media: call.media, outcome: call.outcome }
    if (call.outcome === 'completed' && call.connectedAt !== null) {
      record.durationMs = Math.max(0, call.endedAt - call.connectedAt)
    }
    void this.#env
      .record(call.peer, call.id, call.direction, record, call.startedAt)
      .catch((err: unknown) => log.warn('could not record the call', err))
  }

  #send(call: Call, signal: OutgoingSignal): void {
    // Only candidates come before the opening offer has its id; they wait for it.
    if (!call.id) {
      call.queued.push(signal)
      return
    }
    if (call.phase === 'ended' && signal.kind !== 'bye') return
    void this.#env
      .signal(call.peer, { v: PROTOCOL_VERSION, t: 'rtc', call: call.id, ...signal })
      .catch((err: unknown) => log.warn(`could not send ${signal.kind}`, err))
  }

  #notify(call: Call, notice: CallNotice): void {
    call.notice = notice
    this.#emit()
    this.#arm(call, 'notice', 4000, () => {
      call.notice = null
      this.#emit()
    })
  }

  #arm(call: Call, name: string, ms: number, fire: () => void): void {
    this.#clear(call, name)
    call.timers.set(
      name,
      setTimeout(() => {
        call.timers.delete(name)
        fire()
      }, ms),
    )
  }

  #clear(call: Call, name: string): void {
    const timer = call.timers.get(name)
    if (timer) clearTimeout(timer)
    call.timers.delete(name)
  }

  /** Stop every timer, close the connection and release every device. */
  #clearAll(call: Call): void {
    for (const timer of call.timers.values()) clearTimeout(timer)
    call.timers.clear()
    call.voice?.close()
    call.voice = null
    call.session?.close()
    call.session = null
    stopTracks([call.mic, call.camera, call.screen])
    call.mic = null
    call.camera = null
    call.screen = null
    call.remoteTracks = []
  }

  #current(call: Call): boolean {
    return this.#call === call && !this.#disposed
  }

  #live(call: Call | null): boolean {
    return call !== null && call.phase !== 'ended'
  }

  #emit(): void {
    this.events.emit('changed', this.view)
  }

  #view(call: Call): CallView {
    const video = call.screen ?? call.camera
    return {
      id: call.id,
      peer: call.peer,
      direction: call.direction,
      media: call.media,
      phase: call.phase,
      startedAt: call.startedAt,
      connectedAt: call.connectedAt,
      reached: call.reached,
      notReached: call.notReached,
      path: call.path,
      relaying: call.phase === 'connecting' && call.turn.length > 0 && !!call.session?.restarted,
      voice: call.voice?.view ?? null,
      relayOnly: call.relayOnly,
      local: {
        muted: call.muted,
        camera: !!call.camera,
        screen: !!call.screen,
        facing: call.facing,
        canFlip: call.canFlip,
        canShare: typeof this.#env.media?.getDisplayMedia === 'function',
        stream: this.#stream(call, 'local', video ? [video] : []),
      },
      remote: { ...call.remote, stream: this.#stream(call, 'remote', call.remoteTracks) },
      ended: call.ended,
      notice: call.notice,
    }
  }

  /**
   * A stream for a `<video>` element, rebuilt only when its tracks change so
   * a re-render does not restart playback.
   */
  #stream(call: Call, which: 'local' | 'remote', tracks: MediaStreamTrack[]): MediaStream | null {
    const key = tracks.map((track) => track.id).join(',')
    const cached = call.views[which]
    if (cached && cached[0] === key) return cached[1]
    const stream = tracks.length > 0 ? this.#env.createStream(tracks) : null
    call.views[which] = [key, stream]
    return stream
  }
}

/**
 * How long direct paths get before TURN is brought in: less when a side
 * learned no public address — its network blocks the traffic, so only a LAN
 * path could work — or this one is behind symmetric NAT (ADR-068). Unless both
 * are on the IPv6 internet: then no NAT stands between them, and the direct
 * path gets its full time however the IPv4 side looks (ADR-069).
 */
export function escalateAfter(local: readonly string[], remote: readonly string[]): number {
  if (hasPublicIpv6(local) && hasPublicIpv6(remote)) return ESCALATE_AFTER_MS
  const hard = !hasPublicAddress(local) || !hasPublicAddress(remote) || looksSymmetric(local)
  return hard ? ESCALATE_SOON_MS : ESCALATE_AFTER_MS
}

/**
 * Whether the call has ended — read through a function because it can end
 * during any `await`, which the compiler's narrowing does not know.
 */
const hasEnded = (call: Call): boolean => call.phase === 'ended'

/**
 * How the call is remembered, from how it ended. A hang-up is only ever of an
 * answered call — hanging up one that was not is cancelling or declining it.
 */
function outcomeOf(call: Call, kind: CallEndKind): CallOutcome {
  if (call.connectedAt !== null || kind === 'hangup') return 'completed'
  switch (kind) {
    case 'cancelled':
    case 'declined':
    case 'busy':
    case 'unanswered':
    case 'missed':
      return kind
    default:
      return 'failed'
  }
}
