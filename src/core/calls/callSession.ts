import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { extractFingerprint } from '../transport/webrtc/directSession'
import type { IceCandidateFrame } from '../models/protocol'
import { candidatesInSdp } from './diagnose'

const log = createLogger('call-session')

/**
 * How long to let ICE gather before sending the description that opens a
 * call. Candidates found in that window ride inside the SDP; later ones
 * trickle as separate frames. Every frame is another gift wrap on the relays,
 * so folding the first few in saves several writes for about a second of
 * latency — on a call that is going to ring for several seconds anyway.
 */
export const GATHER_GRACE_MS = 1000

/** Remote candidates held while their description is still on its way. */
const MAX_HELD_CANDIDATES = 64

/**
 * Renegotiations allowed per minute. A call renegotiates when someone turns a
 * camera on or shares a screen — a handful of times at most. Two browsers
 * that disagree about a description can instead offer back and forth for
 * ever, and every offer is a gift wrap on several relays, so past this the
 * session stops offering rather than flood them.
 */
export const MAX_RENEGOTIATIONS_PER_MINUTE = 10

export interface SessionDescription {
  sdp: string
  fingerprint?: string
}

export type SessionSignal =
  ({ kind: 'offer' | 'answer' } & SessionDescription) | { kind: 'candidate'; candidate: IceCandidateFrame }

export type ConnectionPhase = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

/** What each side is sending, told to the other over the call's own data channel. */
export interface MediaState {
  audio: boolean
  video: boolean
  screen: boolean
}

export type CallSessionEvents = {
  /** A description or candidate for the other side, to go out over the relays. */
  signal: SessionSignal
  connection: ConnectionPhase
  /** A track arrived from the other side. */
  track: MediaStreamTrack
  remoteState: MediaState
  /** The other side's DTLS fingerprint did not match its own SDP. Fatal. */
  mismatch: void
}

export type MediaKind = 'audio' | 'video'

/**
 * One call's peer connection.
 *
 * Signalling rides the sealed relay path, so every description is
 * authenticated by the other person's identity key before it is applied —
 * and with it the DTLS fingerprint that keys the media. Audio and video are
 * therefore end-to-end encrypted between the two identity keys by DTLS-SRTP,
 * with ephemeral keys, whether the packets go directly or through a TURN
 * server, which sees only ciphertext.
 *
 * Renegotiation — turning a camera on in a voice call, sharing a screen,
 * restarting ICE after a network change — uses perfect negotiation, the same
 * rule the direct channel follows: the peer with the lexicographically smaller
 * key is polite and yields when both sides offer at once. The opening
 * exchange is driven explicitly instead, because it waits for the person
 * being called to accept.
 */
export class CallSession {
  readonly events = new Emitter<CallSessionEvents>()

  #pc: RTCPeerConnection
  #polite: boolean
  #graceMs: number
  #channel: RTCDataChannel | null = null
  /** The opening offer and answer have both been applied here. */
  #established = false
  /**
   * The call has connected, so renegotiation may begin.
   *
   * Not before: signals travel as separate relay events and can arrive in any
   * order, and an offer that overtook the answer opening the call would find
   * the other side still waiting for that answer. Connecting proves both
   * sides hold both descriptions. A change asked for earlier — a camera
   * turned on while it rang — is remembered and negotiated then.
   */
  #live = false
  #pendingNegotiation = false
  #makingOffer = false
  #ignoreOffer = false
  /** A local description is being made; candidates found meanwhile ride inside it. */
  #describing = false
  #phase: ConnectionPhase = 'new'
  #closed = false
  #localState: MediaState = { audio: false, video: false, screen: false }
  #held: IceCandidateFrame[] = []
  #localCandidates = new Set<string>()
  #remoteCandidates = new Set<string>()
  #gatherWaiters: (() => void)[] = []
  #offeredAt: number[] = []

