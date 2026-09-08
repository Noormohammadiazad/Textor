import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { emptyHealth, type RelayHealth } from '../models/types'
import { normalizeRelayUrl } from './relayUrl'
import { RelaySocket, type PublishResult, type RelaySocketOptions, type SocketState } from './relaySocket'
import {
  circuitState,
  quorumFor,
  recordConnect,
  recordPublish,
  relayScore,
  seededReliability,
} from './relayScore'

const log = createLogger('relays')

export type RelayConnectionState = 'idle' | 'connecting' | 'online' | 'offline'

export interface RelayStatus {
  url: string
  state: RelayConnectionState
  health: RelayHealth
}

export type PublishOutcome = { url: string; ok: true; ms: number } | { url: string; ok: false; error: string }

/**
 * A publish in progress, observable at two moments.
 *
 * `quorum` resolves as soon as enough relays have acknowledged — the moment a
 * message can honestly be called sent — or once every relay has answered if
 * that never happens. `settled` resolves when every relay has answered. The
 * work between the two continues in the background; nothing is cancelled.
 */
export interface PublishHandle {
  quorum: Promise<PublishOutcome[]>
  settled: Promise<PublishOutcome[]>
}

export interface SubCloser {
  close: (reason?: string) => void
}

/** Why the app thinks the network may have changed under it. */
export type WakeReason = 'online' | 'visible' | 'focus' | 'resume'

export type RelayPoolEvents = {
  statusChanged: RelayStatus[]
}

export interface QueryOptions {
  /** Upper bound on the whole query. */
  maxWait?: number
  /**
   * Resolve this long after half the reachable relays have finished, instead
   * of waiting on the slowest. Only for reads a live subscription also covers,
   * where a straggler's events are not lost, merely delivered later.
   */
  graceMs?: number
}

/**
 * The surface the rest of the app depends on. Depending on the interface rather
 * than the class keeps the engine testable against an in-memory relay network,
 * which is the only way to exercise two-peer delivery deterministically.
 */
export interface IRelayPool {
  readonly events: Emitter<RelayPoolEvents>
  readonly readRelays: string[]
  readonly writeRelays: string[]
  readonly onlineCount: number
  /**
   * Increments whenever a read relay loses its connection. If it has not
   * moved since the last catch-up read, the live subscription has seen
   * everything a new catch-up could find.
   */
  readonly epoch: number
  setRelays(read: string[], write: string[]): void
  seedHealth(entries: { url: string; health: RelayHealth }[]): void
  statuses(): RelayStatus[]
  healthSnapshot(): { url: string; health: RelayHealth }[]
  subscribe(
    filter: Filter | (() => Filter),
    handlers: {
      onEvent: (event: NostrEvent, url?: string) => void
      onEose?: (url?: string) => void
      label?: string
    },
    relays?: string[],
  ): SubCloser
  query(filter: Filter, relays?: string[], opts?: QueryOptions): Promise<NostrEvent[]>
  /** Publish and wait for every relay. For writes nobody is waiting on. */
  publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]>
  /** Publish on the critical path: see `PublishHandle`. */
  dispatch(
    event: NostrEvent,
    relays: string[],
    opts?: { quorum?: number; standbys?: string[] },
  ): PublishHandle
  rankedWriteRelays(limit?: number): string[]
  rankedReadRelays(limit?: number): string[]
  /** Open sockets now for relays a message is likely to need shortly. */
  prewarm(relays: string[]): void
  wake(reason: WakeReason): void
  destroy(): void
}

/** How long a publish may take, connection included, before it counts as failed. */
const PUBLISH_TIMEOUT_MS = 10_000
/** A pre-warmed relay is kept connected this long without being used. */
const PREWARM_HOLD_MS = 5 * 60_000
/** An unconfigured relay's socket lingers this long after last use. */
const LINGER_MS = 3 * 60_000
/** After a subscription is ended for a reason other than refusal, try again after this. */
const RESUBSCRIBE_MS = 30_000
/** Recent event ids remembered per subscription, for cross-relay dedup. */
const SEEN_CAPACITY = 4096
const NOTIFY_COALESCE_MS = 50

export interface RelayPoolOptions {
  socket?: RelaySocketOptions
  now?: () => number
}

