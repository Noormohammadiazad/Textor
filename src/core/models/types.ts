import type { Attachment } from './attachment'
import type { CallRecord } from './call'
import type { ChecklistSpec, PollSpec } from './interactive'
import type { MessageDirection, MessageStatus } from '../vault/db'

export type { MessageDirection, MessageStatus }

/** Decrypted body of the `identity` row. */
export interface IdentityRecord {
  pubkey: string
  npub: string
  secretKeyHex: string
  name: string
  about: string
  avatar?: string
  createdAt: number
  /** Set once the user confirms they wrote the recovery phrase down. */
  mnemonicBackedUp: boolean
  /** Kept so the phrase can be shown again from Settings behind a passphrase prompt. */
  mnemonic?: string
}

export type VerificationState = 'unverified' | 'verified'

/**
 * How this contact entered the address book. `incoming` means they messaged us
 * first and we have never confirmed who they are, which the UI surfaces as a
 * message request rather than a normal conversation.
 */
export type ContactSource = 'invite' | 'manual' | 'incoming'

export interface Contact {
  /** Blinded primary key. */
  id: string
  pubkey: string
  npub: string
  /** Name the user set locally; wins over anything the peer sends. */
  name: string
  /** Name the peer last told us. */
  remoteName?: string
  about?: string
  avatar?: string
  /** Where this contact reads their inbox. */
  relays: string[]
  verification: VerificationState
  source: ContactSource
  /** False until the user accepts an unsolicited first message. */
  accepted: boolean
  note?: string
  addedAt: number
  lastSeenAt: number
  blocked: boolean
}

/**
 * Where a message goes: a person, by public key (64 hex characters), or a
 * group, by its conversation id (32 hex characters).
 *
 * One string rather than a union so a route, a store action and an engine call
 * can all carry it unchanged; the two forms cannot be confused because they
 * are different lengths. A group has no public identifier of its own — NIP-17
 * defines it only as a set of people — so its local, vault-blinded
 * conversation id is the only handle there is, and it means nothing off this
 * device.
 */
export type ChatAddress = string

export const isGroupAddress = (address: string): boolean => /^[0-9a-f]{32}$/.test(address)

export type ConversationKind = 'direct' | 'group'

export interface Conversation {
  id: string
  kind: ConversationKind
  /** The other person in a direct conversation. Empty for a group. */
  peerPubkey: string
  /**
   * Everyone taking part except this identity, sorted. One entry for a direct
   * conversation. Fixed for the life of the conversation: under NIP-17 a
   * different set of people is, by definition, a different conversation.
   */
  members: string[]
  /** A group's name (NIP-17 `subject`). */
  subject?: string
  /** When `subject` was set, so a delayed older message cannot rename the group back. */
  subjectAt?: number
  /**
   * Whether the user has taken this conversation. Always true for a direct
   * one, where acceptance lives on the contact; false for a group someone
   * outside the address book started, which is shown as a request.
   */
  accepted: boolean
  lastActivity: number
  unread: number
  pinned: boolean
  /** Unsent text, kept so switching conversations does not lose a half-typed message. */
  draft?: string
  /**
   * Set for a forward-secret group — an MLS group in Marmot's shape — which
   * unlike a small group has a membership that changes, admins who change
   * it, and keys that move on with every change (ADR-049).
   */
  mls?: MlsConversation
}

export interface MlsConversation {
  /** The group's Nostr routing id: the `h` tag of its messages, hex. */
  group: string
  admins: string[]
  epoch: number
  /**
   * Code everyone in the same epoch shares (RFC 9420's epoch authenticator,
   * shortened): compared out of band, it shows nobody sees a different group.
   */
  code: string
  /** When this device's own keys in the group were last refreshed, unix seconds. */
  refreshedAt: number
  /** No longer in the group — removed, left, or restored from a backup. The history stays. */
  left?: boolean
}

