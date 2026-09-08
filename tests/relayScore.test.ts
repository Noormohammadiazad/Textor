import { describe, expect, it } from 'vitest'
import { planAnnouncement } from '@/core/engine/deviceSync'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import {
  chooseRelays,
  CIRCUIT_THRESHOLD,
  circuitState,
  DEAD_AFTER_MS,
  DOWN_AFTER,
  FANOUT,
  isDead,
  isLargeEvent,
  isSizeRefusal,
  quorumFor,
  READ_RETRY_MS,
  recordConnect,
  recordDrop,
  recordEose,
  recordPublish,
  refusesLarge,
  relayScore,
  seededReliability,
  signedOutcomes,
  trialAt,
  usable,
} from '@/core/transport/relayScore'

const health = (patch: Partial<RelayHealth> = {}): RelayHealth => ({ ...emptyHealth(), ...patch })

describe('what a relay will carry (ADR-073)', () => {
  it('tells a large event from a short message', () => {
    expect(isLargeEvent({ content: 'x'.repeat(6 * 1024) })).toBe(false)
    expect(isLargeEvent({ content: 'x'.repeat(6 * 1024 + 1) })).toBe(true)
  })

  it('reads refusals about size or signer as such, and others as a relay failing', () => {
    for (const reason of [
      'invalid: event too large: 66025',
      'blocked: Policy violated and pubkey is not in our web of trust.',
      'message too big',
      'exceeds max size',
      'blocked: spam not permitted',
      'rate-limited: slow down',
    ]) {
      expect(isSizeRefusal(reason)).toBe(true)
    }
    expect(isSizeRefusal('error: disk full')).toBe(false)
    expect(isSizeRefusal('no answer')).toBe(false)
  })

  it('asks again only of relays that did not answer, or refused for some other reason', () => {
    expect(
      signedOutcomes([
        { url: 'wss://took.example', ok: true },
        { url: 'wss://big.example', ok: false, error: 'invalid: event too large: 66025' },
        { url: 'wss://down.example', ok: false, error: 'no answer' },
      ]),
    ).toEqual(['wss://down.example'])
  })

  it('remembers a refusal for six hours', () => {
    expect(refusesLarge(emptyHealth(), 1000)).toBe(false)
    const health = { ...emptyHealth(), largeRefusedAt: 1000 }
    expect(refusesLarge(health, 1000 + 5 * 60 * 60_000)).toBe(true)
    expect(refusesLarge(health, 1000 + 6 * 60 * 60_000)).toBe(false)
  })
})

