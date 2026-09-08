import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '../util/bytes'

/**
 * Chunked authenticated encryption for attachment payloads.
 *
 * Attachments cannot be sealed as one blob the way a message row is. They have
 * to travel in pieces — a relay event has a size ceiling, a data-channel frame
 * has a smaller one, and a transfer that is interrupted must resume rather than
 * restart. So each chunk is encrypted independently and can be decrypted the
 * moment it lands, in any order.
 *
 * Independent chunks invite three attacks, and the construction closes all
 * three:
 *
 *   reordering    the chunk index is bound into the AAD, so a chunk decrypted
 *                 at the wrong position fails its tag
 *   truncation    the total chunk count is bound in too, so dropping the tail
 *                 cannot pass as a complete shorter payload
 *   substitution  the blob id — the SHA-256 of the *plaintext* — is bound in,
 *                 and re-checked after reassembly, so chunks from a different
 *                 payload cannot be spliced in
 *
 * Nonces follow the STREAM pattern: a random 16-byte salt generated once per
 * blob, concatenated with the 8-byte chunk index. The salt makes nonces unique
 * across blobs even in the impossible case of a repeated key, and the index
 * makes them unique within one.
 *
 * The key is random per blob and never reused. It travels to the recipient
 * inside the NIP-44-encrypted rumor, so the ciphertext at rest and in flight is
 * useless without the conversation the message belongs to.
 */

export const BLOB_CRYPTO_VERSION = 1

/**
 * Plaintext bytes per chunk.
 *
 * Sized against the relay path, where a chunk expands by about 3.35x before it
 * reaches the wire — a factor that is easy to underestimate because base64 is
 * applied three times over:
 *
 *   chunk ciphertext -> base64 into the frame        x1.33
 *   frame -> NIP-44 seal, whose payload is base64    x1.33
 *   seal -> NIP-59 gift wrap, base64 again           x1.33
 *
 * Measured, not estimated: 32 KiB produced a 109,732-byte gift wrap, well past
 * the 64 KiB event limit most public relays enforce, so every chunk was
 * silently rejected and no multi-chunk attachment could ever arrive. 16 KiB
 * measures 55,112 bytes, which clears that limit with room for the tag, the
 * frame keys, and a longer relay hint list.
 *
 * The direct data channel could take far more, but one chunk size keeps a
 * payload switchable between transports mid-transfer.
 */
export const CHUNK_BYTES = 16 * 1024

const SALT_LEN = 16
const INDEX_LEN = 8
const TAG_LEN = 16

export interface BlobEnvelope {
  /** SHA-256 of the plaintext, hex. Identity, dedup key, and integrity check. */
  id: string
  /** Per-blob key, hex. Random, single use. */
  key: string
  /** Per-blob nonce salt, hex. */
  salt: string
  /** Plaintext length in bytes. */
  size: number
  /** Number of chunks the payload splits into. */
  chunks: number
}

export const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / CHUNK_BYTES))

/** `salt || index`, 24 bytes, unique per (blob, chunk). */
function nonceFor(salt: Uint8Array, index: number): Uint8Array {
  const counter = new Uint8Array(INDEX_LEN)
  // 8-byte little-endian index. A blob cannot exceed 2^53 chunks in any
  // universe this app runs in, so the high word is always zero.
  new DataView(counter.buffer).setUint32(0, index, true)
  return concatBytes(salt, counter)
}

/**
 * Binds every chunk to its position, the length of the whole, and the payload
 * it belongs to. Any of the three being wrong is an authentication failure
 * rather than a silently corrupt file.
 */
const aadFor = (id: string, index: number, total: number): Uint8Array =>
  utf8ToBytes(`textor/blob/v${BLOB_CRYPTO_VERSION}|${id}|${index}|${total}`)

export const blobId = (plaintext: Uint8Array): string => bytesToHex(sha256(plaintext))

/**
 * Prepare a payload for transfer.
 *
 * Returns the envelope the recipient needs (which travels inside the encrypted
 * rumor) and a function producing chunk `i` on demand, so a large file is never
 * held in memory twice.
 */
export function sealBlob(plaintext: Uint8Array): {
  envelope: BlobEnvelope
  chunk: (index: number) => Uint8Array
} {
  const key = randomBytes(32)
  const salt = randomBytes(SALT_LEN)
  const id = blobId(plaintext)
  const total = chunkCount(plaintext.length)

  const envelope: BlobEnvelope = {
    id,
    key: bytesToHex(key),
    salt: bytesToHex(salt),
    size: plaintext.length,
    chunks: total,
  }

  const chunk = (index: number): Uint8Array => {
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new RangeError(`chunk ${index} out of range 0..${total - 1}`)
    }
    const start = index * CHUNK_BYTES
    const slice = plaintext.subarray(start, Math.min(start + CHUNK_BYTES, plaintext.length))
    return xchacha20poly1305(key, nonceFor(salt, index), aadFor(id, index, total)).encrypt(slice)
  }

  return { envelope, chunk }
}

/** Decrypt one chunk. Throws if it is the wrong chunk, of the wrong payload. */
export function openChunk(
  envelope: Pick<BlobEnvelope, 'id' | 'key' | 'salt' | 'chunks'>,
  index: number,
  ciphertext: Uint8Array,
): Uint8Array {
  if (ciphertext.length < TAG_LEN) throw new Error('chunk too short')
  return xchacha20poly1305(
    hexToBytes(envelope.key),
    nonceFor(hexToBytes(envelope.salt), index),
    aadFor(envelope.id, index, envelope.chunks),
  ).decrypt(ciphertext)
}

/**
 * Reassemble decrypted chunks and verify the result is the payload the sender
 * described.
 *
 * The per-chunk tags already prove each piece is authentic and correctly
 * placed; this last check catches the case they cannot — a sender whose
 * declared size or hash does not match what they actually sent.
 */
export function assembleBlob(
  envelope: Pick<BlobEnvelope, 'id' | 'size'>,
  chunks: readonly Uint8Array[],
): Uint8Array {
  const plaintext = concatBytes(...chunks)
  if (plaintext.length !== envelope.size) {
    throw new Error(`blob size mismatch: got ${plaintext.length}, expected ${envelope.size}`)
  }
  if (blobId(plaintext) !== envelope.id) throw new Error('blob hash mismatch')
  return plaintext
}

/** Ciphertext length of chunk `index`, without producing it. */
export function chunkCipherLength(size: number, index: number): number {
  const start = index * CHUNK_BYTES
  return Math.min(CHUNK_BYTES, Math.max(0, size - start)) + TAG_LEN
}
