import { finalizeEvent } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { SubCloser } from 'nostr-tools/pool'
import { createLogger } from '../util/log'
import { nowSec } from '../util/time'
import { KIND_GIFT_WRAP } from '../crypto/giftwrap'
import { normalizeRelayList } from './relayUrl'
import type { IRelayPool, PublishOutcome } from './relayPool'

const log = createLogger('nostr')

/** NIP-17: a replaceable event listing where a user reads their DM inbox. */
export const KIND_DM_RELAY_LIST = 10050
/** NIP-01 metadata. Only published when the user opts into a public profile. */
export const KIND_METADATA = 0

/**
 * The rewind applied when resubscribing.
 *
 * Gift wraps carry a timestamp randomised up to two days into the past, so a
 * subscription anchored at "when I last synced" would miss anything whose fuzz
 * pushed it behind that mark. Three days of overlap costs a little redundant
 * traffic and guarantees nothing is skipped; dedup makes the overlap free.
 */
export const SYNC_REWIND_SEC = 3 * 24 * 60 * 60

export interface PublicProfile {
  name?: string
  about?: string
  picture?: string
}

/**
 * Nostr-specific operations: everything that knows about event kinds, filters,
 * and NIP semantics lives here, so the relay pool below stays a dumb transport
 * and the engine above stays protocol-agnostic.
 */
export class NostrTransport {
  constructor(private readonly pool: IRelayPool) {}

  /**
   * Subscribe to our inbox.
   *
   * The filter is the narrowest thing a relay can serve: gift wraps p-tagged to
   * us. It reveals which pubkey is fetching, which is unavoidable — someone has
   * to ask for the mail — but never who sent anything, because the wrap's
   * author is a single-use ephemeral key.
   */
  subscribeInbox(
    myPubkey: string,
    sinceSec: number,
    onWrap: (wrap: NostrEvent) => void,
    relays?: string[],
  ): SubCloser {
    const since = Math.max(0, sinceSec - SYNC_REWIND_SEC)
    log.info(`subscribing to inbox since ${since}`)
    return this.pool.subscribe(
      { kinds: [KIND_GIFT_WRAP], '#p': [myPubkey], since },
      { onEvent: onWrap, label: 'inbox' },
      relays,
    )
  }

  /** Catch-up read used on unlock and on regaining connectivity. */
  async fetchInbox(myPubkey: string, sinceSec: number, relays?: string[]): Promise<NostrEvent[]> {
    return this.pool.query(
      { kinds: [KIND_GIFT_WRAP], '#p': [myPubkey], since: Math.max(0, sinceSec - SYNC_REWIND_SEC) },
      relays,
      8000,
    )
  }

  async publishWrap(wrap: NostrEvent, relays: string[]): Promise<PublishOutcome[]> {
    return this.pool.publish(wrap, relays)
  }

  /**
   * Announce where we read our inbox (NIP-17 kind 10050).
   *
   * Without this, a sender can only guess which relays we watch, and delivery
   * degrades to "hope we happen to share one". This event is public and
   * unencrypted by design — it is an address, not a message — so it lists only
   * relay URLs and nothing else.
   */
  async publishInboxRelays(secretKey: Uint8Array, relays: string[]): Promise<PublishOutcome[]> {
    const urls = normalizeRelayList(relays, 6)
    if (urls.length === 0) return []
    const event = finalizeEvent(
      {
        kind: KIND_DM_RELAY_LIST,
        created_at: nowSec(),
        tags: urls.map((url) => ['relay', url]),
        content: '',
      },
      secretKey,
    )
    return this.pool.publish(event, this.pool.rankedWriteRelays())
  }

  /** Look up a peer's inbox relays so our wraps land where they will see them. */
  async fetchInboxRelays(pubkey: string, relays?: string[]): Promise<string[]> {
    const events = await this.pool.query({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey], limit: 1 }, relays)
    const newest = pickNewest(events)
    if (!newest) return []
    return normalizeRelayList(
      newest.tags.filter((tag) => tag[0] === 'relay' && tag[1]).map((tag) => tag[1] as string),
      6,
    )
  }

  /** Opt-in public profile. Off by default: publishing one links key to name. */
  async publishProfile(secretKey: Uint8Array, profile: PublicProfile): Promise<PublishOutcome[]> {
    const event = finalizeEvent(
      { kind: KIND_METADATA, created_at: nowSec(), tags: [], content: JSON.stringify(profile) },
      secretKey,
    )
    return this.pool.publish(event, this.pool.rankedWriteRelays())
  }

  async fetchProfile(pubkey: string, relays?: string[]): Promise<PublicProfile | null> {
    const events = await this.pool.query({ kinds: [KIND_METADATA], authors: [pubkey], limit: 1 }, relays)
    const newest = pickNewest(events)
    if (!newest) return null
    try {
      const parsed: unknown = JSON.parse(newest.content)
      if (typeof parsed !== 'object' || parsed === null) return null
      const { name, about, picture } = parsed as Record<string, unknown>
      return {
        name: typeof name === 'string' ? name.slice(0, 128) : undefined,
        about: typeof about === 'string' ? about.slice(0, 512) : undefined,
        // Remote URLs are never fetched by the app (the CSP forbids it); only
        // inline data: images are rendered.
        picture: typeof picture === 'string' && picture.startsWith('data:image/') ? picture : undefined,
      }
    } catch {
      return null
    }
  }
}

/**
 * Replaceable events should be unique per author, but relays disagree during
 * propagation and a malicious one can serve a stale copy. Always take the
 * newest of whatever came back.
 */
function pickNewest(events: NostrEvent[]): NostrEvent | null {
  let best: NostrEvent | null = null
  for (const event of events) {
    if (!best || event.created_at > best.created_at) best = event
  }
  return best
}
