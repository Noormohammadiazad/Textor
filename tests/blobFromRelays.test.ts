import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { BlobTransfer, type BlobStore, type DropDeps } from '@/core/engine/blobTransfer'
import { chunkEvent, dropAddress } from '@/core/engine/blobDrop'
import { blobRef, blobRefKey, RELAY_CHUNK_BYTES, sealBlob, type BlobRef } from '@/core/crypto/blobCrypto'
import type { Attachment } from '@/core/models/attachment'
import type { ControlFrame } from '@/core/models/protocol'
import { PROTOCOL_VERSION } from '@/core/models/protocol'
import { emptyHealth } from '@/core/models/types'
import { bytesToB64 } from '@/core/util/bytes'
import type { Filter } from 'nostr-tools/filter'

/**
 * Reading a payload from the relays it was put on, and putting one there
 * (ADR-075), with a pool the test answers for: which relay is asked, in what
 * order, what happens when each says nothing, and when the sender is asked.
 */

const SENDER = 'a'.repeat(64)
const senderSk = generateSecretKey()
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

function fakeStore() {
  const rows = new Map<string, Map<number, Uint8Array>>()
  const manifests = new Map<string, { ref: BlobRef; total: number; size: number }>()
  const addresses = new Map<string, string>()
  const store: BlobStore = {
    async getBlobManifest(ref) {
      return manifests.get(blobRefKey(ref))
    },
    async setBlobAddress(ref, address) {
      addresses.set(blobRefKey(ref), address)
    },
    async getBlobAddress(ref) {
      return addresses.get(blobRefKey(ref)) ?? null
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
  return { store, rows, addresses }
}

/** Sealed and described as a sender would, on the relays named. */
function dropped(relays = ['wss://named.example'], length = RELAY_CHUNK_BYTES * 2 + 10) {
  const plaintext = new Uint8Array(length)
  for (let i = 0; i < length; i++) plaintext[i] = i % 251
  const { envelope, chunk } = sealBlob(plaintext, RELAY_CHUNK_BYTES)
  const attachment: Attachment = { ...envelope, kind: 'file', mime: 'application/octet-stream', relays }
  const place = {
    address: dropAddress(envelope),
    copy: blobRef(envelope).copy,
    senderSk,
    at: Math.floor(Date.now() / 1000),
    ttlSec: 86_400,
  }
  const event = (seq: number) => chunkEvent(place, seq, chunk(seq))
  return { attachment, envelope, chunk, event, ref: blobRef(envelope), plaintext }
}

interface Open {
  url: string
  filter: Filter
  onEvent: (event: NostrEvent) => void
  onEose?: () => void
  closed: boolean
}

function harness(over: Partial<DropDeps> = {}) {
  const { store, rows, addresses } = fakeStore()
  const opened: Open[] = []
  const sent: { peer: string; frame: ControlFrame }[] = []
  const queued: { events: NostrEvent[]; relays: string[] }[] = []
  let read = ['wss://mine.example']
  let write = ['wss://mine.example']
  let statuses: ReturnType<DropDeps['pool']['statuses']> = []
  const pool: DropDeps['pool'] = {
    subscribe: (filter, handlers, relays) => {
      const open: Open = {
        url: relays![0]!,
        filter: filter as Filter,
        onEvent: handlers.onEvent,
        closed: false,
        ...(handlers.onEose ? { onEose: () => handlers.onEose!(relays![0]) } : {}),
      }
      opened.push(open)
      return { close: () => void (open.closed = true) }
    },
    rankedReadRelays: () => read,
    rankedWriteRelays: () => write,
    statuses: () => statuses,
  }
  const transfer = new BlobTransfer({
    store,
    isDirect: () => false,
    send: async (peer, frame) => void sent.push({ peer, frame }),
    drop: {
      senderSk,
      pool,
      relaysFor: async () => ['wss://theirs.example', 'wss://mine.example'],
      trusted: async () => true,
      queue: async (events, relays) => void queued.push({ events, relays }),
      ttlSec: () => 86_400,
      ...over,
    },
  })
  return {
    store,
    rows,
    addresses,
    opened,
    sent,
    queued,
    transfer,
    setRead: (urls: string[]) => (read = urls),
    setWrite: (urls: string[]) => (write = urls),
    setStatuses: (next: typeof statuses) => (statuses = next),
  }
}

const requests = (sent: { frame: ControlFrame }[]) => sent.filter((s) => s.frame.t === 'blobreq')

describe('reading a payload from the relays', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('asks for it at its own address, keeps what opens, and finishes', async () => {
    const { attachment, event, plaintext } = dropped()
    const { opened, transfer, sent, rows } = harness()
    const completed: Uint8Array[] = []
    const progress: number[] = []
    transfer.events.on('complete', ({ bytes }) => completed.push(bytes))
    transfer.events.on('progress', ({ received }) => progress.push(received))

    await transfer.expect(SENDER, attachment)
    await advance(0)
    expect(opened[0]?.filter).toEqual({ kinds: [1059], '#p': [dropAddress(attachment)] })
    for (const seq of [2, 0, 1]) opened[0]!.onEvent(event(seq))
    await advance(0)

    expect(progress).toEqual([1, 2, 3])
    expect(completed[0]).toEqual(plaintext)
    expect(rows.size).toBe(1)
    expect(opened[0]!.closed).toBe(true)
    // A relay still finishing up after that changes nothing.
    opened[0]!.onEose?.()
    await advance(10_000)
    expect(opened).toHaveLength(1)
    expect(transfer.isPending(blobRef(attachment))).toBe(false)
    // Nobody had to be asked for anything.
    expect(sent).toEqual([])
  })

  it('tries a relay already open first, then the rest named, then those it reads', async () => {
    const { attachment } = dropped(['wss://other.example', 'wss://mine.example'])
    const { opened, transfer, setRead } = harness()
    setRead(['wss://own.example', 'wss://mine.example'])
    await transfer.expect(SENDER, attachment)
    await advance(0)
    for (let i = 0; i < 2; i++) {
      opened.at(-1)!.onEose?.()
      await advance(2000)
    }
    expect(opened.map((open) => open.url)).toEqual([
      'wss://mine.example',
      'wss://other.example',
      'wss://own.example',
    ])
    expect(opened.slice(0, 2).every((open) => open.closed)).toBe(true)
    transfer.stop()
  })

  it('is not sent by a stranger to a relay of their choosing', async () => {
    const { attachment } = dropped(['wss://stranger.example', 'wss://shared.example'])
    const { opened, transfer, setRead } = harness({ trusted: async () => false })
    setRead(['wss://shared.example', 'wss://own.example'])
    await transfer.expect(SENDER, attachment)
    await advance(0)
    opened.at(-1)!.onEose?.()
    await advance(2000)
    opened.at(-1)!.onEose?.()
    await advance(2000)
    expect(opened.map((open) => open.url)).toEqual(['wss://shared.example', 'wss://own.example'])
    transfer.stop()
  })

  it('moves on from a relay that says nothing, and stays with one that is delivering', async () => {
    const { attachment, event } = dropped(['wss://a.example', 'wss://b.example'])
    const { opened, transfer } = harness()
    await transfer.expect(SENDER, attachment)
    await advance(0)
    expect(opened).toHaveLength(1)
    // No answer of any kind: given up on after a while.
    await advance(8000)
    expect(opened).toHaveLength(2)
    // Delivering: every chunk buys it more time, and its EOSE does not cut it short.
    opened[1]!.onEvent(event(0))
    await advance(7000)
    opened[1]!.onEose?.()
    await advance(7000)
    opened[1]!.onEvent(event(1))
    await advance(7000)
    expect(opened).toHaveLength(3)
    expect(opened[2]!.url).toBe('wss://mine.example')
    transfer.stop()
  })

  it('takes what one relay lacks from the next', async () => {
    const { attachment, event, plaintext } = dropped(['wss://a.example', 'wss://b.example'])
    const { opened, transfer } = harness()
    const completed: Uint8Array[] = []
    transfer.events.on('complete', ({ bytes }) => completed.push(bytes))
    await transfer.expect(SENDER, attachment)
    await advance(0)
    opened[0]!.onEvent(event(0))
    await advance(8000)
    opened[1]!.onEvent(event(1))
    opened[1]!.onEvent(event(2))
    await advance(0)
    expect(completed[0]).toEqual(plaintext)
  })

  it('asks the sender once every relay has been tried, and reads again for what they send', async () => {
    const { attachment, event, plaintext, ref } = dropped()
    const { opened, transfer, sent } = harness()
    const completed: Uint8Array[] = []
    transfer.events.on('complete', ({ bytes }) => completed.push(bytes))
    await transfer.expect(SENDER, attachment)
    await advance(0)
    opened.at(-1)!.onEose?.()
    await advance(2000)
    opened.at(-1)!.onEose?.()
    await advance(2000)
    expect(requests(sent)).toEqual([])
    await advance(8000)
    expect(requests(sent)).toEqual([
      {
        peer: SENDER,
        frame: { v: PROTOCOL_VERSION, t: 'blobreq', id: ref.id, copy: ref.copy, need: [0, 1, 2] },
      },
    ])
    // Named and own, then from the top again.
    expect(opened).toHaveLength(3)
    for (const seq of [0, 1, 2]) opened.at(-1)!.onEvent(event(seq))
    await advance(0)
    expect(completed[0]).toEqual(plaintext)
  })

  it('stops asking after a couple of rounds, and can be resumed later', async () => {
    const { attachment, ref } = dropped()
    const { transfer, sent } = harness()
    const failed: string[] = []
    transfer.events.on('failed', ({ reason }) => failed.push(reason))
    await transfer.expect(SENDER, attachment)
    await advance(10 * 60_000)
    expect(requests(sent)).toHaveLength(2)
    expect(failed).toEqual(['stalled'])
    expect(transfer.isPending(ref)).toBe(false)
    await transfer.resume(SENDER, attachment)
    expect(transfer.isPending(ref)).toBe(true)
    transfer.stop()
  })

  it.each([
    [
      'one with no index',
      () => finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: 'AAAA' }, senderSk),
    ],
    [
      'one past the end',
      () => finalizeEvent({ kind: 1059, created_at: 1, tags: [['seq', '99']], content: 'AAAA' }, senderSk),
    ],
    ['one under another key', () => dropped().event(0)],
    [
      'one claiming to be another chunk',
      () =>
        finalizeEvent(
          { kind: 1059, created_at: 1, tags: [['seq', '0']], content: bytesToB64(new Uint8Array(100)) },
          senderSk,
        ),
    ],
  ])('keeps nothing from %s: anyone can write to an address', async (_label, junk) => {
    const { attachment } = dropped()
    const { opened, transfer, rows } = harness()
    await transfer.expect(SENDER, attachment)
    await advance(0)
    opened[0]!.onEvent(junk())
    await advance(0)
    expect(rows.size).toBe(0)
    transfer.stop()
  })

  it('reads two at a time, and starts the next as one finishes or fails', async () => {
    const first = dropped()
    const second = dropped()
    const third = dropped()
    const { opened, transfer } = harness()
    for (const each of [first, second, third]) await transfer.expect(SENDER, each.attachment)
    await advance(0)
    const addresses = () => opened.map((open) => open.filter['#p']?.[0])
    expect(new Set(addresses()).size).toBe(2)
    expect(addresses()).not.toContain(dropAddress(third.attachment))

    for (const seq of [0, 1, 2]) opened[0]!.onEvent(first.event(seq))
    await advance(0)
    expect(addresses()).toContain(dropAddress(third.attachment))
    transfer.stop()
  })

  it('forgets one waiting its turn if it is finished another way', async () => {
    const first = dropped()
    const second = dropped()
    const third = dropped()
    const { transfer } = harness()
    for (const each of [first, second, third]) await transfer.expect(SENDER, each.attachment)
    await advance(0)
    // Chunks pushed the old way complete it while it waits.
    for (const seq of [0, 1, 2]) {
      await transfer.accept(SENDER, {
        v: PROTOCOL_VERSION,
        t: 'blob',
        id: third.ref.id,
        copy: third.ref.copy,
        seq,
        total: 3,
        data: bytesToB64(third.chunk(seq)),
      })
    }
    expect(transfer.isPending(third.ref)).toBe(false)
    expect(transfer.isPending(first.ref)).toBe(true)
    transfer.stop()
  })

  it('needs no relay for what it already holds', async () => {
    const { attachment, chunk, envelope } = dropped()
    const { opened, transfer } = harness()
    await transfer.store(envelope, chunk)
    await transfer.expect(SENDER, attachment)
    await advance(0)
    expect(opened).toEqual([])
  })

  it('lets go of everything when stopped, and what arrives after is not kept', async () => {
    const { attachment, event } = dropped()
    const { opened, transfer, rows } = harness()
    await transfer.expect(SENDER, attachment)
    await advance(0)
    const open = opened[0]!
    transfer.stop()
    expect(open.closed).toBe(true)
    open.onEvent(event(0))
    open.onEose?.()
    await advance(0)
    expect(rows.size).toBe(0)
    await advance(60_000)
    expect(opened).toHaveLength(1)
  })

  it('does nothing further if stopped while deciding where to look', async () => {
    const { attachment } = dropped()
    let answer: (trusted: boolean) => void = () => undefined
    const { opened, transfer } = harness({ trusted: () => new Promise((resolve) => (answer = resolve)) })
    await transfer.expect(SENDER, attachment)
    await advance(0)
    transfer.stop()
    answer(true)
    await advance(0)
    expect(opened).toEqual([])
  })

  it('does nothing further if stopped while storing a chunk', async () => {
    const { attachment, event } = dropped()
    const { opened, transfer, store } = harness()
    const progress = vi.fn()
    transfer.events.on('progress', progress)
    let release: () => void = () => undefined
    const put = store.putBlobChunk.bind(store)
    store.putBlobChunk = async (...args) => {
      await new Promise<void>((resolve) => (release = resolve))
      return put(...args)
    }
    await transfer.expect(SENDER, attachment)
    await advance(0)
    opened[0]!.onEvent(event(0))
    await advance(0)
    transfer.stop()
    release()
    await advance(0)
    expect(progress).not.toHaveBeenCalled()
  })

  it('does nothing further if stopped while asking the sender', async () => {
    const { attachment } = dropped()
    let release: () => void = () => undefined
    const opened: unknown[] = []
    const { store } = fakeStore()
    const transfer = new BlobTransfer({
      store,
      isDirect: () => false,
      send: () => new Promise<void>((resolve) => (release = resolve)),
      drop: {
        senderSk,
        pool: {
          subscribe: () => {
            opened.push(1)
            return { close: () => undefined }
          },
          rankedReadRelays: () => [],
          rankedWriteRelays: () => [],
          statuses: () => [],
        },
        relaysFor: async () => [],
        trusted: async () => true,
        queue: async () => undefined,
        ttlSec: () => 1,
      },
    })
    await transfer.expect(SENDER, { ...attachment, relays: ['wss://only.example'] })
    await advance(0)
    await advance(8000)
    await advance(8000)
    const before = opened.length
    transfer.stop()
    release()
    await advance(60_000)
    expect(opened.length).toBe(before)
  })
})

