import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { RelayPool, type PublishOutcome } from '@/core/transport/relayPool'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import { verdictFor } from '@/core/transport/relayHealth'
import { FakeSocketNetwork } from './fakeWebSocket'

const signed = (kind = 1059, createdAt = Math.floor(Date.now() / 1000)): NostrEvent =>
  finalizeEvent({ kind, created_at: createdAt, tags: [], content: 'x' }, generateSecretKey())

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

function poolOn(network: FakeSocketNetwork): RelayPool {
  return new RelayPool({ socket: { createSocket: network.factory, random: () => 0, isOffline: () => false } })
}

const acks = (outcomes: PublishOutcome[]) => outcomes.filter((o) => o.ok).map((o) => o.url)

/** A stored health record as an earlier build wrote it: counters, no rolling reliability. */
function legacyHealth(patch: Partial<RelayHealth>): RelayHealth {
  const { reliability: _r, failStreak: _f, connectMs: _c, ...rest } = { ...emptyHealth(), ...patch }
  return rest as RelayHealth
}

describe('relay pool configuration', () => {
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

  it('normalises and dedupes the configured set', () => {
    pool.setRelays(['nos.lol', 'wss://nos.lol/', 'WSS://NOS.LOL'], ['wss://relay.example'])
    expect(pool.readRelays).toEqual(['wss://nos.lol'])
    expect(pool.writeRelays).toEqual(['wss://relay.example'])
  })

  it('drops entries that are not valid relay URLs', () => {
    pool.setRelays(['http://nope.example', 'javascript:alert(1)', 'wss://ok.example'], [])
    expect(pool.readRelays).toEqual(['wss://ok.example'])
  })

  it('connects every relay it means to use as soon as it is known', async () => {
    // The pre-warm: by the time a message is typed, the handshakes are done.
    const a = network.relay('wss://a.example', { connectDelayMs: 1500 })
    const b = network.relay('wss://b.example', { connectDelayMs: 900 })
    pool.setRelays(['wss://a.example'], ['wss://b.example'])
    expect(pool.onlineCount).toBe(0)
    await advance(1600)
    expect(a.openConnections + b.openConnections).toBe(2)
    // Counted as the inbox sees it: the read relays in use.
    expect(pool.onlineCount).toBe(1)
  })

  it('closes sockets for relays removed from the configuration', async () => {
    const a = network.relay('wss://a.example')
    pool.setRelays(['wss://a.example'], [])
    await advance(10)
    expect(a.openConnections).toBe(1)
    pool.setRelays([], [])
    await advance(10)
    expect(a.openConnections).toBe(0)
  })

  it('ranks proven relays above failing ones', () => {
    pool.setRelays([], ['wss://good.example', 'wss://bad.example', 'wss://unknown.example'])
    pool.seedHealth([
      { url: 'wss://good.example', health: legacyHealth({ publishOk: 20, latencyMs: 120 }) },
      { url: 'wss://bad.example', health: legacyHealth({ publishOk: 1, publishFail: 30 }) },
    ])

    const ranked = pool.rankedWriteRelays()
    expect(ranked[0]).toBe('wss://good.example')
    // An untried relay sits mid-pack so it still gets a chance to prove itself.
    expect(ranked.indexOf('wss://unknown.example')).toBeLessThan(ranked.indexOf('wss://bad.example'))
  })

  it('penalises a slow relay against a fast one with the same success rate', () => {
    pool.setRelays([], ['wss://fast.example', 'wss://slow.example'])
    pool.seedHealth([
      { url: 'wss://fast.example', health: legacyHealth({ publishOk: 10, latencyMs: 80 }) },
      { url: 'wss://slow.example', health: legacyHealth({ publishOk: 10, latencyMs: 9000 }) },
    ])
    expect(pool.rankedWriteRelays()[0]).toBe('wss://fast.example')
  })

  it('reports no relays as no coverage rather than throwing', async () => {
    pool.setRelays([], [])
    expect(await pool.query({ kinds: [1059] })).toEqual([])
    expect(pool.onlineCount).toBe(0)
  })
})

