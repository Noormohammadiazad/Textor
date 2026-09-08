import * as nip44 from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'
import { validateRumor, type Rumor } from '../../crypto/giftwrap'
import { createLogger } from '../../util/log'
import { Emitter } from '../../util/emitter'
import { bytesToHex, randomBytes, wipe } from '../../util/bytes'
import type { RtcFrame } from '../../models/protocol'
import { PROTOCOL_VERSION } from '../../models/protocol'

const log = createLogger('rtc')

export type DirectState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'

export type DirectSessionEvents = {
  stateChanged: DirectState
  rumor: Rumor
  /** A frame to hand to the relay path for delivery to the peer. */
  signal: RtcFrame
}

/** Give up if the peer never answers; the relay path already carried the message. */
const CONNECT_TIMEOUT_MS = 20_000
/** Cap a single data-channel frame. Chat rumors are kilobytes at most. */
const MAX_FRAME_BYTES = 256 * 1024

/**
 * One direct peer-to-peer channel to one contact.
 *
 * This is strictly an accelerator. Everything it carries has already been, or
 * will also be, sent over relays — so a failed connection costs latency, never
 * a lost message. That is what lets us run without a TURN server: when NAT
 * traversal fails for the ~10% of peer pairs behind symmetric NAT, the app just
 * keeps working on the relay path.
 *
 * Security notes:
 *  - DTLS is *not* treated as the confidentiality boundary. Every payload is
 *    NIP-44 encrypted between the two identity keys before it reaches the data
 *    channel, so a compromised DTLS handshake still yields ciphertext.
 *  - Offers and answers travel inside gift-wrapped, sealed control frames, so
 *    the SDP (and the DTLS fingerprint it contains) is authenticated by the
 *    peer's identity key before it is ever applied. `fingerprint` is carried
 *    separately as a cross-check that the SDP we applied is the one the peer
 *    meant to send.
 *  - Perfect negotiation resolves simultaneous offers: the peer with the
 *    lexicographically smaller pubkey is polite and yields.
 */
export class DirectSession {
  readonly events = new Emitter<DirectSessionEvents>()
  readonly peerPubkey: string
  readonly sessionId: string

  #pc: RTCPeerConnection | null = null
  #channel: RTCDataChannel | null = null
  #state: DirectState = 'idle'
  #polite: boolean
  #makingOffer = false
  #ignoreOffer = false
  #conversationKey: Uint8Array
  #timeout: ReturnType<typeof setTimeout> | null = null
  #pendingCandidates: RTCIceCandidateInit[] = []
  #peerFingerprint: string | null = null

  constructor(
    secretKey: Uint8Array,
    peerPubkey: string,
    private readonly iceServers: RTCIceServer[],
    sessionId?: string,
  ) {
    this.peerPubkey = peerPubkey
    // Our own CSPRNG rather than crypto.randomUUID: same entropy, one fewer
    // API to depend on being present.
    this.sessionId = sessionId ?? bytesToHex(randomBytes(8))
    const myPubkey = getPublicKey(secretKey)
    this.#polite = myPubkey < peerPubkey
    this.#conversationKey = nip44.getConversationKey(secretKey, peerPubkey)
  }

