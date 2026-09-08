import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { KIND_DELETION, KIND_GIFT_WRAP, RETRACTION_TTL_SEC } from '../crypto/giftwrap'
import type { BlobEnvelope } from '../crypto/blobCrypto'
import { b64ToBytes, bytesToB64, hexToBytes, wipe } from '../util/bytes'

/**
 * Where a payload's chunks wait on the relays, and what each one looks like
 * there (ADR-075).
 *
 * A chunk used to go to each recipient's inbox, as a gift wrap inside a seal
 * inside a control frame. That was three layers of base64 around ciphertext
 * that needed none, one upload per person, a copy to every device whether it
 * wanted the file or not, and nothing at all for the sender's other devices.
 *
 * Now a copy has an address of its own, a public key derived from its key. Only
 * someone holding the message can work it out, so only they can ask for it, and
 * a relay sees events addressed to a key that means nothing. A chunk is
 * the ciphertext, once, in a kind 1059 event. It needs no seal: only someone
 * with the key can have made it, which `openChunk` checks before anything is
 * stored.
 */

const text = new TextEncoder()
const FUZZ_WINDOW_SEC = 2 * 24 * 60 * 60

/** A scalar and a little more, from one key and a purpose. */
function draw(ikm: Uint8Array, salt: Uint8Array, purpose: string): Uint8Array {
  return hkdf(sha256, ikm, salt, text.encode(`textor/blob/${purpose}/v1`), 52)
}

/** The address a copy's chunks wait at: anyone holding its descriptor arrives at the same one. */
export function dropAddress(envelope: Pick<BlobEnvelope, 'key' | 'salt'>): string {
  const drawn = draw(hexToBytes(envelope.key), hexToBytes(envelope.salt), 'drop')
  const secret = schnorr.utils.randomSecretKey(drawn.subarray(0, 48))
  try {
    return getPublicKey(secret)
  } finally {
    wipe(secret)
    wipe(drawn)
  }
}

interface ChunkSigner {
  secret: Uint8Array
  back: number
}

/**
 * Chunks signed by one key. `oxtr` refuses a key after 15 events, and took 32
 * from a key each (ADR-073); measured here, one key across a voice note's 19
 * chunks spent two minutes being refused and retried (ADR-075).
 */
const CHUNKS_PER_SIGNER = 10

/**
 * What signs a run of a copy's chunks: the sender's, so any device of theirs
 * holding the chunks can ask relays to delete them, and nobody else can.
 */
function chunkSigner(senderSk: Uint8Array, copy: string, seq: number): ChunkSigner {
  const run = Math.floor(seq / CHUNKS_PER_SIGNER)
  const drawn = draw(senderSk, hexToBytes(copy), `signer/${run}`)
  const back = new DataView(drawn.buffer, drawn.byteOffset).getUint32(48) % FUZZ_WINDOW_SEC
  const secret = schnorr.utils.randomSecretKey(drawn.subarray(0, 48))
  wipe(drawn)
  return { secret, back }
}

export interface ChunkPlace {
  address: string
  copy: string
  senderSk: Uint8Array
  /** When this upload counts from, unix seconds: the message's time, so it can be worked out again. */
  at: number
  ttlSec: number
}

function build(
  signer: ChunkSigner,
  place: Pick<ChunkPlace, 'address' | 'at'>,
  ttlSec: number,
  seq: number,
  data: Uint8Array,
): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: place.at - signer.back,
      tags: [
        ['p', place.address],
        ['expiration', String(place.at + ttlSec)],
        ['seq', String(seq)],
      ],
      content: bytesToB64(data),
    },
    signer.secret,
  )
}

export function chunkEvent(place: ChunkPlace, seq: number, ciphertext: Uint8Array): NostrEvent {
  const signer = chunkSigner(place.senderSk, place.copy, seq)
  try {
    return build(signer, place, place.ttlSec, seq, ciphertext)
  } finally {
    wipe(signer.secret)
  }
}

/** Which chunk an event says it is, and the bytes. Null if it is not one: anyone can write here. */
export function readChunkEvent(event: NostrEvent): { seq: number; ciphertext: Uint8Array } | null {
  const seq = event.tags.find((tag) => tag[0] === 'seq')?.[1]
  if (!seq || !/^\d{1,6}$/.test(seq)) return null
  try {
    return { seq: Number(seq), ciphertext: b64ToBytes(event.content) }
  } catch {
    return null
  }
}

/**
 * Ask relays to delete an upload of these chunks: an event from each key that
 * signed some. Each lifetime it may have had makes different ids, and a relay
 * ignores an id it does not hold.
 */
export function chunkRetractions(
  place: Omit<ChunkPlace, 'ttlSec'>,
  ttls: readonly number[],
  chunks: readonly Uint8Array[],
): NostrEvent[] {
  const now = Math.floor(Date.now() / 1000)
  const events: NostrEvent[] = []
  for (let first = 0; first < chunks.length; first += CHUNKS_PER_SIGNER) {
    const signer = chunkSigner(place.senderSk, place.copy, first)
    const tags = ttls.flatMap((ttlSec) =>
      chunks
        .slice(first, first + CHUNKS_PER_SIGNER)
        .map((chunk, offset) => ['e', build(signer, place, ttlSec, first + offset, chunk).id]),
    )
    events.push(
      finalizeEvent(
        {
          kind: KIND_DELETION,
          content: '',
          created_at: now,
          tags: [...tags, ['k', String(KIND_GIFT_WRAP)], ['expiration', String(now + RETRACTION_TTL_SEC)]],
        },
        signer.secret,
      ),
    )
    wipe(signer.secret)
  }
  return events
}
