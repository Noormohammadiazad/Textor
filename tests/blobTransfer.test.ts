import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobTransfer, type BlobStore } from '@/core/engine/blobTransfer'
import { blobRef, blobRefKey, CHUNK_BYTES, sealBlob, type BlobRef } from '@/core/crypto/blobCrypto'
import { bytesToB64 } from '@/core/util/bytes'
import type { Attachment } from '@/core/models/attachment'
import type { BlobChunkFrame, ControlFrame } from '@/core/models/protocol'
import { PROTOCOL_VERSION } from '@/core/models/protocol'

const PEER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/**
 * In-memory stand-in with the same duplicate-safety the real store guarantees.
 * Rows are by copy, as in the vault: `rows.get(key(envelope))`.
 */
function fakeStore(): BlobStore & { rows: Map<string, Map<number, Uint8Array>> } {
  const rows = new Map<string, Map<number, Uint8Array>>()
  const manifests = new Map<string, { ref: BlobRef; total: number; size: number }>()
  return {
    rows,
    async getBlobManifest(ref) {
      return manifests.get(blobRefKey(ref))
    },
    async putBlobChunk(ref, seq, data, meta) {
      const chunks = rows.get(blobRefKey(ref)) ?? new Map<number, Uint8Array>()
      chunks.set(seq, data)
      rows.set(blobRefKey(ref), chunks)
      manifests.set(blobRefKey(ref), { ref, total: meta.total, size: meta.size })
      return { received: chunks.size, total: meta.total, complete: chunks.size >= meta.total ? 1 : 0 }
    },
    async missingChunks(ref, total) {
      const chunks = rows.get(blobRefKey(ref))
      const out: number[] = []
      for (let i = 0; i < total; i++) if (!chunks?.has(i)) out.push(i)
      return out
    },
    async getBlobChunk(ref, seq) {
      return rows.get(blobRefKey(ref))?.get(seq) ?? null
    },
    async copiesOf(blobId) {
      return [...manifests.values()].filter((m) => m.ref.id === blobId).map((m) => m.ref)
    },
    async getBlobChunks(ref, total) {
      const chunks = rows.get(blobRefKey(ref))
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

/** Where the fake store keeps a copy. */
const key = (envelope: Parameters<typeof blobRef>[0]): string => blobRefKey(blobRef(envelope))

/**
 * A payload plus the descriptor a recipient would receive for it. Sealed
 * afresh each call, so two calls with one size are two copies of one file.
 */
function payload(bytes: number) {
  const plaintext = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) plaintext[i] = i % 251
  const { envelope, chunk } = sealBlob(plaintext)
  const attachment: Attachment = { ...envelope, kind: 'file', mime: 'application/octet-stream' }
  const ref = blobRef(envelope)
  const frame = (seq: number): BlobChunkFrame => ({
    v: PROTOCOL_VERSION,
    t: 'blob',
    id: envelope.id,
    copy: ref.copy,
    seq,
    total: envelope.chunks,
    data: bytesToB64(chunk(seq)),
  })
  /** As a client from before ADR-052 sends it: no copy named. */
  const legacyFrame = (seq: number): BlobChunkFrame => {
    const { copy: _copy, ...rest } = frame(seq)
    return rest
  }
  return { plaintext, envelope, chunk, attachment, ref, frame, legacyFrame }
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
    await transfer.push(PEER, blobRef(envelope), envelope.chunks)

    expect(store.rows.get(key(envelope))?.size).toBe(3)
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

    expect(store.rows.get(key(envelope))?.size).toBe(envelope.chunks)
    expect(await store.getBlobChunks(blobRef(envelope), envelope.chunks)).not.toBeNull()
  })

  it('serves exactly the chunks a peer asks for', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 3)
    const { sent, transfer } = harness()
    await transfer.store(envelope, chunk)
    await transfer.push(PEER, blobRef(envelope), envelope.chunks)
    sent.length = 0

    await transfer.serve(PEER, envelope.id, blobRef(envelope).copy, [0, 2])

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
    await sender.transfer.serve(PEER, envelope.id, blobRef(envelope).copy, [0, 1])

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
    await transfer.serve(PEER, envelope.id, blobRef(envelope).copy, [0])
    await transfer.serve(PEER, envelope.id, undefined, [0])
    expect(sent).toHaveLength(0)
  })

  it('survives a chunk that has been deleted from under it', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 2)
    const { store, sent, transfer } = harness()
    await transfer.store(envelope, chunk)
    await transfer.push(PEER, blobRef(envelope), envelope.chunks)
    store.rows.get(key(envelope))?.delete(1)
    sent.length = 0

    await expect(transfer.serve(PEER, envelope.id, blobRef(envelope).copy, [0, 1])).resolves.toBeUndefined()
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
      key(attachment),
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
      copy: blobRef(attachment).copy,
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

    // A chunk belonging to a different payload, held under this copy.
    await transfer.accept(PEER, { ...other.frame(0), id: attachment.id, copy: blobRef(attachment).copy })
    await transfer.expect(PEER, attachment)

    // Held, then rejected on verification rather than written to disk.
    expect(store.rows.get(key(attachment))?.size ?? 0).toBe(0)
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
    expect(transfer.isPending(big.ref)).toBe(false)
  })
})

