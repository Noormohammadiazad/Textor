import type { Attachment } from './attachment'
import type { CallRecord } from './call'
import type { ChecklistSpec, PollSpec } from './interactive'
import type { LiveState, LocationSpec } from './location'
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
  /** The Textor ID, once worked out. It follows from the key, so nothing says when it was set (ADR-079). */
  textorId?: string
  /** When each part of the profile was last set, on any device; `createdAt` where absent (ADR-077). */
  at?: ProfileStamps
}

export interface ProfileStamps {
  name?: number
  about?: number
  avatar?: number
}

/**
 * The largest picture a profile record holds. NIP-44 pads in steps this large,
 * and the next step up is past the 64 KiB some relays set (ADR-073). The 192px
 * picture Settings makes comes out well below it.
 */
export const MAX_RECORD_AVATAR = 40_800

/** The stamp of a profile not set yet: on a restored identity, anything found beats it, and it is never told. */
export const PROFILE_UNSET = 1

export type VerificationState = 'unverified' | 'verified'

/**
 * How this contact entered the address book. `incoming` means they messaged us
 * first and we have never confirmed who they are, which the UI surfaces as a
 * message request rather than a normal conversation.
 */
export type ContactSource = 'invite' | 'manual' | 'incoming' | 'id'

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
  /** When they last changed that, by their clock: anything older is not taken (ADR-077). */
  profileAt?: number
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
  /** When that was last set, on any device: the latest wins (ADR-073). */
  blockedAt?: number
  /** Their ID, once checked (ADR-079). */
  textorId?: string
  /** What they said it comes from, kept until it can be checked: only for a contact, as that takes a while. */
  idSalt?: string
  /** When this device told them what its own ID comes from. */
  idToldAt?: number
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
  /** When the newest entry was sent, by its author's clock: what the list shows, and sorts by. */
  lastActivity: number
  /**
   * The conversation's causal clock: past every entry it has held (ADR-063).
   * Absent on one from before keys existed, whose clock starts at
   * `lastActivity`.
   */
  clock?: number
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
  /**
   * When its author sent it, by their clock, in UTC epoch ms: what is shown,
   * in the reader's time zone. Only ever read after decryption.
   */
  ts: number
  /**
   * Where it sorts: the conversation's causal clock when it was sent (ADR-063).
   * At least `ts`, and past everything its author had seen in the
   * conversation. Absent on entries stored before it existed, which sort by
   * `ts` — see `orderOf`.
   */
  order?: number
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
  /** A place, or a live location, when the message is one (ADR-064). As sent: a retry rebuilds its rumor from it. */
  location?: LocationSpec
  /**
   * Where a live location is now: the updates that moved it, folded in as
   * they arrive. Written by this device alone; the rumor never changes.
   */
  live?: LiveState
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
   * When each member's copy last moved on, in the member's own time: what
   * "read at 12:40" in the message's details reads from, for a group.
   */
  receiptsAt?: Record<string, number>
  /** When the one person it was sent to said their device had it. */
  deliveredAt?: number
  /** When they said they had read it. */
  readAt?: number
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
  /** Times this has been sent again, unconfirmed, before relays dropped it (ADR-076). */
  renewed?: number
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
  /**
   * Rolling mean time from asking for the inbox to the relay saying it has
   * sent everything it holds (EOSE), in ms. 0 until measured. How quickly a
   * relay hands over mail, which publish latency does not show.
   */
  eoseMs: number
  /** Open connections lost without being asked to close. */
  drops: number
  /**
   * Recency-weighted share, 0-1, of connections lost within minutes of
   * opening. High for a relay that accepts and then sheds connections, which
   * is what rate limiting and an overloaded server look like.
   */
  churn: number
  /**
   * Connections failed in a row, counted only while some other relay was
   * reachable — so a device that is offline does not condemn every relay.
   * Persisted, so a relay that was down last session is not handshaken with
   * eight times at the start of this one (ADR-067).
   */
  connectStreak: number
  /** When the relay last refused to serve the inbox. `readFail` counts refusals since it last did. */
  readFailAt: number
  /** When it last refused an event for its size (ADR-073). */
  largeRefusedAt?: number
}

export interface RelayEntry {
  id: string
  url: string
  read: boolean
  write: boolean
  enabled: boolean
  /** True for relays Textor added in place of one that stopped working, rather than ones the user chose. */
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
  eoseMs: 0,
  drops: 0,
  churn: 0,
  connectStreak: 0,
  readFailAt: 0,
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
   * behind symmetric NAT or a firewall that blocks peer-to-peer traffic. It is
   * brought into a call only once direct paths have failed (ADR-068).
   */
  iceServers: IceServerSetting[]
  /**
   * Route every call through a TURN server, so the other person sees the
   * relay's address rather than this device's. Needs a TURN server in
   * `iceServers`; see ADR-046.
   */
  callRelayOnly: boolean
  /** Days after which we ask relays to drop our gift wraps: one of `MESSAGE_EXPIRY_DAYS`. */
  messageExpirationDays: number
  enterToSend: boolean
  /**
   * Keep a KeyPackage published, so contacts can add this account to a
   * forward-secret group while it is offline. The package is public and
   * signed by this account's key (ADR-049); turning this off withdraws it.
   */
  mlsInvites: boolean
  /**
   * Draw streets under locations from OpenStreetMap's tiles. Off by default:
   * its servers then see this device's address and the areas looked at, which
   * are often where a contact is (ADR-065).
   */
  streetMaps: boolean
  /**
   * Turn off a relay that has been dead for days, or keeps refusing to serve
   * the inbox, and add a working one in its place from the relays contacts use
   * and the ones Textor ships with (ADR-067).
   */
  autoRelays: boolean
}

/**
 * A STUN or TURN server as the user entered it. With `secret`, the credential
 * is a TURN server's shared secret (coturn's `use-auth-secret`), from which a
 * password is made for each call and never stored or sent (ADR-068).
 */
export interface IceServerSetting extends RTCIceServer {
  secret?: true
}

/** Where what each person's client has said it can do is kept: see `TEXTOR_CAPS`. */
export const PEER_CAPS = 'peer-caps'

/** Where `DeviceMarks` are sealed. */
export const DEVICE_MARKS = 'device-marks'

/**
 * What this identity's devices have said about each conversation, by this
 * device's conversation id (ADR-073). Read as messages arrive, which may be
 * before the device sync chunk has loaded.
 */
export interface DeviceMarks {
  /** Entries at or before this key have been read on another device. */
  read: Record<string, number>
  /** Entries at or before this key have been deleted, on any device. */
  cleared: Record<string, number>
}

/**
 * How long relays may be asked to keep a wrap. No longer than the seen table
 * can vouch for (ADR-051), and no longer than a message with no forward secrecy
 * should sit on someone else's disk (ADR-003).
 */
export const MESSAGE_EXPIRY_DAYS: readonly number[] = [7, 30]
export const MAX_MESSAGE_EXPIRY_DAYS = 30

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
  streetMaps: false,
  autoRelays: true,
}
