import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import {
  MAX_FRAME_CHARS,
  peekEvent,
  RelaySocket,
  type RelaySocketOptions,
} from '@/core/transport/relaySocket'
import { FakeSocketNetwork, type FakeRelayServer } from './fakeWebSocket'

const URL_A = 'wss://a.example'

function signed(kind = 1, createdAt = Math.floor(Date.now() / 1000), content = 'hello'): NostrEvent {
  return finalizeEvent({ kind, created_at: createdAt, tags: [], content }, generateSecretKey())
}

/** Deterministic jitter, so reconnect delays are exact. */
const options = (network: FakeSocketNetwork, extra: RelaySocketOptions = {}): RelaySocketOptions => ({
  createSocket: network.factory,
  random: () => 0,
  isOffline: () => false,
  ...extra,
})

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('relay socket: staying connected', () => {
  let network: FakeSocketNetwork
  let relay: FakeRelayServer
  let socket: RelaySocket

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    relay = network.relay(URL_A)
  })

  afterEach(() => {
    socket?.close()
    vi.useRealTimers()
  })

  it('keeps retrying a relay whose first connection fails', async () => {
    // nostr-tools gave up for good on a relay whose first attempt failed, so a
    // relay briefly down at startup never delivered live mail that session.
    relay.set({ refuse: true })
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(20_000)
    expect(relay.connectAttempts).toBeGreaterThanOrEqual(4)
    expect(socket.state).toBe('backoff')

    relay.set({ refuse: false })
    await advance(31_000)
    expect(socket.state).toBe('open')
  })

  it('delivers a live subscription even when the first handshake takes five seconds', async () => {
    // The measured case: healthy public relays took 5-10 s to open from a slow
    // link, and nostr-tools allowed a subscription 3 s before abandoning it.
    relay.set({ connectDelayMs: 5000 })
    socket = new RelaySocket(URL_A, {}, options(network))
    const received: string[] = []
    socket.subscribe('inbox', { filter: () => ({ kinds: [1] }), onEvent: (event) => received.push(event.id) })
    socket.connect()

    await advance(5100)
    expect(socket.state).toBe('open')
    const live = signed()
    relay.inject(live)
    await advance(10)
    expect(received).toEqual([live.id])
  })

  it('reconnects within about a second of a relay restart, not after ten', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(10)
    expect(socket.state).toBe('open')

    relay.dropAll()
    expect(socket.state).toBe('backoff')
    // Backoff base is 400 ms; with jitter pinned low it is exactly that.
    await advance(450)
    expect(socket.state).toBe('open')
  })

  it('resends the owner’s filter on reconnect, never one advanced past the newest event', async () => {
    // NIP-59 backdates gift wraps by up to two days, so a resumed subscription
    // that starts after the newest event it saw skips anything wrapped during
    // the outage with an earlier timestamp. nostr-tools did exactly that.
    const since = Math.floor(Date.now() / 1000) - 3 * 86_400
    socket = new RelaySocket(URL_A, {}, options(network))
    const received: string[] = []
    socket.subscribe('inbox', {
      filter: () => ({ kinds: [1059], since }),
      onEvent: (event) => received.push(event.id),
    })
    socket.connect()
    await advance(10)

    const recent = signed(1059, Math.floor(Date.now() / 1000))
    relay.inject(recent)
    await advance(10)

    relay.dropAll()
    // Sent during the outage, backdated a day and a half.
    const backdated = signed(1059, Math.floor(Date.now() / 1000) - 36 * 3600)
    relay.inject(backdated)
    await advance(1000)

    const resumed = relay.reqs.filter((req) => req.id === 'inbox')
    expect(resumed).toHaveLength(2)
    expect(resumed[1]?.filters[0]?.since).toBe(since)
    expect(received).toContain(backdated.id)
  })

  it('discards stale backoff and reconnects at once when woken', async () => {
    relay.set({ refuse: true })
    socket = new RelaySocket(URL_A, {}, options(network, { random: () => 1 }))
    socket.connect()
    // Let the backoff grow well past anything a person would wait for.
    await advance(40_000)
    expect(socket.state).toBe('backoff')

    relay.set({ refuse: false })
    socket.wake(false)
    await advance(10)
    expect(socket.state).toBe('open')
  })

  it('retries a relay that never answers far less often, until woken', async () => {
    // A dead entry in a relay list refuses in milliseconds; retrying it every
    // thirty seconds forever is a handshake a minute for nothing.
    relay.set({ refuse: true })
    socket = new RelaySocket(URL_A, {}, options(network, { random: () => 1 }))
    socket.connect()
    await advance(10 * 60_000)
    const attempts = relay.connectAttempts
    await advance(10 * 60_000)
    // Five-minute cap: two or three attempts in ten minutes, not twenty.
    expect(relay.connectAttempts - attempts).toBeLessThanOrEqual(3)

    relay.set({ refuse: false })
    socket.wake(false)
    await advance(10)
    expect(socket.state).toBe('open')
  })

  it('backs off to the cap while the browser reports no network at all', async () => {
    let offline = true
    relay.set({ refuse: true })
    socket = new RelaySocket(URL_A, {}, options(network, { isOffline: () => offline }))
    socket.connect()
    await advance(29_000)
    // One attempt, then nothing: retrying fast while offline only burns battery.
    expect(relay.connectAttempts).toBe(1)

    offline = false
    relay.set({ refuse: false })
    socket.wake(false)
    await advance(10)
    expect(socket.state).toBe('open')
  })
})