/**
 * Relay connections, publishing policy, and health.
 *
 * Built on the premise that any relay may be slow, down, or quietly broken at
 * any moment, and that a person watching a spinner does not care which. So:
 *
 *  - Configured relays are connected as soon as they are known and kept
 *    connected. A message never waits for a handshake that could have happened
 *    earlier.
 *  - A publish goes to every target at once and is called sent at a quorum of
 *    acknowledgements, not when the slowest relay finally answers.
 *  - If that quorum is slow to form, the publish fans out to healthy relays
 *    that are already connected but were not targeted — failover to a hot
 *    standby costs a send, not a handshake.
 *  - Health is recency-weighted and a relay that keeps failing is stopped
 *    from being leaned on, without being dropped from delivery.
 */
export class RelayPool implements IRelayPool {
  readonly events = new Emitter<RelayPoolEvents>()

  #sockets = new Map<string, RelaySocket>()
  #health = new Map<string, RelayHealth>()
  #readUrls: string[] = []
  #writeUrls: string[] = []
  #pinnedUntil = new Map<string, number>()
  #lastUsed = new Map<string, number>()
  #epoch = 0
  #destroyed = false
  #socketOptions: RelaySocketOptions
  #now: () => number
  #notifyTimer: ReturnType<typeof setTimeout> | null = null
  #sweepTimer: ReturnType<typeof setTimeout> | null = null
  #serial = 0
  /** In-flight reads that want to hear when a relay cannot be reached. */
  #downListeners = new Set<(url: string) => void>()

  constructor(opts: RelayPoolOptions = {}) {
    this.#socketOptions = opts.socket ?? {}
    this.#now = opts.now ?? Date.now
  }

