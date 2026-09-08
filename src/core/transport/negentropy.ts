import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '../util/bytes'

/**
 * Negentropy range-based set reconciliation, protocol version 1, as NIP-77
 * carries it — the initiating side only.
 *
 * The question it answers is "which of the events this relay holds for my
 * filter do I not have yet?", without either side sending its whole list. Both
 * sides sort their items by (timestamp, id) and exchange fingerprints of
 * ranges; a range whose fingerprints agree is settled in one message, and one
 * that differs is split until it is small enough to send as a list of ids. For
 * a device that already holds almost everything a relay does — the normal case
 * on every reconnect — that is a few hundred bytes instead of the relay
 * replaying days of gift wraps.
 *
 * Written against the protocol description (hoytech/negentropy, `docs/`) and
 * checked byte for byte against the reference port that ships inside
 * nostr-tools, which cannot be imported here because the package does not
 * export it. See `tests/negentropy.test.ts`.
 */

export const NEGENTROPY_VERSION = 0x61
const ID_SIZE = 32
const FINGERPRINT_SIZE = 16
/** Buckets a mismatched range is split into. */
const BUCKETS = 16
/** A range this small is sent as its ids rather than split further. */
const ID_LIST_BELOW = BUCKETS * 2

const enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

export interface NegentropyItem {
  /** The event's `created_at`, in seconds. */
  createdAt: number
  /** The event id, 64 lowercase hex characters. */
  id: string
}

interface Item {
  timestamp: number
  id: Uint8Array
}

interface Bound {
  /** `Infinity` is the protocol's open upper bound. */
  timestamp: number
  /** A prefix of an id, up to 32 bytes. */
  id: Uint8Array
}

export interface ReconcileStep {
  /** The next message for the relay, or null when reconciliation is complete. */
  next: string | null
  /** Ids the relay holds and we do not. */
  need: string[]
  /** Ids we hold and the relay does not. */
  have: string[]
}

export class NegentropyError extends Error {}

/**
 * One reconciliation, from the client's side.
 *
 * Hold one instance per NEG-OPEN: the timestamp deltas in each message are
 * relative to the previous bound in the same message, and the instance keeps
 * no other state between rounds.
 */
export class NegentropyClient {
  readonly #items: Item[]
  readonly #frameLimit: number
  #lastIn = 0
  #lastOut = 0

