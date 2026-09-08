import { describe, expect, it, vi } from 'vitest'
import { makeVault, type TestVault } from './helpers'
import type { Message } from '@/core/models/types'
import { blindId } from '@/core/crypto/vaultCrypto'
import { blobRef, openChunk, sealBlob, type BlobEnvelope, type BlobRef } from '@/core/crypto/blobCrypto'
import type { Attachment } from '@/core/models/attachment'

const SELF = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const HOUR = 60 * 60 * 1000

const messageId = (n: number) => n.toString(16).padStart(64, '0')

function build(convoId: string, index: number, ts: number): Message {
  return {
    id: messageId(index),
    convoId,
    direction: index % 2 === 0 ? 'out' : 'in',
    status: index % 2 === 0 ? 'sent' : 'delivered',
    ts,
    tsCoarse: 0,
    body: `message ${index}`,
    authorPubkey: index % 2 === 0 ? SELF : PEER,
  }
}

describe('conversation paging', () => {
  it('returns the newest slice, oldest-first', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 60; i++) await t.repo.putMessage(build(convo.id, i, base + i * HOUR))

    const page = await t.repo.listMessages(convo.id, 10)
    expect(page).toHaveLength(10)
    expect(page.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${50 + i}`))
    await t.destroy()
  })

  it('decrypts only what it returns, not the whole history', async () => {
    // The point of walking the [convoId+tsCoarse] index backwards: opening a
    // conversation with years of history must not decrypt years of history.
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.UTC(2024, 0, 1)
    for (let i = 0; i < 400; i++) await t.repo.putMessage(build(convo.id, i, base + i * HOUR))

    let decryptions = 0
    const realOpen = t.vault.openRecord.bind(t.vault)
    t.vault.openRecord = ((blob: Uint8Array, aad: string) => {
      if (aad.startsWith('textor/messages/')) decryptions += 1
      return realOpen(blob, aad)
    }) as typeof t.vault.openRecord

    const page = await t.repo.listMessages(convo.id, 50)
    expect(page).toHaveLength(50)
    // 50 asked for, plus the fixed 64-row boundary over-read.
    expect(decryptions).toBeLessThanOrEqual(50 + 64)
    expect(decryptions).toBeLessThan(400)

    t.vault.openRecord = realOpen
    await t.destroy()
  }, 60_000)

  it('pages backwards with beforeTs without dropping boundary messages', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 40; i++) await t.repo.putMessage(build(convo.id, i, base + i * HOUR))

    const newest = await t.repo.listMessages(convo.id, 10)
    const oldest = newest[0] as Message
    const previous = await t.repo.listMessages(convo.id, 10, oldest.ts)

    expect(previous).toHaveLength(10)
    // The two pages must be contiguous with no gap and no overlap.
    expect(previous.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${20 + i}`))
    await t.destroy()
  })

  it('keeps messages within one hour bucket in exact order', async () => {
    // The index is hour-granular, so ordering inside a bucket is settled after
    // decryption. Without the over-read, a page boundary could scramble these.
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.UTC(2026, 5, 1, 12, 0, 0)
    for (let i = 0; i < 20; i++) await t.repo.putMessage(build(convo.id, i, base + i * 137))

    expect((await t.repo.listMessages(convo.id, 20)).map((m) => m.body)).toEqual(
      Array.from({ length: 20 }, (_, i) => `message ${i}`),
    )
    await t.destroy()
  })

  it('returns the full history for a backup', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 250; i++) await t.repo.putMessage(build(convo.id, i, base + i * HOUR))

    const all = await t.repo.allMessages(convo.id)
    expect(all).toHaveLength(250)
    expect(all[0]?.body).toBe('message 0')
    expect(all[249]?.body).toBe('message 249')
    await t.destroy()
  }, 60_000)

  it('is empty for a conversation with no messages', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    expect(await t.repo.listMessages(convo.id)).toEqual([])
    expect(await t.repo.allMessages(convo.id)).toEqual([])
    await t.destroy()
  })
})

