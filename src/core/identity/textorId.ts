import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent } from 'nostr-tools/pure'
import { verifyEventSignature } from '../crypto/eventSignature'
import type { KdfParams } from '../crypto/kdf'
import type { KdfRequest, KdfResponse } from '../crypto/kdf.worker'
import { normalizeRelayList } from '../transport/relayUrl'
import { concatBytes, utf8ToBytes } from '../util/bytes'

/**
 * The Textor ID: sixteen characters that find someone, like `7X9K-2M4Q-HD3R-T8VW` (ADR-081).
 *
 * The first 75 bits of an scrypt of the public key, then a character that checks the
 * other fifteen. Anyone can work out the ID of any key, so it is as public as the key,
 * and names it the way a fingerprint does. Nobody hands one out, chooses it or can take
 * it: to pass as someone, another key would have to give the same 75 bits, and the
 * scrypt is what puts that past what anyone can spend.
 *
 * Whoever is given one finds a record its owner signed, and works out the ID of the key
 * that signed it themselves, so a relay can hide an owner but cannot name the wrong
 * person.
 *
 * Only ever loaded through `import()`, so none of this is in the precache.
 */

/**
 * Two lanes of scrypt at a quarter of the vault's size each: 32 MiB in all, to be done
 * within a second on the slowest phone, by estimate, as a phone has a core to spare for
 * each lane. An attacker pays for all of it on every guess, side by side or not, and
 * memory is what keeps custom hardware from paying much less (ADR-081).
 */
export const ID_KDF: KdfParams = { algo: 'scrypt', N: 2 ** 14, r: 8, p: 1 }
export const ID_LANES = 2
const KEY_BYTES = 32
export const ID_BITS = 75
/** Five bits to a character: fifteen for the number, and one that checks them. */
const ID_SYMBOLS = ID_BITS / 5
export const ID_LENGTH = ID_SYMBOLS + 1
/** Crockford's: no `I`, `L`, `O` or `U`, so `1` and `0` have nothing to be taken for. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SYMBOLS = /^[0-9A-HJKMNP-TV-Z]*$/

/** NIP-78's kind and the records' life, as in `profileRecord.ts`, which is another chunk's. */
const KIND_APP_DATA = 30078
const RECORD_TTL_SEC = 365 * 86_400

/** Asked of each relay. A record is small, and anyone who knows an ID can add to these. */
const LOOKUP_LIMIT = 64
/**
 * The most records one look will spend a run on: eight runs keep the slowest phone within
 * the ten seconds a look may take, by estimate, while someone flooding an ID with false
 * records needs eight newer than the owner's to hide them.
 */
const MAX_CANDIDATES = 8

const laneSalts = (label: string): Uint8Array[] =>
  Array.from({ length: ID_LANES }, (_, lane) => sha256(utf8ToBytes(`${label}\0${lane}`)))

const KEY_SALTS = laneSalts('textor/id/v2/key')
/** What a record is filed under: the ID itself, as nothing about it is secret. */
const RECORD_PREFIX = 'textor/id/v2:'

/** One lane of scrypt, wherever it runs. */
export type Derive = (password: string, salt: Uint8Array, params: KdfParams) => Promise<Uint8Array>

/** Where there can be no workers: what `deriveKek` does, as the worker runs it. */
const inline: Derive = (password, salt, { N, r, p }) =>
  scryptAsync(password.normalize('NFKC'), salt, { N, r, p, dkLen: KEY_BYTES })

/**
 * One lane, off the main thread. Not through `kdfClient`, though it does the same:
 * imported statically from here as well as from the shell, the bundler would hoist
 * it into a shared chunk not named `lazy-`, and so into the precache.
 */
const offThread: Derive = (password, salt, params) => {
  let worker: Worker
  try {
    worker = new Worker(new URL('../crypto/kdf.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return inline(password, salt, params)
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<KdfResponse>) => {
      const message = event.data
      if (message.type === 'done') resolve(new Uint8Array(message.key))
      else if (message.type === 'error') reject(new Error(message.message))
    })
    // A worker that will not load must not cost anyone their ID.
    worker.addEventListener('error', () => void inline(password, salt, params).then(resolve, reject))
    const request: KdfRequest = { id: 1, passphrase: password, salt, params }
    worker.postMessage(request)
  }).finally(() => worker.terminate())
}

/** One run: every lane at once, each in a worker of its own, and nothing short of all of them will do. */
const run = async (
  password: string,
  salts: Uint8Array[],
  derive: Derive,
  params: KdfParams,
): Promise<Uint8Array> =>
  sha256(concatBytes(...(await Promise.all(salts.map((salt) => derive(password, salt, params))))))

// --- the check character ---------------------------------------------------

/** GF(32), from x^5 + x^2 + 1: the powers of x, and which power each value is. */
const POWERS: number[] = []
const LOGS: number[] = []
for (let power = 0, value = 1; power < 31; power++) {
  POWERS[power] = value
  LOGS[value] = power
  value <<= 1
  if (value & 32) value ^= 0b100101
}

const times = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (POWERS[((LOGS[a] as number) + (LOGS[b] as number)) % 31] as number)

/**
 * The sixteenth character, from the first fifteen: each times a power of x of its own,
 * summed in GF(32), the check's own weight being 1. No weight is zero and no two are
 * alike, so one character wrong always shows, and so do two neighbours swapped,
 * the check among them. Anything else gets through one time in 32 (ADR-081).
 */
