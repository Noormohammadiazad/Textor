import type { Rumor } from '../crypto/giftwrap'
import type { MessengerEvents } from '../engine/messenger'
import type { AppSettings, Conversation, Message, OutboxItem } from '../models/types'
import type { IRelayPool } from '../transport/relayPool'
import type { VaultRepo } from '../vault/repo'

/**
 * What the forward-secret group runtime needs from the engine that loads it.
 *
 * Types only: the shell imports this file and pays nothing for it, while
 * everything that implements MLS — and everything that turns MLS traffic into
 * stored messages — stays in the lazy chunk behind `import('../mls/runtime')`.
 * The engine lends what it already owns and must not duplicate: the outbox
 * and its retry policy, the events the interface listens to, the rules for
 * forgetting a message and its unread count.
 */
export interface MlsHost {
  readonly pubkey: string
  /** Null once the engine has stopped. */
  secretKey(): Uint8Array | null
  readonly pool: IRelayPool
  readonly repo: VaultRepo
  settings(): AppSettings
  /** Where this person reads their inbox, as best known. */
  relaysOf(pubkey: string): Promise<string[]>
  /** Gift-wrap a rumor to one person through the outbox, retried until it lands. */
  sendRumor(pubkey: string, rumor: Rumor): Promise<void>
  /** Queue an item and start the outbox. */
  enqueue(item: OutboxItem): Promise<void>
  /** An attempt failed: back off and retry, or give up, by the outbox's rules. */
  failItem(item: OutboxItem, error: string): Promise<void>
  emit<K extends keyof MessengerEvents>(name: K, payload: MessengerEvents[K]): void
  /** Delete a message and its payload, leaving a tombstone so no copy brings it back. */
  forget(message: Message): Promise<void>
  /** Take a withdrawn message off the unread count, if it was on it. */
  uncount(message: Message): Promise<void>
  /** Whether the conversation is on screen, so a message arriving in it is read. */
  isViewing(convoId: string): boolean
  /** The root of the thread `replyTo` is in. */
  threadRoot(replyTo: string): Promise<string | null>
  /** Store a reaction by the engine's rules: one per person per message. */
  ingestReaction(conversation: Conversation, rumor: InnerEvent): Promise<void>
  /** Someone's standing with us: whose invitation is taken, and whose is refused. */
  standing(pubkey: string): Promise<'accepted' | 'blocked' | 'unknown'>
}

/** An unsigned Nostr-shaped app event, as it travels inside MLS. */
export interface InnerEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

/** Who can be put in a forward-secret group right now, and who cannot yet. */
export interface Readiness {
  ready: string[]
  missing: string[]
}