describe('publishing on the critical path', () => {
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

  it('reaches quorum on the two fastest relays without waiting for a black hole', async () => {
    network.relay('wss://fast1.example', { okDelayMs: 250 })
    network.relay('wss://fast2.example', { okDelayMs: 320 })
    network.relay('wss://slow.example', { okDelayMs: 6000 })
    network.relay('wss://hole.example', { blackhole: true })
    const relays = ['wss://fast1.example', 'wss://fast2.example', 'wss://slow.example', 'wss://hole.example']
    pool.setRelays([], relays)
    await advance(10)

    const handle = pool.dispatch(signed(), relays, { standbys: [] })
    let quorumAt = 0
    let settledAt = 0
    const started = Date.now()
    void handle.quorum.then(() => (quorumAt = Date.now() - started))
    void handle.settled.then(() => (settledAt = Date.now() - started))

    await advance(400)
    expect(quorumAt).toBeGreaterThan(0)
    expect(quorumAt).toBeLessThan(400)
    expect(acks(await handle.quorum).sort()).toEqual(['wss://fast1.example', 'wss://fast2.example'])

    // The rest still settles in the background, and nothing is cancelled.
    await advance(10_000)
    expect(settledAt).toBeGreaterThanOrEqual(6000)
    const settled = await handle.settled
    expect(acks(settled)).toContain('wss://slow.example')
    expect(settled.find((o) => o.url === 'wss://hole.example')).toMatchObject({ ok: false })
  })

  it('fails over to a hot standby when the targets are slow to answer', async () => {
    network.relay('wss://peer1.example', { okDelayMs: 8000 })
    network.relay('wss://peer2.example', { okDelayMs: 8000 })
    const standby = network.relay('wss://mine.example', { okDelayMs: 200 })
    pool.setRelays([], ['wss://mine.example'])
    await advance(10)

    const event = signed()
    const handle = pool.dispatch(event, ['wss://peer1.example', 'wss://peer2.example'], { quorum: 1 })
    let done = false
    void handle.quorum.then(() => (done = true))

    // Unmeasured targets hedge after 2.5 s; the standby answers in 200 ms.
    await advance(2800)
    expect(done).toBe(true)
    expect(acks(await handle.quorum)).toEqual(['wss://mine.example'])
    expect(standby.stored.map((e) => e.id)).toContain(event.id)
  })

  it('spends the standbys at once when every target has already failed', async () => {
    network.relay('wss://full.example', { rejectWrites: 'error: mdb_txn_commit: No space left on device' })
    network.relay('wss://gone.example', { refuse: true })
    network.relay('wss://mine.example')
    pool.setRelays([], ['wss://mine.example'])
    await advance(10)

    const handle = pool.dispatch(signed(), ['wss://full.example', 'wss://gone.example'])
    let done = false
    void handle.quorum.then(() => (done = true))
    await advance(50)
    expect(done).toBe(true)
    expect(acks(await handle.quorum)).toEqual(['wss://mine.example'])
  })

  it('stops forcing reconnects to a relay whose circuit is open, but still delivers to it', async () => {
    const flaky = network.relay('wss://flaky.example', { refuse: true })
    network.relay('wss://ok.example')
    pool.setRelays([], ['wss://ok.example'])
    await advance(10)

    // Three urgent publishes in a row fail and open the circuit.
    for (let i = 0; i < 3; i++) {
      const handle = pool.dispatch(signed(), ['wss://flaky.example'], { standbys: [] })
      await advance(10_100)
      await handle.settled
    }
    const status = pool.statuses().find((s) => s.url === 'wss://flaky.example')
    expect(status?.health.failStreak).toBe(3)

    const attemptsBefore = flaky.connectAttempts
    flaky.set({ refuse: false })
    const event = signed()
    const handle = pool.dispatch(event, ['wss://flaky.example', 'wss://ok.example'], { standbys: [] })
    await advance(50)
    // No forced handshake: the socket keeps to its own backoff schedule…
    expect(flaky.connectAttempts).toBe(attemptsBefore)
    // …and the event still lands once that schedule brings the relay back.
    await advance(10_000)
    await handle.settled
    expect(flaky.stored.map((e) => e.id)).toContain(event.id)
  })

  it('learns from every outcome, so a failing relay sinks in the ranking', async () => {
    network.relay('wss://good.example')
    network.relay('wss://full.example', { rejectWrites: 'error: disk full' })
    const relays = ['wss://good.example', 'wss://full.example']
    pool.setRelays([], relays)
    await advance(10)

    for (let i = 0; i < 4; i++) {
      const handle = pool.dispatch(signed(), relays, { standbys: [] })
      await advance(20)
      await handle.settled
    }
    // Its circuit open, the full relay gives up its place among those in use.
    expect(pool.rankedWriteRelays()).toEqual(['wss://good.example'])
    const full = pool.statuses().find((s) => s.url === 'wss://full.example')
    expect(full?.active).toBe(false)
    expect(full?.health.lastError).toBe('error: disk full')
    expect(full?.health.reliability).toBeLessThan(0.2)
  })
})

describe('reading', () => {
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

  it('delivers an event once however many relays carry it', async () => {
    const event = signed()
    const relays = ['wss://a.example', 'wss://b.example', 'wss://c.example']
    for (const url of relays) network.relay(url).inject(event)
    pool.setRelays(relays, [])

    const received: string[] = []
    pool.subscribe({ kinds: [1059] }, { onEvent: (e) => received.push(e.id) })
    await advance(20)
    expect(received).toEqual([event.id])
    // Each relay is still credited with delivering it.
    await advance(60)
    for (const status of pool.statuses()) expect(status.health.eventsReceived).toBe(1)
  })

  it('resolves a catch-up read shortly after half the relays finish', async () => {
    const early = signed()
    const late = signed()
    network.relay('wss://a.example', { eoseDelayMs: 100 }).inject(early)
    network.relay('wss://b.example', { eoseDelayMs: 150 })
    network.relay('wss://c.example', { eoseDelayMs: 7000 }).inject(late)
    network.relay('wss://d.example', { eoseDelayMs: 7000 })
    pool.setRelays(['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'], [])
    await advance(10)

    let result: NostrEvent[] | null = null
    void pool.query({ kinds: [1059] }, undefined, { maxWait: 8000, graceMs: 1000 }).then((r) => (result = r))
    await advance(1300)
    expect(result).not.toBeNull()
    expect(result!.map((e) => e.id)).toEqual([early.id])
  })

  it('does not wait on a relay that cannot be reached', async () => {
    network.relay('wss://up.example')
    network.relay('wss://down.example', { refuse: true })

    let result: NostrEvent[] | null = null
    void pool
      .query({ kinds: [1059] }, ['wss://up.example', 'wss://down.example'], { maxWait: 8000 })
      .then((r) => (result = r))
    await advance(50)
    expect(result).toEqual([])
  })

  it('records a refused subscription as a read failure and does not retry it', async () => {
    const relay = network.relay('wss://auth.example', { refuseReads: 'auth-required: sign in first' })
    pool.setRelays(['wss://auth.example'], [])
    pool.subscribe({ kinds: [1059] }, { onEvent: () => undefined, label: 'inbox' })
    await advance(60_000)

    const status = pool.statuses()[0]
    expect(status?.health.readFail).toBe(1)
    expect(verdictFor(status)).toBe('degraded')
    expect(relay.reqs.filter((r) => r.id.startsWith('inbox'))).toHaveLength(1)
  })

  it('retries a subscription ended for any other reason', async () => {
    const relay = network.relay('wss://moody.example', { refuseReads: 'error: shutting down' })
    pool.setRelays(['wss://moody.example'], [])
    pool.subscribe({ kinds: [1059] }, { onEvent: () => undefined, label: 'inbox' })
    await advance(10)
    relay.set({ refuseReads: null })
    await advance(31_000)
    expect(relay.reqs.filter((r) => r.id.startsWith('inbox'))).toHaveLength(2)
  })
})

