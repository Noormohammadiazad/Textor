import Dexie, { type EntityTable } from 'dexie'

/**
 * IndexedDB schema.
 *
 * Everything that could identify a person or reveal a message lives inside the
 * `enc` blob of its row. What remains outside is deliberately chosen to be
 * uninformative to someone who copies the database off a locked device:
 *
 *  - primary keys are HMAC-blinded (see crypto/vaultCrypto.ts), so they are
 *    stable lookup handles that mean nothing without the vault key;
 *  - `tsCoarse` is truncated to the hour, enough to page a conversation in
 *    chronological order, not enough to reconstruct an activity timeline;
 *  - `dir` and `status` are small enums whose only leak is message counts.
 *
 * The one plaintext table is `meta`, which holds the keyslots: for each way
 * the vault opens, its kind, salt or credential id, and the data key sealed
 * under it (ADR-054). Those must be readable before unlocking, and none of them
 * reveal anything on their own beyond which kinds of unlock are set up.
 */

export interface MetaRow {
  k: string
  v: unknown
}

export interface EncryptedRow {
  id: string
  enc: Uint8Array
}

export interface ContactRow extends EncryptedRow {
  addedAt: number
  lastSeenAt: number
  /** 0/1 rather than boolean: IndexedDB cannot index booleans. */
  blocked: number
}

export interface ConversationRow extends EncryptedRow {
  lastActivity: number
  unread: number
  pinned: number
}

export type MessageDirection = 'in' | 'out'
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface MessageRow extends EncryptedRow {
  /** Blinded conversation id. */
  convoId: string
  /** Hour-truncated epoch ms; exact time lives in `enc`. */
  tsCoarse: number
  dir: MessageDirection
  status: MessageStatus
}

export interface OutboxRow extends EncryptedRow {
  convoId: string
  attempts: number
  nextAttemptAt: number
  createdAt: number
}

export interface SeenRow {
  /** Blinded relay event id. */
  id: string
  /**
   * Hour-truncated epoch ms: the event's own `created_at` for a delivery mark,
   * when it was made for a tombstone. Rows written before sync marks existed
   * hold the exact arrival time instead. Pruning reads nothing else.
   */
  ts: number
  /**
   * For an inbox gift wrap: its real id and `created_at`, sealed, so a
   * negentropy reconciliation can tell a relay what this device already holds
   * without the blinded key giving it away.
   */
  enc?: Uint8Array
}

export interface RelayRow extends EncryptedRow {
  /** Blinded relay url. */
  id: string
  enabled: number
}

export interface SettingRow extends EncryptedRow {
  id: string
}

/**
 * Manifest for one sealed copy of an attachment payload, inbound or outbound.
 *
 * The counters are in the clear: they say that *an* attachment of some size
 * exists, which the ciphertext length already reveals, and nothing about which
 * conversation it belongs to or what is in it. The payload itself lives in
 * `blobChunks` as ciphertext under a key that exists only inside the sealed
 * message row, and the primary key here is blinded.
 */
export interface BlobRow {
  /** Blinded blob id and copy (ADR-052). */
  id: string
  /**
   * Sealed `{ id, copy }`: which payload and copy this is, for serving a
   * request that names only the payload. Absent from rows written before
   * ADR-052, which is how the one-time migration finds them.
   */
  enc?: Uint8Array
  /** Total chunks in the complete payload. */
  total: number
  /** Plaintext byte length. */
  size: number
  /** Chunks currently stored. */
  received: number
  /** 1 once every chunk is present. Indexed, so sweeps can skip finished rows. */
  complete: number
  /** 1 for payloads we are sending, 0 for payloads we are receiving. */
  outgoing: number
  updatedAt: number
}

/**
 * One encrypted chunk.
 *
 * A row per chunk rather than one row holding an array: rewriting a whole
 * multi-megabyte record on every arriving chunk turns a transfer into O(n^2)
 * of IndexedDB writes, which is slow enough to be felt on a phone.
 */
export interface BlobChunkRow {
  /** `<blinded blob id>:<seq>`. */
  id: string
  /** Blinded blob id, indexed so a payload's chunks can be read or dropped together. */
  blob: string
  seq: number
  /** Chunk ciphertext, exactly as it travelled. */
  data: Uint8Array
}

/**
 * One reaction to one message.
 *
 * A row of its own rather than a field on the message: a reaction is written
 * by the other side, arrives long after the message, and rewriting the sealed
 * message record on every thumbs-up would race with delivery-status updates to
 * the same row.
 */
export interface ReactionRow extends EncryptedRow {
  /** Rumor id of the message reacted to. */
  messageId: string
  /** Blinded conversation id, so a conversation's reactions drop together. */
  convoId: string
}