export interface Message {
  /** Rumor id — identical on both peers, which makes receipts and dedup trivial. */
  id: string
  convoId: string
  direction: MessageDirection
  status: MessageStatus
  /** Exact epoch ms. Only ever read after decryption. */
  ts: number
  /** Hour-truncated epoch ms, mirrored into the row index. */
  tsCoarse: number
  body: string
  authorPubkey: string
  replyTo?: string
  /**
   * The message that started the thread this one belongs to (NIP-10 `root`).
   *
   * Stored alongside the parent so a thread can be grouped without decrypting
   * and walking every message between the two.
   */
  rootId?: string
  /**
   * Attachment descriptor, when the message carries a payload.
   *
   * Lives in the sealed body alongside the text, so the key it contains is at
   * rest under the vault key and in flight under NIP-44 — never in an index.
   */
  attachment?: Attachment
  /** A poll, when the message is one. */
  poll?: PollSpec
  /** A shared checklist, when the message is one. */
  checklist?: ChecklistSpec
  /**
   * A call, when this entry records one rather than a message.
   *
   * Written by this device alone and never sent — see `CallRecord`. Its id is
   * the rumor id of the offer that opened the call, which is also what keeps a
   * replayed offer from being recorded twice, and what lets either person in
   * the call withdraw it from both conversations.
   */
  call?: CallRecord
  /**
   * Delivery per member, for a message we sent to a group.
   *
   * Each member gets their own wrap, reaches the relays on their own, and
   * acknowledges on their own, so "sent" and "read" only mean something per
   * person. `status` is the least advanced of these — a message shows as read
   * when everyone has read it — and this is where "read by 2 of 5" comes from.
   */
  receipts?: Record<string, MessageStatus>
  /**
   * The group name this message carried, kept so a retry rebuilds the rumor
   * exactly — and therefore with the same id — even if the group has been
   * renamed since.
   */
  subject?: string
  /** Which path actually carried it — surfaced in the UI. */
  via?: 'relay' | 'direct'
  /** Number of relays that acknowledged the publish. */
  relayAcks?: number
  error?: string
}

/** Decrypted body of an `outbox` row: everything needed to retry a send. */
export interface OutboxItem {
  id: string
  convoId: string
  /** The recipient of a direct item. Empty for a group item; see `recipients`. */
  peerPubkey: string
  /**
   * Who is still owed this item. One rumor, one wrap each: when some members'
   * wraps reach the relays and others do not, the retry goes to the ones still
   * listed here and nobody receives it twice. Absent on items written before
   * groups existed, which were always for `peerPubkey` alone.
   */
  recipients?: string[]
  /** The rumor, serialised, so retries reuse the same id and stay idempotent. */
  rumorJson: string
  /** Relay hints captured at compose time. */
  relays: string[]
  attempts: number
  nextAttemptAt: number
  createdAt: number
  /** Control frames are fire-and-forget; chat messages are not. */
  ephemeral: boolean
  lastError?: string
  /**
   * An app event for a forward-secret group: `rumorJson` is encrypted to the
   * group with MLS on each attempt and published to the group's relays,
   * rather than gift-wrapped to anyone.
   */
  mls?: boolean
}

/**
 * One reaction to one message.
 *
 * Carried as a sealed NIP-25 kind 7 rumor, so it is invisible to relays — a
 * public reaction would publish the conversation graph this app exists to
 * hide. See ADR-040.
 */
export interface Reaction {
  /** Rumor id of the reaction itself, and the handle used to withdraw it. */
  id: string
  /** Rumor id of the message reacted to. */
  messageId: string
  convoId: string
  authorPubkey: string
  /** A literal emoji, or NIP-25's `+`/`-`. */
  emoji: string
  ts: number
}

/**
 * One sticker: an image held in the encrypted blob store, addressed exactly
 * like an attachment payload so the same chunking, sealing and reading code
 * serves both.
 */
export interface Sticker {
  /** SHA-256 of the plaintext image, hex — the blob store's key. */
  id: string
  key: string
  salt: string
  size: number
  chunks: number
  mime: string
  width?: number
  height?: number
}

/**
 * A pack of stickers, held in this vault.
 *
 * Packs are local: the images live in the blob store as encrypted chunks, and
 * sending one to somebody sends it as an ordinary attachment. Nothing is
 * fetched from a host — NIP-30's remote image URLs cannot be rendered under a
 * policy that forbids remote images, and would be a tracking pixel if they
 * could. See ADR-042.
 */
