import type { Event as NostrEvent } from 'nostr-tools/core'
import { matchFilter, type Filter } from 'nostr-tools/filter'
import { verifyEventSignature } from '../crypto/giftwrap'
import { createLogger } from '../util/log'

const log = createLogger('socket')

/**
 * One WebSocket to one relay, kept alive on purpose.
 *
 * This replaces nostr-tools' `SimplePool` connection handling, which was built
 * for a different app — a feed reader that opens relays on demand and lets them
 * go. Every behaviour below exists because a default of that design measurably
 * stalled or silently broke a messenger:
 *
 *  - It closed any socket idle for 20 s, so a message sent after a pause paid a
 *    fresh TLS handshake. Measured from a slow international link, that turned a
 *    290 ms send into ten seconds.
 *  - A socket whose *first* connection failed was never retried, and inbox
 *    subscriptions allowed 3 s to connect. Handshakes to healthy public relays
 *    measured 5-10 s on that same link, so the live inbox on most relays died at
 *    startup and stayed dead until the app happened to regain focus.
 *  - Its first reconnect waited 10 s.
 *  - On reconnect it advanced each filter's `since` past the newest event seen.
 *    NIP-59 randomises gift-wrap timestamps up to two days into the past, so
 *    that silently skipped messages sent during the outage.
 *  - A dead-but-open socket took up to 49 s to notice, and waited on a close
 *    handshake that a dead network never completes.
 *
 * What it does instead: stays connected while wanted, reconnects within about a
 * second, re-sends subscriptions exactly as the owner defines them, and proves
 * liveness with an adaptive keepalive — plus an immediate probe whenever a
 * publish goes unanswered, because that is the moment a zombie costs something.
 */

export type SocketState = 'idle' | 'connecting' | 'open' | 'backoff' | 'closed'

export type PublishResult = { ok: true; ms: number } | { ok: false; error: string }

/** The subset of the browser WebSocket this module uses, so tests can supply their own. */
export interface WebSocketLike {
  readonly readyState: number
  onopen: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface SocketSubscription {
  /**
   * Evaluated every time the subscription is sent, including after a
   * reconnect, so the owner decides what a resumed subscription asks for.
   */
  filter: () => Filter
  onEvent: (event: NostrEvent) => void
  onEose?: () => void
  /** The relay ended the subscription. It is not re-sent on reconnect. */
  onClosed?: (reason: string) => void
  /** Checked against the raw frame before any parsing or signature work. */
  alreadyHave?: (id: string) => boolean
}

export interface RelaySocketHooks {
  onState?: (state: SocketState) => void
  onOpen?: (connectMs: number) => void
  onConnectFailed?: (reason: string) => void
  /** An open connection was lost without being asked to close. */
  onDropped?: (reason: string) => void
}

export interface RelaySocketOptions {
  createSocket?: WebSocketFactory
  connectTimeoutMs?: number
  probeTimeoutMs?: number
  keepAliveMs?: { initial: number; min: number; max: number; step: number }
  backoffMs?: { base: number; cap: number }
  isOffline?: () => boolean
  random?: () => number
}

const OPEN = 1

/**
 * Inbound frames beyond this are dropped unparsed. The largest legitimate
 * event this app handles is an attachment chunk at about 55 KB; a relay
 * sending megabytes is either broken or trying to spend our memory.
 */
export const MAX_FRAME_CHARS = 1024 * 1024

/** An open socket that has carried traffic this long is considered stable. */
const STABLE_MS = 5000

/**
 * Connection failures in a row, without a single success, after which a relay
 * is treated as down rather than flaky and retried far less often. Measured
 * live, a dead relay refuses in about 5 ms: without this, a permanently gone
 * entry in someone's relay list costs a handshake every thirty seconds for as
 * long as the app is open. A wake-up still retries it at once.
 */
const DEAD_AFTER_FAILURES = 8
const DEAD_BACKOFF_CAP_MS = 5 * 60_000

const DEFAULTS = {
  // Generous, because nothing on the critical path waits for it: a slow
  // handshake delays only that relay, never the message. Cold handshakes to
  // healthy relays measured up to ten seconds on a slow link.
  connectTimeoutMs: 10_000,
  probeTimeoutMs: 5000,
  // Below the 30 s idle timeout common on carrier NAT, then adapted per relay.
  keepAliveMs: { initial: 25_000, min: 10_000, max: 55_000, step: 5000 },
  backoffMs: { base: 400, cap: 30_000 },
}

const PROBE_FILTER = '{"ids":["' + '0'.repeat(64) + '"],"limit":0}'
const HEX64 = /^[0-9a-f]{64}$/

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike

interface PendingPublish {
  frame: string
  sent: boolean
  startedAt: number
  sentAt: number
  promise: Promise<PublishResult>
  finish: (result: PublishResult) => void
  hedge: ReturnType<typeof setTimeout> | null
}

export class RelaySocket {
  readonly url: string

