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
 * The one plaintext table is `meta`, which holds the KDF salt and parameters
 * and the wrapped data key. Those must be readable before unlocking, and none
 * of them reveal anything on their own.
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
  ts: number
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
 * Manifest for one attachment payload, inbound or outbound.
 *
 * Deliberately not encrypted: it holds counters, not content. The payload
 * itself lives in `blobChunks` as ciphertext under a key that exists only
 * inside the sealed message row, and the primary key here is blinded, so this
 * table tells a device attacker that *an* attachment of some size exists and
 * nothing about which conversation it belongs to or what is in it — which the
 * ciphertext length already reveals anyway.
 */
export interface BlobRow {
  /** Blinded blob id. */
  id: string
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
  }
}

export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  kdfSalt: 'kdfSalt',
  kdfParams: 'kdfParams',
  wrappedDataKey: 'wrappedDataKey',
  createdAt: 'createdAt',
  /** Bumped whenever the passphrase changes, so stale tabs re-authenticate. */
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
