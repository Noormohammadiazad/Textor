import Dexie from 'dexie'
import { blindId, contactId as blindContactId, conversationId, seenEventId } from '../crypto/vaultCrypto'
import { coarsenMs, DAY, HOUR } from '../util/time'
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
  type OutboxItem,
  type RelayEntry,
  type RelayHealth,
} from '../models/types'
import type { BlobRow, MessageDirection, MessageRow, MessageStatus } from './db'
import { toBytes, type Vault } from './vault'

const IDENTITY_ID = 'self'
const SETTINGS_ID = 'app'
const SYNC_ID = 'sync'

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

  async getConversation(id: string): Promise<Conversation | null> {
    this.assertUnlocked()
    const row = await this.db.conversations.get(id)
    if (!row) return null
    const body = this.vault.openRecord<Pick<Conversation, 'peerPubkey' | 'draft'>>(
      toBytes(row.enc),
      aad('conversations', id),
    )
    return {
      id,
      peerPubkey: body.peerPubkey,
      draft: body.draft,
      lastActivity: row.lastActivity,
      unread: row.unread,
      pinned: row.pinned === 1,
    }
  }

  async listConversations(): Promise<Conversation[]> {
    this.assertUnlocked()
    const rows = await this.db.conversations.orderBy('lastActivity').reverse().toArray()
    const out: Conversation[] = []
    for (const row of rows) {
      try {
        const body = this.vault.openRecord<Pick<Conversation, 'peerPubkey' | 'draft'>>(
          toBytes(row.enc),
          aad('conversations', row.id),
        )
        out.push({
          id: row.id,
          peerPubkey: body.peerPubkey,
          draft: body.draft,
          lastActivity: row.lastActivity,
          unread: row.unread,
          pinned: row.pinned === 1,
        })
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
      const created: Conversation = { id, peerPubkey, lastActivity: Date.now(), unread: 0, pinned: false }
      await this.writeConversation(created)
      return created
    })
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

  async markConversationRead(id: string): Promise<void> {
    await this.vault.transaction(async () => {
      const existing = await this.getConversation(id)
      if (!existing || existing.unread === 0) return
      await this.writeConversation({ ...existing, unread: 0 })
    })
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.conversations, this.db.messages, this.db.outbox, async () => {
      await this.db.messages.where('convoId').equals(id).delete()
      await this.db.outbox.where('convoId').equals(id).delete()
      await this.db.conversations.delete(id)
    })
  }

  // --- messages -------------------------------------------------------------

  private decodeMessage(row: MessageRow): Message | null {
    try {
      const body = this.vault.openRecord<
        Pick<Message, 'ts' | 'body' | 'authorPubkey' | 'replyTo' | 'via' | 'relayAcks' | 'error'>
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

  async deleteMessage(id: string): Promise<void> {
    await this.db.messages.delete(id)
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
      try {
        const body = this.vault.openRecord<
          Pick<OutboxItem, 'peerPubkey' | 'rumorJson' | 'relays' | 'ephemeral' | 'lastError'>
        >(toBytes(row.enc), aad('outbox', row.id))
        out.push({
          id: row.id,
          convoId: row.convoId,
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt,
          createdAt: row.createdAt,
          ...body,
        })
      } catch {
        // Undecryptable queue entries can never be sent; drop them.
        await this.db.outbox.delete(row.id)
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async countOutbox(): Promise<number> {
    return this.db.outbox.count()
  }

  async dequeue(id: string): Promise<void> {
    await this.db.outbox.delete(id)
  }

  // --- seen-event dedup -----------------------------------------------------

  async hasSeen(eventId: string): Promise<boolean> {
    return (await this.db.seen.get(seenEventId(this.indexKey, eventId))) !== undefined
  }

  async markSeen(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return
    const ts = Date.now()
    await this.db.seen.bulkPut(eventIds.map((eventId) => ({ id: seenEventId(this.indexKey, eventId), ts })))
  }

  /** Relays are asked to expire wraps after 30 days; 45 gives a safe margin. */
  async pruneSeen(olderThanMs = 45 * DAY): Promise<number> {
    return this.db.seen
      .where('ts')
      .below(Date.now() - olderThanMs)
      .delete()
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

  // --- sync cursor ----------------------------------------------------------

  /**
   * How far the inbox has been read, in unix seconds. Encrypted like everything
   * else: on its own it would tell a device attacker exactly when this person
   * last used the app.
   */
  async getSyncCursor(): Promise<number> {
    this.assertUnlocked()
    const row = await this.db.settings.get(SYNC_ID)
    if (!row) return 0
    try {
      return this.vault.openRecord<{ lastSyncSec: number }>(toBytes(row.enc), aad('settings', SYNC_ID))
        .lastSyncSec
    } catch {
      return 0
    }
  }

  async setSyncCursor(lastSyncSec: number): Promise<void> {
    await this.db.settings.put({
      id: SYNC_ID,
      enc: this.vault.sealRecord({ lastSyncSec }, aad('settings', SYNC_ID)),
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
   * Blinded key for a payload.
   *
   * The blob id is the SHA-256 of the plaintext, so an unblinded key would let
   * a device attacker test whether a known file — a leaked document, a specific
   * image — is present, without ever breaking a ciphertext.
   */
  blobKey(blobId: string): string {
    this.assertUnlocked()
    return blindId(this.indexKey, 'blob', blobId)
  }

  async getBlobManifest(blobId: string): Promise<BlobRow | undefined> {
    return this.db.blobs.get(this.blobKey(blobId))
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
    blobId: string,
    seq: number,
    data: Uint8Array,
    meta: { total: number; size: number; outgoing?: boolean },
  ): Promise<BlobRow> {
    const key = this.blobKey(blobId)
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
    }
    await this.db.blobs.put(next)
    return next
  }

  /** Chunk indexes still missing, for a resend request. */
  async missingChunks(blobId: string, total: number): Promise<number[]> {
    const key = this.blobKey(blobId)
    const present = new Set<number>()
    await this.db.blobChunks
      .where('blob')
      .equals(key)
      .each((row) => present.add(row.seq))
    const missing: number[] = []
    for (let i = 0; i < total; i++) if (!present.has(i)) missing.push(i)
    return missing
  }

  async getBlobChunk(blobId: string, seq: number): Promise<Uint8Array | null> {
    const row = await this.db.blobChunks.get(`${this.blobKey(blobId)}:${seq}`)
    return row?.data ?? null
  }

  /**
   * Every chunk in order, or `null` if the payload is incomplete.
   *
   * Returned as ciphertext: decryption needs the per-blob key, which lives in
   * the sealed message row, so it belongs to the caller that already has the
   * message in hand.
   */
  async getBlobChunks(blobId: string, total: number): Promise<Uint8Array[] | null> {
    const key = this.blobKey(blobId)
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
   * Delete a message and the payload it referenced, unless another message
   * still points at the same payload.
   *
   * Forwarding a photo does not copy it, so blob ids are shared. Deleting the
   * bytes out from under a surviving message would leave a permanently broken
   * bubble that no resend can fix, because the sender considers it delivered.
   */
  async deleteMessageAndPayload(id: string): Promise<{ blobDeleted: boolean }> {
    const message = await this.getMessage(id)
    const blobId = message?.attachment?.id
    await this.deleteMessage(id)
    if (!blobId) return { blobDeleted: false }

    // Scanned across every conversation, not just this one: a payload can be
    // referenced by a forward into a different chat.
    let stillReferenced = false
    await this.db.messages.each((row) => {
      if (stillReferenced || row.id === id) return
      const other = this.decodeMessage(row)
      if (other?.attachment?.id === blobId) stillReferenced = true
    })
    if (stillReferenced) return { blobDeleted: false }
    await this.deleteBlob(blobId)
    return { blobDeleted: true }
  }

  async deleteBlob(blobId: string): Promise<void> {
    const key = this.blobKey(blobId)
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

  // --- maintenance ----------------------------------------------------------

  /** Enforce the retention policy. Runs on unlock and once a day thereafter. */
  async applyRetention(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0
    const cutoff = coarsenMs(Date.now() - retentionDays * DAY)
    return this.db.messages.where('tsCoarse').below(cutoff).delete()
  }

  /**
   * Drop payloads no surviving message refers to.
   *
   * Attachments are not deleted alongside their message, because the same
   * payload can be referenced by several — forwarding a photo does not copy it.
   * So the sweep is by reachability, run after retention has removed messages.
   */
  async pruneOrphanBlobs(referenced: ReadonlySet<string>): Promise<number> {
    const live = new Set([...referenced].map((id) => this.blobKey(id)))
    const orphans: string[] = []
    await this.db.blobs.each((row) => {
      if (!live.has(row.id)) orphans.push(row.id)
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
