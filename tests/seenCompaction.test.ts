import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAY, HOUR } from '@/core/util/time'
import { bytesToHex } from '@/core/util/bytes'
import { makeVault, type TestVault } from './helpers'

/**
 * The seen table is what makes a wrap delivered twice cost nothing. It is also
 * the one table that grows with every event received, receipts and attachment
 * chunks included, so it has to be pruned — and pruning it must never make a
 * forgotten wrap look new.
 */

const id = (n: number) =>
  bytesToHex(new Uint8Array(32).fill(n % 256)).slice(0, 60) + n.toString(16).padStart(4, '0')
const sec = (ms: number) => Math.floor(ms / 1000)

describe('seen marks', () => {
  let t: TestVault
  beforeEach(async () => {
    t = await makeVault()
  })
  afterEach(async () => {
    await t.destroy()
  })

  it('remembers a wrap by id, filed under its own hour', async () => {
    const createdAt = sec(Date.now()) - 5000
    await t.repo.markSeen([{ id: id(1), createdAt }])
    expect(await t.repo.hasSeen(id(1))).toBe(true)
    expect(await t.repo.hasSeen(id(2))).toBe(false)
    const [row] = await t.db.seen.toArray()
    expect(row!.ts % HOUR).toBe(0)
    expect(row!.ts).toBeLessThanOrEqual(createdAt * 1000)
    // The real id is never in the clear.
    expect(JSON.stringify(row)).not.toContain(id(1))
    await t.repo.markSeen([])
  })

  it('offers only sealed inbox marks, and only as far back as asked', async () => {
    const now = sec(Date.now())
    await t.repo.markSeen([
      { id: id(1), createdAt: now - 10 },
      { id: id(2), createdAt: now - 3 * 86400 },
    ])
    // Group traffic is deduplicated here too, but is not part of the inbox set.
    await t.repo.markSeen([{ id: id(3), createdAt: now - 10 }], { sync: false })
    await t.repo.withdraw('a'.repeat(64), 'b'.repeat(64))

    expect(await t.repo.seenItems(now - 86400)).toEqual([{ id: id(1), createdAt: now - 10 }])
    expect((await t.repo.seenItems(0)).map((i) => i.id).sort()).toEqual([id(1), id(2)].sort())
  })

  it('skips a mark it cannot open instead of failing the whole list', async () => {
    const now = sec(Date.now())
    await t.repo.markSeen([
      { id: id(1), createdAt: now },
      { id: id(2), createdAt: now },
    ])
    const [first] = await t.db.seen.toArray()
    await t.db.seen.update(first!.id, { enc: new Uint8Array(40) })
    expect(await t.repo.seenItems(0)).toHaveLength(1)
  })
})

