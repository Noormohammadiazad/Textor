import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  createInvite,
  decodeInvite,
  extractInvitePayload,
  InviteError,
  inviteLink,
  isInviteStale,
} from '@/core/identity/invite'
import { b64urlToBytes, bytesToB64url } from '@/core/util/bytes'
import { nowSec } from '@/core/util/time'

const sk = generateSecretKey()
const pk = getPublicKey(sk)

describe('invite codec', () => {
  it('round-trips a full invite', () => {
    const encoded = createInvite(sk, { name: 'Sara', relays: ['wss://relay.damus.io', 'wss://nos.lol'] })
    const invite = decodeInvite(encoded)

    expect(invite.pubkey).toBe(pk)
    expect(invite.name).toBe('Sara')
    expect(invite.relays).toEqual(['wss://relay.damus.io', 'wss://nos.lol'])
    expect(Math.abs(invite.createdAt - nowSec())).toBeLessThan(5)
  })

  it('round-trips non-Latin names', () => {
    const encoded = createInvite(sk, { name: 'سارا احمدی', relays: [] })
    expect(decodeInvite(encoded).name).toBe('سارا احمدی')
  })

  it('handles an empty name and no relays', () => {
    const invite = decodeInvite(createInvite(sk, { name: '', relays: [] }))
    expect(invite.name).toBe('')
    expect(invite.relays).toEqual([])
  })

  it('stays small enough to scan as a QR code', () => {
    const encoded = createInvite(sk, {
      name: 'A reasonably long display name',
      relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
    })
    // Below QR version-10 alphanumeric capacity at error level M, which scans
    // reliably at arm's length on a phone.
    expect(encoded.length).toBeLessThan(400)
  })

  it('normalises and deduplicates relay URLs', () => {
    const invite = decodeInvite(
      createInvite(sk, { name: 'x', relays: ['relay.damus.io/', 'wss://relay.damus.io', 'not a url'] }),
    )
    expect(invite.relays).toEqual(['wss://relay.damus.io'])
  })

  it('caps the relay list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `wss://relay${i}.example.com`)
    expect(decodeInvite(createInvite(sk, { name: 'x', relays: many })).relays.length).toBeLessThanOrEqual(6)
  })

  it('truncates an over-long name instead of failing', () => {
    const invite = decodeInvite(createInvite(sk, { name: 'x'.repeat(500), relays: [] }))
    expect(invite.name.length).toBeGreaterThan(0)
    expect(invite.name.length).toBeLessThanOrEqual(96)
  })
})

describe('invite tampering', () => {
  const encoded = createInvite(sk, { name: 'Sara', relays: ['wss://relay.damus.io'] })

  it('rejects a flipped bit in the body', () => {
    const raw = b64urlToBytes(encoded)
    raw[10] = (raw[10] as number) ^ 0x01
    expect(() => decodeInvite(bytesToB64url(raw))).toThrow(InviteError)
  })

  it('rejects a substituted relay hint', () => {
    // The attack this defends against: forwarding a genuine invite with the
    // relays swapped, so messages go somewhere the recipient never reads.
    const attacker = createInvite(generateSecretKey(), { name: 'Sara', relays: ['wss://evil.example'] })
    const genuine = b64urlToBytes(encoded)
    const forged = b64urlToBytes(attacker)
    // Splice the genuine pubkey into the attacker's body; the signature no
    // longer matches the body it covers.
    forged.set(genuine.subarray(1, 33), 1)
    expect(() => decodeInvite(bytesToB64url(forged))).toThrow(/signature/)
  })

  it('rejects a truncated payload', () => {
    expect(() => decodeInvite(encoded.slice(0, 40))).toThrow(InviteError)
  })

  it('rejects trailing junk', () => {
    const raw = b64urlToBytes(encoded)
    const padded = new Uint8Array(raw.length + 3)
    padded.set(raw.subarray(0, raw.length - 64))
    padded.set(raw.subarray(raw.length - 64), raw.length - 64 + 3)
    expect(() => decodeInvite(bytesToB64url(padded))).toThrow(InviteError)
  })

  it('rejects an unknown version byte', () => {
    const raw = b64urlToBytes(encoded)
    raw[0] = 9
    expect(() => decodeInvite(bytesToB64url(raw))).toThrow(/version/)
  })

  it('rejects non-base64url input', () => {
    expect(() => decodeInvite('!!! not base64 !!!')).toThrow(InviteError)
  })
})

describe('invite links', () => {
  it('puts the payload in the fragment so it never reaches a web server', () => {
    const encoded = createInvite(sk, { name: 'Sara', relays: [] })
    const link = inviteLink(encoded, 'https://textor.ir/')
    expect(link).toBe(`https://textor.ir/#/i/${encoded}`)
    expect(new URL(link).search).toBe('')
  })

  it('extracts a payload from a full link, a fragment, or a bare payload', () => {
    const encoded = createInvite(sk, { name: 'Sara', relays: ['wss://nos.lol'] })
    expect(extractInvitePayload(`https://textor.ir/#/i/${encoded}`)).toBe(encoded)
    expect(extractInvitePayload(`#/i/${encoded}`)).toBe(encoded)
    expect(extractInvitePayload(encoded)).toBe(encoded)
    expect(extractInvitePayload('hello there')).toBeNull()
  })

  it('flags invites old enough that their relay hints are suspect', () => {
    const fresh = decodeInvite(createInvite(sk, { name: 'x', relays: [] }))
    expect(isInviteStale(fresh)).toBe(false)
    expect(isInviteStale(fresh, nowSec() + 200 * 24 * 60 * 60)).toBe(true)
  })
})
