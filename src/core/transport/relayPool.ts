import { SimplePool, type SubCloser } from 'nostr-tools/pool'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { emptyHealth, type RelayHealth } from '../models/types'
import { normalizeRelayUrl } from './relayUrl'

const log = createLogger('relays')

export type RelayConnectionState = 'idle' | 'connecting' | 'online' | 'offline'

export interface RelayStatus {
  url: string
  state: RelayConnectionState
  health: RelayHealth
}

export type PublishOutcome = { url: string; ok: true; ms: number } | { url: string; ok: false; error: string }

export type RelayPoolEvents = {
  statusChanged: RelayStatus[]
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
  setRelays(read: string[], write: string[]): void
  seedHealth(entries: { url: string; health: RelayHealth }[]): void
  statuses(): RelayStatus[]
  healthSnapshot(): { url: string; health: RelayHealth }[]
  subscribe(
    filter: Filter,
    handlers: { onEvent: (event: NostrEvent, url?: string) => void; onEose?: () => void; label?: string },
    relays?: string[],
  ): SubCloser
  query(filter: Filter, relays?: string[], maxWait?: number): Promise<NostrEvent[]>
  publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]>
  rankedWriteRelays(limit?: number): string[]
  destroy(): void
}

/** How long a publish may take before we call it failed. */
const PUBLISH_TIMEOUT_MS = 12_000

/**
 * Thin, opinionated layer over nostr-tools' SimplePool.
 *
 * SimplePool already handles socket lifecycle, reconnection with backoff, and
 * ping/pong. What it does not do is tell you which relays are worth using, so
 * this adds per-relay health scoring: publish success rate and latency drive
 * the ordering shown in the relay panel, and a relay that fails everything
 * quietly stops being counted as delivery coverage.
 *
 * Failure policy throughout: any single relay may be down at any time. An
 * operation succeeds if *one* relay accepts it. That is the entire reason for
 * publishing to several.
 */
export class RelayPool implements IRelayPool {
  readonly events = new Emitter<RelayPoolEvents>()

  #pool: SimplePool
  #health = new Map<string, RelayHealth>()
  #state = new Map<string, RelayConnectionState>()
  #readUrls: string[] = []
  #writeUrls: string[] = []
  #destroyed = false

