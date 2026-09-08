import { Emitter } from '../../util/emitter'
import { createLogger } from '../../util/log'
import type { Rumor } from '../../crypto/giftwrap'
import type { RtcFrame } from '../../models/protocol'
import { DirectSession, type DirectState } from './directSession'

const log = createLogger('rtc-manager')

export type DirectManagerEvents = {
  rumor: { peerPubkey: string; rumor: Rumor }
  signal: { peerPubkey: string; frame: RtcFrame }
  stateChanged: { peerPubkey: string; state: DirectState }
}

/** Do not re-dial a peer more often than this after a failure. */
const REDIAL_COOLDOWN_MS = 60_000

/**
 * Owns one DirectSession per contact and decides when to try to dial.
 *
 * There is no presence protocol in v1, on purpose. An offer *is* a presence
 * probe: if the peer is online they answer within a couple of seconds, and if
 * they are not, nothing happens and the relay path carries the conversation as
 * usual. That removes a whole class of periodic beacons — and the metadata they
 * would publish about when each user is awake — for no loss in behaviour.
 */
export class DirectManager {
  readonly events = new Emitter<DirectManagerEvents>()

  #sessions = new Map<string, DirectSession>()
  #lastAttempt = new Map<string, number>()
  #enabled = true

  constructor(
    private secretKey: Uint8Array,
    private iceServers: RTCIceServer[],
  ) {}

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (!enabled) this.closeAll()
  }

  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers
  }

  get enabled(): boolean {
    return this.#enabled
  }

  isConnected(peerPubkey: string): boolean {
    return this.#sessions.get(peerPubkey)?.isOpen === true
  }

  stateOf(peerPubkey: string): DirectState {
    return this.#sessions.get(peerPubkey)?.state ?? 'idle'
  }

  /** Try to open a channel. Cheap and safe to call whenever a chat is opened. */
  async dial(peerPubkey: string): Promise<void> {
    if (!this.#enabled || !supportsWebRtc()) return
    const existing = this.#sessions.get(peerPubkey)
    if (existing && (existing.isOpen || existing.state === 'connecting')) return

    const last = this.#lastAttempt.get(peerPubkey) ?? 0
    if (Date.now() - last < REDIAL_COOLDOWN_MS) return
    this.#lastAttempt.set(peerPubkey, Date.now())

    existing?.dispose()
    const session = this.#createSession(peerPubkey)
    await session.connect()
  }

  /** Route an inbound signalling frame, creating the answering session if needed. */
  async handleSignal(peerPubkey: string, frame: RtcFrame): Promise<void> {
    if (!this.#enabled || !supportsWebRtc()) return
    let session = this.#sessions.get(peerPubkey)

    if (!session || session.state === 'closed' || session.state === 'failed') {
      if (frame.kind !== 'offer') return
      session?.dispose()
      session = this.#createSession(peerPubkey, frame.sid)
    }

    try {
      await session.handleSignal(frame)
    } catch (err) {
      log.warn('signal handling failed', err)
    }
  }

  send(peerPubkey: string, rumor: Rumor): boolean {
    return this.#sessions.get(peerPubkey)?.send(rumor) ?? false
  }

  close(peerPubkey: string): void {
    const session = this.#sessions.get(peerPubkey)
    if (!session) return
    session.dispose()
    this.#sessions.delete(peerPubkey)
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.dispose()
    this.#sessions.clear()
  }

  dispose(): void {
    this.closeAll()
    this.events.clear()
    this.#lastAttempt.clear()
    this.secretKey = new Uint8Array(32)
  }

  #createSession(peerPubkey: string, sessionId?: string): DirectSession {
    const session = new DirectSession(this.secretKey, peerPubkey, this.iceServers, sessionId)
    session.events.on('signal', (frame) => this.events.emit('signal', { peerPubkey, frame }))
    session.events.on('rumor', (rumor) => this.events.emit('rumor', { peerPubkey, rumor }))
    session.events.on('stateChanged', (state) => {
      this.events.emit('stateChanged', { peerPubkey, state })
      if (state === 'failed' || state === 'closed') {
        // Keep the entry so `stateOf` stays accurate for the UI badge; the
        // cooldown prevents a redial storm.
        this.#lastAttempt.set(peerPubkey, Date.now())
      }
    })
    this.#sessions.set(peerPubkey, session)
    return session
  }
}

export const supportsWebRtc = (): boolean => typeof globalThis.RTCPeerConnection === 'function'
