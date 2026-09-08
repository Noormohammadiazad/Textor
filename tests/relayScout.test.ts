import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RelayPool } from '@/core/transport/relayPool'
import {
  CATALOG,
  clearRepairs,
  declineRelay,
  findCandidates,
  healthFromProbe,
  KIND_RELAY_REPORT,
  monitorReports,
  probeRelay,
  probeRelays,
  rankProbes,
  repairRelays,
  repairs,
  type Probe,
  type ScoutHost,
} from '@/core/transport/relayScout'
import { DEFAULT_DM_RELAYS } from '@/core/transport/defaultRelays'
import { DEAD_AFTER_MS } from '@/core/transport/relayScore'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import { FakeSocketNetwork } from './fakeWebSocket'
import { makeVault, type TestVault } from './helpers'

/**
 * The relay scout (ADR-067): testing relays from this device, finding
 * candidates without trusting anyone's word for them, and replacing a relay
 * only on evidence that it died.
 */

const poolOn = (network: FakeSocketNetwork): RelayPool =>
  new RelayPool({ socket: { createSocket: network.factory, random: () => 0, isOffline: () => false } })

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

async function probed(pool: RelayPool, url: string, ms = 11_000): Promise<Probe> {
  const result = probeRelay(pool, url)
  await advance(ms)
  return result
}

