import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadTurnHealth,
  mintCredential,
  MINTED_TTL_SEC,
  outcomesFor,
  rankTurn,
  recordRelayUse,
  recordTurn,
  serverKey,
  throttled,
  TURN_HEALTH,
  turnKey,
  turnRetryAt,
  turnScore,
  withCredentials,
  type TurnHealth,
  type TurnHealthMap,
} from '@/core/calls/turn'

/**
 * Choosing TURN servers (ADR-068): how a server is recognised however it is
 * written, what calls learn about it, how servers are ranked and rested, and
 * the passwords made from a shared secret.
 */

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const health = (patch: Partial<TurnHealth> = {}): TurnHealth => ({
  ok: 0,
  fail: 0,
  streak: 0,
  allocMs: 0,
  rttMs: 0,
  kbps: 0,
  error: 0,
  lastOkAt: 0,
  lastFailAt: 0,
  ...patch,
})

afterEach(() => vi.unstubAllGlobals())

describe('recognising a server', () => {
  it('spells out the default port and transport, as the browser reports them', () => {
    expect(turnKey('turn:Turn.Example.org')).toBe('turn:turn.example.org:3478?transport=udp')
    expect(turnKey('turns:turn.example.org')).toBe('turns:turn.example.org:5349?transport=tcp')
    expect(turnKey(' turn:turn.example.org:80?transport=tcp ')).toBe('turn:turn.example.org:80?transport=tcp')
    expect(turnKey('TURN:[2001:db8::1]:3478')).toBe('turn:[2001:db8::1]:3478?transport=udp')
    expect(turnKey('turn:turn.example.org:3478?transport=udp')).toBe(turnKey('turn:turn.example.org'))
  })

  it('leaves anything that is not a TURN address as written, in lower case', () => {
    expect(turnKey(' STUN:stun.example.org ')).toBe('stun:stun.example.org')
  })

  it('keys an entry by the address it names', () => {
    expect(serverKey({ urls: 'turn:a.example' })).toBe('turn:a.example:3478?transport=udp')
    expect(serverKey({ urls: ['turns:b.example:443?transport=tcp'] })).toBe(
      'turns:b.example:443?transport=tcp',
    )
    expect(serverKey({ urls: [] })).toBe('')
  })
})

describe('what calls learn', () => {
  it('counts relays, with a rolling time to each, and failures with their reason', () => {
    const map: TurnHealthMap = {}
    recordTurn(map, { url: 'turn:a.example', ms: 200 }, NOW)
    recordTurn(map, { url: 'turn:a.example:3478?transport=udp', ms: 100 }, NOW + 1)
    expect(map['turn:a.example:3478?transport=udp']).toMatchObject({ ok: 2, allocMs: 170, lastOkAt: NOW + 1 })

    recordTurn(map, { url: 'turn:a.example', error: 401 }, NOW + 2)
    recordTurn(map, { url: 'turn:a.example', error: 0 }, NOW + 3)
    expect(map['turn:a.example:3478?transport=udp']).toMatchObject({
      ok: 2,
      fail: 2,
      streak: 2,
      error: 0,
      lastFailAt: NOW + 3,
    })
    recordTurn(map, { url: 'turn:a.example', ms: 300 }, NOW + 4)
    expect(map['turn:a.example:3478?transport=udp']?.streak).toBe(0)
  })

  it('keeps the round trip and bandwidth a call measured through a relay, when it measured them', () => {
    const map: TurnHealthMap = {}
    recordRelayUse(map, { url: 'turn:a.example', rttMs: 0, kbps: 0 })
    expect(map['turn:a.example:3478?transport=udp']).toMatchObject({ rttMs: 0, kbps: 0 })
    recordRelayUse(map, { url: 'turn:a.example', rttMs: 100, kbps: 1000 })
    recordRelayUse(map, { url: 'turn:a.example', rttMs: 200, kbps: 0 })
    expect(map['turn:a.example:3478?transport=udp']).toMatchObject({ rttMs: 130, kbps: 1000 })
  })

  it('judges a server it heard nothing from only once it has had time to answer', () => {
    const servers = [{ urls: 'stun:s.example' }, { urls: 'turn:a.example' }, { urls: 'turn:b.example' }]
    const reported = [{ url: 'turn:a.example:3478?transport=udp', ms: 90 }]
    expect(outcomesFor(servers, reported, false)).toEqual(reported)
    expect(outcomesFor(servers, reported, true)).toEqual([
      ...reported,
      { url: 'turn:b.example:3478?transport=udp', error: 0 },
    ])
  })
})

