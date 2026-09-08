import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { RelaySocket } from '@/core/transport/relaySocket'
import {
  RelayPool,
  type PublishHandle,
  type PublishOutcome,
  type ReconcileOutcome,
  type RelayPoolEvents,
  type RelayProgress,
  type SubCloser,
} from '@/core/transport/relayPool'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '@/core/util/emitter'
import { InboxSync, INBOX_SYNC_TIMING, type InboxSyncStore } from '@/core/engine/inboxSync'
import { inboxFilter, SYNC_REWIND_SEC } from '@/core/transport/nostrTransport'
import type { SyncState } from '@/core/vault/repo'
import { NegentropyClient, type NegentropyItem } from '@/core/transport/negentropy'
import { FakeSocketNetwork, type FakeRelayServer, type FakeWebSocket } from './fakeWebSocket'

/**
 * Catching up without downloading the same wraps again: NIP-77 negentropy
 * where a relay speaks it, a read from that relay's own high-water mark where
 * it does not, and the plumbing each needs in the socket and the pool.
 */

const ME = getPublicKey(generateSecretKey())
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const nowSec = () => Math.floor(Date.now() / 1000)

/** Drive the fake clock until `promise` settles: sockets and timers need it to. */
async function run<T>(promise: Promise<T>, stepMs = 20, maxMs = 60_000): Promise<T> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  for (let spent = 0; !done && spent < maxMs; spent += stepMs) await advance(stepMs)
  return promise
}

/** A gift-wrap-shaped event addressed to us, `ageSec` old. */
function wrap(ageSec = 60): NostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: nowSec() - ageSec, tags: [['p', ME]], content: 'x' },
    generateSecretKey(),
  )
}

function poolOn(network: FakeSocketNetwork): RelayPool {
  return new RelayPool({ socket: { createSocket: network.factory, random: () => 0, isOffline: () => false } })
}

/** Frames the client sent to one relay, parsed. */
function sentTo(network: FakeSocketNetwork, url: string): unknown[][] {
  return network.sockets
    .filter((s) => s.url === url)
    .flatMap((s) => s.sent.map((frame) => JSON.parse(frame) as unknown[]))
}

class MemoryStore implements InboxSyncStore {
  state: SyncState = { lastSyncSec: 0, floorSec: 0, relays: {} }
  held = new Map<string, number>()
  saves = 0
  async load() {
    return structuredClone(this.state)
  }
  async save(state: SyncState) {
    this.saves++
    this.state = structuredClone(state)
  }
  async items(sinceSec: number): Promise<NegentropyItem[]> {
    return [...this.held].filter(([, at]) => at >= sinceSec).map(([id, createdAt]) => ({ id, createdAt }))
  }
}