describe('putting a payload on the relays', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('chooses where each person reads, then ours, within a limit', async () => {
    const { transfer, setWrite } = harness()
    setWrite(['wss://mine.example', 'wss://two.example', 'wss://three.example', 'wss://four.example'])
    expect(await transfer.dropRelays(['b'.repeat(64)])).toEqual([
      'wss://theirs.example',
      'wss://mine.example',
      'wss://two.example',
    ])
    const members = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]
    expect(await transfer.dropRelays(members)).toHaveLength(4)
  })

  it('leaves out a relay that has lately refused events this large', async () => {
    const { transfer, setWrite, setStatuses } = harness()
    setWrite(['wss://mine.example', 'wss://two.example'])
    setStatuses([
      {
        url: 'wss://theirs.example',
        state: 'online',
        active: true,
        health: { ...emptyHealth(), largeRefusedAt: Date.now() },
      },
    ])
    expect(await transfer.dropRelays(['b'.repeat(64)])).toEqual(['wss://mine.example', 'wss://two.example'])
  })

  it('queues one event per chunk at the copy’s address, and remembers it', async () => {
    const { envelope, chunk, ref } = dropped()
    const { transfer, queued, store } = harness()
    await transfer.store(envelope, chunk)
    await transfer.upload(envelope, 1_790_000_000, ['wss://a.example', 'wss://b.example'])
    expect(queued).toHaveLength(1)
    expect(queued[0]!.relays).toEqual(['wss://a.example', 'wss://b.example'])
    expect(queued[0]!.events.map((event) => event.tags.find((tag) => tag[0] === 'seq')?.[1])).toEqual([
      '0',
      '1',
      '2',
    ])
    expect(queued[0]!.events[0]!.tags[0]).toEqual(['p', dropAddress(envelope)])
    expect(await store.getBlobAddress(ref)).toBe(dropAddress(envelope))
  })

  it('leaves out a chunk it no longer holds', async () => {
    const { envelope, chunk, ref } = dropped()
    const { transfer, queued, rows } = harness()
    await transfer.store(envelope, chunk)
    rows.get(blobRefKey(ref))!.delete(1)
    await transfer.upload(envelope, 1_790_000_000, ['wss://a.example'])
    expect(queued[0]!.events).toHaveLength(2)
  })

  it('uploads again, for whoever asks, to where they read, and not over and over', async () => {
    const { envelope, chunk, ref } = dropped()
    const { transfer, queued, sent } = harness()
    await transfer.store(envelope, chunk)
    await transfer.upload(envelope, 1_790_000_000, ['wss://a.example'])

    await transfer.serve(SENDER, ref.id, ref.copy, [0, 2])
    expect(queued).toHaveLength(2)
    expect(queued[1]!.relays[0]).toBe('wss://theirs.example')
    expect(queued[1]!.events.map((event) => event.tags.find((tag) => tag[0] === 'seq')?.[1])).toEqual([
      '0',
      '2',
    ])
    expect(sent).toEqual([])

    // Counted from now, so it does not arrive expired.
    const expiry = Number(queued[1]!.events[0]!.tags.find((tag) => tag[0] === 'expiration')?.[1])
    expect(expiry).toBeGreaterThan(Date.now() / 1000)

    await transfer.serve(SENDER, ref.id, ref.copy, [0, 2])
    expect(queued).toHaveLength(2)
    await advance(60_000)
    await transfer.serve(SENDER, ref.id, ref.copy, [1])
    expect(queued).toHaveLength(3)
  })

  it('has nothing to upload again if it no longer holds what is asked for', async () => {
    const { envelope, chunk, ref } = dropped()
    const { transfer, queued, rows } = harness()
    await transfer.store(envelope, chunk)
    await transfer.upload(envelope, 1_790_000_000, ['wss://a.example'])
    rows.get(blobRefKey(ref))!.delete(0)
    await transfer.serve(SENDER, ref.id, ref.copy, [0])
    expect(queued).toHaveLength(1)
  })

  it('pushes in frames what was never put on relays, as it always did', async () => {
    const { envelope, chunk, ref } = dropped()
    const { transfer, queued, sent } = harness()
    await transfer.store(envelope, chunk)
    await transfer.serve(SENDER, ref.id, ref.copy, [0])
    expect(queued).toEqual([])
    expect(sent.map((s) => s.frame.t)).toEqual(['blob'])
  })

  it('without the means to read from relays, waits to be sent it as before', async () => {
    const { attachment } = dropped()
    const { store } = fakeStore()
    const sent: ControlFrame[] = []
    const transfer = new BlobTransfer({
      store,
      isDirect: () => false,
      send: async (_peer, frame) => void sent.push(frame),
    })
    await transfer.expect(SENDER, attachment)
    await advance(8000)
    expect(sent.map((frame) => frame.t)).toEqual(['blobreq'])
    await store.setBlobAddress(blobRef(attachment), 'x')
    transfer.stop()
  })

  it('serves frames for an address it has no means to upload to', async () => {
    const { envelope, chunk, ref } = dropped()
    const { store } = fakeStore()
    const sent: ControlFrame[] = []
    const transfer = new BlobTransfer({
      store,
      isDirect: () => false,
      send: async (_peer, frame) => void sent.push(frame),
    })
    await transfer.store(envelope, chunk)
    await store.setBlobAddress(ref, 'x')
    await transfer.serve(SENDER, ref.id, ref.copy, [0])
    expect(sent.map((frame) => frame.t)).toEqual(['blob'])
  })

  it('asks relays to delete an upload only if it holds every chunk', async () => {
    const { attachment, envelope, chunk, ref } = dropped()
    const { transfer, rows } = harness()
    await transfer.store(envelope, chunk)
    const events = await transfer.retractions(attachment, 1_790_000_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(5)
    // Three chunks, under each lifetime a wrap may ask for.
    expect(events[0]?.tags.filter((tag) => tag[0] === 'e')).toHaveLength(6)
    rows.get(blobRefKey(ref))!.delete(0)
    expect(await transfer.retractions(attachment, 1_790_000_000)).toEqual([])
  })
})
