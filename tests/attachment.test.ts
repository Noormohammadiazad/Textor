import { describe, expect, it } from 'vitest'
import {
  MAX_DIRECT_BYTES,
  MAX_PREVIEW_CHARS,
  MAX_RELAY_BYTES,
  parseAttachment,
  sanitizeName,
  transportsFor,
} from '@/core/models/attachment'

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