  constructor() {
    this.#pool = new SimplePool({ enableReconnect: true, enablePing: true })
    this.#pool.onRelayConnectionSuccess = (url) => {
      const key = normalizeRelayUrl(url) ?? url
      this.#state.set(key, 'online')
      const health = this.#healthFor(key)
      health.connectOk += 1
      health.lastOkAt = Date.now()
      this.#notify()
    }
    this.#pool.onRelayConnectionFailure = (url) => {
      const key = normalizeRelayUrl(url) ?? url
      this.#state.set(key, 'offline')
      const health = this.#healthFor(key)
      health.connectFail += 1
      health.lastErrorAt = Date.now()
      this.#notify()
    }
  }

  get readRelays(): string[] {
    return [...this.#readUrls]
  }

  get writeRelays(): string[] {
    return [...this.#writeUrls]
  }

  /** Replace the configured relay set. Sockets for dropped relays are closed. */
  setRelays(read: string[], write: string[]): void {
    const previous = new Set([...this.#readUrls, ...this.#writeUrls])
    this.#readUrls = dedupe(read)
    this.#writeUrls = dedupe(write)
    const next = new Set([...this.#readUrls, ...this.#writeUrls])

    const removed = [...previous].filter((url) => !next.has(url))
    if (removed.length > 0) this.#pool.close(removed)
    for (const url of removed) {
      this.#state.delete(url)
    }
    for (const url of next) {
      if (!this.#state.has(url)) this.#state.set(url, 'idle')
    }
    this.#notify()
  }

  seedHealth(entries: { url: string; health: RelayHealth }[]): void {
    for (const { url, health } of entries) {
      const key = normalizeRelayUrl(url)
      // Merge onto a full default rather than spreading the stored record
      // directly. A vault written by an earlier build has no `readFail`, and
      // `undefined += 1` is NaN — which silently disables every comparison that
      // depends on it, so the relay keeps reporting itself healthy.
      if (key) this.#health.set(key, { ...emptyHealth(), ...health })
    }
    this.#notify()
  }

  statuses(): RelayStatus[] {
    const urls = new Set([...this.#readUrls, ...this.#writeUrls, ...this.#health.keys()])
    return [...urls].map((url) => ({
      url,
      state: this.#state.get(url) ?? 'idle',
      health: { ...this.#healthFor(url) },
    }))
  }

  healthSnapshot(): { url: string; health: RelayHealth }[] {
    return [...this.#health.entries()].map(([url, health]) => ({ url, health: { ...health } }))
  }

  get onlineCount(): number {
    let count = 0
    for (const url of new Set([...this.#readUrls, ...this.#writeUrls])) {
      if (this.#state.get(url) === 'online') count += 1
    }
    return count
  }

  /**
   * Long-lived subscription across all read relays.
   *
   * Duplicate events across relays are expected and normal; dedup is the
   * caller's job because only the caller knows what it has already stored.
   *
   * Deliberately one subscription per relay rather than one pooled
   * subscription: SimplePool's pooled `onclose` fires only once *every* relay
   * has closed, so a single relay refusing the subscription — which is what
   * NIP-42 `auth-required` looks like — stays invisible while the others remain
   * open. That is exactly the failure the relay panel exists to report, because
   * such a relay connects, accepts publishes, and quietly delivers no mail.
   * Fanning out also gives exact attribution for received events instead of
   * inferring it from the pool's `seenOn` map.
   */
  subscribe(
    filter: Filter,
    handlers: { onEvent: (event: NostrEvent, url?: string) => void; onEose?: () => void; label?: string },
    relays?: string[],
  ): SubCloser {
    const targets = relays ? dedupe(relays) : this.#readUrls
    if (targets.length === 0) {
      log.warn('subscribe called with no read relays')
      return { close: () => undefined }
    }

    const closers = targets.map((url) =>
      this.#pool.subscribe([url], filter, {
        label: handlers.label ?? 'textor',
        onevent: (event) => {
          this.#healthFor(url).eventsReceived += 1
          handlers.onEvent(event, url)
        },
        oneose: handlers.onEose,
        onclose: (reasons) => {
          for (const { reason } of reasons) {
            // A subscription we closed ourselves is not a relay fault.
            // Recording it would paint every healthy relay with an error.
            if (isSelfInitiatedClose(reason)) continue
            const health = this.#healthFor(url)
            health.lastErrorAt = Date.now()
            health.lastError = reason.slice(0, 160)
            if (isSubscriptionRefusal(reason)) {
              // Up and talking, but it will never hand us our inbox.
              health.readFail += 1
              health.lastReadError = reason.slice(0, 160)
            } else {
              this.#state.set(url, 'offline')
            }
          }
          this.#notify()
        },
      }),
    )

    return {
      close: (reason?: string) => {
        for (const closer of closers) closer.close(reason)
      },
    }
  }

  /** One-shot query that resolves at EOSE across the given relays. */
  async query(filter: Filter, relays?: string[], maxWait = 6000): Promise<NostrEvent[]> {
    const targets = relays ? dedupe(relays) : this.#readUrls
    if (targets.length === 0) return []
    try {
      return await this.#pool.querySync(targets, filter, { maxWait })
    } catch (err) {
      log.warn('query failed', err)
      return []
    }
  }

  /**
   * Publish to every write relay and report each outcome.
   *
   * Deliberately never rejects: partial delivery is the normal case, and the
   * caller decides how many acks are enough.
   */
  async publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]> {
    const targets = dedupe(relays ?? this.#writeUrls)
    if (targets.length === 0) return []

    const started = Date.now()
    const results = await Promise.all(
      this.#pool.publish(targets, event, { maxWait: PUBLISH_TIMEOUT_MS }).map(async (promise, index) => {
        const url = targets[index] as string
        try {
          await promise
          const ms = Date.now() - started
          const health = this.#healthFor(url)
          health.publishOk += 1
          health.lastOkAt = Date.now()
          // Exponential moving average keeps recent behaviour dominant without
          // storing a latency history.
          health.latencyMs = health.latencyMs === 0 ? ms : Math.round(health.latencyMs * 0.7 + ms * 0.3)
          this.#state.set(url, 'online')
          return { url, ok: true, ms } as const
        } catch (err) {
          const health = this.#healthFor(url)
          health.publishFail += 1
          health.lastErrorAt = Date.now()
          health.lastError = errorMessage(err).slice(0, 160)
          return { url, ok: false, error: errorMessage(err) } as const
        }
      }),
    )
    this.#notify()
    return results
  }

  /** Relays ordered best-first: healthy and fast ahead of flaky and slow. */
  rankedWriteRelays(limit = 8): string[] {
    return [...this.#writeUrls]
      .map((url) => ({ url, score: this.#score(url) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.url)
  }

  #score(url: string): number {
    const h = this.#healthFor(url)
    const attempts = h.publishOk + h.publishFail
    // Unproven relays start mid-pack so they get a chance to prove themselves.
    const successRate = attempts === 0 ? 0.5 : h.publishOk / attempts
    const latencyPenalty = h.latencyMs === 0 ? 0 : Math.min(0.4, h.latencyMs / 20_000)
    const onlineBonus = this.#state.get(url) === 'online' ? 0.2 : 0
    return successRate - latencyPenalty + onlineBonus
  }

  #healthFor(url: string): RelayHealth {
    let health = this.#health.get(url)
    if (!health) {
      health = emptyHealth()
      this.#health.set(url, health)
    }
    return health
  }

  #notify(): void {
    if (this.#destroyed) return
    this.events.emit('statusChanged', this.statuses())
  }

  destroy(): void {
    this.#destroyed = true
    try {
      this.#pool.destroy()
    } catch (err) {
      log.warn('pool destroy failed', err)
    }
    this.events.clear()
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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Close reasons that mean "we asked for this", not "the relay failed". */
function isSelfInitiatedClose(reason: string): boolean {
  const normalized = reason.toLowerCase()
  return normalized.includes('closed by caller') || normalized.includes('relay connection closed')
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
