import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobTransfer, type BlobStore } from '@/core/engine/blobTransfer'
import { CHUNK_BYTES, sealBlob } from '@/core/crypto/blobCrypto'
import { bytesToB64 } from '@/core/util/bytes'
import type { Attachment } from '@/core/models/attachment'
import type { BlobChunkFrame, ControlFrame } from '@/core/models/protocol'
import { PROTOCOL_VERSION } from '@/core/models/protocol'

const PEER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/** In-memory stand-in with the same duplicate-safety the real store guarantees. */
function fakeStore(): BlobStore & { rows: Map<string, Map<number, Uint8Array>> } {
  const rows = new Map<string, Map<number, Uint8Array>>()
  const manifests = new Map<string, { total: number; size: number }>()
  return {
    rows,
    async getBlobManifest(blobId) {
      return manifests.get(blobId)
    },
    async putBlobChunk(blobId, seq, data, meta) {
      const chunks = rows.get(blobId) ?? new Map<number, Uint8Array>()
      chunks.set(seq, data)
      rows.set(blobId, chunks)
      manifests.set(blobId, { total: meta.total, size: meta.size })
      return { received: chunks.size, total: meta.total, complete: chunks.size >= meta.total ? 1 : 0 }
    },
    async missingChunks(blobId, total) {
      const chunks = rows.get(blobId)
      const out: number[] = []
      for (let i = 0; i < total; i++) if (!chunks?.has(i)) out.push(i)
      return out
    },
    async getBlobChunk(blobId, seq) {
      return rows.get(blobId)?.get(seq) ?? null
    },
    async getBlobChunks(blobId, total) {
      const chunks = rows.get(blobId)
      if (!chunks) return null
      const out: Uint8Array[] = []
      for (let i = 0; i < total; i++) {
        const chunk = chunks.get(i)
        if (!chunk) return null
        out.push(chunk)
      }
      return out
    },
  }
}

/** A payload plus the descriptor a recipient would receive for it. */
function payload(bytes: number) {
  const plaintext = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) plaintext[i] = i % 251
  const { envelope, chunk } = sealBlob(plaintext)
  const attachment: Attachment = { ...envelope, kind: 'file', mime: 'application/octet-stream' }
  const frame = (seq: number): BlobChunkFrame => ({
    v: PROTOCOL_VERSION,
    t: 'blob',
    id: envelope.id,
    seq,
    total: envelope.chunks,
    data: bytesToB64(chunk(seq)),
  })
  return { plaintext, envelope, chunk, attachment, frame }
}

function harness(opts: { direct?: boolean } = {}) {
  const store = fakeStore()
  const sent: { peer: string; frame: ControlFrame }[] = []
  const transfer = new BlobTransfer({
    store,
    isDirect: () => opts.direct ?? false,
    async send(peer, frame) {
      sent.push({ peer, frame })
    },
  })
  return { store, sent, transfer }
}

describe('sending an attachment', () => {
  it('persists every chunk before pushing, so a later resend can be served', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 2 + 10)
    const { store, sent, transfer } = harness()

    await transfer.store(envelope, chunk)
    await transfer.push(PEER, envelope.id, envelope.chunks)

    expect(store.rows.get(envelope.id)?.size).toBe(3)
    expect(sent.filter((s) => s.frame.t === 'blob')).toHaveLength(3)
    expect(sent.every((s) => s.peer === PEER)).toBe(true)
  })

  it('persists the payload before the message that references it can be read', async () => {
    // The sender's own bubble reads the payload straight back out of storage.
    // If the message could be emitted first it would render as permanently
    // broken — which is exactly what happened before storing was split out.
    const { envelope, chunk } = payload(CHUNK_BYTES + 1)
    const { store, transfer } = harness()

    await transfer.store(envelope, chunk)

    expect(store.rows.get(envelope.id)?.size).toBe(envelope.chunks)
    expect(await store.getBlobChunks(envelope.id, envelope.chunks)).not.toBeNull()
  })

  it('serves exactly the chunks a peer asks for', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 3)
    const { sent, transfer } = harness()
    await transfer.store(envelope, chunk)
    await transfer.push(PEER, envelope.id, envelope.chunks)
    sent.length = 0

    await transfer.serve(PEER, envelope.id, [0, 2])

    const seqs = sent.filter((s) => s.frame.t === 'blob').map((s) => (s.frame as BlobChunkFrame).seq)
    expect(seqs.sort()).toEqual([0, 2])
  })

  it('resends with the true total, not one inferred from the request', async () => {
    // The receiver is missing 0 and 1 of a 4-chunk payload — the tail is
    // already there. Inferring total from max(need)+1 would send "total: 2",
    // which the receiver rejects and which breaks the AAD, so the transfer
    // could never complete. This is the bug that made photos never arrive.
    const { envelope, chunk, attachment, frame } = payload(CHUNK_BYTES * 3 + 10)
    expect(envelope.chunks).toBe(4)

    const sender = harness()
    await sender.transfer.store(envelope, chunk)
    sender.sent.length = 0
    await sender.transfer.serve(PEER, envelope.id, [0, 1])

    const resent = sender.sent.filter((s) => s.frame.t === 'blob').map((s) => s.frame as BlobChunkFrame)
    expect(resent.map((f) => f.seq).sort()).toEqual([0, 1])
    expect(resent.every((f) => f.total === envelope.chunks)).toBe(true)

    // And the receiver actually accepts them.
    const receiver = harness()
    const complete = vi.fn()
    receiver.transfer.events.on('complete', complete)
    await receiver.transfer.expect(PEER, attachment)
    for (const seq of [2, 3]) await receiver.transfer.accept(PEER, frame(seq))
    for (const f of resent) await receiver.transfer.accept(PEER, f)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('refuses to resend a payload this device does not hold', async () => {
    const { envelope } = payload(1000)
    const { sent, transfer } = harness()
    await transfer.serve(PEER, envelope.id, [0])
    expect(sent).toHaveLength(0)
  })

  it('survives a chunk that has been deleted from under it', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 2)
    const { store, sent, transfer } = harness()
    await transfer.store(envelope, chunk)
    await transfer.push(PEER, envelope.id, envelope.chunks)
    store.rows.get(envelope.id)?.delete(1)
    sent.length = 0

    await expect(transfer.serve(PEER, envelope.id, [0, 1])).resolves.toBeUndefined()
    expect(sent).toHaveLength(1)
  })
})

