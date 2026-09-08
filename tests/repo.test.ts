import { describe, expect, it } from 'vitest'
import { makeVault } from './helpers'
import type { Message } from '@/core/models/types'

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
  const BLOB = 'a'.repeat(64)

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