describe('waking up', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    pool = new RelayPool({
      socket: { createSocket: network.factory, random: () => 1, isOffline: () => false },
    })
  })

  afterEach(() => {
    pool.destroy()
    vi.useRealTimers()
  })

  it('reconnects everything at once when the network comes back', async () => {
    const relays = ['wss://a.example', 'wss://b.example']
    const servers = relays.map((url) => network.relay(url, { refuse: true }))
    pool.setRelays(relays, relays)
    await advance(45_000)
    expect(pool.onlineCount).toBe(0)

    for (const server of servers) server.set({ refuse: false })
    pool.wake('online')
    await advance(10)
    expect(pool.onlineCount).toBe(2)
  })

  it('finds and replaces sockets that died while the device slept', async () => {
    const relay = network.relay('wss://a.example')
    pool.setRelays(['wss://a.example'], [])
    await advance(10)
    for (const connection of relay.connections) connection.dead = true
    await advance(5000)

    pool.wake('resume')
    // Probe allowed 3.5 s, then an immediate reconnect.
    await advance(3600 + 1300)
    expect(relay.connectAttempts).toBe(2)
    expect(pool.onlineCount).toBe(1)
  })

  it('does not probe on a mere focus change', async () => {
    const relay = network.relay('wss://a.example')
    pool.setRelays(['wss://a.example'], [])
    await advance(10)
    const framesBefore = relay.reqs.length
    await advance(3000)
    pool.wake('focus')
    await advance(10)
    expect(relay.reqs.length).toBe(framesBefore)
  })

  it('pre-warms a contact’s relays and lets them go once unused', async () => {
    const peer = network.relay('wss://peer.example')
    pool.setRelays(['wss://mine.example'], ['wss://mine.example'])
    network.relay('wss://mine.example')
    pool.prewarm(['wss://peer.example'])
    await advance(10)
    expect(peer.openConnections).toBe(1)

    // Held for five minutes, then closed within the next sweep.
    await advance(5 * 60_000 + 3 * 60_000 + 60_000)
    expect(peer.openConnections).toBe(0)
  })
})

describe('relay health verdicts', () => {
  const status = (health: Partial<ReturnType<typeof emptyHealth>>, state: 'online' | 'offline' | 'idle') => ({
    url: 'wss://x.example',
    state,
    health: { ...emptyHealth(), ...health },
    active: state === 'online',
  })

  it('calls an untouched relay unused, not broken', () => {
    expect(verdictFor(status({}, 'idle'))).toBe('unused')
    expect(verdictFor(undefined)).toBe('unused')
  })

  it('flags a relay that rejects most publishes', () => {
    // This is the offchain.pub case: reads fine, refuses writes from unknown
    // keys, and would otherwise look healthy.
    expect(verdictFor(status({ publishOk: 2, publishFail: 12 }, 'online'))).toBe('degraded')
  })

  it('calls a connected, delivering relay healthy', () => {
    expect(verdictFor(status({ publishOk: 14, publishFail: 0, connectOk: 1 }, 'online'))).toBe('healthy')
  })

  it('calls a relay that never connected offline', () => {
    expect(verdictFor(status({ connectFail: 4 }, 'offline'))).toBe('offline')
  })

  it('degrades a relay that accepts writes but refuses to serve the inbox', () => {
    // The nos.lol / nostr.mom case: NIP-42 auth-required on gift-wrap reads.
    // Publish statistics look perfect, the socket is up, and the user would
    // never receive a single message. Write stats alone would call it healthy.
    expect(verdictFor(status({ publishOk: 30, publishFail: 0, connectOk: 1, readFail: 2 }, 'online'))).toBe(
      'degraded',
    )
  })

  it('does not treat an untouched relay with no read failures as broken', () => {
    expect(verdictFor(status({ readFail: 0 }, 'idle'))).toBe('unused')
  })

  it('calls a relay standing by healthy on its record, and one that has only ever connected degraded', () => {
    expect(verdictFor(status({ publishOk: 3, connectOk: 1 }, 'idle'))).toBe('healthy')
    expect(verdictFor(status({ connectOk: 1 }, 'idle'))).toBe('degraded')
  })

  it('calls a relay the pool has set aside offline, whatever its record', () => {
    expect(verdictFor(status({ publishOk: 40, connectOk: 9, connectStreak: 2 }, 'idle'))).toBe('offline')
  })
})

