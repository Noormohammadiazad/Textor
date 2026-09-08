import { describe, expect, it } from 'vitest'
import {
  encodeControlFrame,
  MAX_RECEIPT_REFS,
  parseControlFrame,
  preciseTimestamp,
  PROTOCOL_VERSION,
  recipientFromTags,
  replyToFromTags,
  timestampTag,
  attachmentTag,
  attachmentFromTags,
  ATTACHMENT_TAG,
} from '@/core/models/protocol'
import { normalizeRelayList, normalizeRelayUrl, relayLabel } from '@/core/transport/relayUrl'
import { safetyNumber } from '@/core/crypto/safetyNumber'

const hex = (c: string) => c.repeat(64)

describe('control frame parsing', () => {
  it('round-trips every frame type', () => {
    const frames = [
      { v: PROTOCOL_VERSION, t: 'receipt' as const, refs: [hex('a')], state: 'read' as const },
      { v: PROTOCOL_VERSION, t: 'typing' as const, active: true },
      { v: PROTOCOL_VERSION, t: 'presence' as const, online: true, expires: 123 },
      { v: PROTOCOL_VERSION, t: 'rtc' as const, sid: 'abc', kind: 'offer' as const, sdp: 'v=0' },
      { v: PROTOCOL_VERSION, t: 'profile' as const, name: 'Sara', relays: ['wss://nos.lol'] },
    ]
    for (const frame of frames) {
      expect(parseControlFrame(encodeControlFrame(frame))).toEqual(frame)
    }
  })

  it('rejects an unknown protocol version, rather than guessing', () => {
    // This is what lets a future v2 ship without old clients misreading it.
    expect(parseControlFrame(JSON.stringify({ v: 99, t: 'typing', active: true }))).toBeNull()
  })

  it('rejects unknown frame types', () => {
    expect(parseControlFrame(JSON.stringify({ v: 1, t: 'selfdestruct' }))).toBeNull()
  })

  it('rejects malformed JSON without throwing', () => {
    expect(parseControlFrame('{ not json')).toBeNull()
    expect(parseControlFrame('[]')).toBeNull()
    expect(parseControlFrame('null')).toBeNull()
    expect(parseControlFrame('"a string"')).toBeNull()
  })

  it('rejects receipts with bad or oversized ref lists', () => {
    const base = { v: 1, t: 'receipt', state: 'read' }
    expect(parseControlFrame(JSON.stringify({ ...base, refs: [] }))).toBeNull()
    expect(parseControlFrame(JSON.stringify({ ...base, refs: ['nothex'] }))).toBeNull()
    expect(parseControlFrame(JSON.stringify({ ...base, refs: [hex('a')], state: 'seen' }))).toBeNull()
    const tooMany = Array.from({ length: MAX_RECEIPT_REFS + 1 }, () => hex('b'))
    expect(parseControlFrame(JSON.stringify({ ...base, refs: tooMany }))).toBeNull()
  })

  it('bounds SDP and ICE candidate sizes', () => {
    const huge = { v: 1, t: 'rtc', sid: 'x', kind: 'offer', sdp: 'a'.repeat(70_000) }
    expect(parseControlFrame(JSON.stringify(huge))).toBeNull()

    const hugeCandidate = {
      v: 1,
      t: 'rtc',
      sid: 'x',
      kind: 'candidate',
      candidate: { candidate: 'c'.repeat(2000), sdpMid: '0', sdpMLineIndex: 0 },
    }
    expect(parseControlFrame(JSON.stringify(hugeCandidate))).toBeNull()
  })

  it('accepts only inline image avatars', () => {
    const ok = { v: 1, t: 'profile', avatar: 'data:image/png;base64,iVBORw0KGgo=' }
    expect(parseControlFrame(JSON.stringify(ok))?.t).toBe('profile')

    // A remote URL would turn a profile push into a tracking pixel, and the
    // CSP would block it anyway.
    for (const avatar of [
      'https://tracker.example/pixel.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      'javascript:alert(1)',
    ]) {
      expect(parseControlFrame(JSON.stringify({ v: 1, t: 'profile', avatar }))).toBeNull()
    }
  })

  it('rejects an oversized avatar', () => {
    const avatar = `data:image/png;base64,${'A'.repeat(70_000)}`
    expect(parseControlFrame(JSON.stringify({ v: 1, t: 'profile', avatar }))).toBeNull()
  })

  it('rejects an over-long profile relay list', () => {
    const relays = Array.from({ length: 20 }, (_, i) => `wss://r${i}.example`)
    expect(parseControlFrame(JSON.stringify({ v: 1, t: 'profile', relays }))).toBeNull()
  })
})

