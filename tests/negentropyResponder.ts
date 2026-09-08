import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'

/**
 * The relay's side of negentropy, for the fake relays in tests.
 *
 * Deliberately a separate, plain port of the reference responder
 * (hoytech/negentropy, js/Negentropy.js, `isInitiator === false`) rather than
 * a mode of the client in `src/`: a bug shared by both halves would cancel
 * out and pass. The client is checked against this, and this is checked
 * against the reference initiator that ships inside nostr-tools.
 */

const VERSION = 0x61
const ID = 32
const FP = 16

interface Item {
  timestamp: number
  id: Uint8Array
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}
const cmpItem = (a: Item, b: Item) =>
  a.timestamp === b.timestamp ? cmpBytes(a.id, b.id) : a.timestamp - b.timestamp

function varint(n: number): number[] {
  if (n === 0) return [0]
  const out: number[] = []
  while (n !== 0) {
    out.push(n & 0x7f)
    n = Math.floor(n / 128)
  }
  out.reverse()
  for (let i = 0; i < out.length - 1; i++) out[i]! |= 0x80
  return out
}

export class NegentropyResponder {
  readonly items: Item[]
  #lastIn = 0
  #lastOut = 0

  constructor(
    events: { id: string; created_at: number }[],
    private readonly frameLimit = 60_000,
  ) {
    this.items = events.map((e) => ({ timestamp: e.created_at, id: hexToBytes(e.id) })).sort(cmpItem)
  }

  /** One round: the client's message in, the relay's reply out (null never happens for a responder). */
  reply(messageHex: string): string {
    const q = hexToBytes(messageHex)
    let at = 0
    const byte = () => {
      if (at >= q.length) throw new Error('ends early')
      return q[at++]!
    }
    const take = (n: number) => {
      if (at + n > q.length) throw new Error('ends early')
      const out = q.subarray(at, at + n)
      at += n
      return out
    }
    const readVarint = () => {
      let r = 0
      for (;;) {
        const b = byte()
        r = r * 128 + (b & 0x7f)
        if ((b & 0x80) === 0) return r
      }
    }
    this.#lastIn = 0
    this.#lastOut = 0
    const full: number[] = [VERSION]
    const version = byte()
    if (version !== VERSION) return bytesToHex(new Uint8Array(full))

    let prevBound: Item = { timestamp: 0, id: new Uint8Array(0) }
    let prevIndex = 0
    let skip = false
    while (at < q.length) {
      let o: number[] = []
      const doSkip = () => {
        if (!skip) return
        skip = false
        o.push(...this.#encodeBound(prevBound), ...varint(0))
      }
      const raw = readVarint()
      let ts = raw === 0 ? Infinity : raw - 1
      ts = this.#lastIn === Infinity || ts === Infinity ? Infinity : ts + this.#lastIn
      this.#lastIn = ts
      const len = readVarint()
      const currBound: Item = { timestamp: ts, id: new Uint8Array(take(len)) }
      const mode = readVarint()
      const lower = prevIndex
      let upper = this.#lowerBound(prevIndex, currBound)

      if (mode === 0) {
        skip = true
      } else if (mode === 1) {
        const theirs = take(FP)
        if (cmpBytes(theirs, this.fingerprint(lower, upper)) !== 0) {
          doSkip()
          this.#split(lower, upper, currBound, o)
        } else {
          skip = true
        }
      } else if (mode === 2) {
        const n = readVarint()
        take(n * ID)
        doSkip()
        const ids: number[] = []
        let count = 0
        let endBound = currBound
        for (let i = lower; i < upper; i++) {
          if (full.length + ids.length > this.frameLimit - 200) {
            endBound = this.items[i]!
            upper = i
            break
          }
          ids.push(...this.items[i]!.id)
          count++
        }
        o.push(...this.#encodeBound(endBound), ...varint(2), ...varint(count), ...ids)
        full.push(...o)
        o = []
      } else {
        throw new Error('unexpected mode')
      }

      if (full.length + o.length > this.frameLimit - 200) {
        full.push(...this.#encodeBound({ timestamp: Infinity, id: new Uint8Array(0) }), ...varint(1))
        full.push(...this.fingerprint(upper, this.items.length))
        break
      }
      full.push(...o)
      prevIndex = upper
      prevBound = currBound
    }
    return bytesToHex(new Uint8Array(full))
  }

  fingerprint(begin: number, end: number): Uint8Array {
    const sum = new Uint8Array(ID)
    for (let i = begin; i < end; i++) {
      let carry = 0
      for (let b = 0; b < ID; b++) {
        const t = sum[b]! + this.items[i]!.id[b]! + carry
        sum[b] = t & 0xff
        carry = t >> 8
      }
    }
    return sha256(new Uint8Array([...sum, ...varint(end - begin)])).subarray(0, FP)
  }

  #split(lower: number, upper: number, upperBound: Item, o: number[]): void {
    const n = upper - lower
    if (n < 32) {
      o.push(...this.#encodeBound(upperBound), ...varint(2), ...varint(n))
      for (let i = lower; i < upper; i++) o.push(...this.items[i]!.id)
      return
    }
    const per = Math.floor(n / 16)
    const extra = n % 16
    let curr = lower
    for (let i = 0; i < 16; i++) {
      const size = per + (i < extra ? 1 : 0)
      const fp = this.fingerprint(curr, curr + size)
      curr += size
      let bound: Item
      if (curr === upper) bound = upperBound
      else {
        const prev = this.items[curr - 1]!
        const next = this.items[curr]!
        if (prev.timestamp !== next.timestamp) bound = { timestamp: next.timestamp, id: new Uint8Array(0) }
        else {
          let shared = 0
          while (shared < ID && prev.id[shared] === next.id[shared]) shared++
          bound = { timestamp: next.timestamp, id: next.id.subarray(0, shared + 1) }
        }
      }
      o.push(...this.#encodeBound(bound), ...varint(1), ...fp)
    }
  }

  #lowerBound(from: number, bound: Item): number {
    let i = from
    while (i < this.items.length && cmpItem(this.items[i]!, bound) < 0) i++
    return i
  }

  #encodeBound(bound: Item): number[] {
    let t: number[]
    if (bound.timestamp === Infinity) {
      this.#lastOut = Infinity
      t = varint(0)
    } else {
      t = varint(bound.timestamp - this.#lastOut + 1)
      this.#lastOut = bound.timestamp
    }
    return [...t, ...varint(bound.id.length), ...bound.id]
  }
}