describe('testing a relay from this device', () => {
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

  it('passes a relay that serves a stranger’s inbox and takes a stranger’s message, timing each', async () => {
    const relay = network.relay('wss://good.example', { connectDelayMs: 50, eoseDelayMs: 30, okDelayMs: 20 })
    const now = Math.floor(Date.now() / 1000)
    const probe = await probed(pool, 'wss://good.example', 200)
    expect(probe.ok).toBe(true)
    expect(probe.reason).toBeUndefined()
    expect(probe.connectMs).toBeGreaterThanOrEqual(50)
    expect(probe.eoseMs).toBeGreaterThanOrEqual(30)
    expect(probe.okMs).toBeGreaterThanOrEqual(20)

    // What it left: one gift wrap, to nobody anyone knows, dated as NIP-59
    // dates them, and gone within the hour.
    expect(relay.stored).toHaveLength(1)
    const [wrap] = relay.stored
    expect(wrap!.kind).toBe(1059)
    expect(wrap!.created_at).toBeLessThanOrEqual(now)
    expect(wrap!.created_at).toBeGreaterThan(now - 2 * 86_400 - 1)
    const expires = Number(wrap!.tags.find((tag) => tag[0] === 'expiration')?.[1])
    expect(expires).toBeGreaterThanOrEqual(now + 3600)
    expect(expires).toBeLessThanOrEqual(now + 3601)
    expect(wrap!.tags.find((tag) => tag[0] === 'p')?.[1]).toMatch(/^[0-9a-f]{64}$/)
    // Asked for a stranger's inbox, never anyone's real one.
    expect(relay.reqs[0]?.filters[0]).toMatchObject({ kinds: [1059], limit: 1 })
    expect(relay.openConnections).toBe(0)
  })

  it('pays no attention to anything a relay sends for the stranger’s inbox', async () => {
    const relay = network.relay('wss://chatty.example', { eoseDelayMs: 50, okDelayMs: 60 })
    const result = probeRelay(pool, 'wss://chatty.example')
    await advance(10)
    const stranger = (relay.reqs[0]?.filters[0] as { '#p': string[] })['#p'][0]!
    relay.inject(
      finalizeEvent(
        { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', stranger]], content: 'x' },
        generateSecretKey(),
      ),
    )
    await advance(100)
    expect((await result).ok).toBe(true)
  })

  it('passes it whichever answer comes first', async () => {
    network.relay('wss://quick-read.example', { eoseDelayMs: 5, okDelayMs: 40 })
    expect((await probed(pool, 'wss://quick-read.example', 100)).ok).toBe(true)
  })

  it('fails a relay that wants sign-in before it serves an inbox', async () => {
    network.relay('wss://auth.example', {
      refuseReads: 'auth-required: requested filter requires authentication',
    })
    const probe = await probed(pool, 'wss://auth.example', 100)
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('auth-required: requested filter requires authentication')
  })

  it('says so when a relay refuses the inbox query without a word', async () => {
    network.relay('wss://terse.example', { refuseReads: '' })
    expect((await probed(pool, 'wss://terse.example', 100)).reason).toBe('refused the inbox query')
  })

  it('fails a relay that will not take a message from a key it does not know', async () => {
    network.relay('wss://wot.example', {
      rejectWrites: 'blocked: NIP-05 verification needed to publish events',
      okDelayMs: 20,
    })
    const probe = await probed(pool, 'wss://wot.example', 100)
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('blocked: NIP-05 verification needed to publish events')
    expect(probe.eoseMs).toBeDefined()
  })

  it('fails a relay that is not there, once, without retrying', async () => {
    const probe = await probed(pool, 'wss://gone.example', 100)
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('connection failed')
    expect(network.sockets.filter((socket) => socket.url === 'wss://gone.example')).toHaveLength(1)
  })

  it('gives up on a relay that never answers', async () => {
    network.relay('wss://hole.example', { blackhole: true })
    const probe = await probed(pool, 'wss://hole.example', 10_100)
    // The test's own budget runs out first: the connection is part of it.
    expect(probe).toEqual({ url: 'wss://hole.example', ok: false, reason: 'timed out' })
  })

  it('gives up on a relay that connects and then says nothing', async () => {
    network.relay('wss://mute.example', { silent: true })
    const probe = await probed(pool, 'wss://mute.example', 10_100)
    expect(probe.reason).toBe('timed out')
    expect(probe.connectMs).toBeDefined()
  })

  it('fails a relay that hangs up halfway', async () => {
    const relay = network.relay('wss://rude.example', { eoseDelayMs: 500, okDelayMs: 500 })
    const result = probeRelay(pool, 'wss://rude.example')
    await advance(10)
    relay.dropAll()
    await advance(10)
    expect((await result).reason).toBe('connection closed')
  })

  it('tests two at a time, in order, and stops starting new ones once enough have passed', async () => {
    network.relay('wss://a.example', { refuse: true })
    network.relay('wss://b.example', { eoseDelayMs: 10 })
    network.relay('wss://c.example', { eoseDelayMs: 10 })
    network.relay('wss://d.example', { eoseDelayMs: 300 })
    const last = network.relay('wss://e.example')
    const seen: string[] = []
    const result = probeRelays(
      pool,
      ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example', 'wss://e.example'],
      { enough: 2, onProbe: (probe) => seen.push(probe.url) },
    )
    await advance(1000)
    const probes = await result
    expect(probes.filter((probe) => probe.ok).map((probe) => probe.url)).toEqual([
      'wss://b.example',
      'wss://c.example',
      'wss://d.example',
    ])
    expect(seen).toEqual(probes.map((probe) => probe.url))
    expect(last.connectAttempts).toBe(0)
  })

  it('tests every one it is given when not told how many it needs', async () => {
    network.relay('wss://a.example')
    const probes = probeRelays(pool, ['wss://a.example', 'wss://b.example'])
    await advance(100)
    expect(Object.fromEntries((await probes).map((probe) => [probe.url, probe.ok]))).toEqual({
      'wss://a.example': true,
      'wss://b.example': false,
    })
  })
})

describe('ranking what was tested', () => {
  const now = 1_000_000

  it('puts the quickest first and the failures last', () => {
    const ranked = rankProbes(
      [
        { url: 'wss://failed.example', ok: false, reason: 'timed out' },
        { url: 'wss://slow.example', ok: true, connectMs: 900, eoseMs: 2400, okMs: 2600 },
        { url: 'wss://fast.example', ok: true, connectMs: 400, eoseMs: 180, okMs: 210 },
      ],
      now,
    )
    expect(ranked.map((probe) => probe.url)).toEqual([
      'wss://fast.example',
      'wss://slow.example',
      'wss://failed.example',
    ])
  })

  it('gives a relay added on the strength of a test a record to be ranked by', () => {
    const health = healthFromProbe(
      { url: 'wss://x.example', ok: true, connectMs: 400, eoseMs: 180, okMs: 210 },
      now,
    )
    expect(health).toMatchObject({
      connectOk: 1,
      connectMs: 400,
      eoseMs: 180,
      latencyMs: 210,
      publishOk: 1,
      lastOkAt: now,
      connectStreak: 0,
    })
    expect(health.reliability).toBeCloseTo(2 / 3, 6)
    expect(healthFromProbe({ url: 'wss://y.example', ok: true }, now)).toMatchObject({
      connectMs: 0,
      eoseMs: 0,
      latencyMs: 0,
    })
  })
})

describe('finding candidates, and replacing relays that died', () => {
  let network: FakeSocketNetwork
  let pool: RelayPool
  let vault: TestVault
  let host: ScoutHost
  let applied: number
  const NOW = Date.now()
  const contact = (n: number) => getPublicKey(new Uint8Array(32).fill(n))
  const dead = (patch: Partial<RelayHealth> = {}): RelayHealth => ({
    ...emptyHealth(),
    connectStreak: 3,
    connectFail: 9,
    lastOkAt: NOW - DEAD_AFTER_MS - 1,
    lastErrorAt: NOW - 1000,
    ...patch,
  })
  const working = (): RelayHealth => ({ ...emptyHealth(), connectOk: 4, publishOk: 9, lastOkAt: NOW - 1000 })

  beforeEach(async () => {
    vi.useRealTimers()
    network = new FakeSocketNetwork()
    pool = poolOn(network)
    vault = await makeVault('scout')
    applied = 0
    host = {
      repo: vault.repo,
      pool,
      apply: async () => {
        applied += 1
      },
      now: () => NOW,
    }
  })

  afterEach(async () => {
    pool.destroy()
    await vault.destroy()
  })

  it('offers contacts’ relays first, most used first, then Textor’s own, never ones configured or turned down', async () => {
    await vault.repo.upsertRelay('wss://mine.example', {})
    await vault.repo.upsertContact(contact(1), {
      accepted: true,
      relays: ['wss://shared.example', 'wss://mine.example'],
    })
    await vault.repo.upsertContact(contact(2), {
      accepted: true,
      relays: ['wss://shared.example/', 'wss://solo.example'],
    })
    await vault.repo.upsertContact(contact(3), { accepted: true, relays: ['wss://removed.example'] })
    // Someone blocked, or a stranger who wrote first, steers nothing.
    await vault.repo.upsertContact(contact(4), {
      accepted: true,
      blocked: true,
      relays: ['wss://blocked.example'],
    })
    await vault.repo.upsertContact(contact(5), { accepted: false, relays: ['wss://stranger.example'] })
    await declineRelay(vault.repo, 'wss://removed.example')
    await vault.repo.upsertRelay(DEFAULT_DM_RELAYS[0]!, {})

    const found = await findCandidates(host)
    expect(found.slice(0, 2)).toEqual([
      { url: 'wss://shared.example', source: 'contacts', count: 2 },
      { url: 'wss://solo.example', source: 'contacts', count: 1 },
    ])
    const urls = found.map((candidate) => candidate.url)
    for (const skipped of ['mine', 'removed', 'blocked', 'stranger']) {
      expect(urls).not.toContain(`wss://${skipped}.example`)
    }
    expect(urls).not.toContain(DEFAULT_DM_RELAYS[0])
    expect(found.slice(2).map((candidate) => candidate.url)).toEqual([
      ...DEFAULT_DM_RELAYS.slice(1),
      ...CATALOG,
    ])
    expect(found.every((candidate) => candidate.source !== 'monitors')).toBe(true)
  })

  it('keeps a relay a contact uses as theirs, even when Textor ships it too', async () => {
    await vault.repo.upsertContact(contact(1), { accepted: true, relays: [CATALOG[0]!] })
    const found = await findCandidates(host)
    expect(found[0]).toEqual({ url: CATALOG[0], source: 'contacts', count: 1 })
    expect(found.filter((candidate) => candidate.url === CATALOG[0])).toHaveLength(1)
  })

  it('asks monitors only when told to, and only for nominations two of them agree on', async () => {
    const monitor = network.relay('wss://reports.example')
    pool.setRelays(['wss://reports.example'], [])
    const report = (key: Uint8Array, relay: string, needs = ['!auth', '!payment'], network = 'clearnet') =>
      monitor.inject(
        finalizeEvent(
          {
            kind: KIND_RELAY_REPORT,
            created_at: Math.floor(NOW / 1000) - 60,
            tags: [['d', relay], ['n', network], ...needs.map((need) => ['R', need])],
            content: '',
          },
          key,
        ),
      )
    const [m1, m2, m3] = [generateSecretKey(), generateSecretKey(), generateSecretKey()]
    for (const key of [m1!, m2!, m3!]) report(key, 'wss://popular.example/')
    for (const key of [m1!, m2!]) report(key, 'wss://pair.example')
    report(m1!, 'wss://lonely.example')
    // Reported, but asking for payment, or sign-in, or off the open internet.
    for (const key of [m1!, m2!]) report(key, 'wss://paid.example', ['!auth', 'payment'])
    for (const key of [m1!, m2!]) report(key, 'wss://members.example', ['!auth', 'auth'])
    for (const key of [m1!, m2!]) report(key, 'wss://onion.example', ['!auth'], 'tor')
    for (const key of [m1!, m2!])
      monitor.inject(
        finalizeEvent(
          {
            kind: KIND_RELAY_REPORT,
            created_at: Math.floor(NOW / 1000) - 60,
            tags: [['R', '!auth']],
            content: '',
          },
          key,
        ),
      )

    expect(await monitorReports(pool, NOW)).toEqual([
      { url: 'wss://popular.example', count: 3 },
      { url: 'wss://pair.example', count: 2 },
    ])
    expect((await findCandidates(host)).some((candidate) => candidate.source === 'monitors')).toBe(false)
    const asked = await findCandidates(host, { monitors: true })
    expect(asked.slice(-2)).toEqual([
      { url: 'wss://popular.example', source: 'monitors', count: 3 },
      { url: 'wss://pair.example', source: 'monitors', count: 2 },
    ])
    // Only reports of relays open to anyone are asked for, and only so many.
    expect(monitor.reqs.at(-1)?.filters[0]).toMatchObject({
      kinds: [KIND_RELAY_REPORT],
      '#R': ['!auth'],
      limit: 100,
    })
  })

  it('takes a report with no network named as the open internet', async () => {
    const monitor = network.relay('wss://reports.example')
    pool.setRelays(['wss://reports.example'], [])
    for (const key of [generateSecretKey(), generateSecretKey()]) {
      monitor.inject(
        finalizeEvent(
          {
            kind: KIND_RELAY_REPORT,
            created_at: Math.floor(NOW / 1000) - 60,
            tags: [
              ['d', 'wss://plain.example'],
              ['R', '!auth'],
            ],
            content: '',
          },
          key,
        ),
      )
    }
    expect(await monitorReports(pool, NOW)).toEqual([{ url: 'wss://plain.example', count: 2 }])
  })

  it('keeps time by the clock when not given one', async () => {
    const { now: _now, ...clockless } = host
    expect(await findCandidates(clockless, { monitors: true })).toHaveLength(
      DEFAULT_DM_RELAYS.length + CATALOG.length,
    )
    expect(await repairRelays(clockless)).toBeNull()
  })

  it('does nothing while no relay has died', async () => {
    await vault.repo.upsertRelay('wss://a.example', { health: working() })
    await vault.repo.upsertRelay('wss://b.example', { health: dead({ lastOkAt: NOW - 1000 }) })
    expect(await repairRelays(host)).toBeNull()
    expect(applied).toBe(0)
  })

  it('turns a dead relay off, and adds nothing, while enough others work', async () => {
    for (const name of ['a', 'b', 'c', 'd'])
      await vault.repo.upsertRelay(`wss://${name}.example`, { health: working() })
    await vault.repo.upsertRelay('wss://dead.example', { health: dead() })
    const repair = await repairRelays(host)
    expect(repair).toEqual({ at: NOW, off: ['wss://dead.example'], added: [] })
    const entries = await vault.repo.listRelays()
    expect(entries.find((entry) => entry.url === 'wss://dead.example')?.enabled).toBe(false)
    expect(entries.filter((entry) => entry.enabled)).toHaveLength(4)
    expect(applied).toBe(1)
    expect(await repairs(vault.repo)).toEqual([repair])
  })

  it('replaces a dead relay with one two contacts use, tested from here first', async () => {
    const shared = network.relay('wss://shared.example', { connectDelayMs: 5 })
    await vault.repo.upsertRelay('wss://a.example', { health: working() })
    await vault.repo.upsertRelay('wss://dead.example', { health: dead() })
    await vault.repo.upsertContact(contact(1), {
      accepted: true,
      relays: ['wss://shared.example', 'wss://solo.example'],
    })
    await vault.repo.upsertContact(contact(2), { accepted: true, relays: ['wss://shared.example'] })
    network.relay('wss://solo.example')

    const repair = await repairRelays(host)
    expect(repair).toEqual({ at: NOW, off: ['wss://dead.example'], added: ['wss://shared.example'] })
    const added = (await vault.repo.listRelays()).find((entry) => entry.url === 'wss://shared.example')!
    expect(added).toMatchObject({ read: true, write: true, enabled: true, discovered: true })
    expect(added.health.connectOk).toBe(1)
    expect(added.health.connectMs).toBeGreaterThan(0)
    expect(shared.stored).toHaveLength(1)
    // One contact alone cannot steer this inbox onto a relay they might run.
    expect(network.servers.get('wss://solo.example')!.connectAttempts).toBe(0)
  })

  it('falls back on the relays Textor ships with, and judges by what it sees now over what was stored', async () => {
    network.relay(DEFAULT_DM_RELAYS[3]!)
    await vault.repo.upsertRelay('wss://a.example', { health: working() })
    await vault.repo.upsertRelay('wss://looked-fine.example', { health: working() })
    // Fine on record; the pool has watched it fail since.
    pool.seedHealth([{ url: 'wss://looked-fine.example', health: dead() }])
    const repair = await repairRelays(host)
    expect(repair?.off).toEqual(['wss://looked-fine.example'])
    expect(repair?.added).toEqual([DEFAULT_DM_RELAYS[3]])
  })

  it('replaces a relay that keeps refusing the inbox', async () => {
    await vault.repo.upsertRelay('wss://a.example', { health: working() })
    await vault.repo.upsertRelay('wss://auth.example', {
      health: { ...working(), readFail: 2, readFailAt: NOW - 60_000 },
    })
    const repair = await repairRelays(host)
    expect(repair?.off).toEqual(['wss://auth.example'])
  })

  it('turns nothing off when nothing works and nothing better can be found', async () => {
    await vault.repo.upsertRelay('wss://dead.example', { health: dead() })
    await vault.repo.upsertRelay('wss://write-only.example', { read: false, health: working() })
    expect(await repairRelays(host)).toBeNull()
    expect((await vault.repo.listRelays()).every((entry) => entry.enabled)).toBe(true)
    expect(applied).toBe(0)
  })

  it('never adds more than the person chose to read from', async () => {
    network.relay(DEFAULT_DM_RELAYS[3]!)
    await vault.repo.upsertRelay('wss://dead.example', { health: dead() })
    await vault.repo.upsertRelay('wss://a.example', { read: false, health: working() })
    const repair = await repairRelays(host)
    expect(repair?.added).toEqual([DEFAULT_DM_RELAYS[3]])
    expect((await vault.repo.listRelays()).filter((entry) => entry.enabled && entry.read)).toHaveLength(1)
  })

  it('keeps the last eight repairs, newest first, until dismissed', async () => {
    for (let i = 0; i < 9; i++) {
      await vault.repo.upsertRelay('wss://a.example', { health: working() })
      await vault.repo.upsertRelay(`wss://dead-${i}.example`, { health: dead() })
      host.now = () => NOW + i
      await repairRelays(host)
    }
    const log = await repairs(vault.repo)
    expect(log).toHaveLength(8)
    expect(log[0]?.off).toEqual(['wss://dead-8.example'])
    await clearRepairs(vault.repo)
    expect(await repairs(vault.repo)).toEqual([])
  })

  it('remembers a relay turned down once, and only so many', async () => {
    await declineRelay(vault.repo, 'wss://x.example')
    await declineRelay(vault.repo, 'wss://x.example')
    for (let i = 0; i < 70; i++) await declineRelay(vault.repo, `wss://r${i}.example`)
    const declined = await vault.repo.getState<string[]>('relay-declined')
    expect(declined).toHaveLength(64)
    expect(declined?.[0]).toBe('wss://r69.example')
    expect(declined).not.toContain('wss://x.example')
  })
})