describe('tag helpers', () => {
  it('reads the recipient and reply target', () => {
    const tags = [
      ['p', hex('a')],
      ['e', hex('b'), '', 'reply'],
    ]
    expect(recipientFromTags(tags)).toBe(hex('a'))
    expect(replyToFromTags(tags)).toBe(hex('b'))
  })

  it('ignores malformed tag values', () => {
    expect(recipientFromTags([['p', 'not-a-key']])).toBeNull()
    expect(replyToFromTags([['e']])).toBeNull()
  })

  it('uses a millisecond tag that agrees with the event second', () => {
    const now = Date.now()
    const createdAt = Math.floor(now / 1000)
    expect(preciseTimestamp([timestampTag(now)], createdAt)).toBe(now)
  })

  it('ignores a millisecond tag that contradicts the event second', () => {
    const createdAt = Math.floor(Date.now() / 1000)
    // A peer must not be able to reorder history by claiming an arbitrary time.
    expect(preciseTimestamp([['ms', String(Date.now() + 999_999)]], createdAt)).toBe(createdAt * 1000)
    expect(preciseTimestamp([['ms', 'NaN']], createdAt)).toBe(createdAt * 1000)
    expect(preciseTimestamp([['ms', '-5']], createdAt)).toBe(createdAt * 1000)
    expect(preciseTimestamp([], createdAt)).toBe(createdAt * 1000)
  })
})

describe('relay url normalisation', () => {
  it('canonicalises equivalent forms', () => {
    for (const input of [
      'wss://nos.lol',
      'wss://nos.lol/',
      'WSS://NOS.LOL',
      'nos.lol',
      'wss://nos.lol:443',
    ]) {
      expect(normalizeRelayUrl(input)).toBe('wss://nos.lol')
    }
  })

  it('keeps a meaningful path', () => {
    expect(normalizeRelayUrl('wss://relay.example/inbox')).toBe('wss://relay.example/inbox')
  })

  it('strips credentials and fragments', () => {
    expect(normalizeRelayUrl('wss://user:pass@relay.example/#frag')).toBe('wss://relay.example')
  })

  it('refuses insecure remote sockets but allows loopback for development', () => {
    expect(normalizeRelayUrl('ws://relay.example')).toBeNull()
    expect(normalizeRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777')
  })

  it('refuses non-websocket schemes instead of mangling them into one', () => {
    for (const input of [
      'http://relay.example',
      'https://relay.example',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'file:///etc/passwd',
      '',
      '   ',
    ]) {
      expect(normalizeRelayUrl(input)).toBeNull()
    }
  })

  it('still accepts a bare host with an explicit port', () => {
    expect(normalizeRelayUrl('relay.example:8080')).toBe('wss://relay.example:8080')
  })

  it('allows a loopback ws:// relay during local development', () => {
    expect(normalizeRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777')
  })

  it('rejects ws:// once the page is served over HTTPS', () => {
    // Mixed content, the CSP, and upgrade-insecure-requests all block it, so
    // accepting the address would only add a relay that can never connect.
    const original = globalThis.location
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:' },
      configurable: true,
      writable: true,
    })
    try {
      expect(normalizeRelayUrl('ws://localhost:7777')).toBeNull()
      expect(normalizeRelayUrl('wss://relay.example')).toBe('wss://relay.example')
    } finally {
      if (original === undefined) delete (globalThis as { location?: unknown }).location
      else
        Object.defineProperty(globalThis, 'location', { value: original, configurable: true, writable: true })
    }
  })

  it('dedupes and caps a list', () => {
    const list = normalizeRelayList(['nos.lol', 'wss://nos.lol/', 'wss://a.example', 'http://bad'], 10)
    expect(list).toEqual(['wss://nos.lol', 'wss://a.example'])
    expect(normalizeRelayList(['a.example', 'b.example', 'c.example'], 2)).toHaveLength(2)
  })

  it('labels a relay by hostname', () => {
    expect(relayLabel('wss://relay.damus.io/path')).toBe('relay.damus.io')
  })
})