describe('health records written by an older build', () => {
  it('gains new counters instead of leaving them undefined', () => {
    // A vault from a build that predates `readFail` must not produce NaN when
    // the counter is incremented — that silently disables the degraded verdict
    // and the relay goes on claiming to be healthy while delivering nothing.
    const legacy = {
      connectOk: 3,
      connectFail: 0,
      publishOk: 12,
      publishFail: 0,
      lastOkAt: 1,
      lastErrorAt: 0,
      latencyMs: 200,
      eventsReceived: 4,
    } as unknown as ReturnType<typeof emptyHealth>

    const network = new FakeSocketNetwork()
    const pool = poolOn(network)
    pool.setRelays(['wss://legacy.example'], ['wss://legacy.example'])
    pool.seedHealth([{ url: 'wss://legacy.example', health: legacy }])

    const seeded = pool.statuses()[0]
    expect(seeded?.health.readFail).toBe(0)
    expect(Number.isNaN(seeded?.health.readFail as number)).toBe(false)
    expect(seeded?.health.failStreak).toBe(0)
    // Reliability is derived from the record's history, not reset to a coin flip.
    expect(seeded?.health.reliability).toBeGreaterThan(0.9)
    // And the preserved counters survive the merge.
    expect(seeded?.health.publishOk).toBe(12)
    pool.destroy()
  })
})

describe('advertised relays', () => {
  it('ranks read relays so invites and profiles carry the ones that work', async () => {
    vi.useFakeTimers()
    const network = new FakeSocketNetwork()
    const pool = poolOn(network)
    network.relay('wss://good.example')
    network.relay('wss://dead.example', { refuse: true })
    network.relay('wss://full.example', { rejectWrites: 'error: disk full' })
    // Stored in the order an unlucky database might return them.
    pool.setRelays(['wss://dead.example', 'wss://full.example', 'wss://good.example'], [])
    pool.seedHealth([
      { url: 'wss://good.example', health: legacyHealth({ publishOk: 40, latencyMs: 300 }) },
      { url: 'wss://dead.example', health: legacyHealth({ connectFail: 30, publishFail: 30 }) },
      { url: 'wss://full.example', health: legacyHealth({ publishOk: 1, publishFail: 20 }) },
    ])
    await vi.advanceTimersByTimeAsync(10)
    expect(pool.rankedReadRelays(1)).toEqual(['wss://good.example'])
    pool.destroy()
    vi.useRealTimers()
  })
})

