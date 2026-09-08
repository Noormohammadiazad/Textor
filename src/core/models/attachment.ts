import type { BlobEnvelope } from '../crypto/blobCrypto'

/**
 * What a message says about the payload attached to it.
 *
 * The descriptor travels inside the NIP-44-encrypted rumor, so every field here
 * — including the key that decrypts the payload — is visible only to the two
 * participants. Relays and blob hosts see ciphertext and nothing else.
 *
 * It is deliberately self-sufficient: the bubble renders a name, a size, a
 * duration, a waveform and a blurred preview before a single byte of the
 * payload has arrived. On a slow relay path that is the difference between a
 * conversation and a progress bar.
 */

export type AttachmentKind = 'voice' | 'image' | 'video' | 'file'

export interface Attachment extends BlobEnvelope {
  kind: AttachmentKind
  mime: string
  /** Original filename, for `file` and sometimes `image`. Never used as a path. */
  name?: string
  /** Playback length in ms, for voice and video. */
  durationMs?: number
  /** Peak envelope for a voice note: 0-100, one per bar. */
  waveform?: number[]
  width?: number
  height?: number
  /**
   * Tiny inline preview as a data: URI — a heavily downscaled JPEG for images
   * and video posters. Capped hard, because it ships inside the message itself
   * and every byte here is paid on the relay path whether or not the recipient
   * ever opens the full payload.
   */
  preview?: string
}

/**
 * Ceilings, chosen against what each transport can actually carry.
 *
 * The relay path is the binding constraint: a public relay typically refuses
 * events beyond 64 KiB, and a courteous client does not fire hundreds of them
 * for one message. At the 16 KiB chunk size this is 32 events per payload,
 * which is as much as it is reasonable to ask of a stranger's relay. Anything
 * larger needs the direct path, where the only limit is patience.
 *
 * Re-encoding is what keeps the common case inside this: a phone photo comes
 * out of the canvas at well under 100 KB.
 */
export const MAX_RELAY_BYTES = 512 * 1024
export const MAX_DIRECT_BYTES = 64 * 1024 * 1024
export const MAX_PREVIEW_CHARS = 4096
export const MAX_WAVEFORM_BARS = 96
export const MAX_NAME_CHARS = 200
export const MAX_MIME_CHARS = 128
/** Five minutes. Long enough for a real thought, short enough to stay sendable. */
export const MAX_VOICE_MS = 5 * 60 * 1000

const KINDS: ReadonlySet<string> = new Set<AttachmentKind>(['voice', 'image', 'video', 'file'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isHex = (v: unknown, len: number): v is string =>
  typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v)

const isSize = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

/**
 * Parse a descriptor received from a peer.
 *
 * Returns `null` rather than throwing, and is strict about every bound: this
 * runs on data from whoever is on the other end of the conversation, and a
 * descriptor claiming a four-gigabyte payload or a 10 MB "preview" is an
 * allocation attack, not a message.
 */
export function parseAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) return null
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind)) return null
  if (!isHex(value.id, 64)) return null
  if (!isHex(value.key, 64)) return null
  if (!isHex(value.salt, 32)) return null
  if (!isSize(value.size, MAX_DIRECT_BYTES)) return null
  if (!isSize(value.chunks, 1 + Math.ceil(MAX_DIRECT_BYTES / 1024))) return null
  if (value.chunks === 0) return null
  if (typeof value.mime !== 'string' || value.mime.length > MAX_MIME_CHARS) return null
  // A MIME type is the one field that reaches a rendering decision, so it is
  // matched rather than merely length-checked.
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(value.mime)) return null

  const attachment: Attachment = {
    kind: value.kind as AttachmentKind,
    id: value.id,
    key: value.key,
    salt: value.salt,
    size: value.size,
    chunks: value.chunks,
    mime: value.mime,
  }

  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.length > MAX_NAME_CHARS) return null
    attachment.name = sanitizeName(value.name)
  }
  if (value.durationMs !== undefined) {
    if (!isSize(value.durationMs, 24 * 60 * 60 * 1000)) return null
    attachment.durationMs = value.durationMs
  }
  if (value.width !== undefined) {
    if (!isSize(value.width, 100_000)) return null
    attachment.width = value.width
  }
  if (value.height !== undefined) {
    if (!isSize(value.height, 100_000)) return null
    attachment.height = value.height
  }
  if (value.waveform !== undefined) {
    if (!Array.isArray(value.waveform) || value.waveform.length > MAX_WAVEFORM_BARS) return null
    if (!value.waveform.every((n) => isSize(n, 100))) return null
    attachment.waveform = value.waveform as number[]
  }
  if (value.preview !== undefined) {
    if (typeof value.preview !== 'string' || value.preview.length > MAX_PREVIEW_CHARS) return null
    // Only a bitmap data URI. An SVG preview would be a script-execution
    // vector, and a remote URL would be a tracking pixel the CSP happens to
    // block today and might not tomorrow.
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.preview)) return null
    attachment.preview = value.preview
  }

  return attachment
}

/**
 * Codepoint ranges stripped from an incoming filename.
 *
 * Expressed as numbers rather than as a regex character class on purpose: the
 * literal characters are invisible, which makes such a class impossible to
 * review and — as this file demonstrated — enough to make `grep` treat the
 * source as binary.
 */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], // C0 controls, including NUL
  [0x7f, 0x9f], // DEL and the C1 controls
  [0x200e, 0x200f], // LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
]

const isStripped = (cp: number): boolean => STRIPPED_RANGES.some(([low, high]) => cp >= low && cp <= high)

export function sanitizeName(name: string): string {
  let cleaned = ''
  for (const char of name) {
    const cp = char.codePointAt(0)
    if (cp === undefined || isStripped(cp)) continue
    // Separators become underscores rather than being dropped, so "a/b" cannot
    // silently collapse into the different name "ab".
    cleaned += char === '/' || char === '\\' ? '_' : char
  }
  // A leading dot hides the file on Unix; traversal is already defanged above.
  cleaned = cleaned.replace(/^\.+/, '').trim()
  return cleaned.slice(0, MAX_NAME_CHARS) || 'file'
}

/** Which transports can carry this payload at all. */
export function transportsFor(size: number): { relay: boolean; direct: boolean } {
  return { relay: size <= MAX_RELAY_BYTES, direct: size <= MAX_DIRECT_BYTES }
}