describe('negentropy frames on one socket', () => {
  let network: FakeSocketNetwork
  let relay: FakeRelayServer
  let socket: RelaySocket

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    relay = network.relay('wss://a.example')
    socket = new RelaySocket(
      'wss://a.example',
      {},
      { createSocket: network.factory, isOffline: () => false, random: () => 0 },
    )
  })
  afterEach(() => {
    socket.close()
    vi.useRealTimers()
  })

  const raw = () => network.sockets.at(-1) as FakeWebSocket
  const session = () => {
    const log: string[] = []
    return {
      log,
      filter: { kinds: [1059] },
      initial: new NegentropyClient([]).initiate(),
      onMessage: (m: string) => log.push(`msg:${m}`),
      onError: (reason: string, refused: boolean) => log.push(`err:${reason}:${refused}`),
    }
  }

  it('refuses to open an exchange before the socket is up', () => {
    const s = session()
    socket.negOpen('neg:1', s)
    expect(s.log).toEqual(['err:not connected:false'])
  })

  it('carries messages both ways and closes cleanly', async () => {
    relay.set({ negentropy: true })
    socket.connect()
    await advance(5)
    const s = session()
    socket.negOpen('neg:1', s)
    await advance(5)
    expect(s.log[0]).toMatch(/^msg:61/)
    const again = new NegentropyClient([]).initiate()
    socket.negSend('neg:1', again)
    socket.negClose('neg:1')
    socket.negSend('neg:1', again) // after close: nothing goes out
    await advance(5)
    const frames = sentTo(network, 'wss://a.example').map((f) => f[0])
    expect(frames.filter((f) => f === 'NEG-MSG')).toHaveLength(1)
    expect(frames).toContain('NEG-CLOSE')
  })

  it('reads an unknown-command NOTICE as "does not speak NIP-77"', async () => {
    socket.connect()
    await advance(5)
    const s = session()
    socket.negOpen('neg:1', s)
    await advance(5)
    expect(s.log).toEqual(['err:ERROR: bad msg: unknown cmd:true'])
  })

  it('tells a relay error, a refusal and a lost connection apart', async () => {
    socket.connect()
    await advance(5)
    // A relay that holds on to every NEG-OPEN, so each answer below is ours.
    const receive = relay.receive.bind(relay)
    relay.receive = (connection, data) => {
      if (!data.startsWith('["NEG-')) receive(connection, data)
    }
    const errored = session()
    const closed = session()
    const malformed = session()
    const dropped = session()
    socket.negOpen('neg:e', errored)
    socket.negOpen('neg:c', closed)
    socket.negOpen('neg:m', malformed)
    socket.negOpen('neg:d', dropped)
    raw().deliver(JSON.stringify(['NEG-ERR', 'neg:e', 'blocked: too many records']))
    raw().deliver(JSON.stringify(['CLOSED', 'neg:c', 'unsupported']))
    raw().deliver(JSON.stringify(['NEG-MSG', 'neg:m', 42]))
    // Frames for exchanges nobody holds are ignored.
    raw().deliver(JSON.stringify(['NEG-MSG', 'neg:gone', '61']))
    raw().deliver(JSON.stringify(['NEG-ERR', 'neg:gone', 'x']))
    raw().deliver(JSON.stringify(['NEG-MSG', 7, '61']))
    raw().deliver(JSON.stringify(['NEG-ERR', 7, 'x']))
    await advance(5)
    relay.dropAll()
    await advance(5)
    expect(errored.log).toEqual(['err:blocked: too many records:false'])
    expect(closed.log).toEqual(['err:unsupported:true'])
    expect(malformed.log).toEqual(['err:malformed NEG-MSG:false'])
    expect(dropped.log).toEqual(['err:connection lost:false'])
  })

  it('does not read an unrelated NOTICE as a refusal once the relay has answered', async () => {
    relay.set({ negentropy: true })
    socket.connect()
    await advance(5)
    const s = session()
    socket.negOpen('neg:1', s)
    await advance(5)
    raw().deliver(JSON.stringify(['NOTICE', 'unknown: rate limited']))
    raw().deliver(JSON.stringify(['NOTICE', 'welcome']))
    await advance(5)
    expect(s.log.filter((l) => l.startsWith('err'))).toEqual([])
    socket.close()
    expect(s.log.at(-1)).toBe('err:closed by caller:false')
  })

  it('reports how far a subscription has got, and forgets it when it ends', async () => {
    relay.inject(wrap())
    socket.subscribe('inbox', { filter: () => ({ kinds: [1059] }), onEvent: () => undefined })
    expect(socket.progressOf('inbox')).toEqual({ reqAt: 0, eoseAt: 0 })
    socket.connect()
    await advance(5)
    const progress = socket.progressOf('inbox')!
    expect(progress.reqAt).toBeGreaterThan(0)
    expect(progress.eoseAt).toBeGreaterThanOrEqual(progress.reqAt)
    expect(socket.lastRxAt).toBeGreaterThanOrEqual(progress.eoseAt)

    // A drop means the stored replay has to happen again.
    relay.dropAll()
    await advance(1)
    expect(socket.progressOf('inbox')?.eoseAt).toBe(0)
    socket.unsubscribe('inbox')
    expect(socket.progressOf('inbox')).toBeNull()

    // A relay that ends a subscription takes its progress with it, reason or not.
    socket.subscribe('other', { filter: () => ({ kinds: [1] }), onEvent: () => undefined })
    socket.subscribe('again', { filter: () => ({ kinds: [1] }), onEvent: () => undefined })
    await advance(1000)
    raw().deliver(JSON.stringify(['CLOSED', 'other', '']))
    raw().deliver(JSON.stringify(['CLOSED', 'again']))
    await advance(5)
    expect(socket.progressOf('other')).toBeNull()
    expect(socket.progressOf('again')).toBeNull()
  })

  it('keeps the first EOSE of a connection, and ignores one for nothing', async () => {
    socket.connect()
    socket.subscribe('inbox', { filter: () => ({ kinds: [1059] }), onEvent: () => undefined })
    await advance(5)
    const first = socket.progressOf('inbox')!.eoseAt
    expect(first).toBeGreaterThan(0)
    await advance(1000)
    raw().deliver(JSON.stringify(['EOSE', 'inbox']))
    raw().deliver(JSON.stringify(['EOSE', 'nobody']))
    await advance(5)
    expect(socket.progressOf('inbox')!.eoseAt).toBe(first)
  })

  it('reads an exchange closed or refused without a reason, and a NOTICE that is not text', async () => {
    socket.connect()
    await advance(5)
    const receive = relay.receive.bind(relay)
    relay.receive = (connection, data) => {
      if (!data.startsWith('["NEG-')) receive(connection, data)
    }
    const closed = session()
    const errored = session()
    socket.negOpen('neg:c', closed)
    socket.negOpen('neg:e', errored)
    raw().deliver(JSON.stringify(['NOTICE', { unknown: 'cmd' }]))
    raw().deliver(JSON.stringify(['CLOSED', 'neg:c']))
    raw().deliver(JSON.stringify(['NEG-ERR', 'neg:e', 5]))
    await advance(5)
    expect(closed.log).toEqual(['err:closed:true'])
    expect(errored.log).toEqual(['err:error:false'])
  })
})