describe('ranking and resting', () => {
  it('rests a server after two failures in a row, ten minutes doubling to a day', () => {
    expect(turnRetryAt(undefined)).toBe(0)
    expect(turnRetryAt(health({ streak: 1, lastFailAt: NOW }))).toBe(0)
    expect(turnRetryAt(health({ streak: 2, lastFailAt: NOW }))).toBe(NOW + 10 * MINUTE)
    expect(turnRetryAt(health({ streak: 4, lastFailAt: NOW }))).toBe(NOW + 40 * MINUTE)
    expect(turnRetryAt(health({ streak: 40, lastFailAt: NOW }))).toBe(NOW + 24 * 60 * MINUTE)
  })

  it('scores reliable, quick servers first, and halves one too narrow for video', () => {
    const unknown = turnScore(undefined)
    const quick = turnScore(health({ ok: 5, allocMs: 100 }))
    const slow = turnScore(health({ ok: 5, allocMs: 2000 }))
    const unmeasured = turnScore(health({ ok: 5 }))
    const failing = turnScore(health({ ok: 1, fail: 5, allocMs: 100 }))
    expect(quick).toBeGreaterThan(unmeasured)
    expect(unmeasured).toBeGreaterThan(slow)
    expect(unknown).toBeGreaterThan(failing)
    expect(quick).toBeGreaterThan(unknown)
    // On a call, the round trip outranks how fast the relay was handed out.
    expect(turnScore(health({ ok: 5, allocMs: 100, rttMs: 900 }))).toBeLessThan(quick)
    const narrow = health({ ok: 5, allocMs: 100, kbps: 120 })
    expect(throttled(narrow)).toBe(true)
    expect(throttled(health({ kbps: 0 }))).toBe(false)
    expect(turnScore(narrow)).toBeCloseTo(quick / 2)
  })

  it('offers TURN servers only, best first, leaving out those resting', () => {
    const stun = { urls: 'stun:s.example' }
    const a = { urls: 'turn:a.example' }
    const b = { urls: 'turn:b.example' }
    const c = { urls: 'turn:c.example' }
    const map: TurnHealthMap = {
      [serverKey(b)]: health({ ok: 9, allocMs: 50 }),
      [serverKey(c)]: health({ fail: 3, streak: 3, lastFailAt: NOW - MINUTE }),
    }
    expect(rankTurn([stun, a, b, c], map, NOW)).toEqual([b, a])
    // Once its rest is over, it is asked again — last.
    expect(rankTurn([stun, a, b, c], map, NOW + 60 * MINUTE)).toEqual([b, a, c])
  })

  it('asks every server when all of them are resting, since a failing call has nothing else', () => {
    const a = { urls: 'turn:a.example' }
    const b = { urls: 'turn:b.example' }
    const map: TurnHealthMap = {
      [serverKey(a)]: health({ fail: 2, streak: 2, lastFailAt: NOW }),
      [serverKey(b)]: health({ ok: 1, fail: 2, streak: 2, lastFailAt: NOW }),
    }
    expect(rankTurn([a, b], map, NOW)).toEqual([b, a])
  })
})

describe('credentials from a shared secret', () => {
  const hmac = (secret: string, text: string) => createHmac('sha1', secret).update(text).digest('base64')

  it('makes coturn’s REST-scheme password: an expiry for a username, its HMAC-SHA1 for a password', async () => {
    const minted = await mintCredential('s3cret', '', NOW)
    const expiry = Math.floor(NOW / 1000) + MINTED_TTL_SEC
    expect(minted).toEqual({ username: String(expiry), credential: hmac('s3cret', String(expiry)) })
    const named = await mintCredential('s3cret', 'alice', NOW)
    expect(named).toEqual({ username: `${expiry}:alice`, credential: hmac('s3cret', `${expiry}:alice`) })
  })

  it('hands passwords through, and puts a made one in place of the secret', async () => {
    const password = { urls: 'turn:a.example', username: 'u', credential: 'p' }
    const secret = { urls: 'turns:b.example', credential: 'k', secret: true as const }
    const [first, second] = await withCredentials([password, secret], NOW)
    expect(first).toEqual(password)
    expect(second).toEqual({ urls: 'turns:b.example', ...(await mintCredential('k', '', NOW)) })
    expect(second).not.toHaveProperty('secret')
  })

  it('leaves out a server whose password cannot be made, rather than offer one sure to fail', async () => {
    vi.stubGlobal('crypto', { subtle: { importKey: () => Promise.reject(new Error('insecure context')) } })
    const password = { urls: 'turn:a.example', username: 'u', credential: 'p' }
    const servers = await withCredentials([password, { urls: 'turn:b.example', secret: true }], NOW)
    expect(servers).toEqual([password])
  })
})

describe('where it is kept', () => {
  it('reads the map back from the vault, and starts afresh from nothing or from an error', async () => {
    const map: TurnHealthMap = { 'turn:a.example:3478?transport=udp': health({ ok: 1 }) }
    const names: string[] = []
    const store = (value: unknown) => ({
      getState: async <T>(name: string) => (names.push(name), value as T),
      putState: async () => undefined,
    })
    expect(await loadTurnHealth(store(map))).toEqual(map)
    expect(names).toEqual([TURN_HEALTH])
    expect(await loadTurnHealth(store(null))).toEqual({})
    const broken = {
      getState: () => Promise.reject(new Error('locked')),
      putState: async () => undefined,
    }
    expect(await loadTurnHealth(broken)).toEqual({})
  })
})
