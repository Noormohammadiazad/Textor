import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import type { SubCloser } from 'nostr-tools/pool'
import { Emitter } from '@/core/util/emitter'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import type { IRelayPool, PublishOutcome, RelayPoolEvents, RelayStatus } from '@/core/transport/relayPool'
import { verifyEventSignature } from '@/core/crypto/giftwrap'

/**
 * A shared, in-memory stand-in for the public relay network.
 *
 * It behaves the way a real relay does in the ways that matter for the engine:
 * it stores signed events, serves them to matching filters, replays history to
 * new subscribers, and delivers the same event to every subscriber (so dedup
 * gets exercised). It rejects unsigned events, because a real relay does.
 */
export class FakeRelayNetwork {
  readonly events: NostrEvent[] = []
  #subscribers = new Set<{ filter: Filter; onEvent: (event: NostrEvent) => void }>()

  /** Set to make every publish fail, simulating being offline. */
  offline = false
  /** Number of publish calls, for asserting traffic volume. */
  publishCount = 0
  /**
   * Fraction of accepted events silently dropped instead of stored.
   *
   * A real relay does this constantly and without telling anyone: it may be
   * restarting, rate-limiting, or refusing an event it considers too large.
   * The publish still *succeeds* from the client's point of view, which is
   * exactly what makes the failure hard to notice and worth testing.
   */
  dropRate = 0
  /** Events accepted from a publisher but never stored or delivered. */
  droppedCount = 0

  setDropRate(rate: number): void {
    this.dropRate = Math.min(1, Math.max(0, rate))
  }

  /**
   * Refuse events above a size, silently.
   *
   * This is the real failure that made attachments undeliverable: public relays
   * cap event size around 64 KiB, and an oversized gift wrap is accepted by the
   * client's publish call and then dropped. Modelling it by size rather than at
   * random reproduces it exactly — the small chat message gets through while
   * every chunk vanishes.
   */
  maxEventBytes = Infinity

  publish(event: NostrEvent): void {
    this.publishCount += 1
    if (this.offline) throw new Error('network is offline')
    if (!verifyEventSignature(event)) throw new Error('invalid signature')
    // Accepted, acknowledged, and thrown away — the silent failure mode.
    if (JSON.stringify(event).length > this.maxEventBytes) {
      this.droppedCount += 1
      return
    }
    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      this.droppedCount += 1
      return
    }
    if (this.events.some((existing) => existing.id === event.id)) return
    this.events.push(event)
    for (const subscriber of this.#subscribers) {
      if (matches(subscriber.filter, event)) subscriber.onEvent(event)
    }
  }

  query(filter: Filter): NostrEvent[] {
    return this.events.filter((event) => matches(filter, event))
  }

  subscribe(filter: Filter, onEvent: (event: NostrEvent) => void): () => void {
    const subscriber = { filter, onEvent }
    this.#subscribers.add(subscriber)
    for (const event of this.query(filter)) onEvent(event)
    return () => this.#subscribers.delete(subscriber)
  }

  reset(): void {
    this.events.length = 0
    this.#subscribers.clear()
    this.offline = false
    this.publishCount = 0
    this.dropRate = 0
    this.droppedCount = 0
    this.maxEventBytes = Infinity
  }
}

export function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  for (const [key, raw] of Object.entries(filter as Record<string, unknown>)) {
    if (!key.startsWith('#') || !Array.isArray(raw)) continue
    const values = raw as string[]
    const tagName = key.slice(1)
    const present = event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1] as string))
    if (!present) return false
  }
  return true
}

/** One client's view of the shared network, satisfying the engine's interface. */
export class FakeRelayPool implements IRelayPool {
  readonly events = new Emitter<RelayPoolEvents>()
  #read: string[] = []
  #write: string[] = []
  #unsubscribes: (() => void)[] = []

  constructor(
    private readonly network: FakeRelayNetwork,
    private readonly url = 'wss://fake.relay',
  ) {
    this.#read = [url]
    this.#write = [url]
  }

  get readRelays(): string[] {
    return [...this.#read]
  }
  get writeRelays(): string[] {
    return [...this.#write]
  }
  get onlineCount(): number {
    return this.network.offline ? 0 : this.#read.length
  }

  setRelays(read: string[], write: string[]): void {
    this.#read = read.length > 0 ? read : [this.url]
    this.#write = write.length > 0 ? write : [this.url]
  }
  seedHealth(): void {}
  statuses(): RelayStatus[] {
    return this.#read.map((url) => ({ url, state: 'online', health: emptyHealth() }))
  }
  healthSnapshot(): { url: string; health: RelayHealth }[] {
    return []
  }

  subscribe(
    filter: Filter,
    handlers: { onEvent: (event: NostrEvent) => void; onEose?: () => void },
  ): SubCloser {
    const unsubscribe = this.network.subscribe(filter, handlers.onEvent)
    this.#unsubscribes.push(unsubscribe)
    handlers.onEose?.()
    return { close: unsubscribe }
  }

  async query(filter: Filter): Promise<NostrEvent[]> {
    return this.network.query(filter)
  }

  async publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]> {
    const targets = relays && relays.length > 0 ? relays : this.#write
    try {
      this.network.publish(event)
      return targets.map((url) => ({ url, ok: true as const, ms: 1 }))
    } catch (err) {
      return targets.map((url) => ({
        url,
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  rankedWriteRelays(): string[] {
    return [...this.#write]
  }

  destroy(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    this.events.clear()
  }
}