/** A sticker pack's manifest. The images themselves live in `blobs`. */
export interface PackRow extends EncryptedRow {
  createdAt: number
}

/**
 * One vote or checklist change, sealed like a reaction and for the same
 * reasons: written by other people, arriving long after the message it
 * applies to, and never folded into the sealed message row, where it would
 * race delivery-status updates. The result is counted at render time.
 */
export interface UpdateRow extends EncryptedRow {
  /** Rumor id of the poll or checklist. */
  targetId: string
  /** Blinded conversation id, so a conversation's updates drop together. */
  convoId: string
}

/**
 * One forward-secret group's MLS state, or one of our KeyPackages' private
 * keys. Sealed whole, keyed by a blinded id: the table reveals how many
 * groups and packages there are, and nothing about them. Overwritten as
 * epochs advance, which is what forward secrecy asks of storage — within what
 * IndexedDB lets an app control (THREAT-MODEL §3.1).
 */
export type MlsRow = EncryptedRow

export class TextorDatabase extends Dexie {
  meta!: EntityTable<MetaRow, 'k'>
  identity!: EntityTable<EncryptedRow, 'id'>
  contacts!: EntityTable<ContactRow, 'id'>
  conversations!: EntityTable<ConversationRow, 'id'>
  messages!: EntityTable<MessageRow, 'id'>
  outbox!: EntityTable<OutboxRow, 'id'>
  seen!: EntityTable<SeenRow, 'id'>
  relays!: EntityTable<RelayRow, 'id'>
  settings!: EntityTable<SettingRow, 'id'>
  blobs!: EntityTable<BlobRow, 'id'>
  blobChunks!: EntityTable<BlobChunkRow, 'id'>
  reactions!: EntityTable<ReactionRow, 'id'>
  packs!: EntityTable<PackRow, 'id'>
  updates!: EntityTable<UpdateRow, 'id'>
  mlsGroups!: EntityTable<MlsRow, 'id'>
  mlsKeys!: EntityTable<MlsRow, 'id'>

  constructor(name = 'textor') {
    super(name)
    this.version(1).stores({
      meta: 'k',
      identity: 'id',
      contacts: 'id, addedAt, lastSeenAt, blocked',
      conversations: 'id, lastActivity, pinned',
      messages: 'id, convoId, tsCoarse, status, [convoId+tsCoarse]',
      outbox: 'id, convoId, nextAttemptAt, createdAt',
      seen: 'id, ts',
      relays: 'id, enabled',
      settings: 'id',
    })
    // v2 adds attachment storage. Purely additive: Dexie carries every existing
    // table forward untouched, so an existing vault upgrades without a rewrite
    // and without needing to be unlocked at migration time.
    this.version(2).stores({
      blobs: 'id, complete, updatedAt, outgoing',
      blobChunks: 'id, blob',
    })
    // v3 adds reactions, additive in the same way: existing tables are carried
    // forward untouched and a vault from v1 or v2 opens without a rewrite.
    this.version(3).stores({
      reactions: 'id, messageId, convoId',
    })
    // v4 adds sticker packs, additive in the same way.
    this.version(4).stores({
      packs: 'id, createdAt',
    })
    // v5 adds poll votes and checklist changes, additive in the same way.
    // Group conversations need no schema change: who is in one lives in the
    // sealed conversation body, and its id is the same blinded key as ever.
    this.version(5).stores({
      updates: 'id, targetId, convoId',
    })
    // v6 adds forward-secret groups: MLS group state and KeyPackage private
    // keys, additive in the same way.
    this.version(6).stores({
      mlsGroups: 'id',
      mlsKeys: 'id',
    })
  }
}

export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  /** Every way the vault opens: see `keyslots.ts`. */
  keyslots: 'keyslots',
  /** The pre-keyslot header, moved into `keyslots` the first time it opens. */
  kdfSalt: 'kdfSalt',
  kdfParams: 'kdfParams',
  wrappedDataKey: 'wrappedDataKey',
  createdAt: 'createdAt',
  /** Bumped whenever a keyslot is added, replaced or removed. */
  keyEpoch: 'keyEpoch',
} as const

let instance: TextorDatabase | null = null

export function getDb(): TextorDatabase {
  if (!instance) instance = new TextorDatabase()
  return instance
}

/** Tests and "delete everything" both need a clean slate. */
export async function resetDb(): Promise<void> {
  const db = getDb()
  await db.delete()
  instance = null
}

export function setDbForTesting(db: TextorDatabase | null): void {
  instance = db
}