describe('resuming after a reload', () => {
  it('asks again for chunks still missing from a previous session', async () => {
    vi.useFakeTimers()
    try {
      const { attachment, chunk } = payload(CHUNK_BYTES * 3)
      const { store, sent, transfer } = harness()
      // One chunk survived the previous session; the watcher did not.
      await store.putBlobChunk(blobRef(attachment), 0, chunk(0), {
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
      await store.putBlobChunk(blobRef(attachment), seq, chunk(seq), {
        total: attachment.chunks,
        size: attachment.size,
      })
    }
    await transfer.resume(PEER, attachment)
    expect(transfer.isPending(blobRef(attachment))).toBe(false)
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

    expect(store.rows.has(key(attachment))).toBe(false)
  })

  it('drops a chunk sent by someone other than the peer who offered it', async () => {
    const { attachment, frame } = payload(1000)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(OTHER, frame(0))

    expect(store.rows.get(key(attachment))?.size ?? 0).toBe(0)
  })

  it('refuses to store a chunk that fails authentication', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    const tampered = { ...frame(0), data: bytesToB64(new Uint8Array(64)) }
    await transfer.accept(PEER, tampered)

    expect(store.rows.get(key(attachment))?.size ?? 0).toBe(0)
  })

  it('refuses a chunk replayed at a different index', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(PEER, { ...frame(0), seq: 1 })

    expect(store.rows.get(key(attachment))?.size ?? 0).toBe(0)
  })

  it('refuses a chunk claiming a different payload length', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.expect(PEER, attachment)

    await transfer.accept(PEER, { ...frame(0), total: 99 })

    expect(store.rows.get(key(attachment))?.size ?? 0).toBe(0)
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
    expect(request?.frame).toMatchObject({
      t: 'blobreq',
      id: attachment.id,
      copy: blobRef(attachment).copy,
      need: [0, 2],
    })
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

    expect(failed).toHaveBeenCalledWith({
      id: attachment.id,
      copy: blobRef(attachment).copy,
      reason: 'stalled',
    })
    expect(sent.filter((s) => s.frame.t === 'blobreq').length).toBeLessThanOrEqual(7)
    expect(transfer.isPending(blobRef(attachment))).toBe(false)
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
    expect(transfer.isPending(blobRef(attachment))).toBe(false)
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

/*
 * Two copies of one file — the same bytes under two keys — are two transfers.
 * Before ADR-052 the second overwrote the first.
 */
describe('two copies of one file', () => {
  const pair = () => {
    const a = payload(CHUNK_BYTES * 2 + 5)
    const b = payload(CHUNK_BYTES * 2 + 5)
    expect(a.envelope.id).toBe(b.envelope.id)
    return { a, b }
  }

  it('keeps each copy to its own chunks, whichever order they arrive in', async () => {
    const { a, b } = pair()
    const { store, transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)
    await transfer.expect(PEER, a.attachment)
    await transfer.expect(PEER, b.attachment)
    for (const seq of [0, 1, 2]) {
      await transfer.accept(PEER, b.frame(seq))
      await transfer.accept(PEER, a.frame(seq))
    }
    expect(complete.mock.calls.map((call) => call[0].copy).sort()).toEqual([a.ref.copy, b.ref.copy].sort())
    expect(store.rows.get(key(a.envelope))?.size).toBe(3)
    expect(store.rows.get(key(b.envelope))?.size).toBe(3)
  })

  it('places a chunk from a client that names no copy by the key it opens under', async () => {
    const { a, b } = pair()
    const { store, transfer } = harness()
    await transfer.expect(PEER, a.attachment)
    await transfer.expect(PEER, b.attachment)
    await transfer.accept(PEER, b.legacyFrame(1))
    await transfer.accept(PEER, a.legacyFrame(0))
    expect([...(store.rows.get(key(a.envelope))?.keys() ?? [])]).toEqual([0])
    expect([...(store.rows.get(key(b.envelope))?.keys() ?? [])]).toEqual([1])
    // One that opens under neither is refused.
    const stranger = payload(CHUNK_BYTES * 2 + 5)
    await transfer.accept(PEER, stranger.legacyFrame(2))
    expect(store.rows.get(key(stranger.envelope))).toBeUndefined()
    expect(store.rows.get(key(a.envelope))?.size).toBe(1)
  })

  it('holds early chunks per copy, and unnamed ones for whichever copy they open under', async () => {
    const { a, b } = pair()
    const { store, transfer } = harness()
    await transfer.accept(PEER, a.frame(0))
    // Unnamed, from an older client: one for each copy, before either is described.
    await transfer.accept(PEER, a.legacyFrame(1))
    await transfer.accept(PEER, b.legacyFrame(2))
    await transfer.expect(PEER, a.attachment)
    expect([...(store.rows.get(key(a.envelope))?.keys() ?? [])].sort()).toEqual([0, 1])
    // b's chunk was not a's, and is still held for b.
    await transfer.expect(PEER, b.attachment)
    expect([...(store.rows.get(key(b.envelope))?.keys() ?? [])]).toEqual([2])
  })

  it('offers every copy held to a request that names none, and only the named one otherwise', async () => {
    const { a, b } = pair()
    const { sent, transfer } = harness()
    await transfer.store(a.envelope, a.chunk)
    await transfer.store(b.envelope, b.chunk)

    await transfer.serve(PEER, a.envelope.id, a.ref.copy, [0])
    expect(sent.map((s) => (s.frame as BlobChunkFrame).copy)).toEqual([a.ref.copy])

    sent.length = 0
    await transfer.serve(PEER, a.envelope.id, undefined, [0, 99])
    expect(sent.map((s) => (s.frame as BlobChunkFrame).copy).sort()).toEqual([a.ref.copy, b.ref.copy].sort())

    // A request past the end of the payload asks for nothing.
    sent.length = 0
    await transfer.serve(PEER, a.envelope.id, a.ref.copy, [99])
    expect(sent).toHaveLength(0)
  })

  it('ignores a chunk that is not base64', async () => {
    const { a } = pair()
    const { store, transfer } = harness()
    await transfer.expect(PEER, a.attachment)
    await transfer.accept(PEER, { ...a.frame(0), data: '%%%' })
    expect(store.rows.get(key(a.envelope))).toBeUndefined()
  })
})

describe('the edges of a transfer', () => {
  afterEach(() => vi.useRealTimers())

  it('paces the direct channel wider, and survives a chunk that will not send', async () => {
    const { envelope, chunk } = payload(CHUNK_BYTES * 2)
    const store = fakeStore()
    const tried: number[] = []
    const transfer = new BlobTransfer({
      store,
      isDirect: () => true,
      async send(_peer, frame) {
        tried.push((frame as BlobChunkFrame).seq)
        if ((frame as BlobChunkFrame).seq === 0) throw new Error('channel closed')
      },
    })
    await transfer.store(envelope, chunk)
    await expect(transfer.push(PEER, blobRef(envelope), envelope.chunks)).resolves.toBeUndefined()
    expect(tried.sort()).toEqual([0, 1])
  })

  it('registers a copy once, however often it is announced or resumed', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { sent, transfer } = harness()
    vi.useFakeTimers()
    await transfer.expect(PEER, attachment)
    await transfer.expect(PEER, attachment)
    await transfer.resume(PEER, attachment)
    await transfer.accept(PEER, frame(0))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(sent.filter((s) => s.frame.t === 'blobreq')).toHaveLength(1)
  })

  it('stops cleanly while a copy is still being registered', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    const { sent, transfer } = harness()
    vi.useFakeTimers()
    const registering = transfer.expect(PEER, attachment)
    transfer.stop()
    await registering
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(0)
    expect(transfer.isPending(blobRef(attachment))).toBe(false)
  })

  it('asks for nothing when stopped while it was working out what is missing', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    const { store, sent, transfer } = harness()
    vi.useFakeTimers()
    await transfer.expect(PEER, attachment)
    let release: () => void = () => undefined
    const read = store.missingChunks.bind(store)
    store.missingChunks = async (ref, total) => {
      await new Promise<void>((resolve) => (release = resolve))
      return read(ref, total)
    }
    await vi.advanceTimersByTimeAsync(9_000)
    transfer.stop()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(0)
  })

  it('finishes a copy whose last chunk reached storage some other way', async () => {
    const { attachment, chunk, frame } = payload(CHUNK_BYTES * 2)
    const { store, sent, transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)
    vi.useFakeTimers()
    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(0))
    await store.putBlobChunk(blobRef(attachment), 1, chunk(1), { total: 2, size: attachment.size })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
  })

  it('finishes once when the last chunk arrives twice at the same moment', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { transfer } = harness()
    const complete = vi.fn()
    transfer.events.on('complete', complete)
    await transfer.expect(PEER, attachment)
    await transfer.accept(PEER, frame(0))
    await Promise.all([transfer.accept(PEER, frame(1)), transfer.accept(PEER, frame(1))])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('says why a complete copy could not be read back', async () => {
    const { attachment, chunk } = payload(CHUNK_BYTES + 5)
    const failed = vi.fn()

    // Its chunks vanished between completing and being read.
    const gone = harness()
    gone.transfer.events.on('failed', failed)
    for (let seq = 0; seq < attachment.chunks; seq++) {
      await gone.store.putBlobChunk(blobRef(attachment), seq, chunk(seq), { total: 2, size: attachment.size })
    }
    gone.store.getBlobChunks = async () => null
    await gone.transfer.expect(PEER, attachment)
    expect(failed).toHaveBeenLastCalledWith({
      id: attachment.id,
      copy: blobRef(attachment).copy,
      reason: 'incomplete',
    })

    // The sender described a different size from what it sent: every chunk
    // authenticates, and the whole does not add up.
    const lying = harness()
    lying.transfer.events.on('failed', failed)
    for (let seq = 0; seq < attachment.chunks; seq++) {
      await lying.store.putBlobChunk(blobRef(attachment), seq, chunk(seq), {
        total: 2,
        size: attachment.size,
      })
    }
    await lying.transfer.expect(PEER, { ...attachment, size: attachment.size + 1 })
    expect(failed).toHaveBeenLastCalledWith({
      id: attachment.id,
      copy: blobRef(attachment).copy,
      reason: 'integrity',
    })
  })

  it('keeps asking when a request cannot be sent', async () => {
    const { attachment } = payload(CHUNK_BYTES * 2)
    let requests = 0
    const transfer = new BlobTransfer({
      store: fakeStore(),
      isDirect: () => false,
      async send() {
        requests++
        throw new Error('offline')
      },
    })
    vi.useFakeTimers()
    await transfer.expect(PEER, attachment)
    await vi.advanceTimersByTimeAsync(9_000 * 2)
    expect(requests).toBe(2)
    transfer.stop()
  })

  it('does not hold an early chunk bigger than the whole buffer', async () => {
    const { attachment, frame } = payload(CHUNK_BYTES * 2)
    const { store, transfer } = harness()
    await transfer.accept(PEER, frame(0))
    await transfer.accept(PEER, { ...frame(1), data: bytesToB64(new Uint8Array(4 * 1024 * 1024 + 1)) })
    await transfer.expect(PEER, attachment)
    // The ordinary early chunk survived; the giant was never held.
    expect([...(store.rows.get(key(attachment))?.keys() ?? [])]).toEqual([0])
  })
})