  constructor(items: readonly NegentropyItem[], frameSizeLimit = 60_000) {
    if (frameSizeLimit < 4096) throw new NegentropyError('frame size limit too small')
    this.#frameLimit = frameSizeLimit
    const seen = new Set<string>()
    const sorted: Item[] = []
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const id = hexToBytes(item.id)
      if (id.length !== ID_SIZE) throw new NegentropyError('item id is not 32 bytes')
      sorted.push({ timestamp: item.createdAt, id })
    }
    this.#items = sorted.sort(compareItems)
  }

  get size(): number {
    return this.#items.length
  }

  /** The NEG-OPEN payload, hex. */
  initiate(): string {
    const out = new Writer()
    out.byte(NEGENTROPY_VERSION)
    this.#lastOut = 0
    this.#splitRange(0, this.#items.length, { timestamp: Infinity, id: EMPTY }, out)
    return bytesToHex(out.bytes())
  }

  /** Answer one NEG-MSG from the relay. */
  reconcile(messageHex: string): ReconcileStep {
    if (!/^(?:[0-9a-f]{2})+$/.test(messageHex)) throw new NegentropyError('message is not hex')
    const query = new Reader(hexToBytes(messageHex))
    this.#lastIn = 0
    this.#lastOut = 0
    const version = query.byte()
    if (version < 0x60 || version > 0x6f) throw new NegentropyError('not a negentropy message')
    if (version !== NEGENTROPY_VERSION) {
      throw new NegentropyError(`relay speaks negentropy version ${version - 0x60}`)
    }

    const need: string[] = []
    const have: string[] = []
    const full = new Writer()
    full.byte(NEGENTROPY_VERSION)
    let prevBound: Bound = { timestamp: 0, id: EMPTY }
    let prevIndex = 0
    let skip = false

    while (!query.done) {
      const o = new Writer()
      const flushSkip = () => {
        if (!skip) return
        skip = false
        this.#encodeBound(prevBound, o)
        o.varint(Mode.Skip)
      }

      const currBound = this.#decodeBound(query)
      const mode = query.varint()
      const lower = prevIndex
      const upper = this.#lowerBound(prevIndex, currBound)

      if (mode === Mode.Skip) {
        skip = true
      } else if (mode === Mode.Fingerprint) {
        const theirs = query.bytes(FINGERPRINT_SIZE)
        if (equalBytes(theirs, this.#fingerprint(lower, upper))) {
          skip = true
        } else {
          flushSkip()
          this.#splitRange(lower, upper, currBound, o)
        }
      } else if (mode === Mode.IdList) {
        const count = query.varint()
        const theirs = new Set<string>()
        for (let i = 0; i < count; i++) theirs.add(bytesToHex(query.bytes(ID_SIZE)))
        skip = true
        for (let i = lower; i < upper; i++) {
          const id = bytesToHex((this.#items[i] as Item).id)
          if (!theirs.delete(id)) have.push(id)
        }
        need.push(...theirs)
      } else {
        throw new NegentropyError(`unexpected mode ${mode}`)
      }

      if (full.length + o.length > this.#frameLimit - 200) {
        // Out of room: settle the rest of the range with one fingerprint and
        // let the relay's next message continue from here.
        this.#encodeBound({ timestamp: Infinity, id: EMPTY }, full)
        full.varint(Mode.Fingerprint)
        full.append(this.#fingerprint(upper, this.#items.length))
        break
      }
      full.append(o.bytes())
      prevIndex = upper
      prevBound = currBound
    }

    return { next: full.length === 1 ? null : bytesToHex(full.bytes()), need, have }
  }

  #splitRange(lower: number, upper: number, upperBound: Bound, o: Writer): void {
    const count = upper - lower
    if (count < ID_LIST_BELOW) {
      this.#encodeBound(upperBound, o)
      o.varint(Mode.IdList)
      o.varint(count)
      for (let i = lower; i < upper; i++) o.append((this.#items[i] as Item).id)
      return
    }
    const perBucket = Math.floor(count / BUCKETS)
    const withExtra = count % BUCKETS
    let curr = lower
    for (let i = 0; i < BUCKETS; i++) {
      const size = perBucket + (i < withExtra ? 1 : 0)
      const fingerprint = this.#fingerprint(curr, curr + size)
      curr += size
      const bound =
        curr === upper ? upperBound : minimalBound(this.#items[curr - 1] as Item, this.#items[curr] as Item)
      this.#encodeBound(bound, o)
      o.varint(Mode.Fingerprint)
      o.append(fingerprint)
    }
  }

  /** The first index at or after `from` whose item is not below `bound`. */
  #lowerBound(from: number, bound: Bound): number {
    let first = from
    let count = this.#items.length - from
    while (count > 0) {
      const step = Math.floor(count / 2)
      const at = first + step
      if (compareItems(this.#items[at] as Item, bound) < 0) {
        first = at + 1
        count -= step + 1
      } else {
        count = step
      }
    }
    return first
  }

  /** SHA-256 of the ids summed mod 2^256 (little-endian) and the count, first 16 bytes. */
  #fingerprint(begin: number, end: number): Uint8Array {
    const sum = new Uint8Array(ID_SIZE)
    for (let i = begin; i < end; i++) {
      const id = (this.#items[i] as Item).id
      let carry = 0
      for (let b = 0; b < ID_SIZE; b++) {
        const total = (sum[b] as number) + (id[b] as number) + carry
        sum[b] = total & 0xff
        carry = total >> 8
      }
    }
    const input = new Writer()
    input.append(sum)
    input.varint(end - begin)
    return sha256(input.bytes()).subarray(0, FINGERPRINT_SIZE)
  }

  #encodeBound(bound: Bound, o: Writer): void {
    if (bound.timestamp === Infinity) {
      this.#lastOut = Infinity
      o.varint(0)
    } else {
      o.varint(bound.timestamp - this.#lastOut + 1)
      this.#lastOut = bound.timestamp
    }
    o.varint(bound.id.length)
    o.append(bound.id)
  }

  #decodeBound(query: Reader): Bound {
    const raw = query.varint()
    let timestamp: number
    if (raw === 0 || this.#lastIn === Infinity) {
      timestamp = Infinity
    } else {
      timestamp = this.#lastIn + raw - 1
    }
    this.#lastIn = timestamp
    const length = query.varint()
    if (length > ID_SIZE) throw new NegentropyError('bound is longer than an id')
    return { timestamp, id: query.bytes(length) }
  }
}

const EMPTY = new Uint8Array(0)

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  }
  return a.length - b.length
}

function compareItems(a: Item | Bound, b: Item | Bound): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1
  return compareBytes(a.id, b.id)
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && compareBytes(a, b) === 0

/** The shortest bound that sorts above `prev` and at or below `curr`. */
function minimalBound(prev: Item, curr: Item): Bound {
  if (curr.timestamp !== prev.timestamp) return { timestamp: curr.timestamp, id: EMPTY }
  let shared = 0
  while (shared < ID_SIZE && curr.id[shared] === prev.id[shared]) shared++
  return { timestamp: curr.timestamp, id: curr.id.subarray(0, shared + 1) }
}

class Writer {
  #buf = new Uint8Array(256)
  #len = 0

  get length(): number {
    return this.#len
  }

  byte(value: number): void {
    this.#reserve(1)
    this.#buf[this.#len++] = value
  }

  append(bytes: Uint8Array): void {
    this.#reserve(bytes.length)
    this.#buf.set(bytes, this.#len)
    this.#len += bytes.length
  }

  /** Big-endian base-128, continuation bit on every byte but the last. */
  varint(value: number): void {
    const groups = [value & 0x7f]
    let rest = Math.floor(value / 128)
    while (rest > 0) {
      groups.push(rest & 0x7f)
      rest = Math.floor(rest / 128)
    }
    for (let i = groups.length - 1; i >= 0; i--) this.byte((groups[i] as number) | (i > 0 ? 0x80 : 0))
  }

  bytes(): Uint8Array {
    return this.#buf.slice(0, this.#len)
  }

  #reserve(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return
    const next = new Uint8Array(Math.max(this.#buf.length * 2, this.#len + extra))
    next.set(this.#buf.subarray(0, this.#len))
    this.#buf = next
  }
}

class Reader {
  #at = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.#at >= this.buf.length
  }

  byte(): number {
    if (this.#at >= this.buf.length) throw new NegentropyError('message ends early')
    return this.buf[this.#at++] as number
  }

  bytes(n: number): Uint8Array {
    if (this.#at + n > this.buf.length) throw new NegentropyError('message ends early')
    const out = this.buf.subarray(this.#at, this.#at + n)
    this.#at += n
    return out
  }

  varint(): number {
    let value = 0
    for (let i = 0; i < 8; i++) {
      const byte = this.byte()
      value = value * 128 + (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new NegentropyError('varint too long')
  }
}
