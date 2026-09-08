import Dexie from 'dexie'
import {
  blindId,
  contactId as blindContactId,
  conversationId,
  conversationIdOf,
  seenEventId,
  withdrawnId,
} from '../crypto/vaultCrypto'
import type { InteractiveUpdate } from '../models/interactive'
import { coarsenMs, DAY, HOUR } from '../util/time'
import type { NegentropyItem } from '../transport/negentropy'
import { toNpub } from '../identity/keys'
import { normalizeRelayList, normalizeRelayUrl } from '../transport/relayUrl'
import {
  DEFAULT_SETTINGS,
  emptyHealth,
  type AppSettings,
  type Contact,
  type Conversation,
  type IdentityRecord,
  type Message,
  type MlsConversation,
  type OutboxItem,
  type Reaction,
  type RelayEntry,
  type StickerPack,
  type RelayHealth,
} from '../models/types'
import type {
  BlobRow,
  ConversationRow,
  MessageDirection,
  MessageRow,
  MessageStatus,
  OutboxRow,
  PackRow,
  ReactionRow,
  UpdateRow,
} from './db'
import { toBytes, VaultLockedError, type Vault } from './vault'
import { blobRef, blobRefKey, chunkOpens, type BlobEnvelope, type BlobRef } from '../crypto/blobCrypto'

const IDENTITY_ID = 'self'
const SETTINGS_ID = 'app'
const SYNC_ID = 'sync'
/** Marks the attachment store as keyed by copy (ADR-052). */
const BLOB_STORE_ID = 'blobstore'
/**
 * A payload written this recently is never swept: the message or pack naming
 * it may still be being written. A sender stores the payload first.
 */
const SWEEP_GRACE_MS = HOUR

const aad = (table: string, id: string): string => `textor/${table}/${id}`

/**
 * Delivery state only ever moves forward. Without this ordering, a late
 * `delivered` receipt arriving after a `read` receipt would visibly downgrade
 * the tick in the sender's conversation.
 */
/** IndexedDB stores query limits as an unsigned long. */
const MAX_QUERY_LIMIT = 2 ** 31 - 1

const STATUS_RANK: Record<MessageStatus, number> = {
  failed: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
}

/**
 * A group message's overall state: the least advanced of its members'. It is
 * read when everyone has read it, and failed if anyone's copy could not be
 * delivered at all — which is what puts the retry button on it.
 */
export function aggregateStatus(receipts: Record<string, MessageStatus>): MessageStatus {
  let lowest: MessageStatus = 'read'
  for (const status of Object.values(receipts)) {
    if (STATUS_RANK[status] < STATUS_RANK[lowest]) lowest = status
  }
  return lowest
}

/**
 * Where inbox sync stands, sealed like the cursor it replaces.
 *
 * `relays` holds each relay's high-water mark — the time up to which this
 * device is known to hold everything that relay held — and what it said the
 * last time it was asked for NIP-77. `floorSec` is the dedup horizon: marks
 * for anything older have been pruned, so a wrap older than it cannot be
 * recognised as already processed and is refused rather than processed twice.
 */
export interface SyncState {
  lastSyncSec: number
  floorSec: number
  relays: Record<string, RelaySyncMark>
}

export interface RelaySyncMark {
  /** Unix seconds. */
  hwm: number
  /** Whether it answered a NIP-77 reconciliation, and when that was learned. */
  neg?: { ok: boolean; at: number }
}

/** What `compactSeen` did. */
export interface SeenCompaction {
  removed: number
  /** The dedup horizon afterwards, unix seconds. */
  floorSec: number
}

/** Seen rows deleted per transaction, so a large prune never blocks delivery for long. */
const SEEN_DELETE_BATCH = 2000

/** The sealed half of a conversation row. */
type ConversationBody = Partial<
  Pick<Conversation, 'kind' | 'members' | 'subject' | 'subjectAt' | 'accepted' | 'draft' | 'mls'>
> &
  Pick<Conversation, 'peerPubkey'>

/**
 * Typed access to the encrypted vault.
 *
 * Every method here is responsible for exactly one thing: turning a domain
 * object into a row whose indexed columns leak nothing, and back. Callers never
 * touch Dexie or the sealing helpers directly, so there is a single place to
 * audit what ends up outside a ciphertext.
 */
export class VaultRepo {
  constructor(private readonly vault: Vault) {}

  private get db() {
    return this.vault.db
  }

  private get indexKey() {
    return this.vault.keys.indexKey
  }

  /**
   * Reads below tolerate a single unreadable row by skipping it, because one
   * corrupt record should not take down a whole list. That tolerance must not
   * extend to a locked vault: every row would fail to open and the caller would
   * see an empty database instead of an error, which reads as data loss.
   */
  private assertUnlocked(): void {
    void this.vault.keys
  }

  // --- identity -------------------------------------------------------------

  async getIdentity(): Promise<IdentityRecord | null> {
    this.assertUnlocked()
    const row = await this.db.identity.get(IDENTITY_ID)
    if (!row) return null
    return this.vault.openIdentity<IdentityRecord>(toBytes(row.enc), aad('identity', IDENTITY_ID))
  }

  async putIdentity(identity: IdentityRecord): Promise<void> {
    await this.db.identity.put({
      id: IDENTITY_ID,
      enc: this.vault.sealIdentity(identity, aad('identity', IDENTITY_ID)),
    })
  }

  async updateIdentity(patch: Partial<IdentityRecord>): Promise<IdentityRecord> {
    return this.vault.transaction(async () => {
      const current = await this.getIdentity()
      if (!current) throw new Error('no identity in vault')
      const next = { ...current, ...patch }
      await this.putIdentity(next)
      return next
    })
  }

  // --- contacts -------------------------------------------------------------

  contactId(pubkey: string): string {
    return blindContactId(this.indexKey, pubkey)
  }

  async getContact(pubkey: string): Promise<Contact | null> {
    this.assertUnlocked()
    const id = this.contactId(pubkey)
    const row = await this.db.contacts.get(id)
    if (!row) return null
    const body = this.vault.openRecord<Omit<Contact, 'id' | 'addedAt' | 'lastSeenAt' | 'blocked'>>(
      toBytes(row.enc),
      aad('contacts', id),
    )
    return { ...body, id, addedAt: row.addedAt, lastSeenAt: row.lastSeenAt, blocked: row.blocked === 1 }
  }

