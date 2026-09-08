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

  it('connects every configured relay as soon as it is known', async () => {
    // The pre-warm: by the time a message is typed, the handshakes are done.
    network.relay('wss://a.example', { connectDelayMs: 1500 })
    network.relay('wss://b.example', { connectDelayMs: 900 })
    pool.setRelays(['wss://a.example'], ['wss://b.example'])
    expect(pool.onlineCount).toBe(0)
    await advance(1600)
    expect(pool.onlineCount).toBe(2)
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
    expect(pool.rankedWriteRelays()).toEqual(['wss://good.example', 'wss://full.example'])
    const full = pool.statuses().find((s) => s.url === 'wss://full.example')
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