function checkOf(symbols: readonly number[]): number {
  let sum = 0
  symbols.forEach((symbol, place) => {
    sum ^= times(POWERS[place + 1] as number, symbol)
  })
  return sum
}

/** The first 75 bits of a key, as fifteen characters, leading zeros and all, then the check. */
export function idOf(key: Uint8Array): string {
  const symbols: number[] = []
  for (let place = 0; place < ID_SYMBOLS; place++) {
    const bit = place * 5
    const pair = ((key[bit >> 3] as number) << 8) | (key[(bit >> 3) + 1] as number)
    symbols.push((pair >> (11 - (bit & 7))) & 31)
  }
  symbols.push(checkOf(symbols))
  return symbols.map((symbol) => ALPHABET[symbol]).join('')
}

/** An ID in its one spelling whose check holds: the only kind kept or looked up. */
export function isTextorId(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== ID_LENGTH || !SYMBOLS.test(value)) return false
  const symbols = [...value].map((symbol) => ALPHABET.indexOf(symbol))
  return checkOf(symbols.slice(0, ID_SYMBOLS)) === symbols[ID_SYMBOLS]
}

// --- reading one ------------------------------------------------------------

/** Persian and Arabic-Indic digits, as a Persian keyboard types them. */
const asciiDigits = (text: string): string =>
  text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) & 0xf))

/**
 * What was typed, read out, pasted or linked: an ID, or what is wrong with it. A typo is
 * told apart from something that is no ID at all, so whoever typed it can be asked to
 * check it before anything is looked up, rather than think nobody has it.
 */
export type IdReading = { id: string } | { problem: 'typo' | 'invalid' }

export function readTextorId(raw: string): IdReading {
  const link = /#\/id\/([^/?#\s]+)/.exec(raw)
  const text = asciiDigits(link ? (link[1] as string) : raw)
    // Marks a chat app may have put around it, and however it was grouped.
    .replace(/[\s\-_.\u2010-\u2015\u2212\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (text.length === 0 || !SYMBOLS.test(text)) return { problem: 'invalid' }
  if (text.length === ID_LENGTH) return isTextorId(text) ? { id: text } : { problem: 'typo' }
  // A character short or over is a slip of typing, not something else altogether.
  return Math.abs(text.length - ID_LENGTH) === 1 ? { problem: 'typo' } : { problem: 'invalid' }
}

// --- working one out --------------------------------------------------------

/** The ID of a key: anyone's, worked out from nothing but the key. */
export const textorIdOf = async (pubkey: string, derive: Derive = offThread): Promise<string> =>
  idOf(await run(pubkey, KEY_SALTS, derive, ID_KDF))

// --- the record ---------------------------------------------------------------

/**
 * The record of an ID: where its owner reads, signed by the owner, filed under the ID.
 * It is there because a relay cannot work an ID out for anyone, so someone given sixteen
 * characters needs something to ask for. A year's life, written again every month.
 */
export function textorIdEvent(
  secretKey: Uint8Array,
  id: string,
  relays: readonly string[],
  nowSec: number,
): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: nowSec,
      tags: [
        ['d', `${RECORD_PREFIX}${id}`],
        ['expiration', String(nowSec + RECORD_TTL_SEC)],
      ],
      content: JSON.stringify({ r: normalizeRelayList(relays, 6) }),
    },
    secretKey,
  )
}

/** Where a record says its owner reads, or null if it is not a record of an ID. */
function relaysOf(event: NostrEvent, d: string): string[] | null {
  if (event.kind !== KIND_APP_DATA || event.tags.find((tag) => tag[0] === 'd')?.[1] !== d) return null
  try {
    const { r } = JSON.parse(event.content) as { r?: unknown }
    if (!Array.isArray(r) || r.length > 6 || !r.every((url) => typeof url === 'string')) return null
    return normalizeRelayList(r, 6)
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
  /** More keys claimed it than were checked, so someone is flooding it, and an owner may be among the rest. */
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
  const d = `${RECORD_PREFIX}${id}`
  const events = await query({ kinds: [KIND_APP_DATA], '#d': [d], limit: LOOKUP_LIMIT })
  const newest = new Map<string, { at: number; relays: string[] }>()
  for (const event of events) {
    const relays = relaysOf(event, d)
    // Checked here as well as where it came in, and afresh, as a check `verifyEvent`
    // remembers on the object would survive a copy with the content changed. This is
    // what names someone.
    if (!relays || !verifyEventSignature(event)) continue
    const held = newest.get(event.pubkey)
    if (!held || event.created_at > held.at) newest.set(event.pubkey, { at: event.created_at, relays })
  }
  const claims = [...newest].sort(([, a], [, b]) => b.at - a.at)
  const owners: IdOwner[] = []
  for (const [pubkey, { relays }] of claims.slice(0, MAX_CANDIDATES)) {
    if ((await textorIdOf(pubkey, derive)) === id) owners.push({ pubkey, relays })
  }
  return { owners, crowded: claims.length > MAX_CANDIDATES }
}

/** A link that opens the app on this ID. The part after `#` is never sent to whoever hosts it. */
export function textorIdLink(id: string, origin?: string): string {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '/')
  return `${base.replace(/[#?].*$/, '')}#/id/${id}`
}
