import { finalizeEvent, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent, UnsignedEvent } from 'nostr-tools/core'
import * as nip44 from 'nostr-tools/nip44'
import { MAX_CLOCK_AHEAD_MS, nowSec } from '../util/time'
import { bytesToHex, hexToBytes, isHex32, wipe } from '../util/bytes'
import { verifyEventSignature } from './eventSignature'

/**
 * NIP-59 gift wrapping, re-implemented on top of nostr-tools' NIP-44 primitives.
 *
 * Why not call `nip59.wrapEvent` directly:
 *   1. We attach a NIP-40 `expiration` tag to every wrap, which requires
 *      building and signing the wrap ourselves (tags are covered by the
 *      signature, so they cannot be added afterwards).
 *   2. `nip59.unwrapEvent` does not check that a rumor's `id` actually hashes
 *      its own content, nor that the rumor is unsigned, nor that timestamps are
 *      sane. A malicious peer could otherwise hand us a rumor whose id points
 *      at something it does not contain, and our dedup keys off that id.
 *
 * Layering (outermost first):
 *   kind 1059 gift wrap  — from a key used for this one wrap to the recipient,
 *                          p-tagged, timestamp fuzzed, expiration tagged
 *   kind 13   seal       — from the sender's real key to the recipient, signed,
 *                          timestamp fuzzed
 *   rumor                — unsigned event carrying the real payload and the
 *                          real timestamp
 *
 * The rumor being unsigned is deliberate: a leaked plaintext proves nothing,
 * because anyone could have written it. That is the deniability property.
 *
 * Everything a wrap would otherwise leave to chance — its signing key, its
 * timestamps, the nonces — is drawn from the sender's key, the rumor and the
 * recipient (ADR-074). To a relay that is as random as ever. To any device of
 * the sender's it means the same wrap can be worked out again, and so deleted
 * from the relays that hold it, and a retry is the same event instead of a
 * second copy.
 */

export const KIND_SEAL = 13
export const KIND_GIFT_WRAP = 1059
export const KIND_DELETION = 5

/** NIP-59 says fuzz backwards only: relays reject events dated in the future. */
const FUZZ_WINDOW_SEC = 2 * 24 * 60 * 60

/**
 * A wrap asks to expire so long after its rumor was written. One sent again so
 * late that this is about to pass, or has, counts from now instead: a relay
 * would refuse it, or drop it at once.
 */
const REISSUE_MARGIN_SEC = 5 * 60

/** Long enough to see out every wrap a deletion could name. */
export const RETRACTION_TTL_SEC = 31 * 24 * 60 * 60

/** How much later each renewal of an undelivered message counts from (ADR-076). */
export const RENEWAL_SPACING_SEC = 25 * 24 * 60 * 60

/**
 * Relays commonly cap a websocket frame around 256-512 KB. Refuse to even
 * attempt decryption above that so a hostile relay cannot make us burn CPU.
 */
const MAX_CONTENT_CHARS = 512 * 1024

/** How far out of step a peer's clock may be before we treat a rumor as bogus. */
const MAX_CLOCK_SKEW_SEC = MAX_CLOCK_AHEAD_MS / 1000

export interface Rumor extends UnsignedEvent {
  readonly id: string
}

export interface WrapOptions {
  /** Ask relays to drop the wrap this many seconds after the rumor was written (NIP-40). */
  expirationSec?: number
  /** Sent again this many times over, each `RENEWAL_SPACING_SEC` later (ADR-076). */
  generation?: number
  /** Override the fuzzed wrap/seal timestamp. Tests only. */
  fuzzedAt?: number
}

/** What one wrap of one rumor to one recipient leaves to chance elsewhere. */
export interface WrapDraw {
  signer: Uint8Array
  nonceKey: Uint8Array
  sealBack: number
  wrapBack: number
}

const text = new TextEncoder()

export function drawWrap(rumorId: string, senderSk: Uint8Array, recipientPk: string): WrapDraw {
  const drawn = hkdf(sha256, senderSk, hexToBytes(rumorId), text.encode(`textor/wrap/v1|${recipientPk}`), 88)
  const view = new DataView(drawn.buffer, drawn.byteOffset)
  return {
    signer: schnorr.utils.randomSecretKey(drawn.subarray(0, 48)),
    nonceKey: drawn.slice(48, 80),
    sealBack: view.getUint32(80) % FUZZ_WINDOW_SEC,
    wrapBack: view.getUint32(84) % FUZZ_WINDOW_SEC,
  }
}