  async listContacts(): Promise<Contact[]> {
    this.assertUnlocked()
    const rows = await this.db.contacts.toArray()
    const out: Contact[] = []
    for (const row of rows) {
      try {
        const body = this.vault.openRecord<Omit<Contact, 'id' | 'addedAt' | 'lastSeenAt' | 'blocked'>>(
          toBytes(row.enc),
          aad('contacts', row.id),
        )
        out.push({
          ...body,
          id: row.id,
          addedAt: row.addedAt,
          lastSeenAt: row.lastSeenAt,
          blocked: row.blocked === 1,
        })
      } catch {
        // A row that will not open is corrupt or was written under a different
        // key. Skip it rather than failing the whole list.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async upsertContact(
    pubkey: string,
    patch: Partial<Omit<Contact, 'id' | 'pubkey' | 'npub'>>,
  ): Promise<Contact> {
    return this.vault.transaction(async () => {
      const existing = await this.getContact(pubkey)
      const now = Date.now()
      const merged: Contact = {
        id: this.contactId(pubkey),
        pubkey,
        npub: toNpub(pubkey),
        name: patch.name ?? existing?.name ?? '',
        remoteName: patch.remoteName ?? existing?.remoteName,
        about: patch.about ?? existing?.about,
        avatar: patch.avatar ?? existing?.avatar,
        relays: normalizeRelayList(patch.relays ?? existing?.relays ?? []),
        verification: patch.verification ?? existing?.verification ?? 'unverified',
        source: patch.source ?? existing?.source ?? 'manual',
        accepted: patch.accepted ?? existing?.accepted ?? false,
        note: patch.note ?? existing?.note,
        addedAt: existing?.addedAt ?? now,
        lastSeenAt: patch.lastSeenAt ?? existing?.lastSeenAt ?? now,
        blocked: patch.blocked ?? existing?.blocked ?? false,
      }
      await this.writeContact(merged)
      return merged
    })
  }

  private async writeContact(contact: Contact): Promise<void> {
    const { id, addedAt, lastSeenAt, blocked, ...body } = contact
    await this.db.contacts.put({
      id,
      enc: this.vault.sealRecord(body, aad('contacts', id)),
      addedAt,
      lastSeenAt,
      blocked: blocked ? 1 : 0,
    })
  }

  async deleteContact(pubkey: string): Promise<void> {
    await this.db.contacts.delete(this.contactId(pubkey))
  }

  // --- conversations --------------------------------------------------------

  conversationId(selfPubkey: string, peerPubkey: string): string {
    return conversationId(this.indexKey, selfPubkey, peerPubkey)
  }

  /** The id of the room holding `selfPubkey` and `members` — direct or group alike. */
  conversationIdOf(selfPubkey: string, members: readonly string[]): string {
    return conversationIdOf(this.indexKey, [selfPubkey, ...members])
  }

  private decodeConversation(row: ConversationRow): Conversation {
    const body = this.vault.openRecord<ConversationBody>(toBytes(row.enc), aad('conversations', row.id))
    // Rows written before groups existed carry only `peerPubkey`, and every one
    // of them is a direct conversation with that person.
    const kind = body.kind ?? 'direct'
    return {
      id: row.id,
      kind,
      peerPubkey: body.peerPubkey,
      members: body.members ?? [body.peerPubkey],
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.subjectAt !== undefined ? { subjectAt: body.subjectAt } : {}),
      accepted: body.accepted ?? true,
      draft: body.draft,
      ...(body.mls ? { mls: body.mls } : {}),
      lastActivity: row.lastActivity,
      unread: row.unread,
      pinned: row.pinned === 1,
    }
  }

  async getConversation(id: string): Promise<Conversation | null> {
    this.assertUnlocked()
    const row = await this.db.conversations.get(id)
    if (!row) return null
    return this.decodeConversation(row)
  }

  async listConversations(): Promise<Conversation[]> {
    this.assertUnlocked()
    const rows = await this.db.conversations.orderBy('lastActivity').reverse().toArray()
    const out: Conversation[] = []
    for (const row of rows) {
      try {
        out.push(this.decodeConversation(row))
      } catch {
        /* unreadable row; skip */
      }
    }
    // Pinned first, then most recent.
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivity - a.lastActivity)
  }

  async ensureConversation(selfPubkey: string, peerPubkey: string): Promise<Conversation> {
    return this.vault.transaction(async () => {
      const id = this.conversationId(selfPubkey, peerPubkey)
      const existing = await this.getConversation(id)
      if (existing) return existing
      const created: Conversation = {
        id,
        kind: 'direct',
        peerPubkey,
        members: [peerPubkey],
        accepted: true,
        lastActivity: Date.now(),
        unread: 0,
        pinned: false,
      }
      await this.writeConversation(created)
      return created
    })
  }

  /**
   * Find or create the group holding exactly these people.
   *
   * A subject is adopted only when it is newer than the one held, so a message
   * delayed in transit cannot rename a group back to what it used to be called.
   * `accepted` only ever turns on here: a group the user has taken is not
   * turned back into a request by a later message from a stranger in it.
   */
  async ensureGroupConversation(
    selfPubkey: string,
    members: readonly string[],
    opts: { subject?: string | null; at?: number; accepted?: boolean } = {},
  ): Promise<Conversation> {
    return this.vault.transaction(async () => {
      const sorted = [...new Set(members)].filter((pubkey) => pubkey !== selfPubkey).sort()
      if (sorted.length < 2) throw new Error('a group needs at least two other people')
      const id = this.conversationIdOf(selfPubkey, sorted)
      const at = opts.at ?? Date.now()
      const existing = await this.getConversation(id)

      if (existing) {
        const renamed = !!opts.subject && opts.subject !== existing.subject && at > (existing.subjectAt ?? 0)
        const accepting = opts.accepted === true && !existing.accepted
        if (!renamed && !accepting) return existing
        const next: Conversation = {
          ...existing,
          ...(renamed ? { subject: opts.subject as string, subjectAt: at } : {}),
          ...(accepting ? { accepted: true } : {}),
        }
        await this.writeConversation(next)
        return next
      }

      const created: Conversation = {
        id,
        kind: 'group',
        peerPubkey: '',
        members: sorted,
        ...(opts.subject ? { subject: opts.subject, subjectAt: at } : {}),
        accepted: opts.accepted ?? false,
        lastActivity: at,
        unread: 0,
        pinned: false,
      }
      await this.writeConversation(created)
      return created
    })
  }

  /** Where a forward-secret group's conversation is kept: a blinded hash of its routing id. */
  mlsConversationId(nostrGroupId: string): string {
    return blindId(this.indexKey, 'mls-group', nostrGroupId)
  }

