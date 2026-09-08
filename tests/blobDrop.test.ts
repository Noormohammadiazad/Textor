import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { chunkEvent, chunkRetractions, dropAddress, readChunkEvent } from '@/core/engine/blobDrop'
import { blobRef, CHUNK_BYTES, chunkOpens, RELAY_CHUNK_BYTES, sealBlob } from '@/core/crypto/blobCrypto'
import { verifyEventSignature } from '@/core/crypto/giftwrap'
import { MAX_RELAY_BYTES, MAX_VOICE_MS } from '@/core/models/attachment'
import { bytesToHex } from '@/core/util/bytes'

/**
 * Chunks on the relays at their copy's own address (ADR-075): what they look
 * like, and that they fit the smallest limit the default relays were measured to
 * keep.
 */

const sender = generateSecretKey()
const DAY = 86_400
/** 65,536 bytes, measured on purplerelay and wirednet: 66,025 was refused as too large. */
const SMALLEST_RELAY_LIMIT = 65_536

const bytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out.subarray(0, Math.min(length, 65_536)))
  return out
}

const sealed = (length = RELAY_CHUNK_BYTES * 2 + 5) => sealBlob(bytes(length), RELAY_CHUNK_BYTES)
const placeOf = (envelope: ReturnType<typeof sealed>['envelope'], ttlSec = 30 * DAY) => ({
  address: dropAddress(envelope),
  copy: blobRef(envelope).copy,
  senderSk: sender,
  at: 1_790_000_000,
  ttlSec,
})

describe('where a copy waits', () => {
  it('is worked out by anyone holding its descriptor, and differs for every copy', () => {
    const one = sealed().envelope
    const two = sealed().envelope
    expect(dropAddress({ key: one.key, salt: one.salt })).toBe(dropAddress(one))
    expect(dropAddress(one)).toMatch(/^[0-9a-f]{64}$/)
    expect(dropAddress(two)).not.toBe(dropAddress(one))
  })

  it('names nobody: not the sender, and not the key it came from', () => {
    const { envelope } = sealed()
    const address = dropAddress(envelope)
    expect(address).not.toBe(getPublicKey(sender))
    expect(address).not.toContain(envelope.key)
  })
})

describe('a chunk as an event', () => {
  it('fits the smallest limit, at the largest chunk and a large index', () => {
    const { envelope, chunk } = sealBlob(bytes(RELAY_CHUNK_BYTES * 3), RELAY_CHUNK_BYTES)
    const event = chunkEvent({ ...placeOf(envelope), at: 9_999_999_999 }, 123_456, chunk(0))
    expect(chunk(0).length).toBe(RELAY_CHUNK_BYTES + 16)
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(SMALLEST_RELAY_LIMIT)
  })

  it('takes a 1 MiB file in 22 events, and a five-minute voice note at 24 kbps in 19', () => {
    expect(Math.ceil(MAX_RELAY_BYTES / RELAY_CHUNK_BYTES)).toBe(22)
    expect(Math.ceil(((MAX_VOICE_MS / 1000) * 24_000) / 8 / RELAY_CHUNK_BYTES)).toBe(19)
    expect(CHUNK_BYTES).toBeLessThan(RELAY_CHUNK_BYTES)
  })

  it('is addressed to the copy, signed, asks to expire, and says only which chunk it is', () => {
    const { envelope, chunk } = sealed()
    const place = placeOf(envelope)
    const event = chunkEvent(place, 1, chunk(1))
    expect(event.kind).toBe(1059)
    expect(verifyEventSignature(event)).toBe(true)
    expect(event.tags).toEqual([
      ['p', place.address],
      ['expiration', String(place.at + place.ttlSec)],
      ['seq', '1'],
    ])
    expect(event.created_at).toBeLessThanOrEqual(place.at)
    expect(event.created_at).toBeGreaterThanOrEqual(place.at - 2 * DAY)
    expect(event.pubkey).not.toBe(getPublicKey(sender))
  })

  it('reads back as the same bytes, which open under the copy’s key', () => {
    const { envelope, chunk } = sealed()
    const read = readChunkEvent(chunkEvent(placeOf(envelope), 1, chunk(1)))!
    expect(read.seq).toBe(1)
    expect(chunkOpens(envelope, 1, read.ciphertext)).toBe(true)
    expect(chunkOpens(envelope, 0, read.ciphertext)).toBe(false)
  })

  it('comes out the same on every device of the sender', () => {
    const { envelope, chunk } = sealed()
    const place = placeOf(envelope)
    expect(chunkEvent(place, 0, chunk(0)).id).toBe(chunkEvent(place, 0, chunk(0)).id)
    const other = chunkEvent({ ...place, senderSk: generateSecretKey() }, 0, chunk(0))
    expect(other.pubkey).not.toBe(chunkEvent(place, 0, chunk(0)).pubkey)
  })

  it('moves to a new signer every ten chunks, under the 15 a relay takes from one key', () => {
    const { envelope, chunk } = sealed()
    const place = placeOf(envelope)
    const signer = (seq: number) => chunkEvent(place, seq, chunk(0)).pubkey
    expect(signer(9)).toBe(signer(0))
    expect(signer(10)).not.toBe(signer(9))
    expect(signer(19)).toBe(signer(10))
    expect(signer(20)).not.toBe(signer(10))
  })

  it.each([
    ['no index', { tags: [['p', 'x']], content: 'AAAA' }],
    ['an empty index', { tags: [['seq', '']], content: 'AAAA' }],
    ['an index that is not a number', { tags: [['seq', '-1']], content: 'AAAA' }],
    ['an absurd index', { tags: [['seq', '1234567']], content: 'AAAA' }],
    ['bytes that are not base64', { tags: [['seq', '1']], content: '!!!' }],
  ])('turns away an event with %s', (_label, event) => {
    expect(readChunkEvent(event as never)).toBeNull()
  })
})

describe('asking relays to delete an upload', () => {
  it('is an event from each signer, naming its chunks under every lifetime', () => {
    const { envelope, chunk } = sealBlob(bytes(RELAY_CHUNK_BYTES * 12), RELAY_CHUNK_BYTES)
    const week = placeOf(envelope, 7 * DAY)
    const month = placeOf(envelope, 30 * DAY)
    const chunks = Array.from({ length: envelope.chunks }, (_, seq) => chunk(seq))
    const events = chunkRetractions(week, [7 * DAY, 30 * DAY], chunks)
    expect(events).toHaveLength(2)
    const named = (event: (typeof events)[number]) =>
      event.tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1])
    for (const [first, length] of [
      [0, 10],
      [10, 2],
    ] as const) {
      const event = events[first / 10]!
      const run = chunks.slice(first, first + length)
      expect(event.kind).toBe(5)
      expect(verifyEventSignature(event)).toBe(true)
      expect(event.pubkey).toBe(chunkEvent(month, first, run[0]!).pubkey)
      expect(named(event)).toEqual([
        ...run.map((data, offset) => chunkEvent(week, first + offset, data).id),
        ...run.map((data, offset) => chunkEvent(month, first + offset, data).id),
      ])
      expect(event.tags).toContainEqual(['k', '1059'])
      expect(JSON.stringify(event)).not.toContain(bytesToHex(sender))
    }
  })
})