describe('what to announce as the inbox (ADR-073)', () => {
  const all = () => true

  it('announces what this device reads when nothing is announced', () => {
    expect(planAnnouncement(['a', 'b'], [], all, 6)).toEqual(['a', 'b'])
  })

  it('changes nothing when this device reads a part of what is announced', () => {
    expect(planAnnouncement(['a', 'b'], ['c', 'b', 'a'], all, 6)).toBeNull()
  })

  it('adds what this device reads, its own first, and keeps what another device may read', () => {
    expect(planAnnouncement(['a', 'd'], ['a', 'b', 'c'], all, 6)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('drops what this device has evidence cannot be used', () => {
    expect(planAnnouncement(['a'], ['a', 'dead'], (url) => url !== 'dead', 6)).toEqual(['a'])
  })

  it('stays within the cap', () => {
    expect(planAnnouncement(['x', 'y'], ['a', 'b', 'c', 'd', 'e'], all, 4)).toEqual(['x', 'y', 'a', 'b'])
  })
})

describe('relay reliability', () => {
  it('drops a long-trusted relay quickly once it starts failing', () => {
    // The purplerelay case, measured live: hundreds of good publishes, then a
    // full disk and every write refused. Lifetime counters still read 98%.
    const relay = health({
      publishOk: 200,
      reliability: seededReliability({ publishOk: 200, publishFail: 0 }),
    })
    for (let i = 0; i < 5; i++) recordPublish(relay, { ok: false }, 1000 + i)
    expect(relay.publishOk / (relay.publishOk + relay.publishFail)).toBeGreaterThan(0.97)
    expect(relay.reliability).toBeLessThan(0.25)
  })

  it('recovers just as quickly once the relay works again', () => {
    const relay = health({ reliability: 0.05 })
    for (let i = 0; i < 6; i++) recordPublish(relay, { ok: true, ms: 300 }, 1000 + i)
    expect(relay.reliability).toBeGreaterThan(0.8)
  })

  it('seeds a sensible starting point for health written before the field existed', () => {
    expect(seededReliability({ publishOk: 0, publishFail: 0 })).toBe(0.5)
    expect(seededReliability({ publishOk: 98, publishFail: 0 })).toBeGreaterThan(0.95)
    expect(seededReliability({ publishOk: 0, publishFail: 30 })).toBeLessThan(0.05)
  })
})

describe('circuit breaker', () => {
  it('stays closed through isolated failures', () => {
    const relay = health()
    recordPublish(relay, { ok: false }, 0)
    recordPublish(relay, { ok: false }, 1)
    expect(circuitState(relay, 2)).toBe('closed')
    recordPublish(relay, { ok: true, ms: 200 }, 3)
    expect(relay.failStreak).toBe(0)
  })

  it('opens after consecutive failures, then allows a trial after the cooldown', () => {
    const relay = health()
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) recordPublish(relay, { ok: false }, 10_000)
    expect(circuitState(relay, 10_000)).toBe('open')
    expect(circuitState(relay, 10_000 + 14_999)).toBe('open')
    expect(circuitState(relay, 10_000 + 15_000)).toBe('half-open')
  })

  it('doubles the cooldown with every further failure, up to five minutes', () => {
    const relay = health()
    for (let i = 0; i < CIRCUIT_THRESHOLD + 2; i++) recordPublish(relay, { ok: false }, 0)
    expect(circuitState(relay, 59_999)).toBe('open')
    expect(circuitState(relay, 60_000)).toBe('half-open')

    for (let i = 0; i < 20; i++) recordPublish(relay, { ok: false }, 0)
    expect(circuitState(relay, 5 * 60_000 - 1)).toBe('open')
    expect(circuitState(relay, 5 * 60_000)).toBe('half-open')
  })
})

describe('relay scoring', () => {
  const now = 1_000_000

  it('lets reliability dominate latency', () => {
    const fastButLossy = health({ reliability: 0.6, latencyMs: 150 })
    const slowButSolid = health({ reliability: 0.98, latencyMs: 1200 })
    expect(relayScore(slowButSolid, { open: false, now })).toBeGreaterThan(
      relayScore(fastButLossy, { open: false, now }),
    )
  })

  it('prefers an open socket, because it skips a handshake', () => {
    const relay = health({ reliability: 0.9, latencyMs: 400 })
    expect(relayScore(relay, { open: true, now })).toBeGreaterThan(relayScore(relay, { open: false, now }))
  })

  it('sinks a relay with an open circuit below an unproven one', () => {
    const failing = health({ reliability: 0.9, latencyMs: 200, failStreak: 4, lastErrorAt: now })
    const unproven = health()
    expect(relayScore(unproven, { open: false, now })).toBeGreaterThan(
      relayScore(failing, { open: false, now }),
    )
  })
})

describe('quorum size', () => {
  it('asks two independent relays when there are enough to ask', () => {
    expect(quorumFor(10)).toBe(2)
    expect(quorumFor(4)).toBe(2)
  })

  it('asks one when two would mean waiting on the slowest', () => {
    expect(quorumFor(3)).toBe(1)
    expect(quorumFor(1)).toBe(1)
    expect(quorumFor(0)).toBe(0)
  })
})

describe('what a publish without a timing teaches', () => {
  it('counts the success and leaves the latency alone', () => {
    const relay = health({ latencyMs: 300 })
    recordPublish(relay, { ok: true }, 5)
    expect(relay.publishOk).toBe(1)
    expect(relay.latencyMs).toBe(300)
    expect(relay.lastOkAt).toBe(5)
  })

  it('scores a relay on trial at half', () => {
    const relay = health({ reliability: 1, latencyMs: 1500, failStreak: CIRCUIT_THRESHOLD, lastErrorAt: 0 })
    expect(circuitState(relay, 60_000)).toBe('half-open')
    expect(relayScore(relay, { open: false, now: 60_000 })).toBeCloseTo(0.25, 6)
  })
})

describe('connection telemetry (ADR-067)', () => {
  it('clears the streak of failed connections on the first that opens', () => {
    const relay = health({ connectStreak: 5 })
    recordConnect(relay, 800, 10)
    expect(relay.connectStreak).toBe(0)
    expect(relay.connectMs).toBe(800)
  })

  it('counts every drop, and as churn only those that die young', () => {
    const relay = health()
    recordDrop(relay, 30_000)
    recordDrop(relay, 30_000)
    expect(relay.drops).toBe(2)
    expect(relay.churn).toBeCloseTo(0.4375, 6)
    const steady = health()
    recordDrop(steady, 60 * 60_000)
    expect(steady.drops).toBe(1)
    expect(steady.churn).toBe(0)
    // A long, healthy connection lost at last brings churn back down.
    recordDrop(relay, 60 * 60_000)
    expect(relay.churn).toBeCloseTo(0.328125, 6)
  })

  it('times the inbox, and takes an answer as the end of any refusal', () => {
    const relay = health({ readFail: 3, readFailAt: 99 })
    recordEose(relay, 400)
    recordEose(relay, 200)
    expect(relay.eoseMs).toBe(340)
    expect(relay.readFail).toBe(0)
  })

  it('reads with the inbox latency where it has been measured, and halves a relay that sheds connections', () => {
    const now = 0
    const relay = health({ reliability: 1, latencyMs: 1500, eoseMs: 0 })
    expect(relayScore(relay, { open: false, now, read: true })).toBeCloseTo(0.5, 6)
    relay.eoseMs = 300
    expect(relayScore(relay, { open: false, now, read: true })).toBeCloseTo(1 / 1.2, 6)
    // Writing still goes by the publish latency.
    expect(relayScore(relay, { open: false, now })).toBeCloseTo(0.5, 6)
    relay.churn = 1
    expect(relayScore(relay, { open: false, now })).toBeCloseTo(0.25, 6)
  })
})

describe('when a relay can be leaned on (ADR-067)', () => {
  const now = 10 * 24 * 60 * 60_000

  it('is down after two failed connections in a row, and tried again after a wait that doubles to an hour', () => {
    expect(trialAt(health({ connectStreak: DOWN_AFTER - 1, lastErrorAt: now }))).toBe(0)
    expect(trialAt(health({ connectStreak: DOWN_AFTER, lastErrorAt: now }))).toBe(now + 30_000)
    expect(trialAt(health({ connectStreak: DOWN_AFTER + 1, lastErrorAt: now }))).toBe(now + 60_000)
    expect(trialAt(health({ connectStreak: DOWN_AFTER + 7, lastErrorAt: now }))).toBe(now + 60 * 60_000)
    expect(trialAt(health({ connectStreak: 400, lastErrorAt: now }))).toBe(now + 60 * 60_000)
  })

  it('is usable unless down, lately refusing the inbox, or — for writing — failing publishes', () => {
    expect(usable(health(), now)).toBe(true)
    expect(usable(health({ connectStreak: DOWN_AFTER }), now)).toBe(false)
    expect(usable(health({ readFail: 1, readFailAt: now - 1 }), now)).toBe(false)
    // Policies change: a refusal is asked about again after six hours.
    expect(usable(health({ readFail: 1, readFailAt: now - READ_RETRY_MS }), now)).toBe(true)
    const failing = health({ failStreak: CIRCUIT_THRESHOLD, lastErrorAt: now })
    expect(usable(failing, now)).toBe(true)
    expect(usable(failing, now, true)).toBe(false)
  })

  it('is dead only on evidence: days unreachable over several tries, or refusing the inbox again and again', () => {
    const unreachable = health({ connectStreak: DOWN_AFTER, connectFail: 6, lastOkAt: now - DEAD_AFTER_MS })
    expect(isDead(unreachable, now)).toBe(true)
    // Worked yesterday: down, not dead.
    expect(isDead({ ...unreachable, lastOkAt: now - DEAD_AFTER_MS + 1 }, now)).toBe(false)
    // Too few tries to say.
    expect(isDead({ ...unreachable, connectFail: 5 }, now)).toBe(false)
    // A relay standing by that nobody has needed for a week is not dead.
    expect(isDead(health({ lastOkAt: now - 7 * DEAD_AFTER_MS }), now)).toBe(false)
    expect(isDead(health({ readFail: 2, readFailAt: now - 1 }), now)).toBe(true)
    expect(isDead(health({ readFail: 1, readFailAt: now - 1 }), now)).toBe(false)
    // Refusals older than a retry say nothing about today.
    expect(isDead(health({ readFail: 5, readFailAt: now - READ_RETRY_MS }), now)).toBe(false)
  })
})

describe('choosing the relays in use (ADR-067)', () => {
  const urls = ['a', 'b', 'c', 'd', 'e', 'f']
  const scores: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }
  const score = (url: string) => scores[url]!
  const all = () => true

  it('takes the best four of six', () => {
    expect(FANOUT).toBe(4)
    expect(chooseRelays(urls, [], score, all)).toEqual(['f', 'e', 'd', 'c'])
  })

  it('keeps relays in use while they work, rather than chasing a better score', () => {
    expect(chooseRelays(urls, ['a', 'b'], score, all)).toEqual(['a', 'b', 'f', 'e'])
  })

  it('replaces a relay that stopped working with the best of the rest', () => {
    const working = (url: string) => url !== 'e'
    expect(chooseRelays(urls, ['f', 'e', 'd', 'c'], score, working)).toEqual(['f', 'd', 'c', 'b'])
  })

  it('forgets relays no longer configured', () => {
    expect(chooseRelays(['a', 'b'], ['f', 'a'], score, all)).toEqual(['a', 'b'])
  })

  it('tries the best anyway when none works, since something must be tried', () => {
    expect(chooseRelays(urls, ['a'], score, () => false)).toEqual(['f', 'e', 'd', 'c'])
    expect(chooseRelays([], [], score, all)).toEqual([])
  })
})
