import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { RelayPool } from '@/core/transport/relayPool'
import { InboxSync, type InboxSyncStore } from '@/core/engine/inboxSync'
import { HORIZON_SEC } from '@/core/transport/nostrTransport'
import type { SyncState } from '@/core/vault/repo'
import type { NegentropyItem } from '@/core/transport/negentropy'
import '@/core/transport/negentropy'
import { FakeSocketNetwork } from './fakeWebSocket'

/**
 * Catching up from relays as they really are (ADR-073): one that stops at its
 * own limit and says it has finished, several holding the same wraps, one
 * offering a wrap past its expiry, and one standing by with something nobody
 * has read.
 */

const ME = getPublicKey(generateSecretKey())
const DAY_SEC = 86_400
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const nowSec = () => Math.floor(Date.now() / 1000)

async function run<T>(promise: Promise<T>, stepMs = 20, maxMs = 120_000): Promise<T> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  for (let spent = 0; !done && spent < maxMs; spent += stepMs) await advance(stepMs)
  return promise
}

function wrap(ageSec = 60, tags: string[][] = []): NostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: nowSec() - ageSec, tags: [['p', ME], ...tags], content: 'x' },
    generateSecretKey(),
  )
}

class MemoryStore implements InboxSyncStore {
  state: SyncState = { lastSyncSec: 1, floorSec: 0, relays: {} }
  held = new Map<string, number>()
  async load() {
    return structuredClone(this.state)
  }
  async save(state: SyncState) {
    this.state = structuredClone(state)
  }
  async items(sinceSec: number): Promise<NegentropyItem[]> {
    return [...this.held].filter(([, at]) => at >= sinceSec).map(([id, createdAt]) => ({ id, createdAt }))
  }
}