describe('the relays in use (ADR-067)', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool
  const urls = (...names: string[]) => names.map((name) => `wss://${name}.example`)
  const SIX = urls('a', 'b', 'c', 'd', 'e', 'f')
  const inbox = () => ({ kinds: [1059], '#p': ['ab'.repeat(32)] })
  const statusOf = (url: string) => pool.statuses().find((status) => status.url === url)!
  const inUse = () =>
    pool
      .statuses()
      .filter((status) => status.active)
      .map((status) => status.url)
  const asked = (server: { reqs: { id: string }[] }) =>
    server.reqs.filter((r) => r.id.startsWith('inbox')).length

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    pool = poolOn(network)
  })

  afterEach(() => {
    pool.destroy()
    vi.useRealTimers()
  })

  it('holds the best four open and lets the rest stand by, unconnected', async () => {
    for (const url of SIX) network.relay(url)
    pool.setRelays(SIX, SIX)
    await advance(10)
    // Untried relays tie, so the configured order decides.
    expect(SIX.filter((url) => network.servers.get(url)!.openConnections > 0)).toEqual(SIX.slice(0, 4))
    expect(inUse()).toEqual(SIX.slice(0, 4))
    expect(pool.onlineCount).toBe(4)
    expect(pool.rankedReadRelays()).toHaveLength(4)
    expect(pool.rankedWriteRelays(2)).toHaveLength(2)
    expect(network.servers.get(SIX[5]!)!.connectAttempts).toBe(0)
  })

  it('brings in a relay standing by the moment one in use goes down, and the inbox follows', async () => {
    const servers = SIX.map((url) => network.relay(url))
    pool.setRelays(SIX, SIX)
    pool.subscribe(inbox, { onEvent: () => undefined, label: 'inbox' })
    await advance(10)
    expect(asked(servers[4]!)).toBe(0)
    const epoch = pool.epoch

    servers[1]!.set({ refuse: true })
    servers[1]!.dropAll()
    await advance(2000)

    expect(statusOf(SIX[1]!).health.connectStreak).toBe(2)
    expect(statusOf(SIX[1]!).active).toBe(false)
    expect(inUse()).toEqual([SIX[0], SIX[2], SIX[3], SIX[4]])
    // The newcomer is asked for the inbox at once, from its own mark.
    expect(asked(servers[4]!)).toBe(1)
    // The one set aside is let go rather than retried every few seconds.
    const attempts = servers[1]!.connectAttempts
    await advance(20_000)
    expect(servers[1]!.connectAttempts).toBe(attempts)
    expect(pool.epoch).toBeGreaterThan(epoch)
  })

  it('sets nothing aside when every relay fails at once: that is the network, not the relays', async () => {
    const four = urls('a', 'b', 'c', 'd')
    for (const url of four) network.relay(url, { refuse: true })
    pool.setRelays(four, four)
    await advance(20_000)
    for (const url of four) {
      expect(statusOf(url).health.connectFail).toBeGreaterThan(2)
      expect(statusOf(url).health.connectStreak).toBe(0)
    }
    expect(inUse()).toEqual(four)
  })

  it('does not connect at start to a relay that was down last session, and tries it when a place is empty', async () => {
    const [a, b] = urls('a', 'b')
    network.relay(a!)
    const later = network.relay(b!)
    pool.seedHealth([{ url: b!, health: { ...emptyHealth(), connectStreak: 2, lastErrorAt: Date.now() } }])
    pool.setRelays([a!, b!], [a!, b!])
    await advance(10)
    expect(later.connectAttempts).toBe(0)
    expect(inUse()).toEqual([a])

    await advance(30_000)
    expect(later.connectAttempts).toBe(1)
    expect(inUse()).toEqual([a, b])
    expect(statusOf(b!).health.connectStreak).toBe(0)
  })

  it('tries a relay that is down once per wait, waiting twice as long after each failure', async () => {
    const [a, b] = urls('a', 'b')
    network.relay(a!)
    const dead = network.relay(b!, { refuse: true })
    pool.seedHealth([{ url: b!, health: { ...emptyHealth(), connectStreak: 2, lastErrorAt: Date.now() } }])
    pool.setRelays([a!, b!], [a!, b!])
    await advance(10)
    const epoch = pool.epoch

    await advance(30_000)
    expect(dead.connectAttempts).toBe(1)
    expect(statusOf(b!).health.connectStreak).toBe(3)
    await advance(59_000)
    expect(dead.connectAttempts).toBe(1)
    await advance(1_100)
    expect(dead.connectAttempts).toBe(2)
    // A relay not in use dropping out is no gap in the inbox.
    expect(pool.epoch).toBe(epoch)
  })

  it('takes a relay that refuses the inbox out of use, and asks it again six hours later', async () => {
    const [a, b] = urls('a', 'b')
    const auth = network.relay(a!, { refuseReads: 'auth-required: sign in first' })
    network.relay(b!)
    pool.setRelays([a!, b!], [a!, b!])
    pool.subscribe(inbox, { onEvent: () => undefined, label: 'inbox' })
    await advance(50)
    expect(statusOf(a!).health.readFail).toBe(1)
    expect(statusOf(a!).health.readFailAt).toBeGreaterThan(0)
    expect(inUse()).toEqual([b])
    expect(auth.openConnections).toBe(0)

    auth.set({ refuseReads: null, eoseDelayMs: 120 })
    await advance(6 * 60 * 60_000)
    await advance(200)
    expect(asked(auth)).toBe(2)
    // It serves the inbox now: the refusal is forgotten, and its answer timed.
    expect(statusOf(a!).health.readFail).toBe(0)
    expect(statusOf(a!).health.eoseMs).toBeGreaterThanOrEqual(120)
    expect(inUse()).toEqual([a, b])
  })

  it('counts a refusal only of the inbox', async () => {
    const [a] = urls('a')
    network.relay(a!, { refuseReads: 'restricted: members only' })
    pool.setRelays([a!], [a!])
    pool.subscribe({ kinds: [445] }, { onEvent: () => undefined, label: 'group' })
    await advance(50)
    expect(statusOf(a!).health.readFail).toBe(0)
    expect(statusOf(a!).health.lastError).toBe('restricted: members only')
  })

  it('replaces a relay whose publishes keep failing with one standing by', async () => {
    const five = urls('a', 'b', 'c', 'd', 'e')
    for (const url of five) network.relay(url)
    network.servers.get(five[3]!)!.set({ rejectWrites: 'error: disk full' })
    pool.setRelays([], five)
    await advance(10)
    for (let i = 0; i < 3; i++) {
      const handle = pool.dispatch(signed(), [five[3]!], { standbys: [] })
      await advance(20)
      await handle.settled
    }
    expect(inUse()).toEqual([five[0], five[1], five[2], five[4]])
    expect(network.servers.get(five[4]!)!.openConnections).toBe(1)
  })

  it('counts a connection lost soon after it opened as churn', async () => {
    const [a] = urls('a')
    const flaky = network.relay(a!)
    pool.setRelays([a!], [a!])
    await advance(10)
    flaky.dropAll()
    await advance(5)
    expect(statusOf(a!).health.drops).toBe(1)
    expect(statusOf(a!).health.churn).toBeCloseTo(0.25, 6)
  })

  it('reads from the relays in use only', async () => {
    const events = SIX.map(() => signed())
    SIX.forEach((url, i) => network.relay(url).inject(events[i]!))
    pool.setRelays(SIX, SIX)
    await advance(10)
    let result: NostrEvent[] = []
    void pool.query({ kinds: [1059] }).then((r) => (result = r))
    await advance(50)
    expect(result.map((e) => e.id).sort()).toEqual(
      events
        .slice(0, 4)
        .map((e) => e.id)
        .sort(),
    )
  })

  it('keeps a relay it stops using connected until a publish waiting on it has settled', async () => {
    const five = urls('a', 'b', 'c', 'd', 'e')
    for (const url of five) network.relay(url)
    const slow = network.servers.get(five[0]!)!
    slow.set({ okDelayMs: 8000 })
    pool.setRelays(five, five)
    await advance(10)
    const handle = pool.dispatch(signed(), [five[0]!], { standbys: [] })
    await advance(10)

    slow.set({ refuseReads: 'auth-required: sign in first' })
    pool.subscribe(inbox, { onEvent: () => undefined, label: 'inbox' })
    await advance(50)
    expect(statusOf(five[0]!).active).toBe(false)
    expect(slow.openConnections).toBe(1)

    const outcomes = await Promise.all([handle.settled, advance(8000)]).then(([o]) => o)
    expect(outcomes[0]?.ok).toBe(true)
    await advance(4 * 60_000)
    expect(slow.openConnections).toBe(0)
  })

  it('follows the relays once they are configured, when subscribed before', async () => {
    const [a] = urls('a')
    const server = network.relay(a!)
    pool.subscribe(inbox, { onEvent: () => undefined, label: 'inbox' })
    pool.setRelays([a!], [a!])
    await advance(10)
    expect(asked(server)).toBe(1)
  })

  it('does nothing with a subscription to no relays at all', () => {
    const closer = pool.subscribe({ kinds: [1] }, { onEvent: () => undefined }, [])
    expect(() => closer.close()).not.toThrow()
  })

  it('makes a one-off socket as it makes its own', async () => {
    const [a] = urls('a')
    network.relay(a!, { connectDelayMs: 40 })
    let opened = -1
    const socket = pool.open(a!, { onOpen: (ms) => (opened = ms) })
    socket.connect()
    await advance(50)
    expect(opened).toBeGreaterThanOrEqual(40)
    expect(inUse()).toEqual([])
    socket.close()
  })

  it('sets a relay aside as soon as stored health says it is down', async () => {
    const four = urls('a', 'b', 'c', 'd')
    for (const url of four) network.relay(url)
    pool.setRelays(four, four)
    await advance(10)
    pool.seedHealth([
      { url: four[2]!, health: { ...emptyHealth(), connectStreak: 4, lastErrorAt: Date.now() } },
    ])
    expect(inUse()).toEqual([four[0], four[1], four[3]])
    await advance(10)
    expect(network.servers.get(four[2]!)!.openConnections).toBe(0)
  })
})

