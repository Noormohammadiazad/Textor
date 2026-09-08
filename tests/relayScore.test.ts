import { describe, expect, it } from 'vitest'
import { emptyHealth, type RelayHealth } from '@/core/models/types'
import {
  CIRCUIT_THRESHOLD,
  circuitState,
  quorumFor,
  recordPublish,
  relayScore,
  seededReliability,
} from '@/core/transport/relayScore'

const health = (patch: Partial<RelayHealth> = {}): RelayHealth => ({ ...emptyHealth(), ...patch })

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