describe('reconciling through the pool', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    pool = poolOn(network)
  })
  afterEach(() => {
    pool.destroy()
    vi.useRealTimers()
  })

  const items = (events: NostrEvent[]) => events.map((e) => ({ id: e.id, createdAt: e.created_at }))

  it('finds exactly the events this device lacks', async () => {
    const relay = network.relay('wss://neg.example', { negentropy: true })
    const held = Array.from({ length: 60 }, () => wrap(100))
    const missing = Array.from({ length: 7 }, () => wrap(100))
    for (const event of [...held, ...missing]) relay.inject(event)
    pool.setRelays(['wss://neg.example'], [])
    await advance(10)

    const outcome = pool.reconcile('wss://neg.example', inboxFilter(ME, 0), items(held))
    await advance(50)
    expect(await outcome).toEqual({ ok: true, need: expect.any(Array), rounds: 1 })
    const result = await outcome
    expect(result.ok && new Set(result.need)).toEqual(new Set(missing.map((e) => e.id)))
  })

  it('does not dial a relay just to reconcile with it', async () => {
    expect(await pool.reconcile('wss://nowhere.example', { kinds: [1059] }, [])).toEqual({
      ok: false,
      refused: false,
      reason: 'not connected',
    })
  })

  it('gives up on a relay that never answers, and on one that never finishes', async () => {
    const silentRelay = network.relay('wss://mute.example')
    // Answers nothing at all to NEG-OPEN: treated as not speaking NIP-77.
    silentRelay.receive = () => undefined
    pool.setRelays(['wss://mute.example'], [])
    await advance(10)
    const mute = pool.reconcile('wss://mute.example', { kinds: [1059] }, [], { firstReplyMs: 1000 })
    await advance(1100)
    expect(await mute).toEqual({ ok: false, refused: true, reason: 'no answer to NEG-OPEN' })

    // Answers the first message and then goes quiet.
    const slow = network.relay('wss://slow.example', { negentropy: true })
    for (let i = 0; i < 80; i++) slow.inject(wrap(10 + i))
    pool.setRelays(['wss://slow.example'], [])
    await advance(10)
    const receive = slow.receive.bind(slow)
    slow.receive = (connection, data) => {
      if (data.startsWith('["NEG-MSG"')) return
      receive(connection, data)
    }
    // A client holding a different, larger set needs a second round, which never comes.
    const ours = items(Array.from({ length: 40 }, (_, i) => wrap(200 + i)))
    const outcome = pool.reconcile('wss://slow.example', { kinds: [1059] }, ours, { maxWaitMs: 2000 })
    await advance(2100)
    const result = await outcome
    expect(result).toMatchObject({ ok: false, refused: false })
  })

  it('abandons an exchange that does not converge, or that it cannot parse', async () => {
    const relay = network.relay('wss://loop.example', { negentropy: true })
    for (let i = 0; i < 200; i++) relay.inject(wrap(10 + (i % 3)))
    pool.setRelays(['wss://loop.example'], [])
    await advance(10)
    const ours = items(Array.from({ length: 40 }, (_, i) => wrap(300 + i)))
    const outcome = pool.reconcile('wss://loop.example', { kinds: [1059] }, ours, { maxRounds: 1 })
    await advance(50)
    expect(await outcome).toEqual({ ok: false, refused: false, reason: 'did not converge' })

    const garbled = network.relay('wss://garbled.example')
    garbled.receive = (_connection, data) => {
      const [type, id] = JSON.parse(data) as [string, string]
      const socket = network.sockets.find((s) => s.url === 'wss://garbled.example')!
      if (type === 'NEG-OPEN') socket.deliver(JSON.stringify(['NEG-MSG', id, 'zz']))
    }
    pool.setRelays(['wss://garbled.example'], [])
    await advance(10)
    const parsed = pool.reconcile('wss://garbled.example', { kinds: [1059] }, [])
    await advance(50)
    expect(await parsed).toEqual({ ok: false, refused: false, reason: 'message is not hex' })
  })

  it('reports progress per relay and re-sends one relay’s REQ on request', async () => {
    const a = network.relay('wss://a.example')
    network.relay('wss://b.example')
    pool.setRelays(['wss://a.example', 'wss://b.example'], [])
    const sinces: Record<string, number> = { 'wss://a.example': 100, 'wss://b.example': 200 }
    const sub = pool.subscribe((url) => ({ kinds: [1059], since: sinces[url] }), { onEvent: () => undefined })
    await advance(10)
    expect(sub.progress?.('wss://a.example')).toMatchObject({ open: true })
    expect(sub.progress?.('wss://unknown.example')).toBeNull()
    expect(a.reqs.at(-1)?.filters[0]?.since).toBe(100)

    sinces['wss://a.example'] = 150
    sub.resend?.('wss://a.example')
    sub.resend?.('wss://unknown.example')
    await advance(10)
    expect(a.reqs.at(-1)?.filters[0]?.since).toBe(150)
    sub.close()
    sub.resend?.('wss://a.example')
    await advance(10)
    expect(a.reqs.filter((r) => r.id.startsWith('sub'))).toHaveLength(2)
  })

  it('re-sends at once a subscription the relay closed, instead of waiting to retry', async () => {
    const a = network.relay('wss://a.example')
    pool.setRelays(['wss://a.example'], [])
    const sub = pool.subscribe({ kinds: [1059] }, { onEvent: () => undefined })
    await advance(10)
    const id = a.reqs.at(-1)!.id
    const socket = network.sockets.find((s) => s.url === 'wss://a.example')!
    socket.deliver(JSON.stringify(['CLOSED', id, 'error: shutting down']))
    await advance(10)
    const reqs = () => a.reqs.filter((r) => r.id === id).length
    const before = reqs()
    sub.resend?.('wss://a.example')
    await advance(10)
    expect(reqs()).toBe(before + 1)
    // The retry it replaced does not fire as well.
    await advance(60_000)
    expect(reqs()).toBe(before + 1)
    sub.close()
  })
})

