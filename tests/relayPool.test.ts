import { describe, expect, it } from 'vitest'
import { RelayPool } from '@/core/transport/relayPool'
import { emptyHealth } from '@/core/models/types'
import { verdictFor } from '@/core/transport/relayHealth'

describe('relay pool configuration', () => {
  it('normalises and dedupes the configured set', () => {
    const pool = new RelayPool()
    pool.setRelays(['nos.lol', 'wss://nos.lol/', 'WSS://NOS.LOL'], ['wss://relay.example'])
    expect(pool.readRelays).toEqual(['wss://nos.lol'])
    expect(pool.writeRelays).toEqual(['wss://relay.example'])
    pool.destroy()
  })

  it('drops entries that are not valid relay URLs', () => {
    const pool = new RelayPool()
    pool.setRelays(['http://nope.example', 'javascript:alert(1)', 'wss://ok.example'], [])
    expect(pool.readRelays).toEqual(['wss://ok.example'])
    pool.destroy()
  })

  it('ranks proven relays above failing ones', () => {
    const pool = new RelayPool()
    pool.setRelays([], ['wss://good.example', 'wss://bad.example', 'wss://unknown.example'])
    pool.seedHealth([
      { url: 'wss://good.example', health: { ...emptyHealth(), publishOk: 20, latencyMs: 120 } },
      { url: 'wss://bad.example', health: { ...emptyHealth(), publishOk: 1, publishFail: 30 } },
    ])

    const ranked = pool.rankedWriteRelays()
    expect(ranked[0]).toBe('wss://good.example')
    // An untried relay sits mid-pack so it still gets a chance to prove itself.
    expect(ranked.indexOf('wss://unknown.example')).toBeLessThan(ranked.indexOf('wss://bad.example'))
    pool.destroy()
  })

  it('penalises a slow relay against a fast one with the same success rate', () => {
    const pool = new RelayPool()
    pool.setRelays([], ['wss://fast.example', 'wss://slow.example'])
    pool.seedHealth([
      { url: 'wss://fast.example', health: { ...emptyHealth(), publishOk: 10, latencyMs: 80 } },
      { url: 'wss://slow.example', health: { ...emptyHealth(), publishOk: 10, latencyMs: 9000 } },
    ])
    expect(pool.rankedWriteRelays()[0]).toBe('wss://fast.example')
    pool.destroy()
  })

  it('reports no relays as no coverage rather than throwing', async () => {
    const pool = new RelayPool()
    pool.setRelays([], [])
    expect(await pool.query({ kinds: [1059] })).toEqual([])
    expect(pool.onlineCount).toBe(0)
    pool.destroy()
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

    const pool = new RelayPool()
    pool.setRelays(['wss://legacy.example'], ['wss://legacy.example'])
    pool.seedHealth([{ url: 'wss://legacy.example', health: legacy }])

    const seeded = pool.statuses()[0]
    expect(seeded?.health.readFail).toBe(0)
    expect(Number.isNaN(seeded?.health.readFail as number)).toBe(false)
    // And the preserved counters survive the merge.
    expect(seeded?.health.publishOk).toBe(12)
    pool.destroy()
  })
})
