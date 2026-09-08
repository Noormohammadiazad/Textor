import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { KdfParams } from '../crypto/kdf'
import type { KdfRequest, KdfResponse } from '../crypto/kdf.worker'
import { normalizeRelayList } from '../transport/relayUrl'
import { bytesToHex, concatBytes, hexToBytes, isHex32, utf8ToBytes, wipe } from '../util/bytes'

/**
 * The Textor ID: ten characters that find someone, like `7X9K2-M4QHD` (ADR-079).
 *
 * Worked out from the twelve words, so every identity has one from the start, the
 * same on every device and after any restore, and nobody hands it out, chooses it or
 * can take it. Whoever is given one finds a record for it and checks the sum
 * themselves, so a relay can hide an owner but cannot name the wrong person.
 *
 * It is the first 50 bits of an scrypt of the public key and a salt from the secret
 * key. The salt comes out only when the record is opened, by someone who has the ID:
 * with no salt, anyone could work out the ID of any key they had seen, and ask a
 * relay whether that key uses Textor. With one, all they can do is guess IDs.
 *
 * Only ever loaded through `import()`, so none of this is in the precache.
 */

/**
 * Two lanes of scrypt at half the vault's size: the 64 MiB known to be safe on a phone,
 * in half the time of one lane that size, as a phone has a core to spare for each. An
 * attacker pays for all of it on every guess, side by side or not (ADR-079).
 */
export const ID_KDF: KdfParams = { algo: 'scrypt', N: 2 ** 15, r: 8, p: 1 }
export const ID_LANES = 2
const KEY_BYTES = 32
export const ID_BITS = 50
const ID_SYMBOLS = ID_BITS / 5
/** Crockford's: no `I`, `L`, `O` or `U`, so `1` and `0` have nothing to be taken for. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ID = /^[0-9A-HJKMNP-TV-Z]{10}$/

/** NIP-78's kind and the records' life, as in `profileRecord.ts`, which is another chunk's. */
const KIND_APP_DATA = 30078
const RECORD_TTL_SEC = 365 * 86_400

/** Asked of each relay. A record is small, and someone who knows an ID can add to these. */
const LOOKUP_LIMIT = 64
/** The most records one look will spend a run on: each may take a budget phone two seconds. */
const MAX_CANDIDATES = 4

const laneSalts = (label: string): Uint8Array[] =>
  Array.from({ length: ID_LANES }, (_, lane) => sha256(utf8ToBytes(`${label}\0${lane}`)))

const CLAIM_SALTS = laneSalts('textor/id/v1/claim')
const ADDRESS_SALTS = laneSalts('textor/id/v1/address')
const SALT_INFO = utf8ToBytes('textor/id/v1/salt')
const RECORD_INFO = utf8ToBytes('textor/id/v1/record')
const SIGNER_INFO = utf8ToBytes('textor/id/v1/signer')
const SIGNATURE = 'textor/id/v1/signature'

/** One lane of scrypt at `ID_KDF`, wherever it runs. */
export type Derive = (password: string, salt: Uint8Array) => Promise<Uint8Array>

/** Where there can be no workers: what `deriveKek` does, as the worker runs it. */
const inline: Derive = (password, salt) =>
  scryptAsync(password.normalize('NFKC'), salt, { N: ID_KDF.N, r: ID_KDF.r, p: ID_KDF.p, dkLen: KEY_BYTES })

/**
 * One lane, off the main thread. Not through `kdfClient`, though it does the same:
 * imported statically from here as well as from the shell, the bundler would hoist
 * it into a shared chunk not named `lazy-`, and so into the precache.
 */
const offThread: Derive = (password, salt) => {
  let worker: Worker
  try {
    worker = new Worker(new URL('../crypto/kdf.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return inline(password, salt)
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<KdfResponse>) => {
      const message = event.data
      if (message.type === 'done') resolve(new Uint8Array(message.key))
      else if (message.type === 'error') reject(new Error(message.message))
    })
    // A worker that will not load must not cost anyone their ID.
    worker.addEventListener('error', () => void inline(password, salt).then(resolve, reject))
    const request: KdfRequest = { id: 1, passphrase: password, salt, params: ID_KDF }
    worker.postMessage(request)
  }).finally(() => worker.terminate())
}