describe('relay socket: dead connections', () => {
  let network: FakeSocketNetwork
  let relay: FakeRelayServer
  let socket: RelaySocket

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    relay = network.relay(URL_A)
  })

  afterEach(() => {
    socket?.close()
    vi.useRealTimers()
  })

  it('reaps a socket that looks open but carries nothing', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(10)
    relay.set({ silent: true })

    // Keepalive after 25 s of silence, then 5 s to answer.
    await advance(30_100)
    expect(socket.state).toBe('backoff')
    await advance(500)
    expect(relay.connectAttempts).toBe(2)
  })

  it('probes at once when a publish goes unanswered, and delivers on the new connection', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(10)
    // The path dies silently, the way a network switch kills a socket.
    for (const connection of relay.connections) connection.dead = true

    const event = signed()
    let result: Awaited<ReturnType<RelaySocket['publish']>> | null = null
    void socket.publish(event, 20_000).then((r) => (result = r))

    // 5 s for the relay to answer, 5 s for the probe: found in ten seconds
    // rather than the keepalive's thirty, and the event goes out again.
    await advance(10_600)
    expect(result).toMatchObject({ ok: true })
    expect(relay.stored.map((e) => e.id)).toContain(event.id)
  })

  it('learns a NAT idle timeout and settles below it', async () => {
    relay.set({ natIdleMs: 18_000 })
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(10)
    expect(socket.keepAliveMs).toBe(25_000)

    // First keepalive at 25 s finds the path dead: halve.
    await advance(30_500)
    expect(socket.keepAliveMs).toBe(12_500)

    // Survives, grows, is killed once more at 20 s, and then stays alive.
    await advance(5 * 60_000)
    const settled = socket.keepAliveMs
    expect(settled).toBe(16_000)
    const attempts = relay.connectAttempts
    await advance(10 * 60_000)
    expect(relay.connectAttempts).toBe(attempts)
    expect(socket.state).toBe('open')
  })

  it('does not stretch the keepalive after a failed wake probe', async () => {
    // A probe that fails because the device slept for an hour says nothing
    // about how long the network tolerates silence.
    socket = new RelaySocket(URL_A, {}, options(network))
    socket.connect()
    await advance(10)
    for (const connection of relay.connections) connection.dead = true
    await advance(3000)
    socket.wake(true)
    await advance(4000)
    expect(socket.keepAliveMs).toBe(25_000)
  })
})