describe('relay pool edges', () => {
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

  it('works with the browser’s own sockets when given none', () => {
    const own = new RelayPool()
    expect(own.readRelays).toEqual([])
    expect(own.rankedReadRelays()).toEqual([])
    own.destroy()
  })

  it('ignores stored health for an address it would never connect to', () => {
    pool.seedHealth([{ url: 'http://not-a-relay.example', health: emptyHealth() }])
    expect(pool.healthSnapshot()).toEqual([])
  })

  it('hands out copies of its health records', async () => {
    network.relay('wss://a.example')
    pool.setRelays(['wss://a.example'], ['wss://a.example'])
    await advance(10)
    const [snapshot] = pool.healthSnapshot()
    expect(snapshot?.url).toBe('wss://a.example')
    expect(snapshot?.health.connectOk).toBe(1)
    snapshot!.health.connectOk = 99
    expect(pool.healthSnapshot()[0]?.health.connectOk).toBe(1)
  })

  it('does not resubscribe once the pool is gone', async () => {
    const relay = network.relay('wss://moody.example', { refuseReads: 'error: shutting down' })
    pool.setRelays(['wss://moody.example'], [])
    pool.subscribe({ kinds: [1059] }, { onEvent: () => undefined, label: 'inbox' })
    await advance(10)
    pool.destroy()
    relay.set({ refuseReads: null })
    await advance(31_000)
    expect(relay.reqs.filter((r) => r.id.startsWith('inbox'))).toHaveLength(1)
  })

  it('counts a relay that refuses a one-off read as having answered', async () => {
    network.relay('wss://auth.example', { refuseReads: 'auth-required: sign in first' })
    let result: NostrEvent[] | null = null
    void pool.query({ kinds: [1059] }, ['wss://auth.example'], { maxWait: 8000 }).then((r) => (result = r))
    await advance(50)
    expect(result).toEqual([])
  })

  it('answers a read once per relay, however that relay finishes', async () => {
    const early = network.relay('wss://a.example')
    network.relay('wss://b.example', { eoseDelayMs: 500 })
    let result: NostrEvent[] | null = null
    void pool
      .query({ kinds: [1059] }, ['wss://a.example', 'wss://b.example'], { maxWait: 8000 })
      .then((r) => (result = r))
    await advance(50)
    // Finished, then lost: the drop is not a second answer.
    early.dropAll()
    await advance(10)
    expect(result).toBeNull()
    await advance(600)
    expect(result).toEqual([])
  })

  it('publishes to the write relays when told no others', async () => {
    const relay = network.relay('wss://w.example')
    pool.setRelays([], ['wss://w.example'])
    await advance(10)
    const event = signed()
    const outcomes = await Promise.all([pool.publish(event), advance(50)]).then(([o]) => o)
    expect(acks(outcomes)).toEqual(['wss://w.example'])
    expect(relay.stored.map((e) => e.id)).toEqual([event.id])
  })

  it('brings in a standby as soon as every target has refused the event', async () => {
    network.relay('wss://full.example', { rejectWrites: 'error: disk full' })
    const spare = network.relay('wss://spare.example')
    pool.setRelays([], ['wss://spare.example'])
    await advance(10)
    const event = signed()
    const handle = pool.dispatch(event, ['wss://full.example'], { standbys: ['wss://spare.example'] })
    const outcomes = await Promise.all([handle.quorum, advance(100)]).then(([o]) => o)
    expect(acks(outcomes)).toEqual(['wss://spare.example'])
    expect(spare.stored.map((e) => e.id)).toEqual([event.id])
  })

  it('ignores a relay dropping that the publish never went to, or that already answered', async () => {
    const other = network.relay('wss://other.example')
    const answered = network.relay('wss://answered.example')
    network.relay('wss://slow.example', { okDelayMs: 3000 })
    pool.setRelays([], ['wss://other.example'])
    await advance(10)
    const handle = pool.dispatch(signed(), ['wss://answered.example', 'wss://slow.example'], {
      quorum: 2,
      standbys: [],
    })
    await advance(50)
    other.dropAll()
    answered.dropAll()
    await advance(10)
    const outcomes = await Promise.all([handle.quorum, advance(3100)]).then(([o]) => o)
    expect(acks(outcomes).sort()).toEqual(['wss://answered.example', 'wss://slow.example'])
  })

  it('settles a publish with nowhere to go at once', async () => {
    const handle = pool.dispatch(signed(), [])
    expect(await handle.quorum).toEqual([])
    expect(await handle.settled).toEqual([])
  })

  it('opens nothing once destroyed', async () => {
    const relay = network.relay('wss://late.example')
    pool.destroy()
    pool.setRelays(['wss://late.example'], [])
    await advance(10)
    expect(relay.connectAttempts).toBe(0)
  })

  it('remembers only the most recent event ids, so its memory stays bounded', async () => {
    const relay = network.relay('wss://busy.example')
    pool.setRelays(['wss://busy.example'], [])
    const first = signed()
    relay.inject(first)
    let received = 0
    pool.subscribe({ kinds: [1059] }, { onEvent: () => (received += 1), label: 'inbox' })
    await advance(10)
    for (let i = 0; i < 4096; i++) relay.inject(signed())
    await advance(10)
    expect(received).toBe(4097)
    // The first has been forgotten, so a second copy of it is delivered again.
    const second = network.relay('wss://again.example')
    second.inject(first)
    pool.subscribe({ kinds: [1059] }, { onEvent: () => (received += 1) }, ['wss://again.example'])
    await advance(10)
    expect(received).toBe(4098)
  }, 60_000)
})