describe('batched status updates', () => {
  it('advances many messages in one pass and reports what changed', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const base = Date.now() - 100 * HOUR
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const message = {
        ...build(convo.id, i, base + i * HOUR),
        direction: 'out' as const,
        status: 'sent' as const,
      }
      await t.repo.putMessage(message)
      ids.push(message.id)
    }

    const updated = await t.repo.advanceMessageStatuses(ids, 'read')
    expect(updated).toHaveLength(20)
    for (const message of await t.repo.listMessages(convo.id, 50)) {
      expect(message.status).toBe('read')
    }
    await t.destroy()
  })

  it('does not move a status backwards, and reports nothing changed', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const message = { ...build(convo.id, 1, Date.now()), direction: 'out' as const, status: 'read' as const }
    await t.repo.putMessage(message)

    expect(await t.repo.advanceMessageStatuses([message.id], 'delivered')).toEqual([])
    expect((await t.repo.getMessage(message.id))?.status).toBe('read')
    await t.destroy()
  })

  it('ignores ids that do not exist', async () => {
    const t = await makeVault()
    expect(await t.repo.advanceMessageStatuses([messageId(999)], 'read')).toEqual([])
    expect(await t.repo.advanceMessageStatuses([], 'read')).toEqual([])
    await t.destroy()
  })

  it('retries a failed message even though failed ranks lowest', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    const message = {
      ...build(convo.id, 2, Date.now()),
      direction: 'out' as const,
      status: 'failed' as const,
    }
    await t.repo.putMessage(message)

    const updated = await t.repo.advanceMessageStatuses([message.id], 'queued')
    expect(updated).toHaveLength(1)
    expect(updated[0]?.status).toBe('queued')
    await t.destroy()
  })
})

describe('drafts', () => {
  it('stores and clears an unsent draft', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)

    await t.repo.updateConversation(convo.id, { draft: 'half-typed thought' })
    expect((await t.repo.getConversation(convo.id))?.draft).toBe('half-typed thought')

    await t.repo.updateConversation(convo.id, { draft: undefined })
    expect((await t.repo.getConversation(convo.id))?.draft).toBeUndefined()
    await t.destroy()
  })

  it('has nowhere to store a draft until a conversation row exists', async () => {
    // Regression: a conversation row is normally created by the first message,
    // so someone who opens a brand-new contact and types without sending had
    // their draft silently dropped. The store now creates the row; this pins
    // the repository behaviour that made the bug possible.
    const t = await makeVault()
    const convoId = t.repo.conversationId(SELF, PEER)
    expect(await t.repo.getConversation(convoId)).toBeNull()

    await t.repo.updateConversation(convoId, { draft: 'lost text' })
    expect(await t.repo.getConversation(convoId)).toBeNull()

    const convo = await t.repo.ensureConversation(SELF, PEER)
    await t.repo.updateConversation(convo.id, { draft: 'kept text' })
    expect((await t.repo.getConversation(convo.id))?.draft).toBe('kept text')
    await t.destroy()
  })

  it('keeps the draft encrypted at rest', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation(SELF, PEER)
    await t.repo.updateConversation(convo.id, { draft: 'UNSENT-SECRET-TEXT' })

    const rows = await t.db.conversations.toArray()
    expect(JSON.stringify(rows)).not.toContain('UNSENT-SECRET-TEXT')
    await t.destroy()
  })
})

