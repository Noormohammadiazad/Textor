import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '@/core/util/emitter'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import type {
  IRelayPool,
  PublishHandle,
  PublishOutcome,
  ReconcileOutcome,
  RelayPoolEvents,
  RelayStatus,
  SubCloser,
  WakeReason,
} from '@/core/transport/relayPool'
import { NegentropyClient, type NegentropyItem } from '@/core/transport/negentropy'
import { verifyEventSignature } from '@/core/crypto/giftwrap'
import { NegentropyResponder } from './negentropyResponder'

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

  /**
   * Whether the network speaks NIP-77. Most large relays do; a relay that
   * does not is modelled by turning this off.
   */
  negentropy = true
  /** Negentropy exchanges run, and events served by query, for asserting traffic. */
  reconciles = 0
  served = 0

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
    const out = this.events.filter((event) => matches(filter, event))
    this.served += out.length
    return out
  }

  /** A live subscription. `limit: 0` asks for new events only, as NIP-01 defines it. */
  subscribe(filter: Filter, onEvent: (event: NostrEvent) => void): () => void {
    const subscriber = { filter, onEvent }
    this.#subscribers.add(subscriber)
    if (filter.limit !== 0) for (const event of this.query(filter)) onEvent(event)
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
    this.negentropy = true
    this.reconciles = 0
    this.served = 0
  }
}

export function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
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
  /** Wake-ups and pre-warms the engine asked for, for asserting lifecycle wiring. */
  readonly wakes: WakeReason[] = []
  readonly prewarmed: string[][] = []
  epoch = 0

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
    filter: Filter | ((url: string) => Filter),
    handlers: { onEvent: (event: NostrEvent, url?: string) => void; onEose?: (url?: string) => void },
  ): SubCloser {
    // The whole network is one relay, reached under the first read URL.
    const url = this.#read[0] as string
    let reqAt = 0
    let eoseAt = 0
    let unsubscribe = () => {}
    const open = () => {
      unsubscribe()
      reqAt = Date.now()
      eoseAt = 0
      unsubscribe = this.network.subscribe(typeof filter === 'function' ? filter(url) : filter, (event) =>
        handlers.onEvent(event, url),
      )
      this.#unsubscribes.push(() => unsubscribe())
      eoseAt = Date.now()
      handlers.onEose?.(url)
    }
    open()
    return {
      close: () => unsubscribe(),
      progress: (target) =>
        target === url ? { reqAt, eoseAt, open: !this.network.offline, lastRxAt: Date.now() } : null,
      resend: (target) => {
        if (target === url) open()
      },
    }
  }

  async query(filter: Filter): Promise<NostrEvent[]> {
    return this.network.query(filter)
  }

  async reconcile(_url: string, filter: Filter, items: readonly NegentropyItem[]): Promise<ReconcileOutcome> {
    if (this.network.offline) return { ok: false, refused: false, reason: 'not connected' }
    if (!this.network.negentropy) return { ok: false, refused: true, reason: 'unknown command: NEG-OPEN' }
    this.network.reconciles += 1
    const { limit: _limit, ...stored } = filter
    const relay = new NegentropyResponder(this.network.events.filter((event) => matches(stored, event)))
    const client = new NegentropyClient(items)
    const need: string[] = []
    let message: string | null = client.initiate()
    let rounds = 0
    while (message) {
      rounds++
      const step = client.reconcile(relay.reply(message))
      need.push(...step.need)
      message = step.next
    }
    return { ok: true, need, rounds }
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

  dispatch(event: NostrEvent, relays: string[]): PublishHandle {
    const settled = this.publish(event, relays)
    return { quorum: settled, settled }
  }

  rankedWriteRelays(): string[] {
    return [...this.#write]
  }

  rankedReadRelays(): string[] {
    return [...this.#read]
  }

  prewarm(relays: string[]): void {
    this.prewarmed.push([...relays])
  }

  wake(reason: WakeReason): void {
    this.wakes.push(reason)
  }

  destroy(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    this.events.clear()
  }
}