describe('compacting the seen table', () => {
  let t: TestVault
  const now = Date.now()
  beforeEach(async () => {
    t = await makeVault()
  })
  afterEach(async () => {
    await t.destroy()
  })

  const marks = (count: number, ageMs: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ id: id(from + i), createdAt: sec(now - ageMs) }))

  it('does nothing, and leaves the floor alone, when nothing is old enough', async () => {
    await t.repo.markSeen(marks(10, DAY))
    expect(await t.repo.compactSeen({ now })).toEqual({ removed: 0, floorSec: 0 })
    expect(await t.repo.compactSeen({ now, floorSec: 1234 })).toEqual({ removed: 0, floorSec: 1234 })
  })

  it('forgets marks past the horizon, and raises the floor to match', async () => {
    await t.repo.markSeen(marks(5, 50 * DAY))
    await t.repo.markSeen(marks(3, 2 * DAY, 100))
    const result = await t.repo.compactSeen({ now })
    expect(result.removed).toBe(5)
    // Anything older than the floor could be one of the five just forgotten.
    expect(result.floorSec * 1000).toBeGreaterThan(now - 50 * DAY)
    expect(result.floorSec * 1000).toBeLessThanOrEqual(now - 45 * DAY)
    expect(await t.db.seen.count()).toBe(3)
  })

  it('keeps the table bounded, oldest delivery marks first', async () => {
    await t.repo.markSeen(marks(30, 20 * DAY))
    await t.repo.markSeen(marks(30, 10 * DAY, 100))
    await t.repo.markSeen(marks(30, 2 * DAY, 200))
    const result = await t.repo.compactSeen({ now, maxRows: 60, targetRows: 45 })
    expect(result.removed).toBe(30)
    expect(await t.db.seen.count()).toBe(60)
    expect(await t.repo.hasSeen(id(0))).toBe(false)
    expect(await t.repo.hasSeen(id(100))).toBe(true)
    expect(result.floorSec * 1000).toBeGreaterThan(now - 20 * DAY)
  })

  it('trims to four fifths of the cap by default, and can trim everything old enough', async () => {
    await t.repo.markSeen(marks(20, 20 * DAY))
    await t.repo.markSeen(marks(40, 10 * DAY, 100))
    expect((await t.repo.compactSeen({ now, maxRows: 50 })).removed).toBe(20)
    expect(await t.db.seen.count()).toBe(40)
    // Keeping none: everything outside the minimum horizon goes.
    await t.repo.markSeen(marks(5, HOUR, 200))
    expect((await t.repo.compactSeen({ now, maxRows: 1, targetRows: 0 })).removed).toBe(40)
    expect(await t.db.seen.count()).toBe(5)
  })

  it('never trims for size inside the minimum horizon, nor any tombstone', async () => {
    await t.repo.markSeen(marks(40, HOUR))
    await t.repo.withdraw('c'.repeat(64), 'd'.repeat(64))
    // Legacy rows (arrival time, nothing sealed) are left to age out.
    await t.db.seen.put({ id: 'legacy', ts: now - 30 * DAY })
    const result = await t.repo.compactSeen({ now, maxRows: 10, targetRows: 5 })
    expect(result).toEqual({ removed: 0, floorSec: 0 })
    expect(await t.repo.isWithdrawn('c'.repeat(64), 'd'.repeat(64))).toBe(true)
    expect(await t.db.seen.get('legacy')).toBeDefined()
  })

  it('deletes in batches, so a large prune does not hold one long transaction', async () => {
    // One more than a batch: the second batch is the one that ends the loop.
    await t.repo.markSeen(marks(2001, 60 * DAY))
    expect((await t.repo.compactSeen({ now })).removed).toBe(2001)
    expect(await t.db.seen.count()).toBe(0)
  })
})

describe('sync state', () => {
  let t: TestVault
  beforeEach(async () => {
    t = await makeVault()
  })
  afterEach(async () => {
    await t.destroy()
  })

  it('starts empty, round-trips sealed, and reads an older cursor forward', async () => {
    expect(await t.repo.getSyncState()).toEqual({ lastSyncSec: 0, floorSec: 0, relays: {} })
    const state = {
      lastSyncSec: 100,
      floorSec: 50,
      relays: { 'wss://a.example': { hwm: 90, neg: { ok: true, at: 1 } } },
    }
    await t.repo.setSyncState(state)
    expect(await t.repo.getSyncState()).toEqual(state)
    const row = await t.db.settings.get('sync')
    expect(JSON.stringify(row)).not.toContain('a.example')

    // What an earlier build wrote: a bare cursor.
    await t.db.settings.put({
      id: 'sync',
      enc: t.vault.sealRecord({ lastSyncSec: 42 }, 'textor/settings/sync'),
    })
    expect(await t.repo.getSyncState()).toEqual({ lastSyncSec: 42, floorSec: 0, relays: {} })
    await t.db.settings.put({ id: 'sync', enc: t.vault.sealRecord({}, 'textor/settings/sync') })
    expect(await t.repo.getSyncState()).toEqual({ lastSyncSec: 0, floorSec: 0, relays: {} })

    await t.db.settings.put({ id: 'sync', enc: new Uint8Array(48) })
    expect(await t.repo.getSyncState()).toEqual({ lastSyncSec: 0, floorSec: 0, relays: {} })
  })
})