  #hooks: RelaySocketHooks
  #createSocket: WebSocketFactory
  #connectTimeoutMs: number
  #probeTimeoutMs: number
  #keepAlive: { initial: number; min: number; max: number; step: number }
  #backoff: { base: number; cap: number }
  #isOffline: () => boolean
  #random: () => number

  #ws: WebSocketLike | null = null
  #state: SocketState = 'idle'
  /** The owner wants this connected, so drops are followed by reconnects. */
  #wanted = false
  #lastDelay = 0
  #failuresSinceOpen = 0
  #connectStartedAt = 0
  #lastRxAt = 0

  #keepAliveMs: number
  /** The idle duration that last killed this connection, if one has. */
  #idleCeilingMs = 0

  #connectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #keepAliveTimer: ReturnType<typeof setTimeout> | null = null
  #stableTimer: ReturnType<typeof setTimeout> | null = null
  #probe: { id: string; silence: number; timer: ReturnType<typeof setTimeout> } | null = null
  #serial = 0

  #subs = new Map<string, SocketSubscription>()
  #publishes = new Map<string, PendingPublish>()

  constructor(url: string, hooks: RelaySocketHooks = {}, opts: RelaySocketOptions = {}) {
    this.url = url
    this.#hooks = hooks
    this.#createSocket = opts.createSocket ?? defaultFactory
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs
    this.#keepAlive = opts.keepAliveMs ?? DEFAULTS.keepAliveMs
    this.#backoff = opts.backoffMs ?? DEFAULTS.backoffMs
    this.#isOffline = opts.isOffline ?? (() => typeof navigator !== 'undefined' && navigator.onLine === false)
    this.#random = opts.random ?? Math.random
    this.#keepAliveMs = this.#keepAlive.initial
  }

  get state(): SocketState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#state === 'open'
  }

  get wanted(): boolean {
    return this.#wanted
  }

  /** Current keepalive interval. Exposed for tests and diagnostics. */
  get keepAliveMs(): number {
    return this.#keepAliveMs
  }

