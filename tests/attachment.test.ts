import { describe, expect, it } from 'vitest'
import {
  MAX_DIRECT_BYTES,
  MAX_PREVIEW_CHARS,
  MAX_RELAY_BYTES,
  parseAttachment,
  sanitizeName,
  transportsFor,
} from '@/core/models/attachment'
import { RELAY_CHUNK_BYTES } from '@/core/crypto/blobCrypto'

const valid = () => ({
  kind: 'image',
  id: 'a'.repeat(64),
  key: 'b'.repeat(64),
  salt: 'c'.repeat(32),
  size: 1024,
  chunks: 1,
  mime: 'image/webp',
})

describe('attachment descriptors from a peer', () => {
  it('accepts a well-formed descriptor', () => {
    expect(parseAttachment(valid())).toMatchObject({ kind: 'image', mime: 'image/webp', size: 1024 })
  })

  it('keeps the optional fields that let a bubble render before the payload lands', () => {
    const parsed = parseAttachment({
      ...valid(),
      kind: 'voice',
      mime: 'audio/webm',
      durationMs: 4200,
      waveform: [0, 50, 100],
    })
    expect(parsed?.durationMs).toBe(4200)
    expect(parsed?.waveform).toEqual([0, 50, 100])
  })

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['an unknown kind', { ...valid(), kind: 'executable' }],
    ['a short id', { ...valid(), id: 'a'.repeat(63) }],
    ['a non-hex key', { ...valid(), key: 'z'.repeat(64) }],
    ['a short salt', { ...valid(), salt: 'c'.repeat(31) }],
    ['a negative size', { ...valid(), size: -1 }],
    ['a fractional size', { ...valid(), size: 1.5 }],
    ['zero chunks', { ...valid(), chunks: 0 }],
    ['a missing mime', { ...valid(), mime: undefined }],
    ['a mime that is not a mime', { ...valid(), mime: 'javascript:alert(1)' }],
  ])('rejects %s', (_label, input) => {
    expect(parseAttachment(input)).toBeNull()
  })

  it('refuses a payload larger than any transport could carry', () => {
    // An unbounded size is an allocation attack, not a message.
    expect(parseAttachment({ ...valid(), size: MAX_DIRECT_BYTES + 1 })).toBeNull()
  })

  it('refuses an oversized preview', () => {
    const preview = `data:image/jpeg;base64,${'A'.repeat(MAX_PREVIEW_CHARS)}`
    expect(parseAttachment({ ...valid(), preview })).toBeNull()
  })

  it('refuses an SVG preview', () => {
    // An inline SVG is a script-execution vector, however small.
    const preview = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    expect(parseAttachment({ ...valid(), preview })).toBeNull()
  })

  it('refuses a remote preview URL', () => {
    expect(parseAttachment({ ...valid(), preview: 'https://tracker.example/pixel.png' })).toBeNull()
  })

  it('accepts a small bitmap preview', () => {
    const preview = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    expect(parseAttachment({ ...valid(), preview })?.preview).toBe(preview)
  })

  it('refuses a waveform with out-of-range bars', () => {
    expect(parseAttachment({ ...valid(), waveform: [0, 101] })).toBeNull()
    expect(parseAttachment({ ...valid(), waveform: [0, -1] })).toBeNull()
  })

  it('refuses a waveform long enough to bloat the message', () => {
    expect(parseAttachment({ ...valid(), waveform: new Array(200).fill(1) })).toBeNull()
  })
})

describe('filenames from a peer', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeName('holiday photo.jpg')).toBe('holiday photo.jpg')
  })

  it('keeps Persian names intact', () => {
    // Arabic-script letters are not bidi controls and must survive untouched.
    expect(sanitizeName('عکس تعطیلات.jpg')).toBe('عکس تعطیلات.jpg')
  })

  it('defuses the right-to-left override filename spoof', () => {
    // U+202E makes "annexe.txt" render while the real extension is .exe. This
    // app renders RTL text legitimately, so the eye cannot be the defence.
    // Written as an escape on purpose: the literal character is invisible and
    // makes git treat this file as binary.
    const spoofed = `report\u202etxt.exe`
    const clean = sanitizeName(spoofed)
    expect(clean).not.toContain('\u202e')
    expect(clean).toBe('reporttxt.exe')
  })

  it('strips control characters', () => {
    expect(sanitizeName('a\u0000b\u001fc\u007f.txt')).toBe('abc.txt')
  })

  it('turns path separators into underscores rather than dropping them', () => {
    // Dropping would turn "a/b" into the different, plausible name "ab".
    expect(sanitizeName('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''))
    expect(sanitizeName('dir\\file.txt')).toBe('dir_file.txt')
  })

  it('never returns an empty name', () => {
    expect(sanitizeName('')).toBe('file')
    expect(sanitizeName('...')).toBe('file')
    expect(sanitizeName('\u0000\u0000')).toBe('file')
  })

  it('is applied to names arriving over the wire', () => {
    const parsed = parseAttachment({ ...valid(), kind: 'file', name: 'x\u202ey/z.bin' })
    expect(parsed?.name).toBe('xy_z.bin')
  })
})

