import { beforeAll, describe, expect, it } from 'vitest'
import { NegentropyClient, NegentropyError, type NegentropyItem } from '@/core/transport/negentropy'
import { bytesToHex } from '@/core/util/bytes'
import { NegentropyResponder } from './negentropyResponder'

/**
 * The client is an independent implementation of a byte protocol, so it is
 * held to two other implementations: the reference initiator that ships
 * inside nostr-tools (not exported, so loaded by path) and the plain port of
 * the reference responder the fake relays use.
 */

interface ReferenceModule {
  NegentropyStorageVector: new () => { insert(ts: number, id: string): void; seal(): void }
  Negentropy: new (
    storage: unknown,
    frameSizeLimit?: number,
  ) => {
    initiate(): string
    reconcile(msg: string, onhave?: (id: string) => void, onneed?: (id: string) => void): string | null
  }
}

let reference: ReferenceModule
beforeAll(async () => {
  const url = new URL('../node_modules/nostr-tools/lib/esm/nip77.js', import.meta.url).href
  reference = (await import(/* @vite-ignore */ url)) as ReferenceModule
})

/** Deterministic pseudo-random ids, so a failure reproduces. */
function makeItems(count: number, seed: number, tsSpread = 50): NegentropyItem[] {
  // mulberry32: an LCG's low bits repeat every 256 draws, which made ids collide.
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  const items: NegentropyItem[] = []
  for (let i = 0; i < count; i++) {
    const id = new Uint8Array(32)
    for (let b = 0; b < 32; b++) id[b] = next() & 0xff
    items.push({ createdAt: 1_700_000_000 + (next() % tsSpread), id: bytesToHex(id) })
  }
  return items
}

const asEvents = (items: NegentropyItem[]) => items.map((i) => ({ id: i.id, created_at: i.createdAt }))

function referenceInitiator(items: NegentropyItem[], frameLimit?: number) {
  const storage = new reference.NegentropyStorageVector()
  for (const item of items) storage.insert(item.createdAt, item.id)
  storage.seal()
  return new reference.Negentropy(storage, frameLimit)
}

/** Run a whole reconciliation of `ours` against a relay holding `theirs`. */
function reconcile(ours: NegentropyItem[], theirs: NegentropyItem[], frameLimit = 60_000) {
  const client = new NegentropyClient(ours, frameLimit)
  const relay = new NegentropyResponder(asEvents(theirs), frameLimit)
  const need = new Set<string>()
  const have = new Set<string>()
  let message: string | null = client.initiate()
  let rounds = 0
  while (message) {
    rounds++
    const step = client.reconcile(relay.reply(message))
    step.need.forEach((id) => need.add(id))
    step.have.forEach((id) => have.add(id))
    message = step.next
  }
  return { need, have, rounds }
}

describe('negentropy client', () => {
  it('opens exactly as the reference implementation does', () => {
    for (const [count, spread] of [
      [0, 50],
      [1, 50],
      [31, 50],
      [32, 50],
      [33, 3],
      [500, 7],
      [3000, 100_000],
    ] as const) {
      const items = makeItems(count, count + 1, spread)
      expect(new NegentropyClient(items).initiate(), `${count} items`).toBe(
        referenceInitiator(items).initiate(),
      )
    }
  })

  it('finds exactly what each side is missing', () => {
    const shared = makeItems(800, 11)
    const onlyRelay = makeItems(37, 12)
    const onlyUs = makeItems(5, 13)
    const { need, have } = reconcile([...shared, ...onlyUs], [...shared, ...onlyRelay])
    expect(need).toEqual(new Set(onlyRelay.map((i) => i.id)))
    expect(have).toEqual(new Set(onlyUs.map((i) => i.id)))
  })

  it('settles in one round when nothing differs', () => {
    const items = makeItems(2000, 21)
    const { need, have, rounds } = reconcile(items, [...items].reverse())
    expect(need.size + have.size).toBe(0)
    expect(rounds).toBe(1)
  })

  it('handles an empty side either way', () => {
    const items = makeItems(90, 31)
    expect(reconcile([], items).need).toEqual(new Set(items.map((i) => i.id)))
    expect(reconcile(items, []).have).toEqual(new Set(items.map((i) => i.id)))
    expect(reconcile([], []).rounds).toBe(1)
  })

  it('keeps going across rounds when a frame fills up', () => {
    // A small frame forces the relay to answer with part of the list and a
    // fingerprint for the rest, and the client to continue from there.
    const shared = makeItems(400, 41, 5)
    const onlyRelay = makeItems(600, 42, 5)
    const { need, rounds } = reconcile(shared, [...shared, ...onlyRelay], 4096)
    expect(need).toEqual(new Set(onlyRelay.map((i) => i.id)))
    expect(rounds).toBeGreaterThan(1)
  })

  it('gives the same answer as the reference initiator against the same relay', () => {
    const shared = makeItems(300, 51, 20)
    const ours = [...shared, ...makeItems(4, 52)]
    const theirs = [...shared, ...makeItems(64, 53)]

    const relayA = new NegentropyResponder(asEvents(theirs))
    const ref = referenceInitiator(ours)
    const refNeed = new Set<string>()
    let msg: string | null = ref.initiate()
    while (msg) msg = ref.reconcile(relayA.reply(msg), undefined, (id) => refNeed.add(id))

    expect(reconcile(ours, theirs).need).toEqual(refNeed)
  })

  it('ignores a duplicate item rather than failing', () => {
    const [item] = makeItems(1, 61)
    expect(new NegentropyClient([item!, item!]).size).toBe(1)
  })

  it('refuses what is not a well-formed exchange', () => {
    const client = new NegentropyClient(makeItems(3, 71))
    expect(() => new NegentropyClient([], 100)).toThrow(NegentropyError)
    expect(() => new NegentropyClient([{ createdAt: 1, id: 'abcd' }])).toThrow(/32 bytes/)
    expect(() => client.reconcile('zz')).toThrow(/not hex/)
    expect(() => client.reconcile('')).toThrow(/not hex/)
    expect(() => client.reconcile('01')).toThrow(/not a negentropy message/)
    expect(() => client.reconcile('62')).toThrow(/version 2/)
    // Open bound, empty id, then a mode nobody defined.
    expect(() => client.reconcile('61000003')).toThrow(/unexpected mode/)
    // A bound claiming a 33-byte id.
    expect(() => client.reconcile('610021')).toThrow(/longer than an id/)
    // A fingerprint cut short.
    expect(() => client.reconcile('61000001aa')).toThrow(/ends early/)
    expect(() => client.reconcile('61ffffffffffffffffff')).toThrow(/varint too long/)
    // A varint whose continuation bit promises a byte that never comes.
    expect(() => client.reconcile('6180')).toThrow(/ends early/)
  })
})