  /**
   * Create or refresh a forward-secret group's conversation from its group
   * state. Unlike a small group, its members change, so they are replaced
   * wholesale; `accepted` still only ever turns on.
   */
  async upsertMlsConversation(
    id: string,
    patch: { members: string[]; subject: string; mls: MlsConversation; accepted?: boolean; at?: number },
  ): Promise<Conversation> {
    return this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      const next: Conversation = {
        id,
        kind: 'group',
        peerPubkey: '',
        lastActivity: patch.at ?? Date.now(),
        unread: 0,
        pinned: false,
        ...existing,
        members: [...patch.members].sort(),
        ...(patch.subject ? { subject: patch.subject } : {}),
        accepted: (existing?.accepted ?? false) || patch.accepted === true,
        mls: patch.mls,
      }
      if (!patch.subject) delete next.subject
      await this.writeConversation(next)
      return next
    })
  }

  // --- forward-secret group state -------------------------------------------

  async getMlsGroup<T>(id: string): Promise<T | null> {
    this.assertUnlocked()
    const row = await this.db.mlsGroups.get(id)
    return row ? this.vault.openRecord<T>(toBytes(row.enc), aad('mlsGroups', id)) : null
  }

  async listMlsGroups<T>(): Promise<{ id: string; value: T }[]> {
    this.assertUnlocked()
    const out: { id: string; value: T }[] = []
    for (const row of await this.db.mlsGroups.toArray()) {
      try {
        out.push({ id: row.id, value: this.vault.openRecord<T>(toBytes(row.enc), aad('mlsGroups', row.id)) })
      } catch {
        /* unreadable: the group is lost to this device, as if it had been left */
      }
    }
    return out
  }

  async putMlsGroup(id: string, value: unknown): Promise<void> {
    await this.db.mlsGroups.put({ id, enc: this.vault.sealRecord(value, aad('mlsGroups', id)) })
  }

  async countMlsGroups(): Promise<number> {
    return this.db.mlsGroups.count()
  }

  async deleteMlsGroup(id: string): Promise<void> {
    await this.db.mlsGroups.delete(id)
  }

  mlsKeyId(ref: string): string {
    return blindId(this.indexKey, 'mls-key', ref)
  }

  async listMlsKeys<T>(): Promise<T[]> {
    this.assertUnlocked()
    const out: T[] = []
    for (const row of await this.db.mlsKeys.toArray()) {
      try {
        out.push(this.vault.openRecord<T>(toBytes(row.enc), aad('mlsKeys', row.id)))
      } catch {
        /* unreadable: a Welcome to it will not open, and the inviter can retry */
      }
    }
    return out
  }

  async putMlsKey(ref: string, value: unknown): Promise<void> {
    const id = this.mlsKeyId(ref)
    await this.db.mlsKeys.put({ id, enc: this.vault.sealRecord(value, aad('mlsKeys', id)) })
  }

  async deleteMlsKey(ref: string): Promise<void> {
    await this.db.mlsKeys.delete(this.mlsKeyId(ref))
  }

  async updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): Promise<void> {
    await this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      if (!existing) return
      await this.writeConversation({ ...existing, ...patch })
    })
  }

  private async writeConversation(conversation: Conversation): Promise<void> {
    const { id, lastActivity, unread, pinned, ...body } = conversation
    await this.db.conversations.put({
      id,
      enc: this.vault.sealRecord(body, aad('conversations', id)),
      lastActivity,
      unread,
      pinned: pinned ? 1 : 0,
    })
  }

  async bumpConversation(id: string, at: number, incrementUnread: boolean): Promise<void> {
    await this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      if (!existing) return
      await this.writeConversation({
        ...existing,
        lastActivity: Math.max(existing.lastActivity, at),
        unread: incrementUnread ? existing.unread + 1 : existing.unread,
      })
    })
  }

  /** Returns whether anything changed, so callers can skip a pointless refresh. */
  async markConversationRead(id: string): Promise<boolean> {
    return this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      if (!existing || existing.unread === 0) return false
      await this.writeConversation({ ...existing, unread: 0 })
      return true
    })
  }

  /** Take one entry off the unread count, for an unread message that no longer exists. */
  async uncountUnread(id: string): Promise<void> {
    await this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      if (!existing || existing.unread === 0) return
      await this.writeConversation({ ...existing, unread: existing.unread - 1 })
    })
  }

  async deleteConversation(id: string): Promise<void> {
    // Its payloads, noted while the messages naming them can still be read.
    const payloads = (await this.#attachmentsOf(this.db.messages.where('convoId').equals(id))).map(blobRef)
    // Sequenced rather than wrapped in a Dexie transaction, for the reason
    // given on `deleteMessage`: an async transaction callback loses its zone.
    // The conversation row goes last, so an interruption leaves a conversation
    // with missing history rather than orphan history with no conversation.
    await this.db.messages.where('convoId').equals(id).delete()
    await this.db.outbox.where('convoId').equals(id).delete()
    await this.db.reactions.where('convoId').equals(id).delete()
    await this.db.updates.where('convoId').equals(id).delete()
    // A forward-secret group's keys go with it: nothing is left to read it with.
    await this.db.mlsGroups.delete(id)
    await this.db.conversations.delete(id)
    // Photos and files go with the conversation, unless a forward elsewhere
    // or a sticker pack still uses the same copy.
    await this.#dropUnreferenced(payloads)
  }

  // --- messages -------------------------------------------------------------

  private decodeMessage(row: MessageRow): Message | null {
    try {
      const body = this.vault.openRecord<
        Pick<
          Message,
          | 'ts'
          | 'body'
          | 'authorPubkey'
          | 'replyTo'
          | 'rootId'
          | 'attachment'
          | 'poll'
          | 'checklist'
          | 'receipts'
          | 'subject'
          | 'via'
          | 'relayAcks'
          | 'error'
        >
      >(toBytes(row.enc), aad('messages', row.id))
      return {
        id: row.id,
        convoId: row.convoId,
        direction: row.dir,
        status: row.status,
        tsCoarse: row.tsCoarse,
        ...body,
      }
    } catch {
      return null
    }
  }

  async putMessage(message: Message): Promise<void> {
    const { id, convoId, direction, status, tsCoarse: _tsCoarse, ...body } = message
    await this.db.messages.put({
      id,
      convoId,
      dir: direction,
      status,
      tsCoarse: coarsenMs(message.ts),
      enc: this.vault.sealRecord(body, aad('messages', id)),
    })
  }

  async getMessage(id: string): Promise<Message | null> {
    this.assertUnlocked()
    const row = await this.db.messages.get(id)
    return row ? this.decodeMessage(row) : null
  }

  async hasMessage(id: string): Promise<boolean> {
    return (await this.db.messages.get(id)) !== undefined
  }

  /**
   * Newest `limit` messages, oldest-first for rendering.
   *
   * Walks the `[convoId+tsCoarse]` index backwards and stops once it has enough
   * rows, so opening a conversation with years of history decrypts a screenful
   * rather than all of it. The index only knows hour buckets, so ordering
   * within a bucket is settled after decryption, on the exact timestamps — the
   * over-read below covers the boundary.
   */
  async listMessages(convoId: string, limit = 200, beforeTs?: number): Promise<Message[]> {
    this.assertUnlocked()
    const upperBound = beforeTs === undefined ? Dexie.maxKey : coarsenMs(beforeTs) + HOUR
    // Over-read so messages sharing the boundary hour cannot be dropped by the
    // cut, and so `beforeTs` filtering has spare rows to work with. Clamped
    // because IndexedDB rejects a limit outside unsigned-long range.
    const fetchCount = Math.min(Math.max(1, limit) + 64, MAX_QUERY_LIMIT)
    const rows = await this.db.messages
      .where('[convoId+tsCoarse]')
      .between([convoId, Dexie.minKey], [convoId, upperBound], true, true)
      .reverse()
      .limit(fetchCount)
      .toArray()

    const decoded: Message[] = []
    for (const row of rows) {
      const message = this.decodeMessage(row)
      if (message && (beforeTs === undefined || message.ts < beforeTs)) decoded.push(message)
    }
    decoded.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    return decoded.slice(Math.max(0, decoded.length - limit))
  }

  /**
   * Every message in a conversation, oldest first.
   *
   * Only for export, which must not silently truncate history. Reading a
   * conversation for display goes through `listMessages`, which pages.
   */
  async allMessages(convoId: string): Promise<Message[]> {
    this.assertUnlocked()
    const rows = await this.db.messages.where('convoId').equals(convoId).toArray()
    const decoded = rows
      .map((row) => this.decodeMessage(row))
      .filter((message): message is Message => message !== null)
    decoded.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    return decoded
  }

  async countMessages(convoId: string): Promise<number> {
    return this.db.messages.where('convoId').equals(convoId).count()
  }

  async updateMessage(id: string, patch: Partial<Omit<Message, 'id' | 'convoId'>>): Promise<Message | null> {
    return this.vault.transaction(async () => {
      const current = await this.getMessage(id)
      if (!current) return null
      const next = { ...current, ...patch }
      await this.putMessage(next)
      return next
    })
  }

  async advanceMessageStatus(id: string, status: MessageStatus): Promise<Message | null> {
    return this.vault.transaction(async () => {
      const current = await this.getMessage(id)
      if (!current) return null
      if (STATUS_RANK[status] <= STATUS_RANK[current.status] && current.status !== 'failed') {
        return current
      }
      const next = { ...current, status }
      await this.putMessage(next)
      return next
    })
  }

  /**
   * Advance several messages at once.
   *
   * A read receipt marks every earlier outgoing message read too, which for a
   * backlog meant one vault transaction and one IndexedDB write per message.
   * One pass, one write.
   */
  async advanceMessageStatuses(ids: string[], status: MessageStatus): Promise<Message[]> {
    if (ids.length === 0) return []
    return this.vault.transaction(async () => {
      const rows = await this.db.messages.bulkGet(ids)
      const updated: Message[] = []
      const writes: MessageRow[] = []

      for (const row of rows) {
        if (!row) continue
        const current = this.decodeMessage(row)
        if (!current) continue
        if (STATUS_RANK[status] <= STATUS_RANK[current.status] && current.status !== 'failed') continue
        const next = { ...current, status }
        const { id, convoId, direction, status: nextStatus, tsCoarse: _tsCoarse, ...body } = next
        writes.push({
          id,
          convoId,
          dir: direction,
          status: nextStatus,
          tsCoarse: coarsenMs(next.ts),
          enc: this.vault.sealRecord(body, aad('messages', id)),
        })
        updated.push(next)
      }

      if (writes.length > 0) await this.db.messages.bulkPut(writes)
      return updated
    })
  }

  /**
   * Move some of a group message's recipients to a new state.
   *
   * Before a copy has reached the relays its state moves freely — queued,
   * sending, failed and back — because that is what retrying is. From "sent"
   * on it only moves forward, for the same reason `advanceMessageStatus` does:
   * a late "delivered" must not undo a "read". Recipients the message was not
   * sent to are ignored, so a receipt from outside the group changes nothing.
   */
  async markRecipients(
    id: string,
    pubkeys: readonly string[],
    status: MessageStatus,
  ): Promise<Message | null> {
    return this.vault.transaction(async () => {
      const current = await this.getMessage(id)
      if (!current?.receipts) return null
      const receipts = { ...current.receipts }
      const settled = STATUS_RANK.sent
      let changed = false
      for (const pubkey of pubkeys) {
        const was = receipts[pubkey]
        if (was === undefined || was === status) continue
        const forward = STATUS_RANK[status] > STATUS_RANK[was]
        const beforeSending = STATUS_RANK[status] < settled && STATUS_RANK[was] < settled
        if (!forward && !beforeSending) continue
        receipts[pubkey] = status
        changed = true
      }
      if (!changed) return current
      const next = { ...current, receipts, status: aggregateStatus(receipts) }
      await this.putMessage(next)
      return next
    })
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.messages.delete(id)
    // A reaction to a message that no longer exists has nothing to attach to.
    //
    // Sequenced rather than wrapped in a Dexie transaction: an async
    // transaction callback loses its zone the moment anything outside Dexie
    // resolves inside it, which fails as `TransactionInactiveError` — the same
    // trap that was removed from `putBlobChunk`. Atomicity buys little here,
    // because a delete interrupted between the two statements leaves reactions
    // that nothing reads: they are only ever queried by the id of a message
    // that still exists, and `deleteConversation` sweeps them.
    await this.db.reactions.where('messageId').equals(id).delete()
    await this.db.updates.where('targetId').equals(id).delete()
  }

  // --- votes and checklist changes -----------------------------------------

  /** Returns false when this update is already stored. */
  async putUpdate(update: InteractiveUpdate): Promise<boolean> {
    this.assertUnlocked()
    const { id, targetId, convoId, ...body } = update
    if (await this.db.updates.get(id)) return false
    await this.db.updates.put({
      id,
      targetId,
      convoId,
      enc: this.vault.sealRecord(body, aad('updates', id)),
    })
    return true
  }

  /** Every update to a page of messages, by message id, so a long history is not decrypted wholesale. */
  async listUpdatesFor(targetIds: readonly string[]): Promise<InteractiveUpdate[]> {
    this.assertUnlocked()
    if (targetIds.length === 0) return []
    const rows = await this.db.updates
      .where('targetId')
      .anyOf([...targetIds])
      .toArray()
    return rows
      .map((row) => this.decodeUpdate(row))
      .filter((update): update is InteractiveUpdate => update !== null)
  }

  private decodeUpdate(row: UpdateRow): InteractiveUpdate | null {
    try {
      const body = this.vault.openRecord<Pick<InteractiveUpdate, 'authorPubkey' | 'ts' | 'frame'>>(
        toBytes(row.enc),
        aad('updates', row.id),
      )
      return { id: row.id, targetId: row.targetId, convoId: row.convoId, ...body }
    } catch {
      /* unreadable row; skip */
      return null
    }
  }

  // --- reactions ------------------------------------------------------------

  /** Returns false when this reaction is already stored, so callers can skip a re-render. */
  async putReaction(reaction: Reaction): Promise<boolean> {
    this.assertUnlocked()
    const { id, messageId, convoId, ...body } = reaction
    if (await this.db.reactions.get(id)) return false
    await this.db.reactions.put({
      id,
      messageId,
      convoId,
      enc: this.vault.sealRecord(body, aad('reactions', id)),
    })
    return true
  }

  async getReaction(id: string): Promise<Reaction | null> {
    this.assertUnlocked()
    const row = await this.db.reactions.get(id)
    return row ? this.decodeReaction(row) : null
  }

  /**
   * Reactions for a page of messages, in arrival order.
   *
   * Queried by message id rather than by conversation so opening a chat with
   * years of history decrypts the reactions of the screenful being shown.
   */
  async listReactionsFor(messageIds: readonly string[]): Promise<Reaction[]> {
    this.assertUnlocked()
    if (messageIds.length === 0) return []
    const rows = await this.db.reactions
      .where('messageId')
      .anyOf([...messageIds])
      .toArray()
    return rows
      .map((row) => this.decodeReaction(row))
      .filter((reaction): reaction is Reaction => reaction !== null)
      .sort((a, b) => a.ts - b.ts)
  }

  /**
   * The reaction this author already has on a message, if any.
   *
   * One per author per message: reacting again replaces, and reacting with the
   * same emoji withdraws. That is a client rule, not a NIP-25 one — the NIP
   * says nothing about duplicates — but a reaction bar that can show the same
   * person three times is noise.
   */
  async findReaction(messageId: string, authorPubkey: string): Promise<Reaction | null> {
    const existing = await this.listReactionsFor([messageId])
    return existing.find((reaction) => reaction.authorPubkey === authorPubkey) ?? null
  }

  async deleteReaction(id: string): Promise<void> {
    await this.db.reactions.delete(id)
  }

  private decodeReaction(row: ReactionRow): Reaction | null {
    try {
      const body = this.vault.openRecord<Pick<Reaction, 'authorPubkey' | 'emoji' | 'ts'>>(
        toBytes(row.enc),
        aad('reactions', row.id),
      )
      return { id: row.id, messageId: row.messageId, convoId: row.convoId, ...body }
    } catch {
      /* unreadable row; skip */
      return null
    }
  }

  // --- sticker packs --------------------------------------------------------

  /**
   * Packs are stored manifest-only: the images are blobs, keyed by content
   * hash, so the same picture used in two packs is stored once and a pack
   * costs a few hundred bytes.
   */
  async putPack(pack: StickerPack): Promise<void> {
    this.assertUnlocked()
    const { id, createdAt, ...body } = pack
    await this.db.packs.put({
      id,
      createdAt,
      enc: this.vault.sealRecord(body, aad('packs', id)),
    })
  }

  async listPacks(): Promise<StickerPack[]> {
    this.assertUnlocked()
    const rows = await this.db.packs.orderBy('createdAt').toArray()
    return rows.map((row) => this.decodePack(row)).filter((pack): pack is StickerPack => pack !== null)
  }

  async getPack(id: string): Promise<StickerPack | null> {
    this.assertUnlocked()
    const row = await this.db.packs.get(id)
    return row ? this.decodePack(row) : null
  }

  /**
   * Remove a pack, and the images no surviving pack still uses.
   *
   * Two packs can share a picture — importing reuses the copy already held —
   * and deleting the bytes from under the other one would leave a sticker
   * that renders as nothing and cannot be repaired.
   */
  async deletePack(id: string): Promise<void> {
    const pack = await this.getPack(id)
    if (!pack) return
    await this.db.packs.delete(id)
    const surviving = new Set<string>()
    for (const other of await this.listPacks()) {
      for (const sticker of other.stickers) surviving.add(blobRefKey(blobRef(sticker)))
    }
    for (const sticker of pack.stickers) {
      if (!surviving.has(blobRefKey(blobRef(sticker)))) await this.deleteBlob(blobRef(sticker))
    }
  }

  private decodePack(row: PackRow): StickerPack | null {
    try {
      const body = this.vault.openRecord<Pick<StickerPack, 'name' | 'stickers'>>(
        toBytes(row.enc),
        aad('packs', row.id),
      )
      return { id: row.id, createdAt: row.createdAt, ...body }
    } catch {
      /* unreadable row; skip */
      return null
    }
  }

  async listPendingOutgoing(): Promise<Message[]> {
    const rows = await this.db.messages.where('status').anyOf('queued', 'sending', 'failed').toArray()
    return rows.map((row) => this.decodeMessage(row)).filter((m): m is Message => m !== null)
  }

  // --- outbox ---------------------------------------------------------------

  async enqueue(item: OutboxItem): Promise<void> {
    const { id, convoId, attempts, nextAttemptAt, createdAt, ...body } = item
    await this.db.outbox.put({
      id,
      convoId,
      attempts,
      nextAttemptAt,
      createdAt,
      enc: this.vault.sealRecord(body, aad('outbox', id)),
    })
  }

  async dueOutbox(now = Date.now(), limit = 32): Promise<OutboxItem[]> {
    this.assertUnlocked()
    const rows = await this.db.outbox.where('nextAttemptAt').belowOrEqual(now).limit(limit).toArray()
    const out: OutboxItem[] = []
    for (const row of rows) {
      const item = await this.openOutboxRow(row)
      if (item) out.push(item)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Ids of due outbox entries, oldest due first, without reading their bodies.
   *
   * The scheduler calls this after every delivery. An attachment's chunks sit
   * in the outbox as 55 KB rows each, and loading them all just to pick the
   * next two to send would copy megabytes out of IndexedDB for every chunk
   * sent. Primary keys come straight off the index.
   */
  async dueOutboxIds(now = Date.now(), limit = 512): Promise<string[]> {
    this.assertUnlocked()
    return (await this.db.outbox
      .where('nextAttemptAt')
      .belowOrEqual(now)
      .limit(limit)
      .primaryKeys()) as string[]
  }

  async getOutboxItem(id: string): Promise<OutboxItem | null> {
    this.assertUnlocked()
    const row = await this.db.outbox.get(id)
    return row ? this.openOutboxRow(row) : null
  }

  /** Every entry queued for one conversation, due or not. `include` filters by id before decrypting. */
  async outboxForConversation(
    convoId: string,
    include: (id: string) => boolean = () => true,
  ): Promise<OutboxItem[]> {
    this.assertUnlocked()
    const ids = (await this.db.outbox.where('convoId').equals(convoId).primaryKeys()) as string[]
    const out: OutboxItem[] = []
    for (const id of ids.filter(include)) {
      const item = await this.getOutboxItem(id)
      if (item) out.push(item)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Bring every retry that is waiting out a backoff forward to now.
   *
   * For when the reason they were waiting has gone — the network came back.
   * Each is rescheduled to its creation time rather than to "now", which keeps
   * them in the order they were written instead of an arbitrary tie.
   */
  async expediteOutbox(now = Date.now()): Promise<number> {
    this.assertUnlocked()
    return this.db.outbox
      .where('nextAttemptAt')
      .above(now)
      .modify((row) => {
        row.nextAttemptAt = Math.min(row.createdAt, now)
      })
  }

  async countOutbox(include?: (id: string) => boolean): Promise<number> {
    if (!include) return this.db.outbox.count()
    const ids = (await this.db.outbox.toCollection().primaryKeys()) as string[]
    return ids.filter(include).length
  }

  private async openOutboxRow(row: OutboxRow): Promise<OutboxItem | null> {
    try {
      const body = this.vault.openRecord<
        Pick<OutboxItem, 'peerPubkey' | 'recipients' | 'rumorJson' | 'relays' | 'ephemeral' | 'lastError'>
      >(toBytes(row.enc), aad('outbox', row.id))
      return {
        id: row.id,
        convoId: row.convoId,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        createdAt: row.createdAt,
        ...body,
      }
    } catch {
      // Undecryptable queue entries can never be sent; drop them.
      await this.db.outbox.delete(row.id)
      return null
    }
  }

  async dequeue(id: string): Promise<void> {
    await this.db.outbox.delete(id)
  }

  // --- seen-event dedup -----------------------------------------------------

  async hasSeen(eventId: string): Promise<boolean> {
    return (await this.db.seen.get(seenEventId(this.indexKey, eventId))) !== undefined
  }

  /**
   * Remember relay events as processed.
   *
   * Keyed and indexed by the event's own hour, not by when it arrived, so the
   * table can be pruned against the same clock relays filter by. With `sync`,
   * the real id and timestamp are sealed into the row as well: those are the
   * items a negentropy reconciliation offers a relay (see `seenItems`).
   */
  async markSeen(
    events: readonly { id: string; createdAt: number }[],
    opts: { sync?: boolean } = {},
  ): Promise<void> {
    if (events.length === 0) return
    const sync = opts.sync ?? true
    await this.db.seen.bulkPut(
      events.map(({ id, createdAt }) => {
        const key = seenEventId(this.indexKey, id)
        return {
          id: key,
          ts: coarsenMs(createdAt * 1000),
          ...(sync ? { enc: this.vault.sealRecord({ i: id, c: createdAt }, aad('seen', key)) } : {}),
        }
      }),
    )
  }

  /** Inbox wraps this device holds that were created at or after `sinceSec`. */
  async seenItems(sinceSec: number): Promise<NegentropyItem[]> {
    this.assertUnlocked()
    const rows = await this.db.seen
      .where('ts')
      .aboveOrEqual(coarsenMs(sinceSec * 1000))
      .toArray()
    const out: NegentropyItem[] = []
    for (const row of rows) {
      if (!row.enc) continue
      try {
        const { i, c } = this.vault.openRecord<{ i: string; c: number }>(
          toBytes(row.enc),
          aad('seen', row.id),
        )
        if (c >= sinceSec) out.push({ id: i, createdAt: c })
      } catch {
        /* unreadable row; the relay will simply send that event again */
      }
    }
    return out
  }

  /**
   * Prune the seen table, and keep it bounded.
   *
   * Marks older than `horizonMs` go: relays are asked to expire wraps after
   * 30 days, so by 45 nothing should still be carrying them. Beyond
   * `maxRows`, the oldest delivery marks go too — down to `targetRows`, but
   * never any younger than `minHorizonMs`, which stays well above the three
   * days a subscription rewinds. Tombstones are never dropped for size.
   *
   * Whatever is forgotten raises the floor: a wrap from before it could be
   * one this device has already processed, so it is refused rather than
   * trusted to be new. See ADR-051.
   */
  async compactSeen(
    opts: {
      now?: number
      horizonMs?: number
      minHorizonMs?: number
      maxRows?: number
      targetRows?: number
      floorSec?: number
    } = {},
  ): Promise<SeenCompaction> {
    const now = opts.now ?? Date.now()
    let floorMs = (opts.floorSec ?? 0) * 1000
    let removed = 0

    const horizon = coarsenMs(now - (opts.horizonMs ?? 45 * DAY))
    const aged = await this.#deleteSeenBelow(horizon, false)
    if (aged > 0) floorMs = Math.max(floorMs, horizon)
    removed += aged

    const maxRows = opts.maxRows ?? 100_000
    const count = await this.db.seen.count()
    if (count > maxRows) {
      const keep = Math.min(opts.targetRows ?? Math.floor(maxRows * 0.8), maxRows)
      const pivot = await this.db.seen
        .orderBy('ts')
        .offset(count - keep)
        .first()
      const youngest = coarsenMs(now - (opts.minHorizonMs ?? 7 * DAY))
      const cutoff = Math.min(pivot?.ts ?? youngest, youngest)
      const trimmed = await this.#deleteSeenBelow(cutoff, true)
      if (trimmed > 0) floorMs = Math.max(floorMs, cutoff)
      removed += trimmed
    }
    return { removed, floorSec: Math.floor(floorMs / 1000) }
  }

  async #deleteSeenBelow(cutoffMs: number, deliveryMarksOnly: boolean): Promise<number> {
    let removed = 0
    for (;;) {
      const below = this.db.seen.where('ts').below(cutoffMs)
      const keys = await (deliveryMarksOnly ? below.filter((row) => row.enc !== undefined) : below)
        .limit(SEEN_DELETE_BATCH)
        .primaryKeys()
      if (keys.length === 0) return removed
      await this.db.seen.bulkDelete(keys)
      removed += keys.length
      if (keys.length < SEEN_DELETE_BATCH) return removed
    }
  }

  // --- tombstones ------------------------------------------------------------

  /**
   * Remember that `id`, written by `author`, has been deleted — so a copy that
   * arrives afterwards is dropped rather than bringing it back.
   *
   * The seen marks cannot do this on their own: they name wraps, and one rumor
   * travels in many. A sender's outbox re-wraps on every retry, and a
   * withdrawal can overtake the thing it withdraws, because wrap timestamps
   * are fuzzed and a catch-up read returns them in any order.
   *
   * Kept in the seen table under a key of its own, blinded like every other,
   * and pruned with the seen marks for the same reason: by then every wrap
   * that could carry the rumor has expired off the relays. Keyed by author as
   * well as id, so asking to delete what someone else wrote leaves nothing
   * that could stop it arriving.
   */
  async withdraw(id: string, author: string): Promise<void> {
    await this.db.seen.put({ id: withdrawnId(this.indexKey, id, author), ts: coarsenMs(Date.now()) })
  }

  async isWithdrawn(id: string, author: string): Promise<boolean> {
    return (await this.db.seen.get(withdrawnId(this.indexKey, id, author))) !== undefined
  }

  // --- relays ---------------------------------------------------------------

  relayId(url: string): string {
    return blindId(this.indexKey, 'relay', url)
  }

  async listRelays(): Promise<RelayEntry[]> {
    this.assertUnlocked()
    const rows = await this.db.relays.toArray()
    const out: RelayEntry[] = []
    for (const row of rows) {
      try {
        const body = this.vault.openRecord<Omit<RelayEntry, 'id' | 'enabled'>>(
          toBytes(row.enc),
          aad('relays', row.id),
        )
        out.push({ ...body, id: row.id, enabled: row.enabled === 1 })
      } catch {
        /* unreadable row; skip */
      }
    }
    return out.sort((a, b) => a.url.localeCompare(b.url))
  }

  async upsertRelay(
    url: string,
    patch: Partial<Omit<RelayEntry, 'id' | 'url'>> = {},
  ): Promise<RelayEntry | null> {
    const normalized = normalizeRelayUrl(url)
    if (!normalized) return null
    return this.vault.transaction(async () => {
      const id = this.relayId(normalized)
      const row = await this.db.relays.get(id)
      let existing: Omit<RelayEntry, 'id' | 'enabled'> | null = null
      if (row) {
        try {
          existing = this.vault.openRecord<Omit<RelayEntry, 'id' | 'enabled'>>(
            toBytes(row.enc),
            aad('relays', id),
          )
        } catch {
          existing = null
        }
      }
      const entry: RelayEntry = {
        id,
        url: normalized,
        read: patch.read ?? existing?.read ?? true,
        write: patch.write ?? existing?.write ?? true,
        discovered: patch.discovered ?? existing?.discovered ?? false,
        enabled: patch.enabled ?? (row ? row.enabled === 1 : true),
        // Same forward-merge as everywhere else: a record stored by an older
        // build must gain new counters rather than leaving them undefined.
        health: { ...emptyHealth(), ...(patch.health ?? existing?.health) },
      }
      const { id: _id, enabled, ...body } = entry
      await this.db.relays.put({
        id,
        enc: this.vault.sealRecord(body, aad('relays', id)),
        enabled: enabled ? 1 : 0,
      })
      return entry
    })
  }

  async removeRelay(url: string): Promise<void> {
    const normalized = normalizeRelayUrl(url)
    if (normalized) await this.db.relays.delete(this.relayId(normalized))
  }

  async saveRelayHealth(url: string, health: RelayHealth): Promise<void> {
    await this.upsertRelay(url, { health })
  }

  // --- sync state -----------------------------------------------------------

  /**
   * How far the inbox has been read. Encrypted like everything else: on its
   * own it would tell a device attacker exactly when this person last used
   * the app, and on which relays.
   *
   * A vault written before per-relay marks existed holds only `lastSyncSec`;
   * it is read forward onto an empty state, so every relay starts from it.
   */
  async getSyncState(): Promise<SyncState> {
    this.assertUnlocked()
    const empty: SyncState = { lastSyncSec: 0, floorSec: 0, relays: {} }
    const row = await this.db.settings.get(SYNC_ID)
    if (!row) return empty
    try {
      const stored = this.vault.openRecord<Partial<SyncState>>(toBytes(row.enc), aad('settings', SYNC_ID))
      return {
        lastSyncSec: stored.lastSyncSec ?? 0,
        floorSec: stored.floorSec ?? 0,
        relays: stored.relays ?? {},
      }
    } catch {
      return empty
    }
  }

  async setSyncState(state: SyncState): Promise<void> {
    await this.db.settings.put({
      id: SYNC_ID,
      enc: this.vault.sealRecord(state, aad('settings', SYNC_ID)),
    })
  }

  // --- settings -------------------------------------------------------------

  async getSettings(): Promise<AppSettings> {
    this.assertUnlocked()
    const row = await this.db.settings.get(SETTINGS_ID)
    if (!row) return { ...DEFAULT_SETTINGS }
    try {
      const stored = this.vault.openRecord<Partial<AppSettings>>(
        toBytes(row.enc),
        aad('settings', SETTINGS_ID),
      )
      // Merge forward so a vault written by an older build gains new defaults.
      return { ...DEFAULT_SETTINGS, ...stored }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.vault.transaction(async () => {
      const next = { ...(await this.getSettings()), ...patch }
      await this.db.settings.put({
        id: SETTINGS_ID,
        enc: this.vault.sealRecord(next, aad('settings', SETTINGS_ID)),
      })
      return next
    })
  }

  // --- attachment payloads --------------------------------------------------

  /**
   * Blinded key for one sealed copy of a payload.
   *
   * The blob id is the SHA-256 of the plaintext, so an unblinded key would let
   * a device attacker test whether a known file — a leaked document, a specific
   * image — is present, without ever breaking a ciphertext. The copy is part
   * of it because one payload can be held under several keys (ADR-052).
   */
  blobKey(ref: BlobRef): string {
    this.assertUnlocked()
    return blindId(this.indexKey, 'blob', blobRefKey(ref))
  }

  /** Where a payload was stored before ADR-052: by its id alone. */
  #legacyBlobKey(blobId: string): string {
    return blindId(this.indexKey, 'blob', blobId)
  }

  async getBlobManifest(ref: BlobRef): Promise<BlobRow | undefined> {
    return this.db.blobs.get(this.blobKey(ref))
  }

  /**
   * Store one chunk and refresh the manifest.
   *
   * `received` is counted from the rows that exist rather than incremented.
   * The relay path re-delivers routinely, and a counter that a duplicate could
   * bump would complete a transfer still missing pieces — so the count is
   * derived, which makes that impossible rather than merely guarded against.
   * It also means no transaction is needed to keep the two tables consistent.
   */
  async putBlobChunk(
    ref: BlobRef,
    seq: number,
    data: Uint8Array,
    meta: { total: number; size: number; outgoing?: boolean },
  ): Promise<BlobRow> {
    const key = this.blobKey(ref)
    await this.db.blobChunks.put({ id: `${key}:${seq}`, blob: key, seq, data })

    const current = await this.db.blobs.get(key)
    const received = await this.db.blobChunks.where('blob').equals(key).count()
    const next: BlobRow = {
      id: key,
      total: meta.total,
      size: meta.size,
      received,
      complete: received >= meta.total ? 1 : 0,
      outgoing: meta.outgoing ? 1 : (current?.outgoing ?? 0),
      updatedAt: Date.now(),
      enc: current?.enc ?? this.#sealRef(key, ref),
    }
    await this.db.blobs.put(next)
    return next
  }

  #sealRef(key: string, ref: BlobRef): Uint8Array {
    return this.vault.sealRecord({ id: ref.id, copy: ref.copy }, aad('blobs', key))
  }

  /**
   * Every copy of a payload this device holds.
   *
   * For a resend request from a client that predates ADR-052, which names the
   * payload but not the copy. Rare, so it reads every manifest rather than
   * keeping an index that would show which rows hold the same file.
   */
  async copiesOf(blobId: string): Promise<BlobRef[]> {
    const out: BlobRef[] = []
    for (const row of await this.db.blobs.toArray()) {
      if (!row.enc) continue
      try {
        const ref = this.vault.openRecord<BlobRef>(toBytes(row.enc), aad('blobs', row.id))
        if (ref.id === blobId) out.push(ref)
      } catch {
        /* unreadable row; it cannot be served */
      }
    }
    return out
  }

  /** Chunk indexes still missing, for a resend request. */
  async missingChunks(ref: BlobRef, total: number): Promise<number[]> {
    const key = this.blobKey(ref)
    const present = new Set<number>()
    await this.db.blobChunks
      .where('blob')
      .equals(key)
      .each((row) => present.add(row.seq))
    const missing: number[] = []
    for (let i = 0; i < total; i++) if (!present.has(i)) missing.push(i)
    return missing
  }

  async getBlobChunk(ref: BlobRef, seq: number): Promise<Uint8Array | null> {
    const row = await this.db.blobChunks.get(`${this.blobKey(ref)}:${seq}`)
    return row?.data ?? null
  }

  /**
   * Every chunk in order, or `null` if the payload is incomplete.
   *
   * Returned as ciphertext: decryption needs the per-blob key, which lives in
   * the sealed message row, so it belongs to the caller that already has the
   * message in hand.
   */
  async getBlobChunks(ref: BlobRef, total: number): Promise<Uint8Array[] | null> {
    const key = this.blobKey(ref)
    const found = new Map<number, Uint8Array>()
    await this.db.blobChunks
      .where('blob')
      .equals(key)
      .each((row) => {
        if (row.seq >= 0 && row.seq < total) found.set(row.seq, row.data)
      })

    // Built by index rather than filtered from a sparse array: `new Array(n)`
    // produces holes, and `Array.prototype.some` skips holes — so a
    // completeness check written that way reports a half-empty payload as
    // whole, and the caller concatenates undefined.
    const chunks: Uint8Array[] = []
    for (let seq = 0; seq < total; seq++) {
      const chunk = found.get(seq)
      if (!chunk) return null
      chunks.push(chunk)
    }
    return chunks
  }

  /**
   * Delete a message and the payload it referenced, unless something else
   * still uses the same copy.
   *
   * Forwarding a photo does not copy it, and sending a sticker sends the
   * pack's own copy, so a copy can be shared. Deleting the bytes out from
   * under a surviving message would leave a permanently broken bubble that no
   * resend can fix, and out from under a pack, a sticker that shows nothing.
   * Another copy of the same file, under its own key, is a different payload.
   */
  async deleteMessageAndPayload(id: string): Promise<{ blobDeleted: boolean }> {
    const message = await this.getMessage(id)
    await this.deleteMessage(id)
    if (!message?.attachment) return { blobDeleted: false }
    return { blobDeleted: (await this.#dropUnreferenced([blobRef(message.attachment)])) > 0 }
  }

  async deleteBlob(ref: BlobRef): Promise<void> {
    const key = this.blobKey(ref)
    // Chunks first: a manifest without chunks is a resumable transfer, while
    // chunks without a manifest are unreachable bytes that nothing will sweep.
    await this.db.blobChunks.where('blob').equals(key).delete()
    await this.db.blobs.delete(key)
  }

  /** Total bytes of attachment ciphertext held on this device. */
  async blobBytes(): Promise<number> {
    let bytes = 0
    await this.db.blobs.each((row) => {
      bytes += row.size
    })
    return bytes
  }

  /**
   * Move payloads stored before ADR-052 to where they are looked for now.
   *
   * They were keyed by payload alone, so each legacy row holds whichever copy
   * was written last. Its owner is found by trying the stored chunks against
   * the key of every message and sticker naming that payload: the one they
   * authenticate under is the copy they are. A row no key opens can be read
   * by nothing on this device, so it goes; so do the copies it overwrote,
   * which were never there to move. Runs once, and again after an
   * interruption, since every step is safe to repeat.
   */
  async migrateBlobStore(): Promise<{ moved: number; dropped: number }> {
    this.assertUnlocked()
    const done = { moved: 0, dropped: 0 }
    if (await this.db.settings.get(BLOB_STORE_ID)) return done
    const legacy = (await this.db.blobs.toArray()).filter((row) => !row.enc)
    if (legacy.length > 0) {
      const owners = new Map<string, BlobEnvelope[]>()
      const offer = (envelope: BlobEnvelope): void => {
        const key = this.#legacyBlobKey(envelope.id)
        owners.set(key, [...(owners.get(key) ?? []), envelope])
      }
      for (const envelope of await this.#referencedEnvelopes()) offer(envelope)

      for (const row of legacy) {
        const chunks = await this.db.blobChunks.where('blob').equals(row.id).sortBy('seq')
        const first = chunks[0]
        const owner = first
          ? owners.get(row.id)?.find((envelope) => chunkOpens(envelope, first.seq, first.data))
          : undefined
        if (owner) {
          const ref = blobRef(owner)
          const key = this.blobKey(ref)
          await this.db.blobChunks.bulkPut(
            chunks.map((chunk) => ({
              id: `${key}:${chunk.seq}`,
              blob: key,
              seq: chunk.seq,
              data: chunk.data,
            })),
          )
          await this.db.blobs.put({ ...row, id: key, enc: this.#sealRef(key, ref) })
          done.moved++
        } else {
          done.dropped++
        }
        await this.db.blobChunks.where('blob').equals(row.id).delete()
        await this.db.blobs.delete(row.id)
      }
    }
    await this.db.settings.put({
      id: BLOB_STORE_ID,
      enc: this.vault.sealRecord({ keyedBy: 'copy' }, aad('settings', BLOB_STORE_ID)),
    })
    return done
  }

  // --- maintenance ----------------------------------------------------------

  /**
   * Drop payload copies nothing refers to any more: no message, and no
   * sticker in any pack. Run after retention removes messages, since
   * attachments are not deleted one by one there — a copy can be shared, by
   * a forward or a sticker. Reachability also collects anything an earlier
   * interruption left behind. A copy written within the last hour is kept:
   * it may belong to a message or pack still being written.
   */
  async pruneUnreferencedBlobs(now = Date.now()): Promise<number> {
    const referenced = (await this.#referencedEnvelopes()).map(blobRef)
    return this.pruneOrphanBlobs(referenced, now - SWEEP_GRACE_MS)
  }

  /** Delete these copies, except any a message or sticker still refers to. */
  async #dropUnreferenced(candidates: readonly BlobRef[]): Promise<number> {
    if (candidates.length === 0) return 0
    const live = new Set((await this.#referencedEnvelopes()).map((envelope) => blobRefKey(blobRef(envelope))))
    let dropped = 0
    for (const ref of new Map(candidates.map((c) => [blobRefKey(c), c])).values()) {
      if (live.has(blobRefKey(ref))) continue
      await this.deleteBlob(ref)
      dropped++
    }
    return dropped
  }

  /**
   * Every payload envelope this device refers to: each message's attachment,
   * and each sticker in each pack.
   *
   * What sweeps and deletions decide by, so it must not miss anything. A row
   * that cannot be opened while the vault is unlocked is corrupt, and its
   * payload unreadable anyway. One that cannot be opened because the vault
   * locked mid-scan would look like a row that refers to nothing — so a lock
   * fails the scan, and whatever depended on it, rather than let it finish.
   */
  async #referencedEnvelopes(): Promise<BlobEnvelope[]> {
    this.assertUnlocked()
    const found = await this.#attachmentsOf(this.db.messages.toCollection())
    for (const row of await this.db.packs.toArray()) {
      const pack = this.decodePack(row)
      if (!pack) this.assertUnlocked()
      for (const sticker of pack?.stickers ?? []) found.push(sticker)
    }
    return found
  }

  /**
   * The attachments of these message rows. Throws if the vault locks while
   * they are read — after the scan, never inside it: Dexie drops an error
   * thrown from an `each` callback, and the scan would end quietly short.
   */
  async #attachmentsOf(rows: {
    each(visit: (row: MessageRow) => void): PromiseLike<unknown>
  }): Promise<BlobEnvelope[]> {
    const found: BlobEnvelope[] = []
    let lockedMidScan = false
    await rows.each((row) => {
      const message = this.decodeMessage(row)
      if (message?.attachment) found.push(message.attachment)
      else if (!message && !this.vault.isUnlocked) lockedMidScan = true
    })
    if (lockedMidScan) throw new VaultLockedError()
    return found
  }

  /** Enforce the retention policy. Runs on unlock and once a day thereafter. */
  async applyRetention(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0
    const cutoff = coarsenMs(Date.now() - retentionDays * DAY)
    const expiring = (await this.db.messages.where('tsCoarse').below(cutoff).primaryKeys()) as string[]
    if (expiring.length === 0) return 0
    await this.db.messages.bulkDelete(expiring)
    // Reactions outliving the message they point at would accumulate
    // unreachable rows forever. Sequenced for the same reason as `deleteMessage`.
    await this.db.reactions.where('messageId').anyOf(expiring).delete()
    await this.db.updates.where('targetId').anyOf(expiring).delete()
    return expiring.length
  }

  /**
   * Drop every payload copy not in `referenced`, and written before
   * `writtenBefore`.
   *
   * Rows from before ADR-052 that have not been moved yet are never touched:
   * they are keyed by payload, so nothing could be referenced as them, and
   * the migration will read them at the next start.
   */
  async pruneOrphanBlobs(referenced: Iterable<BlobRef>, writtenBefore = Infinity): Promise<number> {
    const live = new Set([...referenced].map((ref) => this.blobKey(ref)))
    const orphans: string[] = []
    await this.db.blobs.each((row) => {
      if (row.enc && !live.has(row.id) && row.updatedAt < writtenBefore) orphans.push(row.id)
    })
    if (orphans.length === 0) return 0
    await this.db.blobChunks.where('blob').anyOf(orphans).delete()
    await this.db.blobs.bulkDelete(orphans)
    return orphans.length
  }

  async stats(): Promise<{
    messages: number
    contacts: number
    conversations: number
    outbox: number
    blobs: number
    blobBytes: number
  }> {
    const [messages, contacts, conversations, outbox, blobs, blobBytes] = await Promise.all([
      this.db.messages.count(),
      this.db.contacts.count(),
      this.db.conversations.count(),
      this.db.outbox.count(),
      this.db.blobs.count(),
      this.blobBytes(),
    ])
    return { messages, contacts, conversations, outbox, blobs, blobBytes }
  }
}

export type { MessageDirection, MessageStatus }