describe('relay socket: publishing and inbound frames', () => {
  let network: FakeSocketNetwork
  let relay: FakeRelayServer
  let socket: RelaySocket

  beforeEach(() => {
    vi.useFakeTimers()
    network = new FakeSocketNetwork()
    relay = network.relay(URL_A)
  })

  afterEach(() => {
    socket?.close()
    vi.useRealTimers()
  })

  it('holds a publish made while connecting and sends it the moment the socket opens', async () => {
    relay.set({ connectDelayMs: 2000 })
    socket = new RelaySocket(URL_A, {}, options(network))
    const pending = socket.publish(signed(), 10_000)
    await advance(2010)
    expect(await pending).toMatchObject({ ok: true })
  })

  it('reports a rejection with the relay’s reason', async () => {
    relay.set({ rejectWrites: 'error: mdb_txn_commit: No space left on device' })
    socket = new RelaySocket(URL_A, {}, options(network))
    const pending = socket.publish(signed(), 10_000)
    await advance(10)
    expect(await pending).toEqual({ ok: false, error: 'error: mdb_txn_commit: No space left on device' })
  })

  it('treats a duplicate as success, because the relay holds the event', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    const event = signed()
    relay.inject(event)
    const pending = socket.publish(event, 10_000)
    await advance(10)
    expect(await pending).toMatchObject({ ok: true })
  })

  it('times out a publish to a black-holed relay instead of hanging', async () => {
    relay.set({ blackhole: true })
    socket = new RelaySocket(URL_A, {}, options(network))
    const pending = socket.publish(signed(), 10_000)
    await advance(10_010)
    expect(await pending).toEqual({ ok: false, error: 'publish timed out' })
  })

  it('passes on only events that are signed and match the filter', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    const received: string[] = []
    socket.subscribe('s', { filter: () => ({ kinds: [1] }), onEvent: (event) => received.push(event.id) })
    socket.connect()
    await advance(10)

    const good = signed(1)
    const wrongKind = signed(7)
    const forged = { ...signed(1), content: 'tampered' }
    const ws = network.sockets[0]!
    for (const event of [good, wrongKind, forged]) ws.deliver(JSON.stringify(['EVENT', 's', event]))
    await advance(10)
    expect(received).toEqual([good.id])
  })

  it('skips a duplicate before parsing it', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    const have = new Set<string>()
    let delivered = 0
    const parse = vi.spyOn(JSON, 'parse')
    socket.subscribe('s', {
      filter: () => ({ kinds: [1] }),
      alreadyHave: (id) => have.has(id),
      onEvent: (event) => {
        have.add(event.id)
        delivered += 1
      },
    })
    socket.connect()
    await advance(10)

    const event = signed(1)
    const frame = JSON.stringify(['EVENT', 's', event])
    const ws = network.sockets[0]!
    ws.deliver(frame)
    await advance(10)
    const parsesAfterFirst = parse.mock.calls.length
    ws.deliver(frame)
    ws.deliver(frame)
    await advance(10)

    expect(delivered).toBe(1)
    expect(parse.mock.calls.length).toBe(parsesAfterFirst)
    parse.mockRestore()
  })

  it('drops an oversized frame unparsed', async () => {
    socket = new RelaySocket(URL_A, {}, options(network))
    const received: string[] = []
    socket.subscribe('s', { filter: () => ({ kinds: [1] }), onEvent: (event) => received.push(event.id) })
    socket.connect()
    await advance(10)

    const huge = signed(1, Math.floor(Date.now() / 1000), 'x'.repeat(MAX_FRAME_CHARS))
    network.sockets[0]!.deliver(JSON.stringify(['EVENT', 's', huge]))
    await advance(10)
    expect(received).toEqual([])
  })

  it('does not resend a subscription the relay refused', async () => {
    relay.set({ refuseReads: 'auth-required: we only serve authenticated users' })
    socket = new RelaySocket(URL_A, {}, options(network))
    const reasons: string[] = []
    socket.subscribe('inbox', {
      filter: () => ({ kinds: [1059] }),
      onEvent: () => undefined,
      onClosed: (r) => reasons.push(r),
    })
    socket.connect()
    await advance(10)
    relay.dropAll()
    await advance(1000)

    expect(reasons).toEqual(['auth-required: we only serve authenticated users'])
    expect(relay.reqs.filter((req) => req.id === 'inbox')).toHaveLength(1)
  })
})

describe('peeking at raw event frames', () => {
  const id = 'ab'.repeat(32)

  it('finds the subscription and event ids', () => {
    const frame = JSON.stringify(['EVENT', 'inbox:1', { id, kind: 1 }])
    expect(peekEvent(frame)).toEqual({ subId: 'inbox:1', eventId: id })
  })

  it('is not fooled by an id key inside the content', () => {
    // Inside a JSON string every quote is escaped, so the pattern cannot occur.
    const decoy = 'cd'.repeat(32)
    const frame = JSON.stringify(['EVENT', 's', { content: `"id":"${decoy}"`, id, kind: 1 }])
    expect(peekEvent(frame)?.eventId).toBe(id)
  })

  it('declines anything it cannot read cleanly', () => {
    expect(peekEvent('["EVENT"')).toBeNull()
    expect(peekEvent(JSON.stringify(['EVENT', 's', { id: 'short' }]))).toBeNull()
  })
})
