import type { Attachment } from './attachment'
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

export interface Conversation {
  id: string
  peerPubkey: string
  lastActivity: number
  unread: number
  pinned: boolean
  /** Unsent text, kept so switching conversations does not lose a half-typed message. */
  draft?: string
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
   * Attachment descriptor, when the message carries a payload.
   *
   * Lives in the sealed body alongside the text, so the key it contains is at
   * rest under the vault key and in flight under NIP-44 — never in an index.
   */
  attachment?: Attachment
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
  peerPubkey: string
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
  /** User-supplied TURN servers, for people behind symmetric NAT. */
  iceServers: RTCIceServer[]
  /** Days after which we ask relays to drop our gift wraps. */
  messageExpirationDays: number
  enterToSend: boolean
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
  messageExpirationDays: 30,
  enterToSend: true,
}