describe('attachment payload storage', () => {
  const chunk = (byte: number, len = 32): Uint8Array => new Uint8Array(len).fill(byte)
  const BLOB: BlobRef = { id: 'a'.repeat(64), copy: 'c'.repeat(32) }

  it('reports an incomplete payload as incomplete', async () => {
    // The completeness check was written with `new Array(n)` plus `.some()`,
    // and `.some()` skips holes — so a payload missing its middle chunk read as
    // whole and the caller concatenated undefined.
    const t = await makeVault()
    try {
      await t.repo.putBlobChunk(BLOB, 0, chunk(1), { total: 3, size: 96 })
      await t.repo.putBlobChunk(BLOB, 2, chunk(3), { total: 3, size: 96 })

      expect(await t.repo.getBlobChunks(BLOB, 3)).toBeNull()
      expect(await t.repo.missingChunks(BLOB, 3)).toEqual([1])
    } finally {
      await t.destroy()
    }
  })

  it('returns chunks in index order once every one is present', async () => {
    const t = await makeVault()
    try {
      for (const seq of [2, 0, 1]) {
        await t.repo.putBlobChunk(BLOB, seq, chunk(seq + 1), { total: 3, size: 96 })
      }
      const chunks = await t.repo.getBlobChunks(BLOB, 3)
      expect(chunks?.map((c) => c[0])).toEqual([1, 2, 3])
      expect(await t.repo.missingChunks(BLOB, 3)).toEqual([])
    } finally {
      await t.destroy()
    }
  })

  it('counts a duplicate chunk once', async () => {
    // Relays re-deliver routinely; a counter that a duplicate could bump would
    // complete a transfer that is still missing a piece.
    const t = await makeVault()
    try {
      await t.repo.putBlobChunk(BLOB, 0, chunk(1), { total: 2, size: 64 })
      const again = await t.repo.putBlobChunk(BLOB, 0, chunk(1), { total: 2, size: 64 })
      expect(again.received).toBe(1)
      expect(again.complete).toBe(0)
    } finally {
      await t.destroy()
    }
  })

  it('removes a payload and every chunk of it', async () => {
    const t = await makeVault()
    try {
      for (const seq of [0, 1]) {
        await t.repo.putBlobChunk(BLOB, seq, chunk(seq), { total: 2, size: 64 })
      }
      await t.repo.deleteBlob(BLOB)
      expect(await t.repo.getBlobManifest(BLOB)).toBeUndefined()
      expect(await t.repo.getBlobChunk(BLOB, 0)).toBeNull()
      expect((await t.repo.stats()).blobs).toBe(0)
    } finally {
      await t.destroy()
    }
  })
})

/*
 * One file, two keys: the same photo sent twice, or by two people, is two
 * sealed copies under one id. They are stored apart, and before ADR-052 they
 * were not.
 */