describe('inbox sync over real sockets', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool
  let store: MemoryStore
  let received: string[]
  let sync: InboxSync

  const start = async (urls: string[]) => {
    pool = poolOn(network)
    pool.setRelays(urls, [])
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
    await advance(20)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    store = new MemoryStore()
  })
  afterEach(() => {
    sync?.stop()
    pool?.destroy()
    vi.useRealTimers()
  })

  it('after a restart, downloads only what arrived while it was gone', async () => {
    const relay = network.relay('wss://neg.example', { negentropy: true })
    const old = Array.from({ length: 50 }, (_, i) => wrap(3600 + i))
    for (const event of old) relay.inject(event)

    await start(['wss://neg.example'])
    await run(sync.catchUp())
    expect(new Set(received)).toEqual(new Set(old.map((e) => e.id)))
    // Live-only subscription: the relay replayed nothing itself.
    expect(relay.reqs.filter((r) => r.id.startsWith('inbox')).at(-1)?.filters[0]).toMatchObject({ limit: 0 })
    sync.stop()
    pool.destroy()
    await advance(10)

    // Two more arrive while the app is closed.
    const fresh = [wrap(30), wrap(40)]
    for (const event of fresh) relay.inject(event)
    const before = relay.eventsSent
    await start(['wss://neg.example'])
    await run(sync.catchUp())
    expect(received.sort()).toEqual(fresh.map((e) => e.id).sort())
    // Before: every restart replayed three days of wraps from every relay.
    expect(relay.eventsSent - before).toBe(2)
    expect(store.state.relays['wss://neg.example']?.neg?.ok).toBe(true)
  })

  it('falls back to a window read on a relay without NIP-77, and remembers', async () => {
    const relay = network.relay('wss://plain.example')
    const stored = Array.from({ length: 5 }, () => wrap(600))
    for (const event of stored) relay.inject(event)

    await start(['wss://plain.example'])
    await run(sync.catchUp())
    expect(new Set(received)).toEqual(new Set(stored.map((e) => e.id)))
    expect(relay.negOpens).toBe(1)
    expect(sync.snapshot().relays['wss://plain.example']?.neg?.ok).toBe(false)

    // Next session goes straight to the window read.
    sync.stop()
    pool.destroy()
    await start(['wss://plain.example'])
    await run(sync.catchUp())
    expect(relay.negOpens).toBe(1)
    expect(relay.reqs.filter((r) => r.id.startsWith('inbox')).at(-1)?.filters[0]?.limit).toBeUndefined()

    // …until a week has passed, when it is asked again.
    sync.stop()
    pool.destroy()
    vi.setSystemTime(Date.now() + INBOX_SYNC_TIMING.NEG_REFUSED_RETRY_MS + 1000)
    await start(['wss://plain.example'])
    await run(sync.catchUp())
    expect(relay.negOpens).toBe(2)
  })

  it('falls back for a while when a reconciliation fails for another reason', async () => {
    const relay = network.relay('wss://busy.example')
    relay.inject(wrap(100))
    const receive = relay.receive.bind(relay)
    relay.receive = (connection, data) => {
      if (data.startsWith('["NEG-OPEN"')) {
        const id = (JSON.parse(data) as string[])[1]
        network.sockets.at(-1)!.deliver(JSON.stringify(['NEG-ERR', id, 'blocked: too many records']))
        return
      }
      receive(connection, data)
    }
    await start(['wss://busy.example'])
    await run(sync.catchUp())
    expect(received).toHaveLength(1)
    // Not recorded as refusing NIP-77: it does speak it, it just said no this time.
    expect(sync.snapshot().relays['wss://busy.example']?.neg).toBeUndefined()
    expect(relay.reqs.at(-1)?.filters[0]?.limit).toBeUndefined()
  })

  it('asks each relay from its own high-water mark, not one shared cursor', async () => {
    const a = network.relay('wss://a.example')
    const b = network.relay('wss://b.example')
    const day = 24 * 3600
    // One reading of the clock: the fake one moves while the sync starts.
    const t0 = nowSec()
    store.state = {
      lastSyncSec: t0 - day,
      floorSec: 0,
      relays: {
        'wss://a.example': { hwm: t0 - 10 * day, neg: { ok: false, at: Date.now() } },
        'wss://b.example': { hwm: t0 - 60, neg: { ok: false, at: Date.now() } },
      },
    }
    await start(['wss://a.example', 'wss://b.example'])
    // A relay with no mark of its own starts from the last full catch-up.
    expect(sync.sinceFor('wss://never.example')).toBe(t0 - day - SYNC_REWIND_SEC)
    await run(sync.catchUp())
    // Relay A was unreachable for ten days: it is asked for all of them.
    expect(a.reqs.at(-1)?.filters[0]?.since).toBe(t0 - 10 * day - SYNC_REWIND_SEC)
    // Relay B was live a minute ago: three days back from there, not from A's mark.
    expect(b.reqs.at(-1)?.filters[0]?.since).toBe(t0 - 60 - SYNC_REWIND_SEC)
  })

  it('advances a relay’s mark only while its connection is proven complete', async () => {
    const relay = network.relay('wss://live.example', { negentropy: true })
    await start(['wss://live.example'])
    await run(sync.catchUp())
    const first = sync.snapshot().relays['wss://live.example']!.hwm
    expect(first).toBeGreaterThanOrEqual(nowSec() - 1)

    // Traffic on a caught-up connection moves the mark forward…
    await advance(60_000)
    relay.inject(wrap(5))
    await advance(10)
    sync.tick()
    const second = sync.snapshot().relays['wss://live.example']!.hwm
    expect(second).toBeGreaterThan(first)

    // …but a reconnect that has not caught up yet proves nothing.
    relay.set({ connectDelayMs: 120_000 })
    relay.dropAll()
    await advance(90_000)
    sync.tick()
    expect(sync.snapshot().relays['wss://live.example']!.hwm).toBe(second)
  })

  it('writes its state down, but not on every tick', async () => {
    network.relay('wss://a.example', { negentropy: true })
    await start(['wss://a.example'])
    await run(sync.catchUp())
    const saves = store.saves
    sync.tick()
    sync.tick()
    expect(store.saves).toBe(saves)
    await advance(INBOX_SYNC_TIMING.SAVE_EVERY_MS + 1000)
    sync.tick()
    expect(store.saves).toBeGreaterThanOrEqual(saves)
    sync.stop()
    expect(store.state.lastSyncSec).toBeGreaterThan(0)
  })

  it('never asks for anything older than the dedup floor', async () => {
    const relay = network.relay('wss://a.example')
    const t0 = nowSec()
    store.state = { lastSyncSec: 0, floorSec: t0 - 3600, relays: {} }
    store.state.relays['wss://a.example'] = { hwm: 0, neg: { ok: false, at: Date.now() } }
    await start(['wss://a.example'])
    await run(sync.catchUp())
    expect(relay.reqs.at(-1)?.filters[0]?.since).toBe(t0 - 3600)

    sync.setFloor(t0 - 7200) // never lowered
    expect(sync.floorSec).toBe(t0 - 3600)
    sync.setFloor(t0 - 60)
    expect(sync.floorSec).toBe(t0 - 60)
  })

  it('re-reads a window relay when a catch-up is forced, and skips a complete one otherwise', async () => {
    const relay = network.relay('wss://a.example')
    store.state.relays['wss://a.example'] = { hwm: 0, neg: { ok: false, at: Date.now() } }
    await start(['wss://a.example'])
    await run(sync.catchUp())
    const reqs = relay.reqs.length
    await run(sync.catchUp())
    expect(relay.reqs.length).toBe(reqs)
    await run(sync.catchUp({ force: true }))
    expect(relay.reqs.length).toBe(reqs + 1)
  })

  it('does not wait for ever on a relay that stays silent', async () => {
    const urls = ['wss://f1.example', 'wss://f2.example', 'wss://stuck.example']
    network.relay('wss://f1.example', { eoseDelayMs: 100 })
    network.relay('wss://f2.example', { eoseDelayMs: 100 })
    network.relay('wss://stuck.example', { eoseDelayMs: 60_000 })
    for (const url of urls) store.state.relays[url] = { hwm: 0, neg: { ok: false, at: Date.now() } }
    await start(urls)
    const started = Date.now()
    await run(sync.catchUp({ graceMs: 500 }), 10)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('stops cleanly in the middle of a catch-up', async () => {
    network.relay('wss://slow.example', { eoseDelayMs: 60_000 })
    store.state.relays['wss://slow.example'] = { hwm: 0, neg: { ok: false, at: Date.now() } }
    await start(['wss://slow.example'])
    await advance(10)
    const done = sync.catchUp()
    sync.stop()
    await done
    await run(sync.catchUp()) // no subscription: nothing to do
    sync.open() // stopped: stays closed
    expect(pool.statuses()).toHaveLength(1)
  })
})