  constructor(pc: RTCPeerConnection, opts: { polite: boolean; gatherGraceMs?: number }) {
    this.#pc = pc
    this.#polite = opts.polite
    this.#graceMs = opts.gatherGraceMs ?? GATHER_GRACE_MS

    pc.onicecandidate = (event) => {
      const found = event.candidate
      if (!found?.candidate) {
        this.#wakeGatherers()
        return
      }
      this.#localCandidates.add(found.candidate)
      if (this.#describing) return
      this.events.emit('signal', {
        kind: 'candidate',
        candidate: { candidate: found.candidate, sdpMid: found.sdpMid, sdpMLineIndex: found.sdpMLineIndex },
      })
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') this.#wakeGatherers()
    }
    pc.ontrack = (event) => this.events.emit('track', event.track)
    pc.onnegotiationneeded = () => void this.#negotiate()
    pc.onconnectionstatechange = () => this.#updatePhase()
    pc.oniceconnectionstatechange = () => this.#updatePhase()

    // Negotiated rather than announced, so both sides create it up front and
    // it needs no signalling of its own. It carries only mute and camera
    // state, inside the same DTLS session as the media.
    const channel = pc.createDataChannel('call-state', { negotiated: true, id: 0, ordered: true })
    channel.onopen = () => this.#flushState()
    channel.onmessage = (event) => this.#readState(event.data)
    this.#channel = channel
  }

  get phase(): ConnectionPhase {
    return this.#phase
  }

  /**
   * Put a track on the call, change it, or take it off.
   *
   * An existing sender is reused with `replaceTrack`, which needs no
   * renegotiation: turning the camera off and on again, flipping it, or
   * swapping it for a screen costs nothing on the relays. A new kind of media
   * — video in what began as a voice call — adds a transceiver, and the
   * negotiation that follows goes out as an ordinary offer.
   */
  async setTrack(kind: MediaKind, track: MediaStreamTrack | null, stream?: MediaStream): Promise<void> {
    if (this.#closed) return
    const transceiver = this.#transceiverFor(kind)
    if (!transceiver) {
      if (track) this.#pc.addTrack(track, ...(stream ? [stream] : []))
      return
    }
    await transceiver.sender.replaceTrack(track)
    // Receive-only because the other side offered this media and we had none
    // to send back: now we do, which is a change of direction to negotiate.
    if (track && (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive')) {
      transceiver.direction = 'sendrecv'
    }
  }

  /** Make the offer that opens a call. */
  async offer(): Promise<SessionDescription> {
    this.#describing = true
    try {
      await this.#pc.setLocalDescription(await this.#pc.createOffer())
      // Whatever was asked for before now is in this offer; only a change
      // made from here on needs a negotiation of its own.
      this.#pendingNegotiation = false
      await this.#gathered()
      return this.#takeDescription()
    } finally {
      this.#describing = false
    }
  }

  /**
   * Apply a description from the other side, and return the answer to send
   * when it was an offer.
   *
   * This is perfect negotiation: an offer that collides with one of ours is
   * ignored by the impolite peer and wins on the polite one, which rolls its
   * own back. A stale answer — one for an offer that has since been rolled
   * back — is dropped.
   */
  async receive(
    type: 'offer' | 'answer',
    sdp: string,
    fingerprint?: string,
  ): Promise<SessionDescription | null> {
    if (this.#closed) return null
    const pc = this.#pc
    if (type === 'offer') {
      const collision = this.#makingOffer || pc.signalingState !== 'stable'
      this.#ignoreOffer = !this.#polite && collision
      if (this.#ignoreOffer) {
        log.debug('ignoring a colliding offer (impolite side)')
        return null
      }
      // Our offer may still be being made, in which case there is nothing to
      // roll back yet: `#negotiate` sees the remote offer and abandons its own.
      if (collision && pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' })
    } else if (pc.signalingState !== 'have-local-offer') {
      return null
    }

    await pc.setRemoteDescription({ type, sdp })
    if (!this.#checkFingerprint(sdp, fingerprint)) return null
    for (const candidate of candidatesInSdp(sdp)) this.#remoteCandidates.add(candidate)
    await this.#drainHeld()

    if (type === 'answer') {
      this.#established = true
      return null
    }
    const opening = !this.#established
    this.#describing = true
    try {
      await pc.setLocalDescription(await pc.createAnswer())
      if (opening) this.#pendingNegotiation = false
      // Only the answer that opens the call waits for candidates; a
      // renegotiation reuses the transport already running.
      if (opening) await this.#gathered()
      this.#established = true
      return this.#takeDescription()
    } finally {
      this.#describing = false
    }
  }

  /**
   * Add a candidate from the other side.
   *
   * Candidates are separate frames and can overtake the description they
   * belong to — relays deliver in any order — so one that cannot be used yet
   * is held and retried each time a new description is applied.
   */
  async addCandidate(candidate: IceCandidateFrame): Promise<void> {
    if (this.#closed) return
    this.#remoteCandidates.add(candidate.candidate)
    if (!this.#pc.remoteDescription) {
      this.#hold(candidate)
      return
    }
    try {
      await this.#pc.addIceCandidate(candidate)
    } catch (err) {
      // Belongs to an offer we ignored, or to one still in flight.
      if (!this.#ignoreOffer) this.#hold(candidate)
      log.debug('holding an ICE candidate that does not apply yet', err)
    }
  }

  /** Gather fresh candidates and renegotiate — after a network change, say. */
  restartIce(): void {
    if (this.#closed) return
    if (typeof this.#pc.restartIce === 'function') this.#pc.restartIce()
    else void this.#negotiate({ iceRestart: true })
  }

  /** Tell the other side what we are sending. Repeated when the channel opens. */
  sendState(state: MediaState): void {
    this.#localState = { ...state }
    this.#flushState()
  }

  /** Every candidate either side has put forward, for diagnosing a failure. */
  candidates(): { local: string[]; remote: string[] } {
    const local = new Set(this.#localCandidates)
    const sdp = this.#pc.localDescription?.sdp
    if (sdp) for (const candidate of candidatesInSdp(sdp)) local.add(candidate)
    return { local: [...local], remote: [...this.#remoteCandidates] }
  }

  /**
   * Whether media is flowing directly between the two devices or through a
   * TURN server — shown on the call, because it decides who can see whose IP.
   */
  async selectedPath(): Promise<'direct' | 'relay' | null> {
    try {
      const stats = await this.#pc.getStats()
      const reports = [...stats.values()] as Record<string, unknown>[]
      const selectedId = reports.find(
        (r) => r.type === 'transport' && r.selectedCandidatePairId,
      )?.selectedCandidatePairId
      const pair = reports.find(
        (r) =>
          r.type === 'candidate-pair' &&
          (selectedId ? r.id === selectedId : r.nominated === true && r.state === 'succeeded'),
      )
      if (!pair) return null
      const types = [pair.localCandidateId, pair.remoteCandidateId].map(
        (id) => reports.find((r) => r.id === id)?.candidateType,
      )
      return types.includes('relay') ? 'relay' : 'direct'
    } catch {
      return null
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#wakeGatherers()
    const pc = this.#pc
    pc.onicecandidate = null
    pc.onicegatheringstatechange = null
    pc.ontrack = null
    pc.onnegotiationneeded = null
    pc.onconnectionstatechange = null
    pc.oniceconnectionstatechange = null
    try {
      this.#channel?.close()
      pc.close()
    } catch {
      /* already closed */
    }
    this.#channel = null
    this.#held = []
    this.#phase = 'closed'
    this.events.clear()
  }

  // --- internals ------------------------------------------------------------

  async #negotiate(options?: RTCOfferOptions): Promise<void> {
    if (this.#closed) return
    if (!this.#live) {
      this.#pendingNegotiation = true
      return
    }
    const now = Date.now()
    this.#offeredAt = this.#offeredAt.filter((at) => now - at < 60_000)
    if (this.#offeredAt.length >= MAX_RENEGOTIATIONS_PER_MINUTE) {
      log.warn('renegotiating too often; holding off')
      return
    }
    this.#offeredAt.push(now)
    const pc = this.#pc
    try {
      this.#makingOffer = true
      this.#describing = true
      const offer = await pc.createOffer(options)
      // A remote offer may have been applied while ours was being made.
      if (pc.signalingState !== 'stable') return
      await pc.setLocalDescription(offer)
      this.#emitDescription('offer')
    } catch (err) {
      log.warn('renegotiation failed', err)
    } finally {
      this.#makingOffer = false
      this.#describing = false
    }
  }

  #emitDescription(kind: 'offer' | 'answer'): void {
    const description = this.#takeDescription()
    if (description.sdp) this.events.emit('signal', { kind, ...description })
  }

  #takeDescription(): SessionDescription {
    const sdp = this.#pc.localDescription?.sdp ?? ''
    const fingerprint = extractFingerprint(sdp)
    return fingerprint ? { sdp, fingerprint } : { sdp }
  }

  /**
   * The fingerprint the peer stated must be the one in the SDP it sent. Both
   * came in one authenticated frame, so a mismatch means something mangled it
   * — and a call whose keys are in doubt must not go ahead.
   */
  #checkFingerprint(sdp: string, stated?: string): boolean {
    if (!stated) return true
    const inSdp = extractFingerprint(sdp)
    if (!inSdp || inSdp.toLowerCase() === stated.toLowerCase()) return true
    log.error('DTLS fingerprint mismatch; abandoning the call')
    this.events.emit('mismatch', undefined)
    return false
  }

  #hold(candidate: IceCandidateFrame): void {
    if (this.#held.length >= MAX_HELD_CANDIDATES) this.#held.shift()
    this.#held.push(candidate)
  }

  async #drainHeld(): Promise<void> {
    const held = this.#held
    this.#held = []
    for (const candidate of held) await this.addCandidate(candidate)
  }

  #gathered(): Promise<void> {
    if (this.#pc.iceGatheringState === 'complete' || this.#closed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.#graceMs)
      this.#gatherWaiters.push(done)
      function done() {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  #wakeGatherers(): void {
    const waiters = this.#gatherWaiters
    this.#gatherWaiters = []
    for (const wake of waiters) wake()
  }

  #transceiverFor(kind: MediaKind): RTCRtpTransceiver | undefined {
    return this.#pc
      .getTransceivers()
      .find(
        (transceiver) =>
          transceiver.receiver.track.kind === kind &&
          transceiver.direction !== 'stopped' &&
          transceiver.currentDirection !== 'stopped',
      )
  }

  #updatePhase(): void {
    const pc = this.#pc
    const phase = connectionPhase(pc.connectionState, pc.iceConnectionState)
    if (phase === this.#phase || this.#closed) return
    this.#phase = phase
    if (phase === 'connected' && !this.#live) {
      this.#live = true
      if (this.#pendingNegotiation) {
        this.#pendingNegotiation = false
        void this.#negotiate()
      }
    }
    this.events.emit('connection', phase)
  }

  #flushState(): void {
    if (this.#channel?.readyState !== 'open') return
    try {
      this.#channel.send(JSON.stringify(this.#localState))
    } catch (err) {
      log.debug('could not send media state', err)
    }
  }

  #readState(data: unknown): void {
    const state = parseMediaState(data)
    if (state) this.events.emit('remoteState', state)
  }
}

/**
 * The connection's overall state. `connectionState` where the browser has it,
 * and the ICE state where it does not — Firefox only gained the former in 2023.
 */
export function connectionPhase(
  connection: RTCPeerConnectionState | undefined,
  ice: RTCIceConnectionState,
): ConnectionPhase {
  if (connection) return connection
  switch (ice) {
    case 'checking':
      return 'connecting'
    case 'connected':
    case 'completed':
      return 'connected'
    case 'disconnected':
    case 'failed':
    case 'closed':
    case 'new':
      return ice
  }
}

/** The other side's media state, from untrusted bytes. */
export function parseMediaState(data: unknown): MediaState | null {
  if (typeof data !== 'string' || data.length > 256) return null
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== 'object' || value === null) return null
    const { audio, video, screen } = value as Record<string, unknown>
    if (typeof audio !== 'boolean' || typeof video !== 'boolean' || typeof screen !== 'boolean') return null
    return { audio, video, screen }
  } catch {
    return null
  }
}