describe('relay pool edges, continued', () => {
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

  it('times only inbox reads', async () => {
    network.relay('wss://a.example', { eoseDelayMs: 80 })
    pool.setRelays(['wss://a.example'], [])
    let eose = 0
    pool.subscribe({ kinds: [445] }, { onEvent: () => undefined, onEose: () => (eose += 1) })
    await advance(100)
    expect(eose).toBe(1)
    expect(pool.statuses()[0]?.health.eoseMs).toBe(0)
  })

  it('pays no attention to a relay a read was not sent to dropping', async () => {
    const bystander = network.relay('wss://bystander.example')
    network.relay('wss://asked.example', { eoseDelayMs: 300 })
    pool.setRelays(['wss://bystander.example'], [])
    await advance(10)
    let result: NostrEvent[] | null = null
    void pool.query({ kinds: [1059] }, ['wss://asked.example'], { maxWait: 8000 }).then((r) => (result = r))
    await advance(50)
    bystander.dropAll()
    await advance(10)
    expect(result).toBeNull()
    await advance(300)
    expect(result).toEqual([])
  })

  it('does not pre-warm a relay whose circuit is open', async () => {
    const failing = network.relay('wss://failing.example')
    pool.seedHealth([
      {
        url: 'wss://failing.example',
        health: { ...emptyHealth(), failStreak: 5, lastErrorAt: Date.now() },
      },
    ])
    pool.prewarm(['wss://failing.example'])
    await advance(10)
    expect(failing.connectAttempts).toBe(0)
  })

  it('wakes only the sockets something still wants', async () => {
    network.relay('wss://kept.example')
    const passing = network.relay('wss://passing.example', { refuse: true })
    pool.setRelays(['wss://kept.example'], ['wss://kept.example'])
    await advance(10)
    // A publish to someone else's relay, which fails and is left to back off.
    const handle = pool.dispatch(signed(), ['wss://passing.example'], { standbys: [] })
    await advance(10_100)
    await handle.settled
    const attempts = passing.connectAttempts
    pool.wake('online')
    await advance(10)
    expect(passing.connectAttempts).toBe(attempts)
  })
})