/** A pool whose every answer the test decides, for the paths real relays rarely take. */
class ScriptedPool {
  readonly events = new Emitter<RelayPoolEvents>()
  readonly readRelays = ['wss://s.example']
  readonly writeRelays = ['wss://s.example']
  readonly onlineCount = 1
  readonly epoch = 0
  filter: ((url: string) => Filter) | null = null
  handlers: { onEvent: (e: NostrEvent) => void; onEose?: (url?: string) => void } | null = null
  progress: RelayProgress | null = { reqAt: 1, eoseAt: 2, open: true, lastRxAt: 3 }
  reconcileImpl: () => Promise<ReconcileOutcome> = async () => ({ ok: true, need: [], rounds: 1 })
  queryImpl: () => Promise<NostrEvent[]> = async () => []
  resent: string[] = []
  setRelays(): void {}
  seedHealth(): void {}
  statuses() {
    return []
  }
  healthSnapshot() {
    return []
  }
  subscribe(
    filter: Filter | ((url: string) => Filter),
    handlers: ScriptedPool['handlers'] & object,
  ): SubCloser {
    this.filter = typeof filter === 'function' ? filter : () => filter
    this.handlers = handlers
    return { close: () => undefined, progress: () => this.progress, resend: (url) => this.resent.push(url) }
  }
  /** The relay asks for the subscription's filter, as a REQ does. */
  req(url = 'wss://s.example'): Filter {
    return this.filter!(url)
  }
  async query(): Promise<NostrEvent[]> {
    return this.queryImpl()
  }
  reconcile(): Promise<ReconcileOutcome> {
    return this.reconcileImpl()
  }
  async publish(): Promise<PublishOutcome[]> {
    return []
  }
  dispatch(): PublishHandle {
    return { quorum: Promise.resolve([]), settled: Promise.resolve([]) }
  }
  rankedWriteRelays() {
    return this.writeRelays
  }
  rankedReadRelays() {
    return this.readRelays
  }
  prewarm(): void {}
  wake(): void {}
  destroy(): void {}
}