describe('choosing a transport by size', () => {
  it('allows both paths for a small payload', () => {
    expect(transportsFor(64 * 1024)).toEqual({ relay: true, direct: true })
  })

  it('drops the relay path once a payload would flood it', () => {
    expect(transportsFor(MAX_RELAY_BYTES + 1)).toEqual({ relay: false, direct: true })
  })

  it('allows neither beyond the direct ceiling', () => {
    expect(transportsFor(MAX_DIRECT_BYTES + 1)).toEqual({ relay: false, direct: false })
  })
})

describe('a payload on the relays (ADR-075)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    kind: 'voice',
    id: 'a'.repeat(64),
    key: 'b'.repeat(64),
    salt: 'c'.repeat(32),
    size: 100_000,
    chunks: 3,
    mime: 'audio/webm',
    chunkBytes: RELAY_CHUNK_BYTES,
    relays: ['wss://one.example', 'wss://two.example'],
    ...over,
  })

  it('says how it was cut and where it is', () => {
    const parsed = parseAttachment(base())
    expect(parsed?.chunkBytes).toBe(RELAY_CHUNK_BYTES)
    expect(parsed?.relays).toEqual(['wss://one.example', 'wss://two.example'])
  })

  it('needs neither, as a client from before it sends', () => {
    const { chunkBytes: _c, relays: _r, ...plain } = base({ chunks: 7 })
    const parsed = parseAttachment(plain)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('chunkBytes')
    expect(parsed).not.toHaveProperty('relays')
  })

  it('keeps fields in one order, so another device can rebuild the message exactly', () => {
    expect(
      Object.keys(parseAttachment(base({ name: 'n', durationMs: 1, width: 1, height: 1, waveform: [1] }))!),
    ).toEqual([
      'kind',
      'id',
      'key',
      'salt',
      'size',
      'chunks',
      'mime',
      'chunkBytes',
      'relays',
      'name',
      'durationMs',
      'width',
      'height',
      'waveform',
    ])
  })

  it.each([
    ['a chunk size of nothing', { chunkBytes: 0 }],
    ['a chunk size larger than an event holds', { chunkBytes: RELAY_CHUNK_BYTES + 1 }],
    ['a chunk size that is not a number', { chunkBytes: '100' }],
    ['a chunk count the size does not come to', { chunks: 4 }],
    ['relays that are not a list', { relays: 'wss://one.example' }],
    ['an empty list of relays', { relays: [] }],
    ['too many relays', { relays: ['a', 'b', 'c', 'd', 'e'].map((n) => `wss://${n}.example`) }],
    ['a relay that is not a relay', { relays: ['https://one.example'] }],
    ['a relay that is not text', { relays: [7] }],
  ])('refuses %s', (_label, over) => {
    expect(parseAttachment(base(over))).toBeNull()
  })

  it('refuses a payload of no chunks, and a name too long', () => {
    expect(parseAttachment(base({ chunks: 0 }))).toBeNull()
    expect(parseAttachment(base({ chunks: -1 }))).toBeNull()
    expect(parseAttachment(base({ name: 'x'.repeat(201) }))).toBeNull()
    expect(parseAttachment(base({ name: 7 }))).toBeNull()
  })

  it('refuses dimensions out of bounds', () => {
    expect(parseAttachment(base({ width: -1 }))).toBeNull()
    expect(parseAttachment(base({ height: -1 }))).toBeNull()
    expect(parseAttachment(base({ durationMs: -1 }))).toBeNull()
  })

  it('reaches the relays up to a megabyte, and needs a direct channel past it', () => {
    expect(transportsFor(MAX_RELAY_BYTES)).toEqual({ relay: true, direct: true })
    expect(transportsFor(MAX_RELAY_BYTES + 1)).toEqual({ relay: false, direct: true })
  })
})