describe('what a relay will carry (ADR-073)', () => {
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

  const sized = (chars: number): NostrEvent =>
    finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x'.repeat(chars) },
      generateSecretKey(),
    )
  const health = (url: string) => pool.statuses().find((status) => status.url === url)!.health

  it('does not hold a refusal of a large event against the relay, and stops sending it those', async () => {
    const picky = network.relay('wss://picky.example', {
      rejectWrites: 'blocked: pubkey is not in our web of trust',
    })
    network.relay('wss://open.example')
    pool.setRelays([], ['wss://picky.example', 'wss://open.example'])
    await advance(10)

    const first = pool.publish(sized(9000), ['wss://picky.example', 'wss://open.example'])
    await advance(10)
    expect(acks(await first)).toEqual(['wss://open.example'])
    expect(health('wss://picky.example').failStreak).toBe(0)
    expect(health('wss://picky.example').largeRefusedAt).toBeGreaterThan(0)

    // Not uploaded there again for now, while a short message still goes.
    const seen = () =>
      picky.reqs.length +
      network.sockets
        .filter((s) => s.url === 'wss://picky.example')
        .flatMap((s) => s.sent)
        .filter((frame) => frame.startsWith('["EVENT"')).length
    const before = seen()
    const second = pool.publish(sized(9000), ['wss://picky.example', 'wss://open.example'])
    await advance(10)
    expect(acks(await second)).toEqual(['wss://open.example'])
    expect(seen()).toBe(before)

    const short = pool.publish(sized(100), ['wss://picky.example', 'wss://open.example'])
    await advance(10)
    await short
    expect(seen()).toBe(before + 1)
  })

  it('still tries such a relay when there is nowhere else', async () => {
    const picky = network.relay('wss://only.example', { rejectWrites: 'invalid: event too large: 70000' })
    pool.setRelays([], ['wss://only.example'])
    await advance(10)
    await Promise.all([pool.publish(sized(9000), ['wss://only.example']), advance(10)])
    const again = pool.publish(sized(9000), ['wss://only.example'])
    await advance(10)
    expect(await again).toEqual([
      { url: 'wss://only.example', ok: false, error: 'invalid: event too large: 70000' },
    ])
    expect(picky.reqs).toHaveLength(0)
  })

  it('counts any other refusal of a large event as it always did', async () => {
    network.relay('wss://full.example', { rejectWrites: 'error: disk full' })
    pool.setRelays([], ['wss://full.example'])
    await advance(10)
    await Promise.all([pool.publish(sized(9000), ['wss://full.example']), advance(10)])
    expect(health('wss://full.example').failStreak).toBe(1)
    expect(health('wss://full.example').largeRefusedAt).toBeUndefined()
  })

  it('counts a short event refused for its signer as it always did', async () => {
    network.relay('wss://wot.example', { rejectWrites: 'blocked: not in our web of trust' })
    pool.setRelays([], ['wss://wot.example'])
    await advance(10)
    await Promise.all([pool.publish(sized(100), ['wss://wot.example']), advance(10)])
    expect(health('wss://wot.example').failStreak).toBe(1)
  })
})

describe('reading where this identity’s other devices read (ADR-073)', () => {
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

  it('moves to the relays named, among those it knows, while they work', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `wss://${name}.example`)
    for (const url of urls) network.relay(url)
    pool.setRelays(urls, [])
    await advance(10)
    const before = pool.rankedReadRelays()
    const others = urls.filter((url) => !before.includes(url))
    expect(others).toHaveLength(2)

    pool.preferRead([...others, 'wss://unknown.example'])
    await advance(10)
    const after = pool.rankedReadRelays()
    expect(after).toHaveLength(4)
    expect(after).toEqual(expect.arrayContaining(others))
    expect(after).not.toContain('wss://unknown.example')
  })

  it('does not lean on a named relay that is down', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((name) => `wss://${name}.example`)
    for (const url of urls) network.relay(url)
    pool.setRelays(urls, [])
    await advance(10)
    const spare = urls.find((url) => !pool.rankedReadRelays().includes(url))!
    pool.seedHealth([{ url: spare, health: { ...emptyHealth(), connectStreak: 5, lastErrorAt: Date.now() } }])
    pool.preferRead([spare])
    await advance(10)
    expect(pool.rankedReadRelays()).not.toContain(spare)
  })
})

describe('NIP-77 as a lazy chunk', () => {
  it('reports a chunk that will not load as a failure, not a refusal', async () => {
    vi.useFakeTimers()
    const network = new FakeSocketNetwork()
    network.relay('wss://neg.example', { negentropy: true })
    const pool = new RelayPool({
      socket: { createSocket: network.factory, random: () => 0, isOffline: () => false },
      negentropy: () => Promise.reject(new Error('no such chunk')),
    })
    pool.setRelays(['wss://neg.example'], [])
    await advance(10)
    expect(await pool.reconcile('wss://neg.example', { kinds: [1059] }, [])).toEqual({
      ok: false,
      refused: false,
      reason: 'could not load',
    })
    pool.destroy()
    vi.useRealTimers()
  })

  it('tells a read that finished from one that merely ended', async () => {
    vi.useFakeTimers()
    const network = new FakeSocketNetwork()
    network.relay('wss://fine.example')
    network.relay('wss://mute.example', { eoseDelayMs: 60_000 })
    const pool = poolOn(network)
    pool.setRelays(['wss://fine.example', 'wss://mute.example'], [])
    await advance(10)
    const finished: string[] = []
    const fine = pool.query({ kinds: [1] }, ['wss://fine.example'], { onEose: (url) => finished.push(url) })
    await advance(10)
    await fine
    const mute = pool.query({ kinds: [1] }, ['wss://mute.example'], {
      maxWait: 100,
      onEose: (url) => finished.push(url),
    })
    await advance(200)
    await mute
    expect(finished).toEqual(['wss://fine.example'])
    pool.destroy()
    vi.useRealTimers()
  })
})

describe('reading a payload’s chunks (ADR-075)', () => {
  it('learns nothing about the inbox from it', async () => {
    vi.useFakeTimers()
    const network = new FakeSocketNetwork()
    network.relay('wss://a.example', { refuseReads: 'auth-required: sign in' })
    network.relay('wss://b.example')
    const pool = poolOn(network)
    pool.setRelays(['wss://b.example'], [])
    await advance(10)
    const health = (url: string) => pool.statuses().find((status) => status.url === url)!.health
    const filter = { kinds: [1059], '#p': ['c'.repeat(64)] }
    const refused = pool.subscribe(filter, { onEvent: () => undefined, label: 'blob' }, ['wss://a.example'])
    const fine = pool.subscribe(filter, { onEvent: () => undefined, label: 'blob' }, ['wss://b.example'])
    await advance(10)
    expect(health('wss://a.example').readFail).toBe(0)
    expect(health('wss://b.example').eoseMs).toBe(0)
    refused.close()
    fine.close()
    pool.destroy()
    vi.useRealTimers()
  })
})