  get state(): DirectState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#channel?.readyState === 'open'
  }

  /** Start an outbound connection and emit the offer for the relay path. */
  async connect(): Promise<void> {
    if (this.#state === 'connected' || this.#state === 'connecting') return
    this.#setState('connecting')
    const pc = this.#ensurePeerConnection()

    const channel = pc.createDataChannel('textor', { ordered: true })
    this.#attachChannel(channel)

    try {
      this.#makingOffer = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.#emitDescription('offer')
    } catch (err) {
      log.warn('failed to create offer', err)
      this.#setState('failed')
    } finally {
      this.#makingOffer = false
    }
  }

  /** Feed a signalling frame that arrived (authenticated) over the relay path. */
  async handleSignal(frame: RtcFrame): Promise<void> {
    if (frame.kind === 'bye') {
      this.close()
      return
    }

    const pc = this.#ensurePeerConnection()

    if (frame.kind === 'candidate') {
      if (!frame.candidate) return
      // Candidates can outrun the description they belong to.
      if (!pc.remoteDescription) {
        this.#pendingCandidates.push(frame.candidate)
        return
      }
      try {
        await pc.addIceCandidate(frame.candidate)
      } catch (err) {
        if (!this.#ignoreOffer) log.debug('ignoring ICE candidate', err)
      }
      return
    }

    if (!frame.sdp) return

    if (frame.kind === 'offer') {
      // Perfect negotiation: if we are mid-offer and impolite, ignore theirs.
      const collision = this.#makingOffer || pc.signalingState !== 'stable'
      this.#ignoreOffer = !this.#polite && collision
      if (this.#ignoreOffer) {
        log.debug('ignoring colliding offer (impolite peer)')
        return
      }
      if (this.#state === 'idle') this.#setState('connecting')
      if (collision) await pc.setLocalDescription({ type: 'rollback' })
      await pc.setRemoteDescription({ type: 'offer', sdp: frame.sdp })
      this.#verifyFingerprint(frame)
      await this.#drainCandidates(pc)
      await pc.setLocalDescription(await pc.createAnswer())
      this.#emitDescription('answer')
      return
    }

    if (frame.kind === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return
      await pc.setRemoteDescription({ type: 'answer', sdp: frame.sdp })
      this.#verifyFingerprint(frame)
      await this.#drainCandidates(pc)
    }
  }

  /** Send a rumor over the channel. Returns false when the channel is not up. */
  send(rumor: Rumor): boolean {
    if (!this.isOpen || !this.#channel) return false
    try {
      const payload = nip44.encrypt(JSON.stringify(rumor), this.#conversationKey)
      if (payload.length > MAX_FRAME_BYTES) return false
      this.#channel.send(payload)
      return true
    } catch (err) {
      log.warn('direct send failed', err)
      return false
    }
  }

  close(): void {
    this.#clearTimeout()
    try {
      this.#channel?.close()
      this.#pc?.close()
    } catch {
      /* already torn down */
    }
    this.#channel = null
    this.#pc = null
    this.#pendingCandidates = []
    if (this.#state !== 'closed') this.#setState('closed')
  }

  dispose(): void {
    this.close()
    wipe(this.#conversationKey)
    this.#conversationKey = new Uint8Array(32)
    this.events.clear()
  }

  // --- internals ------------------------------------------------------------

  #ensurePeerConnection(): RTCPeerConnection {
    if (this.#pc) return this.#pc
    const pc = new RTCPeerConnection({ iceServers: [...this.iceServers], iceCandidatePoolSize: 2 })

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.events.emit('signal', {
        v: PROTOCOL_VERSION,
        t: 'rtc',
        sid: this.sessionId,
        kind: 'candidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      })
    }

    pc.ondatachannel = (event) => this.#attachChannel(event.channel)

    pc.onconnectionstatechange = () => {
      const connection = pc.connectionState
      if (connection === 'failed' || connection === 'disconnected') {
        this.#setState('failed')
      } else if (connection === 'closed') {
        this.#setState('closed')
      }
    }

    this.#pc = pc
    this.#armTimeout()
    return pc
  }

  #attachChannel(channel: RTCDataChannel): void {
    this.#channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      this.#clearTimeout()
      log.info(`direct channel open to ${this.peerPubkey.slice(0, 8)}`)
      this.#setState('connected')
    }
    channel.onclose = () => {
      if (this.#state === 'connected') this.#setState('closed')
    }
    channel.onerror = () => this.#setState('failed')
    channel.onmessage = (event) => this.#handleMessage(event.data)
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return
    try {
      const json = nip44.decrypt(data, this.#conversationKey)
      const parsed: unknown = JSON.parse(json)
      // Identical validation to the relay path: the direct channel is not a
      // more-trusted source just because the bytes took a shorter route.
      this.events.emit('rumor', validateRumor(parsed, this.peerPubkey))
    } catch (err) {
      log.warn('dropping malformed direct frame', err)
    }
  }

  #emitDescription(kind: 'offer' | 'answer'): void {
    const sdp = this.#pc?.localDescription?.sdp
    if (!sdp) return
    const frame: RtcFrame = { v: PROTOCOL_VERSION, t: 'rtc', sid: this.sessionId, kind, sdp }
    const fingerprint = extractFingerprint(sdp)
    if (fingerprint) frame.fingerprint = fingerprint
    this.events.emit('signal', frame)
  }

  /**
   * Cross-check the fingerprint the peer stated against the one in the SDP we
   * applied. Both arrived inside the same authenticated frame, so a mismatch
   * means something mangled the payload rather than a live attack — but it is
   * exactly the kind of mismatch that should abort rather than proceed.
   */
  #verifyFingerprint(frame: RtcFrame): void {
    if (!frame.fingerprint || !frame.sdp) return
    const inSdp = extractFingerprint(frame.sdp)
    this.#peerFingerprint = inSdp
    if (inSdp && inSdp.toLowerCase() !== frame.fingerprint.toLowerCase()) {
      log.error('DTLS fingerprint mismatch; aborting direct session')
      this.close()
      this.#setState('failed')
    }
  }

  get peerFingerprint(): string | null {
    return this.#peerFingerprint
  }

  async #drainCandidates(pc: RTCPeerConnection): Promise<void> {
    const pending = this.#pendingCandidates
    this.#pendingCandidates = []
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        /* stale candidate; harmless */
      }
    }
  }

  #armTimeout(): void {
    this.#clearTimeout()
    this.#timeout = setTimeout(() => {
      if (this.#state !== 'connected') {
        log.info('direct connection timed out; staying on the relay path')
        this.close()
        this.#setState('failed')
      }
    }, CONNECT_TIMEOUT_MS)
  }

  #clearTimeout(): void {
    if (this.#timeout) clearTimeout(this.#timeout)
    this.#timeout = null
  }

  #setState(state: DirectState): void {
    if (this.#state === state) return
    this.#state = state
    this.events.emit('stateChanged', state)
  }
}

/** Pull `a=fingerprint:sha-256 AB:CD:...` out of an SDP blob. */
export function extractFingerprint(sdp: string): string | null {
  const match = sdp.match(/^a=fingerprint:(\S+)\s+(\S+)/m)
  return match ? `${match[1]} ${match[2]}` : null
}