/** Build an unsigned rumor carrying the real timestamp. */
export function createRumor(template: Partial<UnsignedEvent>, senderSk: Uint8Array): Rumor {
  const rumor = {
    created_at: nowSec(),
    kind: 14,
    content: '',
    tags: [] as string[][],
    ...template,
    pubkey: getPublicKey(senderSk),
  } as UnsignedEvent
  return { ...rumor, id: getEventHash(rumor) } as Rumor
}

/**
 * The nonce is a keyed hash of what it encrypts, so the same bytes encrypt the
 * same way on every device, and different bytes can never share a nonce.
 */
function encryptTo(json: string, sk: Uint8Array, recipientPk: string, nonceKey: Uint8Array): string {
  const conversationKey = nip44.getConversationKey(sk, recipientPk)
  try {
    return nip44.encrypt(json, conversationKey, hmac(sha256, nonceKey, text.encode(json)))
  } finally {
    wipe(conversationKey)
  }
}

function decryptFrom(content: string, sk: Uint8Array, senderPk: string): unknown {
  const conversationKey = nip44.getConversationKey(sk, senderPk)
  try {
    return JSON.parse(nip44.decrypt(content, conversationKey))
  } finally {
    wipe(conversationKey)
  }
}

/**
 * A rumor as it goes into a seal: these fields, in this order, whatever order
 * the object in hand happens to have them in.
 */
const rumorJson = (rumor: Rumor): string =>
  JSON.stringify({
    id: rumor.id,
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  })

function sealWith(
  draw: WrapDraw,
  rumor: Rumor,
  senderSk: Uint8Array,
  recipientPk: string,
  at: number,
): NostrEvent {
  const unsigned = {
    pubkey: getPublicKey(senderSk),
    created_at: at,
    kind: KIND_SEAL,
    tags: [] as string[][],
    content: encryptTo(rumorJson(rumor), senderSk, recipientPk, draw.nonceKey),
  }
  const id = getEventHash(unsigned)
  // The seal is inside the wrap, so its signature has to come out the same too.
  const aux = hmac(sha256, draw.nonceKey, hexToBytes(id))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), senderSk, aux))
  return { id, ...unsigned, sig } as NostrEvent
}

export function createSeal(rumor: Rumor, senderSk: Uint8Array, recipientPk: string, at?: number): NostrEvent {
  const draw = drawWrap(rumor.id, senderSk, recipientPk)
  return sealWith(draw, rumor, senderSk, recipientPk, at ?? rumor.created_at - draw.sealBack)
}

/** Seal + wrap a rumor for one recipient. The same arguments give the same wrap, on any device. */
export function giftWrap(
  rumor: Rumor,
  senderSk: Uint8Array,
  recipientPk: string,
  opts: WrapOptions = {},
): NostrEvent {
  if (!isHex32(recipientPk)) throw new Error('recipient pubkey must be 32-byte hex')
  const draw = drawWrap(rumor.id, senderSk, recipientPk)
  try {
    const ttl = opts.expirationSec ?? 0
    const start = rumor.created_at + (opts.generation ?? 0) * RENEWAL_SPACING_SEC
    const late = ttl > 0 && start + ttl < nowSec() + REISSUE_MARGIN_SEC
    const from = late ? nowSec() : start
    const tags: string[][] = [['p', recipientPk]]
    // Expiration is advisory. Relays that honour NIP-40 drop the wrap; the
    // ones that do not are exactly why we never rely on remote deletion.
    if (ttl > 0) tags.push(['expiration', String(from + ttl)])
    const seal = sealWith(draw, rumor, senderSk, recipientPk, opts.fuzzedAt ?? from - draw.sealBack)
    return finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        content: encryptTo(JSON.stringify(seal), draw.signer, recipientPk, draw.nonceKey),
        created_at: opts.fuzzedAt ?? from - draw.wrapBack,
        tags,
      },
      draw.signer,
    )
  } finally {
    wipe(draw.signer)
    wipe(draw.nonceKey)
  }
}

