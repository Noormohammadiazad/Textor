import { describe, expect, it } from 'vitest'
import {
  CHUNK_BYTES,
  assembleBlob,
  blobId,
  chunkCipherLength,
  chunkCount,
  openChunk,
  sealBlob,
} from '@/core/crypto/blobCrypto'
import { randomBytes } from '@/core/util/bytes'

/** Encrypt, then decrypt every chunk, returning the reassembled payload. */
function roundTrip(plaintext: Uint8Array): Uint8Array {
  const { envelope, chunk } = sealBlob(plaintext)
  const chunks = Array.from({ length: envelope.chunks }, (_, i) => openChunk(envelope, i, chunk(i)))
  return assembleBlob(envelope, chunks)
}

describe('chunked attachment encryption', () => {
  it('round-trips a payload smaller than one chunk', () => {
    const plaintext = randomBytes(1000)
    expect(roundTrip(plaintext)).toEqual(plaintext)
  })

  it('round-trips a payload spanning several chunks', () => {
    const plaintext = randomBytes(CHUNK_BYTES * 3 + 17)
    const { envelope } = sealBlob(plaintext)
    expect(envelope.chunks).toBe(4)
    expect(roundTrip(plaintext)).toEqual(plaintext)
  })

  it('round-trips an exact multiple of the chunk size', () => {
    // The off-by-one that produces a trailing empty chunk lives here.
    const plaintext = randomBytes(CHUNK_BYTES * 2)
    const { envelope } = sealBlob(plaintext)
    expect(envelope.chunks).toBe(2)
    expect(roundTrip(plaintext)).toEqual(plaintext)
  })

  it('round-trips an empty payload as a single chunk', () => {
    const plaintext = new Uint8Array(0)
    expect(chunkCount(0)).toBe(1)
    expect(roundTrip(plaintext)).toEqual(plaintext)
  })

  it('decrypts chunks in any order', () => {
    // Chunks arrive over relays with no ordering guarantee at all.
    const plaintext = randomBytes(CHUNK_BYTES * 3)
    const { envelope, chunk } = sealBlob(plaintext)
    const out: Uint8Array[] = new Array(envelope.chunks)
    for (const i of [2, 0, 1]) out[i] = openChunk(envelope, i, chunk(i))
    expect(assembleBlob(envelope, out)).toEqual(plaintext)
  })

  it('gives every blob a distinct key and salt', () => {
    const a = sealBlob(randomBytes(64)).envelope
    const b = sealBlob(randomBytes(64)).envelope
    expect(a.key).not.toBe(b.key)
    expect(a.salt).not.toBe(b.salt)
  })

  it('identifies a payload by the hash of its plaintext, so duplicates collapse', () => {
    const plaintext = randomBytes(2048)
    expect(sealBlob(plaintext).envelope.id).toBe(sealBlob(plaintext).envelope.id)
    expect(sealBlob(plaintext).envelope.id).toBe(blobId(plaintext))
  })
})

describe('what an attacker cannot do to a chunked payload', () => {
  const plaintext = randomBytes(CHUNK_BYTES * 3)

  it('rejects a chunk replayed at the wrong index', () => {
    const { envelope, chunk } = sealBlob(plaintext)
    // Chunk 0 is a perfectly valid ciphertext — just not for position 1.
    expect(() => openChunk(envelope, 1, chunk(0))).toThrow()
  })

  it('rejects a chunk from a different payload of the same shape', () => {
    const a = sealBlob(plaintext)
    const b = sealBlob(randomBytes(CHUNK_BYTES * 3))
    expect(() => openChunk(a.envelope, 0, b.chunk(0))).toThrow()
  })

  it('rejects a payload whose declared chunk count was tampered with', () => {
    // Truncating the tail and claiming a shorter payload must not authenticate.
    const { envelope, chunk } = sealBlob(plaintext)
    const truncated = { ...envelope, chunks: envelope.chunks - 1 }
    expect(() => openChunk(truncated, 0, chunk(0))).toThrow()
  })

  it('rejects a flipped bit anywhere in a chunk', () => {
    const { envelope, chunk } = sealBlob(plaintext)
    const tampered = chunk(1)
    tampered[5] = (tampered[5] ?? 0) ^ 0x01
    expect(() => openChunk(envelope, 1, tampered)).toThrow()
  })

  it('rejects a truncated chunk', () => {
    const { envelope, chunk } = sealBlob(plaintext)
    expect(() => openChunk(envelope, 0, chunk(0).subarray(0, 8))).toThrow(/too short/)
  })

  it('rejects reassembly when the sender lied about the size', () => {
    const { envelope, chunk } = sealBlob(plaintext)
    const chunks = Array.from({ length: envelope.chunks }, (_, i) => openChunk(envelope, i, chunk(i)))
    expect(() => assembleBlob({ ...envelope, size: envelope.size - 1 }, chunks)).toThrow(/size mismatch/)
  })

  it('rejects reassembly when the sender lied about the hash', () => {
    // Every chunk authenticates, yet the whole is not what was advertised —
    // the case per-chunk tags cannot catch on their own.
    const { envelope, chunk } = sealBlob(plaintext)
    const chunks = Array.from({ length: envelope.chunks }, (_, i) => openChunk(envelope, i, chunk(i)))
    const lying = { ...envelope, id: 'f'.repeat(64) }
    expect(() => assembleBlob(lying, chunks)).toThrow(/hash mismatch/)
  })

  it('refuses to produce a chunk outside the payload', () => {
    const { envelope, chunk } = sealBlob(randomBytes(100))
    expect(() => chunk(envelope.chunks)).toThrow(RangeError)
    expect(() => chunk(-1)).toThrow(RangeError)
  })
})

describe('randomness at attachment scale', () => {
  it('fills buffers larger than one getRandomValues call', () => {
    // Web Crypto refuses more than 65,536 bytes per call. Attachment payloads
    // routinely exceed that, and a short or throwing fill in a crypto util is
    // the kind of bug that only shows up on a large file.
    const big = randomBytes(200_000)
    expect(big.length).toBe(200_000)
    // Every 64 KiB block must be filled, not just the first.
    for (const offset of [0, 65_536, 131_072, 199_000]) {
      expect(big.subarray(offset, offset + 512).some((b) => b !== 0)).toBe(true)
    }
  })
})

describe('transfer accounting', () => {
  it('predicts ciphertext length without encrypting', () => {
    const size = CHUNK_BYTES + 500
    const { chunk } = sealBlob(randomBytes(size))
    expect(chunkCipherLength(size, 0)).toBe(chunk(0).length)
    expect(chunkCipherLength(size, 1)).toBe(chunk(1).length)
  })

  it('counts chunks the way the sender splits them', () => {
    expect(chunkCount(1)).toBe(1)
    expect(chunkCount(CHUNK_BYTES)).toBe(1)
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2)
  })
})