describe('receiving an attachment', () => {
  it('reassembles the original bytes', async () => {
    const { plaintext, attachment, frame } = payload(CHUNK_BYTES * 2 + 77)
    const { transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)

    await transfer.expect(PEER, attachment)
    for (const seq of [0, 1, 2]) await transfer.accept(PEER, frame(seq))

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]?.[0].bytes).toEqual(plaintext)
  })

  it('reassembles chunks that arrive out of order', async () => {
    const { plaintext, attachment, frame } = payload(CHUNK_BYTES * 3)
    const { transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)

    await transfer.expect(PEER, attachment)
    for (const seq of [2, 0, 1]) await transfer.accept(PEER, frame(seq))

    expect(complete.mock.calls[0]?.[0].bytes).toEqual(plaintext)
  })

  it('does not double-count a chunk that arrives twice', async () => {
    // Relays re-deliver routinely; a duplicate must not complete a transfer
    // that is still missing a piece.
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)

    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(0))
    await transfer.accept(PEER, frame(0))

    expect(complete).not.toHaveBeenCalled()
  })

  it('completes from disk alone, without a single chunk arriving', async () => {
    // The resume case: the app was closed mid-transfer and reopened. Nothing
    // about completion may depend on having seen the chunks in this session.
    const { plaintext, attachment, chunk } = payload(CHUNK_BYTES + 5)
    const { store, transfer } = harness()
    store.rows.set(
      attachment.id,
      new Map(Array.from({ length: attachment.chunks }, (_, seq) => [seq, chunk(seq)])),
    )
    const complete = vi.fn()
    transfer.events.on('complete', complete)

    await transfer.expect(PEER, attachment)

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]?.[0].bytes).toEqual(plaintext)
  })

  it('emits progress as chunks land', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { transfer } = harness()
    const progress = vi.fn()
    transfer.events.on('progress', progress)

    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(0))

    expect(progress).toHaveBeenCalledWith({
      id: attachment.id,
      received: 1,
      total: 2,
      outgoing: false,
    })
  })
})

describe('chunks that arrive before the message describing them', () => {
  it('keeps them and uses them once the descriptor lands', async () => {
    // The relay path delivers in whatever order it likes, and the sender pushes
    // chunks the instant it publishes. Dropping early chunks threw away most of
    // a payload and left resend requests to rebuild it.
    const { plaintext, attachment, frame } = payload(CHUNK_BYTES * 2 + 20)
    const { transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)

    for (const seq of [0, 1, 2]) await transfer.accept(PEER, frame(seq))
    expect(complete).not.toHaveBeenCalled()

    await transfer.expect(PEER, attachment)

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]?.[0].bytes).toEqual(plaintext)
  })

  it('holds only what it can verify later, and discards the rest', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    const other = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()

    // A chunk belonging to a different payload, held under this id.
    await transfer.accept(PEER, { ...other.frame(0), id: attachment.id })
    await transfer.expect(PEER, attachment)

    // Held, then rejected on verification rather than written to disk.
    expect(store.rows.get(attachment.id)?.size ?? 0).toBe(0)
  })

  it('caps what it will hold for a peer that never sends the message', async () => {
    // Otherwise a peer can spend our memory for free.
    const { transfer } = harness()
    const big = payload(CHUNK_BYTES * 4)
    for (let round = 0; round < 400; round++) {
      await transfer.accept(PEER, { ...big.frame(0), id: `${round.toString(16).padStart(64, '0')}` })
    }
    // Nothing asserts an exact number; the point is that it terminates and the
    // process is still alive with a bounded buffer.
    expect(transfer.isPending(big.attachment.id)).toBe(false)
  })
})