/** A wrap whose own `expiration` has passed: a relay should no longer have offered it. */
export function isExpired(wrap: Pick<NostrEvent, 'tags'>, atSec: number): boolean {
  const expiration = wrap.tags.find((tag) => tag[0] === 'expiration')?.[1]
  return expiration !== undefined && Number(expiration) <= atSec
}

export class GiftWrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GiftWrapError'
  }
}

function assertPlainEvent(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GiftWrapError(`${label} is not an object`)
  }
}

/**
 * Unwrap and fully validate a gift wrap.
 *
 * Every check here exists because skipping it lets a peer or relay lie to us:
 *  - seal signature      -> proves who wrote the message
 *  - rumor.pubkey == seal.pubkey -> stops A from sealing a rumor attributed to B
 *  - rumor has no `sig`  -> preserves deniability; a signed rumor is a red flag
 *  - rumor.id is correct -> our dedup and reply threading key off this id
 *  - timestamp sanity    -> keeps a hostile peer from parking messages far in
 *                           the future at the top of the conversation
 */
export function unwrapGift(wrap: NostrEvent, recipientSk: Uint8Array): Rumor {
  if (wrap.kind !== KIND_GIFT_WRAP) throw new GiftWrapError(`expected kind ${KIND_GIFT_WRAP}`)
  if (typeof wrap.content !== 'string' || wrap.content.length > MAX_CONTENT_CHARS) {
    throw new GiftWrapError('gift wrap content too large')
  }
  if (!verifyEventSignature(wrap)) throw new GiftWrapError('gift wrap signature is invalid')

  const seal = decryptFrom(wrap.content, recipientSk, wrap.pubkey)
  assertPlainEvent(seal, 'seal')
  if (seal.kind !== KIND_SEAL) throw new GiftWrapError(`expected seal kind ${KIND_SEAL}`)
  // No longer than the wrap's own limit: NIP-44 encrypts at most 64 KiB.
  if (typeof seal.content !== 'string') throw new GiftWrapError('seal content is malformed')
  if (!verifyEventSignature(seal)) throw new GiftWrapError('seal signature is invalid')

  const rumor = decryptFrom(seal.content, recipientSk, seal.pubkey as string)
  return validateRumor(rumor, seal.pubkey as string)
}

/**
 * Validate an untrusted rumor and return it in canonical form.
 *
 * Shared by both transports: a rumor that arrived inside a gift wrap and one
 * that arrived over a direct data channel get exactly the same scrutiny, so
 * there is no weaker path an attacker could steer us onto.
 *
 * Each check earns its place:
 *  - author match      -> stops A from handing us a rumor attributed to B
 *  - unsigned          -> preserves deniability; a signed rumor is a red flag
 *  - id is a real hash -> dedup, receipts, and reply threading all key off it,
 *                         so a forged id would let a peer overwrite or
 *                         suppress a different message
 *  - timestamp sanity  -> keeps a peer from parking a message far in the future
 *                         and pinning it to the top of the conversation
 */
export function validateRumor(value: unknown, expectedAuthor: string): Rumor {
  assertPlainEvent(value, 'rumor')
  const rumor = value

  if (rumor.pubkey !== expectedAuthor) {
    throw new GiftWrapError('rumor author does not match the authenticated sender')
  }
  if ('sig' in rumor) {
    throw new GiftWrapError('rumor must be unsigned')
  }
  if (typeof rumor.kind !== 'number' || typeof rumor.content !== 'string' || !Array.isArray(rumor.tags)) {
    throw new GiftWrapError('rumor is malformed')
  }
  for (const tag of rumor.tags) {
    if (!Array.isArray(tag) || tag.some((entry) => typeof entry !== 'string')) {
      throw new GiftWrapError('rumor tags are malformed')
    }
  }
  if (typeof rumor.created_at !== 'number' || !Number.isFinite(rumor.created_at)) {
    throw new GiftWrapError('rumor timestamp is malformed')
  }
  if (rumor.created_at > nowSec() + MAX_CLOCK_SKEW_SEC) {
    throw new GiftWrapError('rumor timestamp is implausibly far in the future')
  }

  const { id, ...unsigned } = rumor as { id?: unknown } & UnsignedEvent
  const computed = getEventHash(unsigned)
  if (typeof id !== 'string' || id !== computed) {
    throw new GiftWrapError('rumor id does not match its contents')
  }

  return { ...unsigned, id: computed } as Rumor
}
