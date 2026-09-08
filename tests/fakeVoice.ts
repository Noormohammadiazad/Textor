import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import type { IRelayPool, PublishOutcome } from '@/core/transport/relayPool'
import type { VoicePlatform } from '@/core/calls/relayVoice'

/**
 * Relay voice's two seams, faked (ADR-069, ADR-070): relays that pass events
 * to whoever is subscribed on that relay — or refuse them, in the ways
 * measured — and a microphone and speaker a test can talk into and listen to.
 */

interface Subscription {
  filter: Filter
  relays: readonly string[]
  onEvent: (event: NostrEvent, url?: string) => void
}

/**
 * Relays as separate servers. An event reaches a subscription only if it was
 * published to a relay the subscription is held on — which is how one side
 * can send where the other is not listening.
 */
export class FakeVoiceRelays {
  subscriptions = new Set<Subscription>()
  published: { event: NostrEvent; relay: string }[] = []
  /** Relays refusing everything, with the words they use: "rate limited", a web of trust. */
  refusing = new Map<string, string>()
  /** Relays refusing ephemeral kinds only, as one measured blocks the whole range. */
  blockingEphemeral = new Set<string>()
  /** How long each relay says it took to accept an event, where it is slower than usual. */
  acceptMs = new Map<string, number>()
  delayMs = 5

  /** One side's pool: its own read relays, and relays it cannot reach at all. */
  pool(
    read: readonly string[],
    unreachable: readonly string[] = [],
  ): Pick<IRelayPool, 'publish' | 'subscribe' | 'rankedReadRelays'> {
    return {
      rankedReadRelays: () => [...read],
      subscribe: (filter, handlers, relays) => {
        const held = (relays ?? read).filter((url) => !unreachable.includes(url))
        const subscription: Subscription = {
          filter: filter as Filter,
          relays: held,
          onEvent: handlers.onEvent,
        }
        this.subscriptions.add(subscription)
        return { close: () => void this.subscriptions.delete(subscription) }
      },
      publish: async (event, relays = []) => relays.map((url) => this.#take(event, url, unreachable)),
    }
  }

  /** What a relay received, in order. */
  sentTo(relay: string): NostrEvent[] {
    return this.published.filter((entry) => entry.relay === relay).map((entry) => entry.event)
  }

  #take(event: NostrEvent, url: string, unreachable: readonly string[]): PublishOutcome {
    if (unreachable.includes(url)) return { url, ok: false, error: 'could not connect' }
    const refusal = this.refusing.get(url)
    if (refusal) return { url, ok: false, error: refusal }
    if (event.kind !== 1059 && this.blockingEphemeral.has(url)) {
      return { url, ok: false, error: `blocked: Blocked event by ephemeral kind range: ${event.kind}` }
    }
    this.published.push({ event, relay: url })
    setTimeout(() => {
      for (const { filter, relays, onEvent } of [...this.subscriptions]) {
        if (relays.includes(url) && matches(filter, event)) onEvent(event, url)
      }
    }, this.delayMs)
    return { url, ok: true, ms: this.acceptMs.get(url) ?? 5 }
  }
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  const wanted = filter['#p']
  return !wanted || event.tags.some(([name, value]) => name === 'p' && wanted.includes(value!))
}

/** A microphone that says what a test tells it to, and a speaker that remembers what it played. */
export class FakeVoicePlatform implements VoicePlatform {
  isSupported = true
  captureError: Error | null = null
  playerError: Error | null = null
  capturing = false
  played: Uint8Array[] = []
  muted = false
  playersClosed = 0
  #onFrame: ((frame: Uint8Array) => void) | null = null

  async supported(): Promise<boolean> {
    return this.isSupported
  }

  async capture(onFrame: (frame: Uint8Array) => void) {
    if (this.captureError) throw this.captureError
    this.#onFrame = onFrame
    this.capturing = true
    return {
      stop: () => {
        this.capturing = false
        this.#onFrame = null
      },
    }
  }

  player() {
    if (this.playerError) throw this.playerError
    return {
      play: (frames: Uint8Array[]) => void this.played.push(...frames),
      mute: (muted: boolean) => void (this.muted = muted),
      close: () => void (this.playersClosed += 1),
    }
  }

  /** The microphone hears `count` frames of 20 ms, each filled with `byte`. */
  speak(count: number, byte = 1, size = 30): void {
    for (let i = 0; i < count; i++) this.#onFrame?.(new Uint8Array(size).fill(byte))
  }
}