/** Persian and Arabic-Indic digits, as a Persian keyboard types them. */
const asciiDigits = (text: string): string =>
  text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) & 0xf))

/**
 * An ID as typed, read out, pasted or linked, in its one spelling, or null if it
 * cannot be one. There is no check symbol: a wrong character finds nobody anyway, and
 * a symbol spent on checking is five bits off what forging costs (ADR-079).
 */
export function parseTextorId(raw: string): string | null {
  const link = /#\/id\/([^/?#\s]+)/.exec(raw)
  const id = asciiDigits(link ? (link[1] as string) : raw)
    // Marks a chat app may have put around it, and however it was grouped.
    .replace(/[\s\-_.\u2010-\u2015\u2212\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  return ID.test(id) ? id : null
}

/**
 * The hidden half of what an ID is worked out from: the same on every device of this
 * identity. Told to contacts, so they can work out the ID, and to nobody else.
 */
export const idSaltOf = (secretKey: Uint8Array): string =>
  bytesToHex(hkdf(sha256, secretKey, undefined, SALT_INFO, 16))

/** The first 50 bits of a key, as ten symbols, leading zeros and all. They fit a double exactly. */
export function idOf(key: Uint8Array): string {
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength)
  let value = view.getUint32(0) * 2 ** (ID_BITS - 32) + (view.getUint32(4) >>> (64 - ID_BITS))
  let id = ''
  for (let place = 0; place < ID_SYMBOLS; place++) {
    id = (ALPHABET[value % 32] as string) + id
    value = Math.floor(value / 32)
  }
  return id
}

/** One run: every lane at once, each in a worker of its own, and nothing short of all of them will do. */
const run = async (password: string, salts: Uint8Array[], derive: Derive): Promise<Uint8Array> =>
  sha256(concatBytes(...(await Promise.all(salts.map((salt) => derive(password, salt))))))

/** What a public key and salt give: the one check an ID ever needs. */
export const textorIdFrom = async (
  pubkey: string,
  salt: string,
  derive: Derive = offThread,
): Promise<string> => idOf(await run(`${pubkey}:${salt}`, CLAIM_SALTS, derive))

/** This identity's ID. Takes what it needs of the secret key before waiting for anything. */
export function deriveTextorId(secretKey: Uint8Array, derive: Derive = offThread): Promise<string> {
  return textorIdFrom(getPublicKey(secretKey), idSaltOf(secretKey), derive)
}

/**
 * Where an ID's record is, and what opens it: scrypt of the ID.
 *
 * Slow on purpose. A relay holding these cannot read one without the ID, and this is
 * what it has to run for every guess, which is what makes collecting who uses Textor
 * expensive: a cheap hash here would let it try all fifty bits in days (ADR-079).
 */
async function placeOf(id: string, derive: Derive): Promise<{ d: string; sealKey: Uint8Array }> {
  const drawn = hkdf(sha256, await run(id, ADDRESS_SALTS, derive), undefined, RECORD_INFO, 48)
  return { d: bytesToHex(drawn.subarray(0, 16)), sealKey: drawn.slice(16, 48) }
}

const signatureDigest = (
  id: string,
  pubkey: string,
  salt: string,
  relays: readonly string[],
  stamp: number,
): Uint8Array => sha256(utf8ToBytes(JSON.stringify([SIGNATURE, id, pubkey, salt, relays, stamp])))

interface RecordBody {
  k: string
  w: string
  r: string[]
  t: number
  s: string
}

/**
 * The record of an ID, for anyone who has been given it.
 *
 * Everything that needs the secret key is done before anything is waited for: the
 * engine wipes its copy when the vault locks. Signed by a key nothing public ties to
 * the identity, so a relay sees an opaque event. The owner's own signature inside says
 * the relays are theirs: the sum proves whose ID it is, but anyone who has the ID can
 * make a record, and would otherwise be able to send people elsewhere.
 */
export async function textorIdEvent(
  secretKey: Uint8Array,
  id: string,
  relays: readonly string[],
  nowSec: number,
  derive: Derive = offThread,
): Promise<NostrEvent> {
  const pubkey = getPublicKey(secretKey)
  const hints = normalizeRelayList(relays, 6)
  const salt = idSaltOf(secretKey)
  const signature = schnorr.sign(signatureDigest(id, pubkey, salt, hints, nowSec), secretKey)
  const seed = hkdf(sha256, secretKey, undefined, SIGNER_INFO, 48)
  const signer = schnorr.utils.randomSecretKey(seed)
  wipe(seed)
  const body: RecordBody = { k: pubkey, w: salt, r: hints, t: nowSec, s: bytesToHex(signature) }
  try {
    const { d, sealKey } = await placeOf(id, derive)
    return finalizeEvent(
      {
        kind: KIND_APP_DATA,
        created_at: nowSec,
        tags: [
          ['d', d],
          ['expiration', String(nowSec + RECORD_TTL_SEC)],
        ],
        content: nip44.encrypt(JSON.stringify(body), sealKey),
      },
      signer,
    )
  } finally {
    wipe(signer)
  }
}

const isSignature = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{128}$/.test(value)
const isSalt = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

/** What a record says, once its signature holds. Not yet whether the ID is the signer's: that costs scrypt. */
function openRecord(event: NostrEvent, id: string, sealKey: Uint8Array): RecordBody | null {
  try {
    const { k, w, r, t, s } = JSON.parse(nip44.decrypt(event.content, sealKey)) as Partial<RecordBody>
    if (!isHex32(k) || !isSalt(w) || !isSignature(s) || !Array.isArray(r) || r.length > 6) return null
    if (!Number.isSafeInteger(t) || (t as number) <= 0) return null
    const body: RecordBody = { k, w, r: r as string[], t: t as number, s }
    return schnorr.verify(hexToBytes(s), signatureDigest(id, k, w, body.r, body.t), hexToBytes(k))
      ? body
      : null
  } catch {
    return null
  }
}

export interface IdOwner {
  pubkey: string
  relays: string[]
}

export interface IdLookup {
  /**
   * Everyone whose key gives this ID. One, nearly always. More means two keys reached
   * the same number, by chance or by effort, and only the person asking can tell which
   * they meant.
   */
  owners: IdOwner[]
  /** More records claimed it than were checked, so someone is flooding it, and an owner may be among the rest. */
  crowded: boolean
}

/**
 * Who holds an ID, as far as the relays will say. Nothing a relay does can name the
 * wrong person, without someone having done the work of forging: what it can do is say
 * nothing, so the worst it can do is that nobody is found.
 */
export async function lookUpTextorId(
  id: string,
  query: (filter: Filter) => Promise<NostrEvent[]>,
  derive: Derive = offThread,
): Promise<IdLookup> {
  const { d, sealKey } = await placeOf(id, derive)
  const events = await query({ kinds: [KIND_APP_DATA], '#d': [d], limit: LOOKUP_LIMIT })
  const newest = new Map<string, RecordBody>()
  for (const event of events) {
    const body = openRecord(event, id, sealKey)
    if (!body) continue
    const held = newest.get(body.k)
    if (!held || body.t > held.t) newest.set(body.k, body)
  }
  const bodies = [...newest.values()].sort((a, b) => b.t - a.t)
  const owners: IdOwner[] = []
  for (const body of bodies.slice(0, MAX_CANDIDATES)) {
    if ((await textorIdFrom(body.k, body.w, derive)) === id) {
      owners.push({ pubkey: body.k, relays: normalizeRelayList(body.r, 6) })
    }
  }
  return { owners, crowded: bodies.length > MAX_CANDIDATES }
}

/** A link that opens the app on this ID. The part after `#` is never sent to whoever hosts it. */
export function textorIdLink(id: string, origin?: string): string {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '/')
  return `${base.replace(/[#?].*$/, '')}#/id/${id}`
}