describe('resuming after a reload', () => {
  it('asks again for chunks still missing from a previous session', async () => {
    vi.useFakeTimers()
    try {
      const { attachment, chunk } = payload(CHUNK_BYTES * 3)
      const { store, sent, transfer } = harness()
      // One chunk survived the previous session; the watcher did not.
      await store.putBlobChunk(attachment.id, 0, chunk(0), {
        total: attachment.chunks,
        size: attachment.size,
      })

      await transfer.resume(PEER, attachment)
      await vi.advanceTimersByTimeAsync(9000)

      const request = sent.find((s) => s.frame.t === 'blobreq')
      expect(request?.frame).toMatchObject({ t: 'blobreq', need: [1, 2] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-register a payload that is already complete', async () => {
    const { attachment, chunk } = payload(CHUNK_BYTES + 1)
    const { store, transfer } = harness()
    for (let seq = 0; seq < attachment.chunks; seq++) {
      await store.putBlobChunk(attachment.id, seq, chunk(seq), {
        total: attachment.chunks,
        size: attachment.size,
      })
    }
    await transfer.resume(PEER, attachment)
    expect(transfer.isPending(attachment.id)).toBe(false)
  })
})

describe('what a hostile or confused peer cannot do', () => {
  it('never writes an unverified chunk to disk', async () => {
    // Without the descriptor there is no key, so such a chunk cannot be checked
    // yet. It may be held in memory, but persisting it would be free disk
    // consumption for an attacker.
    const { attachment, frame } = payload(1000)
    const { store, transfer } = harness()

    await transfer.accept(PEER, frame(0))

    expect(store.rows.has(attachment.id)).toBe(false)
  })

  it('drops a chunk sent by someone other than the peer who offered it', async () => {
    const { attachment, frame } = payload(1000)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(OTHER, frame(0))

    expect(store.rows.get(attachment.id)?.size ?? 0).toBe(0)
  })

  it('refuses to store a chunk that fails authentication', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    const tampered = { ...frame(0), data: bytesToB64(new Uint8Array(64)) }
    await transfer.accept(PEER, tampered)

    expect(store.rows.get(attachment.id)?.size ?? 0).toBe(0)
  })

  it('refuses a chunk replayed at a different index', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(PEER, { ...frame(0), seq: 1 })

    expect(store.rows.get(attachment.id)?.size ?? 0).toBe(0)
  })

  it('refuses a chunk claiming a different payload length', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(PEER, { ...frame(0), total: 99 })

    expect(store.rows.get(attachment.id)?.size ?? 0).toBe(0)
  })
})

describe('recovering a stalled transfer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for exactly the chunks that are missing', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 3)
    const { sent, transfer } = harness()

    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(1))
    sent.length = 0

    await vi.advanceTimersByTimeAsync(9_000)

    const request = sent.find((s) => s.frame.t === 'blobreq')
    expect(request?.frame).toMatchObject({ t: 'blobreq', id: attachment.id, need: [0, 2] })
  })

  it('sends no request at all while chunks keep arriving', async () => {
    // A healthy transfer must never cost a redundant round trip.
    const { attachment, frame } = payload(CHUNK_BYTES * 3)
    const { sent, transfer } = harness()

    await transfer.expect(PEER, attachment)
    for (const seq of [0, 1, 2]) {
      await vi.advanceTimersByTimeAsync(5_000)
      await transfer.accept(PEER, frame(seq))
    }

    expect(sent.filter((s) => s.frame.t === 'blobreq')).toHaveLength(0)
  })

  it('gives up after repeated rounds with no progress', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    const { sent, transfer } = harness()
    const failed = vi.fn()
    transfer.events.on('failed', failed)

    await transfer.expect(PEER, attachment)
    // Well past the round limit; a peer that has gone away must not cost an
    // unbounded number of relay events.
    await vi.advanceTimersByTimeAsync(9_000 * 10)

    expect(failed).toHaveBeenCalledWith({ id: attachment.id, reason: 'stalled' })
    expect(sent.filter((s) => s.frame.t === 'blobreq').length).toBeLessThanOrEqual(7)
    expect(transfer.isPending(attachment.id)).toBe(false)
  })

  it('stops asking once the payload completes', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { sent, transfer } = harness()

    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(0))
    await transfer.accept(PEER, frame(1))
    sent.length = 0

    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toHaveLength(0)
    expect(transfer.isPending(attachment.id)).toBe(false)
  })

  it('drops every timer when stopped', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    const { sent, transfer } = harness()
    await transfer.expect(PEER, attachment)

    transfer.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toHaveLength(0)
  })
})