  get pendingPublishes(): number {
    return this.#publishes.size
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Ask for the connection to be up, and to stay up.
   *
   * `urgent` cuts a pending backoff short — for a relay someone is waiting on
   * right now. It does not reset the backoff, so a relay that keeps failing
   * keeps backing off further between urgent attempts.
   */
  connect(urgent = false): void {
    this.#wanted = true
    if (this.#state === 'open' || this.#state === 'connecting') return
    if (this.#state === 'backoff') {
      if (!urgent) return
      this.#clearTimer('reconnect')
    }
    this.#open()
  }

  /**
   * The world may have changed: the network came back, the device woke, the
   * tab became visible. Stale backoff timers are discarded and reconnection
   * starts now. With `probe`, an apparently open socket must also prove it is
   * alive — after sleep or a network change, many are not.
   */
  wake(probe: boolean): void {
    if (!this.#wanted) return
    switch (this.#state) {
      case 'backoff':
        this.#clearTimer('reconnect')
        this.#lastDelay = 0
        this.#failuresSinceOpen = 0
        this.#open()
        return
      case 'idle':
      case 'closed':
        this.#open()
        return
      case 'open':
        if (probe && Date.now() - this.#lastRxAt > 2000) this.#sendProbe(Math.min(this.#probeTimeoutMs, 3500))
        return
      case 'connecting':
        return
    }
  }

  /** Close for good. Pending publishes fail and subscriptions are dropped. */
  close(): void {
    this.#wanted = false
    this.#teardown()
    this.#clearTimer('reconnect')
    for (const entry of [...this.#publishes.values()]) entry.finish({ ok: false, error: 'closed by caller' })
    this.#subs.clear()
    this.#setState('closed')
  }

  #open(): void {
    this.#teardown()
    this.#connectStartedAt = Date.now()
    this.#setState('connecting')

    let ws: WebSocketLike
    try {
      ws = this.#createSocket(this.url)
    } catch (err) {
      this.#down(`could not open socket: ${errorText(err)}`)
      return
    }
    this.#ws = ws

    this.#connectTimer = setTimeout(() => this.#down('connection timed out'), this.#connectTimeoutMs)
    ws.onopen = () => this.#onOpen()
    ws.onmessage = (event) => this.#onMessage(event.data)
    ws.onerror = () => this.#down(this.#state === 'open' ? 'connection error' : 'connection failed')
    ws.onclose = () => this.#down('connection closed')
  }

  #onOpen(): void {
    this.#clearTimer('connect')
    const connectMs = Date.now() - this.#connectStartedAt
    this.#failuresSinceOpen = 0
    this.#lastRxAt = Date.now()
    this.#setState('open')
    this.#hooks.onOpen?.(connectMs)

    // Only a connection that stays up earns a reset of the backoff. A relay
    // that accepts the handshake and hangs up at once — which is what rate
    // limiting often looks like — must keep backing off, not retry in a
    // tight loop.
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = null
      this.#lastDelay = 0
    }, STABLE_MS)

    for (const [id, sub] of this.#subs) this.#sendReq(id, sub)
    for (const [, entry] of this.#publishes) {
      if (!entry.sent) this.#sendPublish(entry)
    }
    this.#scheduleKeepAlive()
  }

  /**
   * The connection is gone, or never arrived.
   *
   * Handlers are detached before anything else, so a dead socket that finally
   * reports its close minutes later cannot tear down the connection that has
   * since replaced it.
   */
  #down(reason: string, idleDeath?: { silence: number }): void {
    if (this.#state === 'closed' && !this.#wanted) return
    const wasOpen = this.#state === 'open'
    this.#teardown()

    // Anything sent but not acknowledged goes again on the next connection.
    // Relays deduplicate by event id, so a resend can never double a message;
    // not resending would drop one the relay never actually received.
    for (const entry of this.#publishes.values()) {
      entry.sent = false
      if (entry.hedge) clearTimeout(entry.hedge)
      entry.hedge = null
    }

    if (wasOpen) {
      // Only a failed keepalive teaches anything about the path. The probe
      // went out after `silence` of quiet and was never answered, so whatever
      // silently cut the connection — typically a NAT or carrier idle timeout
      // — acts in less than that. Halve the interval, and remember the length
      // so growth never climbs back to it. A drop mid-conversation, or a
      // failed probe after the device slept, says nothing about idle limits.
      if (idleDeath) {
        this.#idleCeilingMs = idleDeath.silence
        this.#keepAliveMs = Math.min(
          this.#keepAliveMs,
          Math.max(this.#keepAlive.min, Math.round(idleDeath.silence / 2)),
        )
      }
      log.debug(`${this.url} dropped: ${reason}`)
      this.#hooks.onDropped?.(reason)
    } else {
      this.#failuresSinceOpen += 1
      this.#hooks.onConnectFailed?.(reason)
    }

    if (this.#wanted) this.#scheduleReconnect()
    else this.#setState('closed')
  }

  /**
   * Decorrelated jitter: each delay is drawn from between the base and three
   * times the previous one. Spreads reconnects out without starting slow, and
   * needs no attempt counter — the previous delay is the whole state.
   */
  #scheduleReconnect(): void {
    const { base } = this.#backoff
    const cap = this.#failuresSinceOpen >= DEAD_AFTER_FAILURES ? DEAD_BACKOFF_CAP_MS : this.#backoff.cap
    let delay: number
    if (this.#isOffline()) {
      // The browser reports no network at all. Retrying fast burns battery for
      // nothing; the `online` event will wake us the moment it returns.
      delay = this.#backoff.cap
    } else {
      const upper = Math.max(base, (this.#lastDelay || base) * 3)
      delay = Math.min(cap, base + this.#random() * (upper - base))
    }
    this.#lastDelay = delay
    this.#setState('backoff')
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      if (this.#wanted) this.#open()
    }, delay)
  }

  #teardown(): void {
    this.#clearTimer('connect')
    this.#clearTimer('keepalive')
    this.#clearTimer('stable')
    if (this.#probe) {
      clearTimeout(this.#probe.timer)
      this.#probe = null
    }
    const ws = this.#ws
    this.#ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      // Not awaited: a dead network never completes the close handshake, and
      // the replacement connection must not wait on it.
      ws.close()
    } catch {
      /* already closed */
    }
  }

  // --- keepalive ------------------------------------------------------------

  #scheduleKeepAlive(): void {
    this.#clearTimer('keepalive')
    if (this.#state !== 'open') return
    const silence = Date.now() - this.#lastRxAt
    const wait = Math.max(250, this.#keepAliveMs - silence)
    this.#keepAliveTimer = setTimeout(() => {
      this.#keepAliveTimer = null
      if (this.#state !== 'open') return
      if (Date.now() - this.#lastRxAt >= this.#keepAliveMs - 50)
        this.#sendProbe(this.#probeTimeoutMs, 'keepalive')
      else this.#scheduleKeepAlive()
    }, wait)
  }

  /**
   * Prove the connection is alive with the cheapest request a relay must
   * answer: a subscription for an event that cannot exist, with limit 0. Any
   * inbound frame counts as proof, not only the reply.
   */
  #sendProbe(timeoutMs: number, kind: 'keepalive' | 'check' = 'check'): void {
    if (this.#state !== 'open' || this.#probe) return
    const id = `ka:${++this.#serial}`
    const silence = Date.now() - this.#lastRxAt
    const timer = setTimeout(() => {
      this.#probe = null
      log.debug(`${this.url} failed its liveness probe`)
      this.#down('liveness probe timed out', kind === 'keepalive' ? { silence } : undefined)
    }, timeoutMs)
    this.#probe = { id, silence, timer }
    this.#rawSend(`["REQ","${id}",${PROBE_FILTER}]`)
  }

  #probeAnswered(): void {
    const probe = this.#probe
    if (!probe) return
    clearTimeout(probe.timer)
    this.#probe = null
    // Surviving a full idle interval is evidence the path tolerates at least
    // that much silence, so the interval creeps up — but stays below the
    // length already seen to kill this connection. With a NAT that cuts at
    // 18 s this settles at 16 s after two losses, rather than oscillating.
    if (probe.silence >= this.#keepAliveMs * 0.9) {
      const ceiling = this.#idleCeilingMs > 0 ? Math.round(this.#idleCeilingMs * 0.8) : this.#keepAlive.max
      const grown = Math.min(this.#keepAlive.max, ceiling, this.#keepAliveMs + this.#keepAlive.step)
      this.#keepAliveMs = Math.max(this.#keepAliveMs, this.#keepAlive.min, grown)
    }
  }

  // --- subscriptions --------------------------------------------------------

  subscribe(id: string, sub: SocketSubscription): void {
    this.#subs.set(id, sub)
    if (this.#state === 'open') this.#sendReq(id, sub)
  }

  unsubscribe(id: string): void {
    if (!this.#subs.delete(id)) return
    if (this.#state === 'open') this.#rawSend(`["CLOSE",${JSON.stringify(id)}]`)
  }

  hasSubscription(id: string): boolean {
    return this.#subs.has(id)
  }

  #sendReq(id: string, sub: SocketSubscription): void {
    let filter: Filter
    try {
      filter = sub.filter()
    } catch (err) {
      log.warn('subscription filter threw', err)
      return
    }
    this.#rawSend(`["REQ",${JSON.stringify(id)},${JSON.stringify(filter)}]`)
  }

  // --- publishing -----------------------------------------------------------

  /**
   * Publish and report the relay's verdict. Never rejects.
   *
   * The timeout covers everything, including waiting for a connection, so a
   * caller always hears back. A publish made while disconnected is held and
   * sent the moment the socket opens; `urgent` cuts a pending backoff short.
   */
  publish(event: NostrEvent, timeoutMs: number, urgent = true): Promise<PublishResult> {
    const existing = this.#publishes.get(event.id)
    if (existing) return existing.promise

    let finish!: (result: PublishResult) => void
    const promise = new Promise<PublishResult>((resolve) => {
      finish = resolve
    })
    const entry: PendingPublish = {
      frame: `["EVENT",${JSON.stringify(event)}]`,
      sent: false,
      startedAt: Date.now(),
      sentAt: 0,
      promise,
      finish: () => undefined,
      hedge: null,
    }
    const timer = setTimeout(() => entry.finish({ ok: false, error: 'publish timed out' }), timeoutMs)
    entry.finish = (result) => {
      if (this.#publishes.get(event.id) !== entry) return
      clearTimeout(timer)
      if (entry.hedge) clearTimeout(entry.hedge)
      this.#publishes.delete(event.id)
      finish(result)
    }
    this.#publishes.set(event.id, entry)

    if (this.#state === 'open') this.#sendPublish(entry)
    else this.connect(urgent)
    return promise
  }

  #sendPublish(entry: PendingPublish): void {
    entry.sent = true
    entry.sentAt = Date.now()
    this.#rawSend(entry.frame)
    // If the relay has not answered and nothing at all has arrived since, the
    // socket may be dead. Waiting for the keepalive to find out could take a
    // minute; this is the moment a zombie actually costs something.
    const sentAt = entry.sentAt
    entry.hedge = setTimeout(() => {
      entry.hedge = null
      if (this.#state === 'open' && this.#lastRxAt < sentAt) this.#sendProbe(this.#probeTimeoutMs)
    }, this.#probeTimeoutMs)
  }

  // --- inbound --------------------------------------------------------------

  #onMessage(data: unknown): void {
    this.#lastRxAt = Date.now()
    this.#probeAnswered()
    if (this.#state === 'open' && !this.#keepAliveTimer) this.#scheduleKeepAlive()
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) return

    // Duplicate events are the norm — every relay delivers the same message —
    // so they are recognised from the raw frame and skipped before paying for
    // a JSON parse and a Schnorr verification.
    if (data.startsWith('["EVENT"')) {
      const peeked = peekEvent(data)
      if (peeked) {
        const sub = this.#subs.get(peeked.subId)
        if (!sub || sub.alreadyHave?.(peeked.eventId)) return
      }
    }

    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return

    switch (frame[0]) {
      case 'EVENT':
        this.#onEvent(frame[1], frame[2])
        return
      case 'EOSE': {
        const id = frame[1]
        if (typeof id !== 'string') return
        if (id.startsWith('ka:')) {
          this.#rawSend(`["CLOSE",${JSON.stringify(id)}]`)
          return
        }
        this.#subs.get(id)?.onEose?.()
        return
      }
      case 'CLOSED': {
        const id = frame[1]
        if (typeof id !== 'string') return
        const sub = this.#subs.get(id)
        if (!sub) return
        this.#subs.delete(id)
        sub.onClosed?.(typeof frame[2] === 'string' ? frame[2] : '')
        return
      }
      case 'OK': {
        const [, id, accepted, reason] = frame as [string, unknown, unknown, unknown]
        if (typeof id !== 'string') return
        const entry = this.#publishes.get(id)
        if (!entry) return
        const message = typeof reason === 'string' ? reason : ''
        // "duplicate:" means the relay already holds the event — the outcome a
        // publish wants, whatever the boolean says.
        if (accepted === true || message.startsWith('duplicate:')) {
          entry.finish({ ok: true, ms: Date.now() - entry.startedAt })
        } else {
          entry.finish({ ok: false, error: message || 'rejected' })
        }
        return
      }
      case 'NOTICE':
        if (typeof frame[1] === 'string') log.debug(`${this.url} notice: ${frame[1].slice(0, 200)}`)
        return
      default:
        // AUTH challenges included: Textor is anonymous and never authenticates.
        return
    }
  }

  #onEvent(subId: unknown, value: unknown): void {
    if (typeof subId !== 'string') return
    const sub = this.#subs.get(subId)
    if (!sub || typeof value !== 'object' || value === null) return
    const event = value as NostrEvent
    if (typeof event.id !== 'string' || !HEX64.test(event.id)) return
    if (sub.alreadyHave?.(event.id)) return
    // A relay may send anything under any subscription id. Nothing it sends
    // is passed on unless it matches what was asked for and is signed.
    if (!matchFilter(sub.filter(), event)) return
    if (!verifyEventSignature(event)) return
    sub.onEvent(event)
  }

  // --- plumbing -------------------------------------------------------------

  #rawSend(frame: string): void {
    const ws = this.#ws
    if (!ws || ws.readyState !== OPEN) return
    try {
      ws.send(frame)
    } catch (err) {
      this.#down(`send failed: ${errorText(err)}`)
    }
  }

  #setState(state: SocketState): void {
    if (this.#state === state) return
    this.#state = state
    this.#hooks.onState?.(state)
  }

  #clearTimer(which: 'connect' | 'reconnect' | 'keepalive' | 'stable'): void {
    const handle = {
      connect: this.#connectTimer,
      reconnect: this.#reconnectTimer,
      keepalive: this.#keepAliveTimer,
      stable: this.#stableTimer,
    }[which]
    if (handle) clearTimeout(handle)
    if (which === 'connect') this.#connectTimer = null
    else if (which === 'reconnect') this.#reconnectTimer = null
    else if (which === 'keepalive') this.#keepAliveTimer = null
    else this.#stableTimer = null
  }
}

/**
 * Pull the subscription id and event id out of a raw EVENT frame without
 * parsing it.
 *
 * Safe on hostile input for the only use it has. In valid JSON an unescaped
 * quote is always a string delimiter, so `"id":"` can only be the event's own
 * id key; the subscription id is one this client chose. If the frame is
 * malformed the peek may return nonsense, which at worst skips a frame that
 * would have failed to parse anyway. And a skip only ever happens for an id
 * already verified and delivered, so a relay forging a known id gains nothing.
 */
export function peekEvent(frame: string): { subId: string; eventId: string } | null {
  const subStart = frame.indexOf('"', 8)
  if (subStart === -1) return null
  const subEnd = frame.indexOf('"', subStart + 1)
  if (subEnd === -1 || subEnd - subStart > 80) return null
  const keyAt = frame.indexOf('"id":"', subEnd)
  if (keyAt === -1) return null
  const eventId = frame.slice(keyAt + 6, keyAt + 70)
  if (!HEX64.test(eventId)) return null
  return { subId: frame.slice(subStart + 1, subEnd), eventId }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