describe('attachment payloads by copy', () => {
  const bytes = new Uint8Array(40_000).map((_, i) => (i * 13 + 5) % 251)
  const PEER = 'b'.repeat(64)

  const attachmentOf = (envelope: BlobEnvelope): Attachment => ({
    ...envelope,
    kind: 'file',
    mime: 'application/octet-stream',
  })
  const store = async (t: TestVault, sealed: ReturnType<typeof sealBlob>) => {
    for (let seq = 0; seq < sealed.envelope.chunks; seq++) {
      await t.repo.putBlobChunk(blobRef(sealed.envelope), seq, sealed.chunk(seq), {
        total: sealed.envelope.chunks,
        size: sealed.envelope.size,
      })
    }
  }
  const read = async (t: TestVault, envelope: BlobEnvelope) => {
    const chunks = await t.repo.getBlobChunks(blobRef(envelope), envelope.chunks)
    return chunks?.map((c, seq) => openChunk(envelope, seq, c))
  }
  const message = (id: string, envelope: BlobEnvelope): Message => ({
    id,
    convoId: 'convo',
    direction: 'in',
    status: 'delivered',
    ts: Date.now(),
    tsCoarse: 0,
    body: '',
    authorPubkey: PEER,
    attachment: attachmentOf(envelope),
  })

  it('keeps two copies of one file apart, and finds both by the file', async () => {
    const t = await makeVault()
    try {
      const a = sealBlob(bytes)
      const b = sealBlob(bytes)
      await store(t, a)
      await store(t, b)
      expect(await read(t, a.envelope)).toHaveLength(a.envelope.chunks)
      expect(await read(t, b.envelope)).toHaveLength(b.envelope.chunks)
      const copies = await t.repo.copiesOf(a.envelope.id)
      expect(copies.map((c) => c.copy).sort()).toEqual(
        [blobRef(a.envelope).copy, blobRef(b.envelope).copy].sort(),
      )
      expect(await t.repo.copiesOf('f'.repeat(64))).toEqual([])
      // A manifest it cannot open is skipped, not fatal.
      const row = (await t.db.blobs.toArray())[0]!
      await t.db.blobs.put({ ...row, enc: new Uint8Array(48) })
      expect(await t.repo.copiesOf(a.envelope.id)).toHaveLength(1)
    } finally {
      await t.destroy()
    }
  })

  it('deletes a copy with its last message, and never another copy of the file', async () => {
    const t = await makeVault()
    try {
      const a = sealBlob(bytes)
      const b = sealBlob(bytes)
      await store(t, a)
      await store(t, b)
      await t.repo.putMessage(message('1'.repeat(64), a.envelope))
      await t.repo.putMessage(message('2'.repeat(64), a.envelope)) // a forward: the same copy
      await t.repo.putMessage(message('3'.repeat(64), b.envelope))

      expect(await t.repo.deleteMessageAndPayload('1'.repeat(64))).toEqual({ blobDeleted: false })
      expect(await t.repo.deleteMessageAndPayload('2'.repeat(64))).toEqual({ blobDeleted: true })
      expect(await t.repo.getBlobManifest(blobRef(a.envelope))).toBeUndefined()
      expect(await read(t, b.envelope)).toHaveLength(b.envelope.chunks)
      expect(await t.repo.deleteMessageAndPayload('4'.repeat(64))).toEqual({ blobDeleted: false })
    } finally {
      await t.destroy()
    }
  })

  it('sweeps copies nothing refers to', async () => {
    const t = await makeVault()
    try {
      const a = sealBlob(bytes)
      const b = sealBlob(bytes)
      await store(t, a)
      await store(t, b)
      expect(await t.repo.pruneOrphanBlobs([blobRef(a.envelope)])).toBe(1)
      expect(await t.repo.pruneOrphanBlobs([blobRef(a.envelope)])).toBe(0)
      expect(await read(t, a.envelope)).toHaveLength(a.envelope.chunks)
      expect(await t.repo.getBlobManifest(blobRef(b.envelope))).toBeUndefined()
    } finally {
      await t.destroy()
    }
  })

  it('sweeps only what nothing refers to, and nothing written in the last hour', async () => {
    const t = await makeVault()
    try {
      const used = sealBlob(bytes)
      const sticker = sealBlob(bytes.slice(0, 5000))
      const unused = sealBlob(bytes.slice(0, 7000))
      const fresh = sealBlob(bytes.slice(0, 9000))
      for (const sealed of [used, sticker, unused]) await store(t, sealed)
      await t.repo.putMessage(message('1'.repeat(64), used.envelope))
      await t.repo.putPack({
        id: 'p',
        name: 'P',
        createdAt: 1,
        stickers: [{ ...sticker.envelope, mime: 'image/webp' }],
      })
      // A message and a pack that cannot be opened, with the vault unlocked:
      // corrupt, their payloads unreadable anyway. The sweep carries on.
      await t.db.messages.put({
        id: '9'.repeat(64),
        convoId: 'c',
        dir: 'in',
        status: 'delivered',
        tsCoarse: 0,
        enc: new Uint8Array(64),
      })
      await t.db.packs.put({ id: 'broken', createdAt: 2, enc: new Uint8Array(64) })
      // A row from before ADR-052, not yet moved.
      await t.db.blobs.put({
        id: 'legacy',
        total: 1,
        size: 1,
        received: 1,
        complete: 1,
        outgoing: 0,
        updatedAt: 0,
      })

      const later = Date.now() + 2 * 3_600_000
      await store(t, fresh) // written "just now", from where the sweep stands
      await t.db.blobs.update(t.repo.blobKey(blobRef(fresh.envelope)), { updatedAt: later - 60_000 })

      expect(await t.repo.pruneUnreferencedBlobs(later)).toBe(1)
      expect(await t.repo.getBlobManifest(blobRef(unused.envelope))).toBeUndefined()
      for (const kept of [used, sticker, fresh]) expect(await read(t, kept.envelope)).toBeDefined()
      expect(await t.db.blobs.get('legacy')).toBeDefined()
    } finally {
      await t.destroy()
    }
  })

  it.each([
    ['a message', 1],
    ['a pack', 2],
  ])('deletes nothing if the vault locks while it reads %s', async (_what, lockAt) => {
    const t = await makeVault()
    try {
      const used = sealBlob(bytes)
      const unused = sealBlob(bytes.slice(0, 7000))
      await store(t, used)
      await store(t, unused)
      await t.repo.putMessage(message('1'.repeat(64), used.envelope))
      await t.repo.putPack({ id: 'p', name: 'P', createdAt: 1, stickers: [] })
      const open = t.vault.openRecord.bind(t.vault)
      let calls = 0
      vi.spyOn(t.vault, 'openRecord').mockImplementation((blob, label) => {
        if (++calls === lockAt) t.vault.lock()
        return open(blob, label)
      })
      await expect(t.repo.pruneUnreferencedBlobs(Date.now() + 2 * 3_600_000)).rejects.toThrow(/locked/)
      expect(await t.db.blobs.count()).toBe(2)
    } finally {
      vi.restoreAllMocks()
      await t.destroy()
    }
  })

  it('frees a deleted conversation’s payloads, except a copy still used elsewhere', async () => {
    const t = await makeVault()
    try {
      const only = sealBlob(bytes)
      const forwarded = sealBlob(bytes.slice(0, 6000))
      const sticker = sealBlob(bytes.slice(0, 5000))
      for (const sealed of [only, forwarded, sticker]) await store(t, sealed)
      const inX = (id: string, envelope: BlobEnvelope) => ({ ...message(id, envelope), convoId: 'x' })
      await t.repo.putMessage(inX('1'.repeat(64), only.envelope))
      await t.repo.putMessage(inX('2'.repeat(64), forwarded.envelope))
      await t.repo.putMessage(inX('3'.repeat(64), sticker.envelope))
      await t.repo.putMessage(inX('4'.repeat(64), only.envelope)) // the same copy twice in one conversation
      await t.repo.putMessage({ ...message('5'.repeat(64), forwarded.envelope), convoId: 'y' })
      await t.repo.putPack({
        id: 'p',
        name: 'P',
        createdAt: 1,
        stickers: [{ ...sticker.envelope, mime: 'image/webp' }],
      })
      await t.db.messages.put({
        id: '9'.repeat(64),
        convoId: 'x',
        dir: 'in',
        status: 'delivered',
        tsCoarse: 0,
        enc: new Uint8Array(64),
      })

      await t.repo.deleteConversation('x')
      expect(await t.repo.getBlobManifest(blobRef(only.envelope))).toBeUndefined()
      expect(await read(t, forwarded.envelope)).toBeDefined()
      expect(await read(t, sticker.envelope)).toBeDefined()
      // A conversation with nothing attached costs no scan at all.
      await t.repo.deleteConversation('empty')
    } finally {
      await t.destroy()
    }
  })

  it('refuses to delete a conversation while locked, rather than lose track of its payloads', async () => {
    const t = await makeVault()
    try {
      const only = sealBlob(bytes)
      await store(t, only)
      await t.repo.putMessage({ ...message('1'.repeat(64), only.envelope), convoId: 'x' })
      t.vault.lock()
      await expect(t.repo.deleteConversation('x')).rejects.toThrow(/locked/)
      expect(await t.db.messages.count()).toBe(1)
      expect(await t.db.blobs.count()).toBe(1)
    } finally {
      await t.destroy()
    }
  })

  it('moves payloads stored by id alone to their copy, once', async () => {
    const t = await makeVault()
    try {
      const legacy = (id: string) => blindId(t.vault.keys.indexKey, 'blob', id)
      const putLegacy = async (sealed: ReturnType<typeof sealBlob>, seqs: number[]) => {
        const key = legacy(sealed.envelope.id)
        for (const seq of seqs) {
          await t.db.blobChunks.put({ id: `${key}:${seq}`, blob: key, seq, data: sealed.chunk(seq) })
        }
        await t.db.blobs.put({
          id: key,
          total: sealed.envelope.chunks,
          size: sealed.envelope.size,
          received: seqs.length,
          complete: seqs.length === sealed.envelope.chunks ? 1 : 0,
          outgoing: 0,
          updatedAt: Date.now(),
        })
      }
      // The collision itself: two messages, one file, and only the second
      // copy's chunks survived under the shared key.
      const first = sealBlob(bytes)
      const second = sealBlob(bytes)
      await t.repo.putMessage(message('1'.repeat(64), first.envelope))
      await t.repo.putMessage(message('2'.repeat(64), second.envelope))
      await putLegacy(second, [0, 1, 2])
      // A sticker, a transfer that had not started, and bytes nothing names.
      const sticker = sealBlob(bytes.slice(0, 5000))
      await t.repo.putPack({
        id: 'pack',
        name: 'Pack',
        createdAt: 1,
        stickers: [{ ...sticker.envelope, mime: 'image/webp' }],
      })
      await putLegacy(sticker, [0])
      const pending = sealBlob(bytes.slice(0, 20_000))
      await t.repo.putMessage(message('3'.repeat(64), pending.envelope))
      await putLegacy(pending, [])
      const stray = sealBlob(new Uint8Array(100))
      await putLegacy(stray, [0])
      // A row written since, which the migration leaves alone.
      const fresh = sealBlob(new Uint8Array(200))
      await store(t, fresh)
      // And a message with nothing attached.
      await t.repo.putMessage({ ...message('5'.repeat(64), stray.envelope), attachment: undefined })
      // Until they move, the old rows cannot be offered by copy.
      expect(await t.repo.copiesOf(second.envelope.id)).toEqual([])

      expect(await t.repo.migrateBlobStore()).toEqual({ moved: 2, dropped: 2 })
      expect(await read(t, second.envelope)).toHaveLength(second.envelope.chunks)
      expect(await t.repo.getBlobManifest(blobRef(first.envelope))).toBeUndefined()
      expect(await read(t, sticker.envelope)).toHaveLength(1)
      expect(await read(t, fresh.envelope)).toHaveLength(1)
      expect(await t.repo.missingChunks(blobRef(pending.envelope), pending.envelope.chunks)).toHaveLength(2)
      expect((await t.db.blobs.toArray()).every((row) => row.enc)).toBe(true)
      expect(await t.db.blobChunks.where('blob').equals(legacy(stray.envelope.id)).count()).toBe(0)

      // Done once: a later start finds nothing to do, whatever is there.
      await putLegacy(stray, [0])
      expect(await t.repo.migrateBlobStore()).toEqual({ moved: 0, dropped: 0 })
    } finally {
      await t.destroy()
    }
  })

  it('marks a vault with nothing to move as done', async () => {
    const t = await makeVault()
    try {
      expect(await t.repo.migrateBlobStore()).toEqual({ moved: 0, dropped: 0 })
      expect(await t.db.settings.get('blobstore')).toBeDefined()
    } finally {
      await t.destroy()
    }
  })
})