describe('catching up from real relays', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool
  let store: MemoryStore
  let received: string[]
  let sync: InboxSync

  const windowMark = (hwm = 0) => ({ hwm, neg: { ok: false, at: Date.now() } })

  const start = async (urls: string[], active = urls) => {
    pool = new RelayPool({
      socket: { createSocket: network.factory, random: () => 0, isOffline: () => false },
    })
    pool.setRelays(urls, [])
    pool.preferRead(active)
    received = []
    sync = new InboxSync({
      pool,
      store,
      pubkey: ME,
      onWrap: (event) => {
        if (store.held.has(event.id)) return
        store.held.set(event.id, event.created_at)
        sync.noteWrap(event.id, event.created_at)
        received.push(event.id)
      },
    })
    await sync.start()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    store = new MemoryStore()
  })
  afterEach(() => {
    sync.stop()
    pool.destroy()
    vi.useRealTimers()
  })

  describe('a relay that stops at its own limit', () => {
    it('reads on past it, and moves the mark only once there is nothing older', async () => {
      // What primal does: 500 and an EOSE, as if that were all. Before this, the
      // mark moved to now and everything older on that relay was never asked for.
      const relay = network.relay('wss://cap.example', { maxLimit: 25 })
      const stored = Array.from({ length: 70 }, (_, i) => wrap(100 + i * 10))
      for (const event of stored) relay.inject(event)
      store.state.relays['wss://cap.example'] = windowMark()

      await start(['wss://cap.example'])
      await run(sync.catchUp({ maxWaitMs: 60_000 }))

      expect(new Set(received)).toEqual(new Set(stored.map((event) => event.id)))
      const pages = relay.reqs.filter((req) => req.filters[0]?.until !== undefined)
      expect(pages.length).toBeGreaterThanOrEqual(2)
      expect(sync.snapshot().relays['wss://cap.example']!.hwm).toBeGreaterThan(0)
    })

    it('does not ask again after a replay too short to have reached a limit', async () => {
      const relay = network.relay('wss://small.example', { maxLimit: 25 })
      for (let i = 0; i < 5; i++) relay.inject(wrap(100 + i))
      store.state.relays['wss://small.example'] = windowMark()
      await start(['wss://small.example'])
      await run(sync.catchUp())
      expect(received).toHaveLength(5)
      expect(relay.reqs.filter((req) => req.filters[0]?.until !== undefined)).toHaveLength(0)
    })

    it('counts duplicates towards the limit: another relay having delivered them changes nothing', async () => {
      // Skipped unparsed by the pool, and still proof the relay stopped short.
      const first = network.relay('wss://first.example', { eoseDelayMs: 0 })
      const capped = network.relay('wss://capped.example', { maxLimit: 25, eoseDelayMs: 500 })
      const shared = Array.from({ length: 25 }, (_, i) => wrap(100 + i))
      const older = Array.from({ length: 5 }, (_, i) => wrap(5000 + i))
      for (const event of shared) {
        first.inject(event)
        capped.inject(event)
      }
      for (const event of older) capped.inject(event)
      store.state.relays['wss://first.example'] = windowMark()
      store.state.relays['wss://capped.example'] = windowMark()
      await start(['wss://first.example', 'wss://capped.example'])
      await run(sync.catchUp({ maxWaitMs: 60_000 }))
      await advance(5000)
      expect(new Set(received)).toEqual(new Set([...shared, ...older].map((event) => event.id)))
    })

    it('steps past a page all from one second', async () => {
      const relay = network.relay('wss://same.example', { maxLimit: 25 })
      const at = 500
      const stored = Array.from({ length: 25 }, () => wrap(at))
      const older = wrap(9000)
      for (const event of [...stored, older]) relay.inject(event)
      store.state.relays['wss://same.example'] = windowMark()
      await start(['wss://same.example'])
      await run(sync.catchUp({ maxWaitMs: 60_000 }))
      expect(received).toContain(older.id)
    })

    it('keeps the mark when a page never finishes, and asks again later', async () => {
      const relay = network.relay('wss://stall.example', { maxLimit: 25 })
      for (let i = 0; i < 40; i++) relay.inject(wrap(100 + i * 10))
      store.state.relays['wss://stall.example'] = windowMark(1)
      const receive = relay.receive.bind(relay)
      let stall = true
      relay.receive = (connection, data) => {
        if (stall && data.includes('"until"')) return
        receive(connection, data)
      }
      await start(['wss://stall.example'])
      await advance(20_000)
      expect(sync.snapshot().relays['wss://stall.example']!.hwm).toBe(1)

      stall = false
      await run(sync.catchUp({ force: true, maxWaitMs: 60_000 }))
      expect(received).toHaveLength(40)
      expect(sync.snapshot().relays['wss://stall.example']!.hwm).toBeGreaterThan(1)
    })

    it('reads one EOSE once, however many a relay sends', async () => {
      const relay = network.relay('wss://echo.example', { maxLimit: 25, eoseDelayMs: 50 })
      for (let i = 0; i < 30; i++) relay.inject(wrap(100 + i))
      store.state.relays['wss://echo.example'] = windowMark()
      await start(['wss://echo.example'])
      await advance(60)
      const pages = () => relay.reqs.filter((req) => req.filters[0]?.until !== undefined).length
      const before = pages()
      expect(before).toBe(1)
      const inbox = relay.reqs.find((req) => req.id.startsWith('inbox'))!.id
      network.sockets.at(-1)!.deliver(JSON.stringify(['EOSE', inbox]))
      await advance(1)
      expect(pages()).toBe(before)
      await run(sync.catchUp({ maxWaitMs: 60_000 }))
      await advance(5000)
      expect(received).toHaveLength(30)
    })

    it('gives up for now after a very long read, with the mark where it was', async () => {
      const relay = network.relay('wss://deep.example', { maxLimit: 20 })
      for (let i = 0; i < 1400; i++) relay.inject(wrap(100 + i * 2))
      store.state.relays['wss://deep.example'] = windowMark(1)
      await start(['wss://deep.example'])
      await run(sync.catchUp({ maxWaitMs: 1000 }))
      await advance(120_000)
      expect(sync.snapshot().relays['wss://deep.example']!.hwm).toBe(1)
      expect(received.length).toBeGreaterThan(1000)
    })

    it('stops reading once stopped', async () => {
      const relay = network.relay('wss://halt.example', { maxLimit: 25, eoseDelayMs: 100 })
      for (let i = 0; i < 40; i++) relay.inject(wrap(100 + i * 10))
      store.state.relays['wss://halt.example'] = windowMark(1)
      await start(['wss://halt.example'])
      await advance(150)
      sync.stop()
      await advance(20_000)
      expect(store.state.relays['wss://halt.example']!.hwm).toBe(1)
    })
  })

  describe('several relays holding the same wraps', () => {
    it('downloads each only once, one relay at a time', async () => {
      const a = network.relay('wss://a.example', { negentropy: true })
      const b = network.relay('wss://b.example', { negentropy: true })
      const c = network.relay('wss://c.example', { negentropy: true })
      const stored = Array.from({ length: 30 }, (_, i) => wrap(100 + i))
      for (const event of stored) {
        a.inject(event)
        b.inject(event)
        c.inject(event)
      }
      await start(['wss://a.example', 'wss://b.example', 'wss://c.example'])
      await run(sync.catchUp())
      expect(received).toHaveLength(30)
      // Before: each relay was found to have thirty the device lacked, and sent them.
      expect(a.eventsSent + b.eventsSent + c.eventsSent).toBe(30)
    })

    it('still fetches what only a later relay has', async () => {
      const a = network.relay('wss://a.example', { negentropy: true })
      const b = network.relay('wss://b.example', { negentropy: true })
      const shared = wrap(100)
      const only = wrap(200)
      a.inject(shared)
      b.inject(shared)
      b.inject(only)
      await start(['wss://a.example', 'wss://b.example'])
      await run(sync.catchUp())
      expect(new Set(received)).toEqual(new Set([shared.id, only.id]))
    })
  })

  describe('what is refused', () => {
    it('refuses a wrap past its own expiry, and stops asking for it', async () => {
      const relay = network.relay('wss://old.example', { negentropy: true })
      const gone = wrap(1000, [['expiration', String(nowSec() - 10)]])
      const live = wrap(1000, [['expiration', String(nowSec() + 1000)]])
      const noTag = wrap(1000)
      for (const event of [gone, live, noTag]) relay.inject(event)
      await start(['wss://old.example'])
      await run(sync.catchUp())
      expect(new Set(received)).toEqual(new Set([live.id, noTag.id]))

      const before = relay.eventsSent
      await run(sync.catchUp({ force: true }))
      expect(relay.eventsSent).toBe(before)
    })

    it('starts a device with no history at the horizon, so nothing older comes back', async () => {
      store.state = { lastSyncSec: 0, floorSec: 0, relays: {} }
      const relay = network.relay('wss://new.example', { negentropy: true })
      const recent = wrap(40 * DAY_SEC)
      const ancient = wrap(60 * DAY_SEC)
      relay.inject(recent)
      relay.inject(ancient)
      await start(['wss://new.example'])
      await run(sync.catchUp())
      expect(received).toEqual([recent.id])
      expect(sync.floorSec).toBeGreaterThanOrEqual(nowSec() - HORIZON_SEC - 5)
    })

    it('reads a new device’s whole history, though its sockets were still connecting when it asked', async () => {
      // The catch-up at start finds nothing connected yet. It used to move the
      // shared cursor to now all the same, and every relay then read from there.
      store.state = { lastSyncSec: 0, floorSec: 0, relays: {} }
      const relay = network.relay('wss://late.example', { connectDelayMs: 200 })
      const old = wrap(20 * DAY_SEC)
      relay.inject(old)
      await start(['wss://late.example'])
      await run(sync.catchUp())
      expect(received).toEqual([old.id])
      expect(sync.lastSyncSec).toBeGreaterThan(0)
    })

    it('moves no cursor on a catch-up that reached nothing', async () => {
      store.state = { lastSyncSec: 0, floorSec: 0, relays: {} }
      network.relay('wss://down.example', { refuse: true })
      await start(['wss://down.example'])
      await run(sync.catchUp({ maxWaitMs: 500 }))
      expect(sync.lastSyncSec).toBe(0)
    })

    it('leaves a device with history at the floor it already had', async () => {
      store.state = { lastSyncSec: nowSec() - 100, floorSec: 0, relays: {} }
      network.relay('wss://kept.example')
      await start(['wss://kept.example'])
      expect(sync.floorSec).toBe(0)
    })
  })

  describe('a relay standing by', () => {
    const urls = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example', 'wss://r4.example']
    const standby = 'wss://standby.example'

    it('is looked in on, once a day, and only what it alone holds is fetched', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const relay = network.relay(standby, { negentropy: true })
      const only = wrap(100)
      relay.inject(only)
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      expect(received).toEqual([])

      await run(sync.sweepStandby())
      expect(received).toEqual([only.id])
      const mark = sync.snapshot().relays[standby]!
      expect(mark.sweptAt).toBeGreaterThan(0)
      expect(mark.hwm).toBeGreaterThan(0)
      expect(mark.neg?.ok).toBe(true)

      // Not again within the hour, nor the same relay within the day.
      const reads = () => relay.reqs.filter((req) => req.filters[0]?.kinds?.includes(1059)).length
      const before = reads()
      await run(sync.sweepStandby())
      await advance(2 * 60 * 60_000)
      await run(sync.sweepStandby())
      expect(reads()).toBe(before)

      await advance(24 * 60 * 60_000)
      await run(sync.sweepStandby())
      expect(reads()).toBeGreaterThan(before)
    })

    it('looks in on the one left longest', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const second = 'wss://standby2.example'
      network.relay(standby, { negentropy: true })
      network.relay(second, { negentropy: true })
      store.state.relays[standby] = { hwm: 0, sweptAt: Date.now() - 2 * DAY_SEC * 1000 }
      store.state.relays[second] = { hwm: 0, sweptAt: Date.now() - 3 * DAY_SEC * 1000 }
      await start([...urls, standby, second], urls)
      await run(sync.catchUp())
      await run(sync.sweepStandby())
      expect(sync.snapshot().relays[second]!.sweptAt).toBeGreaterThan(Date.now() - 60_000)
      expect(sync.snapshot().relays[standby]!.sweptAt).toBeLessThan(Date.now() - 60_000)
    })

    it('reads a relay that does not speak NIP-77 by the window, and remembers', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const relay = network.relay(standby)
      const only = wrap(100)
      relay.inject(only)
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      await run(sync.sweepStandby())
      expect(received).toEqual([only.id])
      expect(sync.snapshot().relays[standby]!.neg?.ok).toBe(false)
    })

    it('reads by window straight away where NIP-77 is known not to work', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const relay = network.relay(standby)
      const only = wrap(100)
      relay.inject(only)
      store.state.relays[standby] = windowMark()
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      await run(sync.sweepStandby())
      expect(received).toEqual([only.id])
      expect(relay.negOpens).toBe(0)
    })

    it('leaves the mark alone when the read did not finish', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const relay = network.relay(standby)
      relay.inject(wrap(100))
      store.state.relays[standby] = windowMark(7)
      relay.receive = () => undefined
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      await run(sync.sweepStandby())
      const mark = sync.snapshot().relays[standby]!
      expect(mark.hwm).toBe(7)
      expect(mark.sweptAt).toBeGreaterThan(0)
    })

    it('falls back without a verdict when a reconciliation merely fails', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      const relay = network.relay(standby)
      relay.inject(wrap(100))
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      vi.spyOn(pool, 'reconcile').mockResolvedValue({ ok: false, refused: false, reason: 'not connected' })
      await run(sync.sweepStandby())
      expect(received).toHaveLength(1)
      expect(sync.snapshot().relays[standby]!.neg).toBeUndefined()
    })

    it('has nothing to do with every relay in use, or once stopped', async () => {
      for (const url of urls) network.relay(url)
      await start(urls)
      await run(sync.catchUp())
      await run(sync.sweepStandby())
      expect(Object.values(sync.snapshot().relays).some((mark) => mark.sweptAt)).toBe(false)
      sync.stop()
      await run(sync.sweepStandby())
    })

    it('drops the result of a visit stopped on the way', async () => {
      for (const url of urls) network.relay(url, { negentropy: true })
      network.relay(standby, { eoseDelayMs: 1000 })
      await start([...urls, standby], urls)
      await run(sync.catchUp())
      const visiting = sync.sweepStandby()
      await advance(10)
      sync.stop()
      await run(visiting)
      expect(sync.snapshot().relays[standby]?.sweptAt).toBeUndefined()
    })
  })
})