export interface StickerPack {
  id: string
  name: string
  createdAt: number
  stickers: Sticker[]
}

export interface RelayHealth {
  connectOk: number
  connectFail: number
  publishOk: number
  publishFail: number
  /**
   * Subscriptions the relay refused — most often NIP-42 `auth-required`.
   *
   * Tracked apart from publish failures because the two fail independently and
   * mean different things: a relay can happily accept everything you send while
   * refusing to hand you your own inbox, which looks perfectly healthy from
   * write statistics alone and delivers you nothing.
   */
  readFail: number
  lastReadError?: string
  lastOkAt: number
  lastErrorAt: number
  lastError?: string
  /** Rolling mean publish latency in ms. */
  latencyMs: number
  eventsReceived: number
  /**
   * Recency-weighted publish success, 0-1.
   *
   * The lifetime counters above cannot tell a relay that failed last year from
   * one that failed a minute ago: a relay with two hundred good publishes that
   * has just run out of disk still reads as 98% reliable. This decays, so a
   * relay that breaks drops down the ranking within a few messages and one
   * that recovers climbs back just as quickly.
   */
  reliability: number
  /** Publishes failed in a row since the last success. Drives the circuit breaker. */
  failStreak: number
  /** Rolling mean time for a socket to open, in ms. 0 until measured. */
  connectMs: number
}

export interface RelayEntry {
  id: string
  url: string
  read: boolean
  write: boolean
  enabled: boolean
  /** True for relays discovered from a contact rather than chosen by the user. */
  discovered: boolean
  health: RelayHealth
}

export const emptyHealth = (): RelayHealth => ({
  connectOk: 0,
  connectFail: 0,
  publishOk: 0,
  publishFail: 0,
  readFail: 0,
  lastOkAt: 0,
  lastErrorAt: 0,
  latencyMs: 0,
  eventsReceived: 0,
  reliability: 0.5,
  failStreak: 0,
  connectMs: 0,
})

export type RetentionPolicy = 'forever' | '90d' | '30d' | '7d' | 'session'
export type ThemePreference = 'system' | 'light' | 'dark'
export type LocaleCode = 'en' | 'fa'

export interface AppSettings {
  locale: LocaleCode
  theme: ThemePreference
  /** Minutes of inactivity before the vault re-locks. 0 disables the timer. */
  autoLockMinutes: number
  lockOnHide: boolean
  retention: RetentionPolicy
  sendReadReceipts: boolean
  sendTypingIndicators: boolean
  enableDirectConnection: boolean
  /** Publish a public kind-0 profile. Off by default: it is a metadata leak. */
  publishPublicProfile: boolean
  notificationsEnabled: boolean
  /**
   * User-supplied STUN and TURN servers, tried after the public STUN
   * defaults. A TURN server is what lets a call connect when both people are
   * behind symmetric NAT or a firewall that blocks peer-to-peer traffic.
   */
  iceServers: RTCIceServer[]
  /**
   * Route every call through a TURN server, so the other person sees the
   * relay's address rather than this device's. Needs a TURN server in
   * `iceServers`; see ADR-046.
   */
  callRelayOnly: boolean
  /** Days after which we ask relays to drop our gift wraps. */
  messageExpirationDays: number
  enterToSend: boolean
  /**
   * Keep a KeyPackage published, so contacts can add this account to a
   * forward-secret group while it is offline. The package is public and
   * signed by this account's key (ADR-049); turning this off withdraws it.
   */
  mlsInvites: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'en',
  theme: 'system',
  autoLockMinutes: 15,
  lockOnHide: false,
  retention: 'forever',
  sendReadReceipts: true,
  sendTypingIndicators: true,
  enableDirectConnection: true,
  publishPublicProfile: false,
  notificationsEnabled: false,
  iceServers: [],
  callRelayOnly: false,
  messageExpirationDays: 30,
  enterToSend: true,
  mlsInvites: true,
}