describe('safety numbers', () => {
  const alice = hex('a')
  const bob = hex('b')

  it('is identical for both parties regardless of argument order', () => {
    expect(safetyNumber(alice, bob)).toEqual(safetyNumber(bob, alice))
  })

  it('differs for a different pair', () => {
    expect(safetyNumber(alice, bob).compact).not.toBe(safetyNumber(alice, hex('c')).compact)
  })

  it('renders 12 groups of 5 digits plus 8 emoji', () => {
    const number = safetyNumber(alice, bob)
    expect(number.groups).toHaveLength(12)
    expect(number.groups.every((g) => /^\d{5}$/.test(g))).toBe(true)
    expect(number.emoji).toHaveLength(8)
    expect(number.compact).toHaveLength(60)
  })
})

describe('attachment chunk frames', () => {
  const chunk = {
    v: PROTOCOL_VERSION,
    t: 'blob' as const,
    id: 'a'.repeat(64),
    seq: 0,
    total: 3,
    data: 'AAEC',
  }

  it('round-trips a chunk frame', () => {
    expect(parseControlFrame(encodeControlFrame(chunk))).toEqual(chunk)
  })

  it('rejects a chunk index outside the declared total', () => {
    // seq must address a real chunk, or a receiver sizes a buffer from a lie.
    expect(parseControlFrame(JSON.stringify({ ...chunk, seq: 3 }))).toBeNull()
    expect(parseControlFrame(JSON.stringify({ ...chunk, seq: -1 }))).toBeNull()
  })

  it('rejects a zero-chunk payload', () => {
    expect(parseControlFrame(JSON.stringify({ ...chunk, total: 0, seq: 0 }))).toBeNull()
  })

  it('rejects a fractional index', () => {
    expect(parseControlFrame(JSON.stringify({ ...chunk, seq: 1.5 }))).toBeNull()
  })

  it('rejects data that is not base64', () => {
    // The decoder is handed this string directly.
    expect(parseControlFrame(JSON.stringify({ ...chunk, data: 'not base64!' }))).toBeNull()
    expect(parseControlFrame(JSON.stringify({ ...chunk, data: '' }))).toBeNull()
  })

  it('rejects a chunk larger than any transport would carry', () => {
    const data = 'A'.repeat(70 * 1024)
    expect(parseControlFrame(JSON.stringify({ ...chunk, data }))).toBeNull()
  })

  it('round-trips a resend request', () => {
    const request = { v: PROTOCOL_VERSION, t: 'blobreq' as const, id: 'b'.repeat(64), need: [1, 4] }
    expect(parseControlFrame(encodeControlFrame(request))).toEqual(request)
  })

  it('rejects a resend request demanding an unbounded list', () => {
    const need = Array.from({ length: 300 }, (_, i) => i)
    expect(
      parseControlFrame(JSON.stringify({ v: PROTOCOL_VERSION, t: 'blobreq', id: 'b'.repeat(64), need })),
    ).toBeNull()
  })

  it('accepts an empty resend request meaning "all of it"', () => {
    const request = { v: PROTOCOL_VERSION, t: 'blobreq' as const, id: 'b'.repeat(64), need: [] }
    expect(parseControlFrame(encodeControlFrame(request))).toEqual(request)
  })
})

describe('attachment descriptors on a chat rumor', () => {
  it('round-trips through a tag', () => {
    const descriptor = { kind: 'voice', id: 'a'.repeat(64) }
    const tags = [['p', 'c'.repeat(64)], attachmentTag(descriptor)]
    expect(attachmentFromTags(tags)).toEqual(descriptor)
  })

  it('returns null when there is no attachment', () => {
    expect(attachmentFromTags([['p', 'c'.repeat(64)]])).toBeNull()
  })

  it('returns null rather than throwing on malformed JSON', () => {
    expect(attachmentFromTags([[ATTACHMENT_TAG, '{not json']])).toBeNull()
  })

  it('refuses a tag large enough to bloat every copy of the message', () => {
    expect(attachmentFromTags([[ATTACHMENT_TAG, 'x'.repeat(9000)]])).toBeNull()
  })
})

describe('withdrawal frames', () => {
  const redact = { v: PROTOCOL_VERSION, t: 'redact' as const, refs: ['a'.repeat(64)] }

  it('round-trips', () => {
    expect(parseControlFrame(encodeControlFrame(redact))).toEqual(redact)
  })

  it('rejects an empty or oversized reference list', () => {
    expect(parseControlFrame(JSON.stringify({ ...redact, refs: [] }))).toBeNull()
    const many = Array.from({ length: 100 }, () => 'b'.repeat(64))
    expect(parseControlFrame(JSON.stringify({ ...redact, refs: many }))).toBeNull()
  })

  it('rejects references that are not rumor ids', () => {
    expect(parseControlFrame(JSON.stringify({ ...redact, refs: ['nope'] }))).toBeNull()
  })
})