describe('inbox sync at the edges', () => {
  let pool: ScriptedPool
  let store: MemoryStore
  let sync: InboxSync
  let now: number

  const make = async (state?: Partial<SyncState>) => {
    pool = new ScriptedPool()
    store = new MemoryStore()
    store.state = { lastSyncSec: 0, floorSec: 0, relays: {}, ...state }
    now = 1_000_000
    sync = new InboxSync({ pool, store, pubkey: ME, onWrap: () => undefined, now: () => now })
    await sync.start()
  }
  const windowMode = { 'wss://s.example': { hwm: 0, neg: { ok: false, at: 1_000_000 } } }

  afterEach(() => {
    sync?.stop()
    vi.useRealTimers()
  })

  it('ignores an EOSE for a relay it never asked, or with no relay named', async () => {
    await make()
    pool.handlers!.onEose?.()
    pool.handlers!.onEose?.('wss://never.example')
    expect(sync.snapshot().relays).toEqual({})
  })

  it('completes a window read even when the pool cannot say when it asked', async () => {
    await make({ relays: windowMode })
    pool.req()
    pool.progress = null
    pool.handlers!.onEose?.('wss://s.example')
    expect(sync.snapshot().relays['wss://s.example']?.hwm).toBe(1000)
  })

  it('waits on a relay that has finished replaying but not been marked, until it drops', async () => {
    vi.useFakeTimers()
    await make({ relays: windowMode })
    pool.req() // EOSE never delivered to the sync, though the pool reports one
    const done = sync.catchUp({ maxWaitMs: 5000 })
    let settled = false
    void done.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    pool.progress = { ...pool.progress!, open: false }
    now += 1
    pool.req() // resubscribe re-evaluates nothing new; the drop is what counts
    sync.open() // runs are cleared while it waits
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(settled).toBe(true)
  })

  it('advances nothing on a connection it has not caught up on', async () => {
    await make({ relays: windowMode })
    pool.req()
    pool.handlers!.onEose?.('wss://s.example')
    const hwm = sync.snapshot().relays['wss://s.example']!.hwm
    pool.progress = { reqAt: 2_000_000, eoseAt: 0, open: true, lastRxAt: 3_000_000 }
    sync.tick()
    expect(sync.snapshot().relays['wss://s.example']!.hwm).toBe(hwm)
  })

  it('stops fetching what a reconciliation found missing once stopped', async () => {
    await make()
    pool.req()
    const ids = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(64, '0'))
    pool.reconcileImpl = async () => ({ ok: true, need: ids, rounds: 1 })
    let calls = 0
    pool.queryImpl = async () => {
      calls++
      sync.stop()
      return []
    }
    pool.handlers!.onEose?.('wss://s.example')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
  })

  it('keeps waiting on a relay whose run a reopened subscription replaced', async () => {
    vi.useFakeTimers()
    await make()
    pool.req()
    let finish: (outcome: ReconcileOutcome) => void = () => undefined
    pool.reconcileImpl = () => new Promise((resolve) => (finish = resolve))
    pool.handlers!.onEose?.('wss://s.example') // reconciling, not yet done
    const done = sync.catchUp({ maxWaitMs: 5000 })
    let settled = false
    void done.then(() => (settled = true))
    sync.open() // the relay has not been asked again yet: no run for it
    await vi.advanceTimersByTimeAsync(10)
    finish({ ok: true, need: [], rounds: 1 }) // completes the old run, and wakes the wait
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(settled).toBe(true)
  })

  it('keeps its item cache in step with what arrives and with the floor', async () => {
    await make()
    sync.noteWrap('a'.repeat(64), 10) // nothing loaded yet: ignored
    store.held.set('b'.repeat(64), 500_000)
    store.held.set('c'.repeat(64), 900_000)
    store.held.set('e'.repeat(64), 850_000)
    // The clock reads 900 000 s plus the rewind: this reconciliation, from
    // since 0, leaves the relay caught up to then.
    now = (900_000 + SYNC_REWIND_SEC) * 1000
    pool.req()
    pool.handlers!.onEose?.('wss://s.example') // loads items from since 0
    await new Promise((resolve) => setTimeout(resolve, 10))
    sync.noteWrap('d'.repeat(64), 950_000)
    sync.setFloor(600) // below everything: nothing pruned beyond that
    sync.setFloor(800_000)
    // A later reconciliation from a later since uses the cache, minus the old.
    let offered: NegentropyItem[] = []
    const spy = vi.spyOn(pool, 'reconcile').mockImplementation(async (...args: unknown[]) => {
      offered = args[2] as NegentropyItem[]
      return { ok: true, need: [], rounds: 1 }
    })
    // The next starts at 900 000 s: e, above the floor, is before it.
    now += 1
    ;(sync as unknown as { open(): void }).open()
    pool.req()
    pool.handlers!.onEose?.('wss://s.example')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spy).toHaveBeenCalled()
    expect(offered.map((i) => i.id).sort()).toEqual(['c'.repeat(64), 'd'.repeat(64)])
  })

  it('keeps unsaved state dirty when saving fails, and says so', async () => {
    await make()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.save = async () => {
      throw new Error('disk full')
    }
    sync.setFloor(5)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warn).toHaveBeenCalled()
    store.save = async (state) => {
      store.state = state
    }
    sync.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.state.floorSec).toBe(5)
  })
})