  get readRelays(): string[] {
    return [...this.#readUrls]
  }

  get writeRelays(): string[] {
    return [...this.#writeUrls]
  }

  get epoch(): number {
    return this.#epoch
  }

  get onlineCount(): number {
    let count = 0
    for (const url of this.#configured()) {
      if (this.#sockets.get(url)?.isOpen) count += 1
    }
    return count
  }

  /**
   * Replace the configured relay set.
   *
   * Every configured relay is connected immediately. This is the pre-warm that
   * matters most: it runs the moment the vault is unlocked, so by the time
   * someone has picked a conversation and typed a message, the handshakes —
   * one to ten seconds each on a slow link — are already behind them.
   */
  setRelays(read: string[], write: string[]): void {
    const previous = this.#configured()
    this.#readUrls = dedupe(read)
    this.#writeUrls = dedupe(write)
    const next = this.#configured()

    for (const url of previous) {
      if (next.has(url) || this.#isPinned(url)) continue
      this.#sockets.get(url)?.close()
      this.#sockets.delete(url)
    }
    for (const url of next) this.#socket(url).connect()
    this.#notify()
  }

  seedHealth(entries: { url: string; health: RelayHealth }[]): void {
    for (const { url, health } of entries) {
      const key = normalizeRelayUrl(url)
      if (!key) continue
      // Merge onto a full default rather than spreading the stored record
      // directly. A vault written by an earlier build lacks newer counters, and
      // `undefined += 1` is NaN — which silently disables every comparison that
      // depends on it, so the relay keeps reporting itself healthy.
      const merged = { ...emptyHealth(), ...health }
      if (typeof (health as Partial<RelayHealth>).reliability !== 'number') {
        merged.reliability = seededReliability(merged)
      }
      this.#health.set(key, merged)
    }
    this.#notify()
  }

  statuses(): RelayStatus[] {
    const urls = new Set([...this.#readUrls, ...this.#writeUrls, ...this.#health.keys()])
    return [...urls].map((url) => ({
      url,
      state: connectionState(this.#sockets.get(url)?.state),
      health: { ...this.#healthFor(url) },
    }))
  }

  healthSnapshot(): { url: string; health: RelayHealth }[] {
    return [...this.#health.entries()].map(([url, health]) => ({ url, health: { ...health } }))
  }

  // --- reading --------------------------------------------------------------

  /**
   * Long-lived subscription, one per relay.
   *
   * One per relay rather than pooled so that a single relay refusing the
   * subscription — which is what NIP-42 `auth-required` looks like — is
   * attributable and visible (ADR-020). Events are deduplicated across relays
   * here, so the caller sees each once and the expensive work happens once.
   *
   * A function filter is re-evaluated on every reconnect, which is how the
   * inbox resumes from its sync cursor rather than from wherever a relay's
   * newest event happened to be.
   */
  subscribe(
    filter: Filter | (() => Filter),
    handlers: {
      onEvent: (event: NostrEvent, url?: string) => void
      onEose?: (url?: string) => void
      label?: string
    },
    relays?: string[],
  ): SubCloser {
    const targets = relays ? dedupe(relays) : [...this.#readUrls]
    if (targets.length === 0) {
      log.warn('subscribe called with no read relays')
      return { close: () => undefined }
    }

    const id = `${handlers.label ?? 'sub'}:${++this.#serial}`
    const filterFn = typeof filter === 'function' ? filter : () => filter
    const seen = new RecentIds(SEEN_CAPACITY)
    const retries = new Map<string, ReturnType<typeof setTimeout>>()
    let closed = false

    const attach = (url: string): void => {
      if (closed || this.#destroyed) return
      const socket = this.#socket(url)
      socket.subscribe(id, {
        filter: filterFn,
        alreadyHave: (eventId) => {
          if (!seen.has(eventId)) return false
          this.#healthFor(url).eventsReceived += 1
          return true
        },
        onEvent: (event) => {
          this.#healthFor(url).eventsReceived += 1
          if (seen.has(event.id)) return
          seen.add(event.id)
          handlers.onEvent(event, url)
        },
        onEose: () => handlers.onEose?.(url),
        onClosed: (reason) => {
          const health = this.#healthFor(url)
          health.lastErrorAt = this.#now()
          health.lastError = reason.slice(0, 160)
          if (isSubscriptionRefusal(reason)) {
            // Up and talking, but it will never hand us our inbox. Retrying
            // would only hide that from the relay panel.
            health.readFail += 1
            health.lastReadError = reason.slice(0, 160)
          } else if (!closed) {
            retries.set(
              url,
              setTimeout(() => {
                retries.delete(url)
                attach(url)
              }, RESUBSCRIBE_MS),
            )
          }
          this.#notify()
        },
      })
      socket.connect()
    }

    for (const url of targets) attach(url)

    return {
      close: () => {
        closed = true
        for (const timer of retries.values()) clearTimeout(timer)
        retries.clear()
        for (const url of targets) this.#sockets.get(url)?.unsubscribe(id)
      },
    }
  }

  /**
   * One-shot read that resolves when the relays have finished sending.
   *
   * "Finished" is judged against relays that could answer at all: a relay
   * whose socket is down is not waited on. With `graceMs`, the read resolves
   * shortly after half of those have finished instead of waiting on the slowest.
   */
  async query(filter: Filter, relays?: string[], opts: QueryOptions = {}): Promise<NostrEvent[]> {
    const targets = relays ? dedupe(relays) : [...this.#readUrls]
    if (targets.length === 0) return []
    const maxWait = opts.maxWait ?? 6000

    return new Promise<NostrEvent[]>((resolve) => {
      const id = `q:${++this.#serial}`
      const events = new Map<string, NostrEvent>()
      const finished = new Set<string>()
      const timers: ReturnType<typeof setTimeout>[] = []
      let done = false

      const enough = Math.max(1, Math.ceil(targets.length / 2))

      const finish = (): void => {
        if (done) return
        done = true
        for (const timer of timers) clearTimeout(timer)
        this.#downListeners.delete(onDown)
        for (const url of targets) this.#sockets.get(url)?.unsubscribe(id)
        resolve([...events.values()])
      }
      // A relay answers by finishing its stored events or by refusing; one
      // that cannot be reached at all has answered too, and is not waited on.
      const onFinished = (url: string): void => {
        if (done || finished.has(url)) return
        finished.add(url)
        if (finished.size >= targets.length) finish()
        else if (opts.graceMs !== undefined && finished.size === enough) {
          timers.push(setTimeout(finish, opts.graceMs))
        }
      }
      const onDown = (url: string): void => {
        if (targets.includes(url)) onFinished(url)
      }
      this.#downListeners.add(onDown)

      timers.push(setTimeout(finish, maxWait))
      for (const url of targets) {
        const socket = this.#socket(url)
        socket.subscribe(id, {
          filter: () => filter,
          alreadyHave: (eventId) => events.has(eventId),
          onEvent: (event) => {
            if (!events.has(event.id)) events.set(event.id, event)
          },
          onEose: () => onFinished(url),
          onClosed: () => onFinished(url),
        })
        // Someone is waiting on this read, so a pending backoff is cut short.
        socket.connect(true)
      }
    })
  }

  // --- writing --------------------------------------------------------------

  async publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]> {
    return this.dispatch(event, relays ?? this.#writeUrls, { standbys: [] }).settled
  }

  /**
   * Publish on the critical path.
   *
   * Every target is published to at once. Relays whose circuit is open are
   * still included — they may be the only relay the recipient reads — but are
   * not forced to reconnect, so a relay known to be failing costs nothing
   * unless it has already recovered on its own.
   *
   * If the quorum has not formed within a delay derived from the targets' own
   * measured latency, the event also goes to standbys: healthy, already
   * connected relays that were not targeted. The same happens at once if every
   * target has failed. That is the difference between a failover that costs a
   * send and one that costs a handshake.
   */
  dispatch(
    event: NostrEvent,
    relays: string[],
    opts: { quorum?: number; standbys?: string[] } = {},
  ): PublishHandle {
    const now = this.#now()
    const targets = this.#rank(dedupe(relays), now)
    const quorum = Math.min(opts.quorum ?? quorumFor(targets.length), Math.max(1, targets.length))

    const outcomes: PublishOutcome[] = []
    let acked = 0
    let pending = 0
    let quorumResolved = false
    let resolveQuorum!: (value: PublishOutcome[]) => void
    let resolveSettled!: (value: PublishOutcome[]) => void
    const quorumPromise = new Promise<PublishOutcome[]>((resolve) => (resolveQuorum = resolve))
    const settledPromise = new Promise<PublishOutcome[]>((resolve) => (resolveSettled = resolve))

    const launched = new Set<string>()
    const answered = new Set<string>()
    let standbys = dedupe(opts.standbys ?? this.#writeUrls)
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null

    const reachQuorum = (): void => {
      if (quorumResolved) return
      quorumResolved = true
      if (hedgeTimer) clearTimeout(hedgeTimer)
      this.#downListeners.delete(onDown)
      resolveQuorum([...outcomes])
    }

    // A target whose connection has just failed is not answering any time
    // soon, though its publish stays queued in case the relay comes back. If
    // every target still outstanding is in that state, waiting out the hedge
    // delay would be waiting on nothing.
    const stalled = new Set<string>()
    const maybeFailover = (): void => {
      if (quorumResolved || acked >= quorum || standbys.length === 0) return
      if ([...launched].every((u) => answered.has(u) || stalled.has(u))) launchStandbys()
    }
    const onDown = (url: string): void => {
      if (quorumResolved || !launched.has(url) || answered.has(url)) return
      stalled.add(url)
      maybeFailover()
    }
    this.#downListeners.add(onDown)

    const launchStandbys = (): boolean => {
      const ready = this.#rank(
        standbys.filter(
          (url) =>
            !launched.has(url) &&
            this.#sockets.get(url)?.isOpen === true &&
            circuitState(this.#healthFor(url), this.#now()) === 'closed',
        ),
        this.#now(),
      ).slice(0, Math.max(1, quorum - acked))
      standbys = []
      for (const url of ready) launch(url)
      return ready.length > 0
    }

    const launch = (url: string): void => {
      launched.add(url)
      pending += 1
      const socket = this.#socket(url)
      const urgent = circuitState(this.#healthFor(url), this.#now()) !== 'open'
      void socket.publish(event, PUBLISH_TIMEOUT_MS, urgent).then((result: PublishResult) => {
        answered.add(url)
        this.#recordPublish(url, result)
        outcomes.push(result.ok ? { url, ok: true, ms: result.ms } : { url, ok: false, error: result.error })
        if (result.ok) acked += 1
        pending -= 1
        if (acked >= quorum) reachQuorum()
        if (pending > 0) {
          maybeFailover()
          return
        }
        // Every relay tried so far has answered. Short of quorum, spend the
        // standbys before giving up rather than after a retry backoff.
        if (acked < quorum && !quorumResolved && standbys.length > 0 && launchStandbys()) return
        reachQuorum()
        resolveSettled([...outcomes])
      })
    }

    if (targets.length === 0) {
      this.#downListeners.delete(onDown)
      resolveQuorum([])
      resolveSettled([])
      return { quorum: quorumPromise, settled: settledPromise }
    }

    for (const url of targets) launch(url)

    if (standbys.length > 0) {
      hedgeTimer = setTimeout(
        () => {
          hedgeTimer = null
          if (!quorumResolved) launchStandbys()
        },
        this.#hedgeDelay(targets, quorum),
      )
    }

    return { quorum: quorumPromise, settled: settledPromise }
  }

  /**
   * How long to wait for a quorum before bringing in standbys.
   *
   * Two and a half times the expected latency of the relay that would complete
   * the quorum: long enough that a healthy relay is not second-guessed, short
   * enough that a stalled one is. Bounded so a relay that has never been
   * measured cannot make the wait unreasonable in either direction.
   */
  #hedgeDelay(ranked: string[], quorum: number): number {
    const latencies = ranked.map((url) => this.#healthFor(url).latencyMs).filter((ms) => ms > 0)
    latencies.sort((a, b) => a - b)
    const expected = latencies[Math.min(quorum, latencies.length) - 1]
    if (expected === undefined) return 2500
    return Math.min(4000, Math.max(1000, expected * 2.5))
  }

  /** Configured write relays, best first. */
  rankedWriteRelays(limit = 8): string[] {
    return this.#rank(this.#writeUrls, this.#now()).slice(0, limit)
  }

  /** Configured read relays, best first. */
  rankedReadRelays(limit = 8): string[] {
    return this.#rank(this.#readUrls, this.#now()).slice(0, limit)
  }

  // --- connection management ------------------------------------------------

  prewarm(relays: string[]): void {
    const until = this.#now() + PREWARM_HOLD_MS
    for (const url of dedupe(relays)) {
      this.#pinnedUntil.set(url, until)
      this.#lastUsed.set(url, this.#now())
      const socket = this.#socket(url)
      if (circuitState(this.#healthFor(url), this.#now()) !== 'open') socket.connect()
    }
    this.#scheduleSweep()
  }

  /**
   * The network may have changed. Every socket the app wants is told so:
   * stale reconnect timers are dropped, and — unless this is merely a focus
   * change, which cannot have changed the network — apparently open sockets
   * are probed, because after sleep or a network switch many are dead.
   */
  wake(reason: WakeReason): void {
    const probe = reason !== 'focus'
    for (const [url, socket] of this.#sockets) {
      if (this.#isWanted(url)) socket.wake(probe)
    }
    this.#notify()
  }

  destroy(): void {
    this.#destroyed = true
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer)
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer)
    this.#notifyTimer = null
    this.#sweepTimer = null
    for (const socket of this.#sockets.values()) socket.close()
    this.#sockets.clear()
    this.events.clear()
  }

  #socket(url: string): RelaySocket {
    let socket = this.#sockets.get(url)
    if (socket) return socket
    socket = new RelaySocket(
      url,
      {
        onState: (state) => {
          if (state === 'closed' && !this.#isWanted(url)) this.#sockets.delete(url)
          this.#notify()
        },
        onOpen: (ms) => {
          recordConnect(this.#healthFor(url), ms, this.#now())
          this.#notify()
        },
        onConnectFailed: (reason) => {
          const health = this.#healthFor(url)
          health.connectFail += 1
          health.lastErrorAt = this.#now()
          health.lastError = reason.slice(0, 160)
          if (this.#readUrls.includes(url)) this.#epoch += 1
          for (const listener of [...this.#downListeners]) listener(url)
          this.#notify()
        },
        onDropped: (reason) => {
          const health = this.#healthFor(url)
          health.lastErrorAt = this.#now()
          health.lastError = reason.slice(0, 160)
          if (this.#readUrls.includes(url)) this.#epoch += 1
          for (const listener of [...this.#downListeners]) listener(url)
          this.#notify()
        },
      },
      this.#socketOptions,
    )
    this.#sockets.set(url, socket)
    if (!this.#configured().has(url)) {
      this.#lastUsed.set(url, this.#now())
      this.#scheduleSweep()
    }
    return socket
  }

  #recordPublish(url: string, result: PublishResult): void {
    const health = this.#healthFor(url)
    recordPublish(health, result.ok ? { ok: true, ms: result.ms } : { ok: false }, this.#now())
    if (!result.ok) health.lastError = result.error.slice(0, 160)
    this.#lastUsed.set(url, this.#now())
    this.#notify()
  }

  #rank(urls: string[], now: number): string[] {
    return urls
      .map((url) => ({
        url,
        score: relayScore(this.#healthFor(url), { open: this.#sockets.get(url)?.isOpen === true, now }),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.url)
  }

  #configured(): Set<string> {
    return new Set([...this.#readUrls, ...this.#writeUrls])
  }

  #isPinned(url: string): boolean {
    return (this.#pinnedUntil.get(url) ?? 0) > this.#now()
  }

  #isWanted(url: string): boolean {
    return this.#configured().has(url) || this.#isPinned(url)
  }

  /**
   * Close sockets to unconfigured relays once they have gone unused for a
   * while — typically a contact's inbox relays after a conversation ends.
   * Kept open until then so a follow-up message is not another handshake.
   */
  #scheduleSweep(): void {
    if (this.#sweepTimer || this.#destroyed) return
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = null
      let transient = 0
      for (const [url, socket] of this.#sockets) {
        if (this.#configured().has(url)) continue
        if (this.#isPinned(url)) {
          // Still counted, so the sweep is around to close it once the pin lapses.
          transient += 1
          continue
        }
        const idle = this.#now() - (this.#lastUsed.get(url) ?? 0)
        if (idle >= LINGER_MS && socket.pendingPublishes === 0) {
          socket.close()
          this.#sockets.delete(url)
          this.#pinnedUntil.delete(url)
        } else {
          transient += 1
        }
      }
      if (transient > 0) this.#scheduleSweep()
    }, LINGER_MS / 3)
  }

  #healthFor(url: string): RelayHealth {
    let health = this.#health.get(url)
    if (!health) {
      health = emptyHealth()
      this.#health.set(url, health)
    }
    return health
  }

  /** Coalesced: a burst of socket events becomes one status update. */
  #notify(): void {
    if (this.#destroyed || this.#notifyTimer) return
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null
      if (!this.#destroyed) this.events.emit('statusChanged', this.statuses())
    }, NOTIFY_COALESCE_MS)
  }
}

function connectionState(state: SocketState | undefined): RelayConnectionState {
  switch (state) {
    case 'open':
      return 'online'
    case 'connecting':
      return 'connecting'
    case 'backoff':
    case 'closed':
      return 'offline'
    default:
      return 'idle'
  }
}

/** A bounded set of recently seen ids; the oldest are forgotten first. */
class RecentIds {
  #ids = new Set<string>()
  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.#ids.has(id)
  }

  add(id: string): void {
    this.#ids.add(id)
    if (this.#ids.size > this.capacity) {
      const oldest = this.#ids.values().next().value
      if (oldest !== undefined) this.#ids.delete(oldest)
    }
  }
}

function dedupe(urls: string[]): string[] {
  const out = new Set<string>()
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url)
    if (normalized) out.add(normalized)
  }
  return [...out]
}

/**
 * The relay is up and talking, but declined to serve this subscription.
 *
 * Overwhelmingly NIP-42 (`auth-required: ...`), which several large relays have
 * begun demanding for gift-wrap inbox reads. Textor is anonymous by design and
 * does not authenticate to relays, so such a relay can never deliver mail — the
 * user needs to see that rather than a green tick.
 */
function isSubscriptionRefusal(reason: string): boolean {
  const normalized = reason.toLowerCase()
  return (
    normalized.includes('auth-required') ||
    normalized.includes('restricted') ||
    normalized.includes('blocked') ||
    normalized.includes('not supported')
  )
}
