/**
 * Textor's wire protocol: what goes *inside* a NIP-59 gift wrap.
 *
 * Two rumor kinds only:
 *
 *   kind 14    - a chat message, exactly as NIP-17 defines it. Other Nostr DM
 *                clients (0xchat, Amethyst, ...) can read these, and we can
 *                read theirs. Interoperability is deliberate: a messenger whose
 *                users cannot leave is not a privacy tool.
 *
 *   kind 20014 - a Textor control frame (receipts, typing, presence, WebRTC
 *                signalling, profile push). Chosen from the ephemeral range so
 *                that a relay which ever saw one unwrapped would not store it.
 *                Clients that do not understand it ignore it.
 *
 * Every control frame carries an explicit `v`. Anything with a `v` we do not
 * know is dropped rather than guessed at, which is what lets us ship `v: 2`
 * later (a forward-secret message layer, say) without old clients misreading
 * new frames.
 */

export const KIND_CHAT = 14
export const KIND_FILE = 15
export const KIND_CONTROL = 20014

export const PROTOCOL_VERSION = 1

/** Rumor kinds we are willing to process at all. */
export const ACCEPTED_RUMOR_KINDS: ReadonlySet<number> = new Set([KIND_CHAT, KIND_CONTROL])

export const MAX_MESSAGE_CHARS = 16_000

export type DeliveryState = 'delivered' | 'read'

export interface ReceiptFrame {
  v: number
  t: 'receipt'
  /**
   * Rumor ids being acknowledged. Batched deliberately: one gift wrap per
   * acknowledged message would roughly double relay traffic for a busy
   * conversation, and every extra wrap is another row of metadata.
   */
  refs: string[]
  state: DeliveryState
}

export const MAX_RECEIPT_REFS = 64

export interface TypingFrame {
  v: number
  t: 'typing'
  active: boolean
}

export interface PresenceFrame {
  v: number
  t: 'presence'
  online: boolean
  /** Unix seconds after which this beacon is stale. */
  expires: number
  /** True when the sender is reachable for a direct connection right now. */
  rtc?: boolean
}

export type RtcSignalKind = 'offer' | 'answer' | 'candidate' | 'bye'

export interface RtcFrame {
  v: number
  t: 'rtc'
  /** Session id, so two racing offers can be resolved deterministically. */
  sid: string
  kind: RtcSignalKind
  sdp?: string
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /**
   * DTLS certificate fingerprint of the offerer/answerer, carried *inside* the
   * encrypted frame. Comparing it against the fingerprint negotiated by the
   * peer connection binds the media path to the identity keys, so a signalling
   * relay cannot substitute its own DTLS endpoint.
   */
  fingerprint?: string
}

export interface ProfileFrame {
  v: number
  t: 'profile'
  name?: string
  about?: string
  /** data: URI, small. Sent to contacts directly rather than published. */
  avatar?: string
  /** The sender's preferred DM inbox relays, so replies land where they look. */
  relays?: string[]
}

/**
 * One encrypted chunk of an attachment payload.
 *
 * Chunks are control frames rather than part of the chat rumor so that the
 * message itself stays small and arrives immediately: the bubble renders from
 * the descriptor — name, size, duration, waveform, blurred preview — while the
 * bytes are still in flight, and an attachment that never finishes transferring
 * leaves a message rather than a hole.
 */
export interface BlobChunkFrame {
  v: number
  t: 'blob'
  /** Blob id: SHA-256 of the plaintext payload, hex. */
  id: string
  /** Zero-based chunk index. */
  seq: number
  /** Total chunks, repeated so a receiver can size its buffer from any chunk. */
  total: number
  /** Base64 of the chunk ciphertext. */
  data: string
}

/**
 * Ask a peer to (re)send specific chunks.
 *
 * The relay path drops events — a relay may be down, may refuse the publish, or
 * may simply not have been subscribed at the moment. Without this frame a
 * single lost chunk means the whole payload is unrecoverable and the sender
 * never learns. With it, the receiver drives the transfer to completion and a
 * resumed transfer costs only what is actually missing.
 */
export interface BlobRequestFrame {
  v: number
  t: 'blobreq'
  id: string
  /** Chunk indexes still missing. Empty means "all of it". */
  need: number[]
}

/**
 * Ask the peer to delete messages we sent them.
 *
 * A request, not a command, and honestly named: it is a tombstone the other
 * client is asked to honour, not an erasure we can enforce. Anyone running a
 * modified client, and any relay that kept the wrap, still has the ciphertext.
 * The threat model says so plainly, and the UI must not promise more.
 *
 * What it does guarantee is the ordinary case: both devices drop the message
 * and its payload, and an offline peer drops them on reconnect, because the
 * frame is queued durably rather than fired once into the void.
 */
export interface RedactFrame {
  v: number
  t: 'redact'
  /** Rumor ids to delete. Only ever honoured for messages that peer authored. */
  refs: string[]
}

export const MAX_REDACT_REFS = 64

/** Base64 of a 32 KiB chunk plus its tag is about 43.7 KB; this leaves headroom. */
export const MAX_CHUNK_DATA_CHARS = 64 * 1024
/** Enough to cover the largest payload the relay path will carry. */
export const MAX_BLOB_CHUNKS = 65_536
/** One request frame should not be able to demand an unbounded resend. */
export const MAX_BLOB_REQUEST_REFS = 256

export type ControlFrame =
  | ReceiptFrame
  | TypingFrame
  | PresenceFrame
  | RtcFrame
  | ProfileFrame
  | BlobChunkFrame
  | BlobRequestFrame
  | RedactFrame

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isHex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const isIndex = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

/**
 * Parse a control frame from untrusted JSON.
 *
 * Returns `null` rather than throwing: a peer sending garbage should cost us a
 * dropped frame, not an exception that aborts a whole sync batch.
 */
export function parseControlFrame(json: string): ControlFrame | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.v !== PROTOCOL_VERSION) return null

  switch (value.t) {
    case 'receipt': {
      if (!Array.isArray(value.refs) || value.refs.length === 0) return null
      if (value.refs.length > MAX_RECEIPT_REFS) return null
      if (!value.refs.every(isHex32)) return null
      if (value.state !== 'delivered' && value.state !== 'read') return null
      return { v: PROTOCOL_VERSION, t: 'receipt', refs: value.refs as string[], state: value.state }
    }

    case 'typing':
      if (typeof value.active !== 'boolean') return null
      return { v: PROTOCOL_VERSION, t: 'typing', active: value.active }

    case 'presence': {
      if (typeof value.online !== 'boolean') return null
      if (typeof value.expires !== 'number' || !Number.isFinite(value.expires)) return null
      const frame: PresenceFrame = {
        v: PROTOCOL_VERSION,
        t: 'presence',
        online: value.online,
        expires: value.expires,
      }
      if (typeof value.rtc === 'boolean') frame.rtc = value.rtc
      return frame
    }

    case 'rtc': {
      if (!isStr(value.sid, 64)) return null
      const kind = value.kind
      if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate' && kind !== 'bye') return null
      const frame: RtcFrame = { v: PROTOCOL_VERSION, t: 'rtc', sid: value.sid, kind }
      // SDP blobs are bounded: a legitimate offer is a few KB, and an
      // unbounded one is a memory-exhaustion vector.
      if (value.sdp !== undefined) {
        if (!isStr(value.sdp, 64_000)) return null
        frame.sdp = value.sdp
      }
      if (value.candidate !== undefined) {
        const c = value.candidate
        if (!isRecord(c) || !isStr(c.candidate, 1024)) return null
        if (c.sdpMid !== null && typeof c.sdpMid !== 'string') return null
        if (c.sdpMLineIndex !== null && typeof c.sdpMLineIndex !== 'number') return null
        frame.candidate = {
          candidate: c.candidate,
          sdpMid: (c.sdpMid as string | null) ?? null,
          sdpMLineIndex: (c.sdpMLineIndex as number | null) ?? null,
        }
      }
      if (value.fingerprint !== undefined) {
        if (!isStr(value.fingerprint, 512)) return null
        frame.fingerprint = value.fingerprint
      }
      return frame
    }

    case 'profile': {
      const frame: ProfileFrame = { v: PROTOCOL_VERSION, t: 'profile' }
      if (value.name !== undefined) {
        if (!isStr(value.name, 128)) return null
        frame.name = value.name
      }
      if (value.about !== undefined) {
        if (!isStr(value.about, 512)) return null
        frame.about = value.about
      }
      if (value.avatar !== undefined) {
        // Cap at 64 KB of data: URI and require an image MIME type. An
        // unbounded avatar is both a storage and a rendering hazard.
        if (!isStr(value.avatar, 64 * 1024)) return null
        if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.avatar)) return null
        frame.avatar = value.avatar
      }
      if (value.relays !== undefined) {
        if (!Array.isArray(value.relays) || value.relays.length > 12) return null
        const relays = value.relays.filter((r): r is string => isStr(r, 512))
        if (relays.length !== value.relays.length) return null
        frame.relays = relays
      }
      return frame
    }

    case 'blob': {
      if (!isHex32(value.id)) return null
      if (!isIndex(value.total, MAX_BLOB_CHUNKS) || value.total === 0) return null
      if (!isIndex(value.seq, value.total - 1)) return null
      if (!isStr(value.data, MAX_CHUNK_DATA_CHARS) || value.data.length === 0) return null
      // Matched, not merely length-checked: the decoder is handed this string
      // directly, and a strict shape is cheaper than a decoder that throws.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return null
      return {
        v: PROTOCOL_VERSION,
        t: 'blob',
        id: value.id,
        seq: value.seq,
        total: value.total,
        data: value.data,
      }
    }

    case 'redact': {
      if (!Array.isArray(value.refs) || value.refs.length === 0) return null
      if (value.refs.length > MAX_REDACT_REFS) return null
      if (!value.refs.every(isHex32)) return null
      return { v: PROTOCOL_VERSION, t: 'redact', refs: value.refs as string[] }
    }

    case 'blobreq': {
      if (!isHex32(value.id)) return null
      if (!Array.isArray(value.need) || value.need.length > MAX_BLOB_REQUEST_REFS) return null
      if (!value.need.every((n) => isIndex(n, MAX_BLOB_CHUNKS - 1))) return null
      return { v: PROTOCOL_VERSION, t: 'blobreq', id: value.id, need: value.need as number[] }
    }

    default:
      return null
  }
}

export const encodeControlFrame = (frame: ControlFrame): string => JSON.stringify(frame)

/** Read the `p` tag naming the counterparty of a chat rumor. */
export function recipientFromTags(tags: readonly string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === 'p' && isHex32(tag[1])) return tag[1]
  }
  return null
}

/**
 * Millisecond-precision send time, carried as a rumor tag.
 *
 * Nostr `created_at` is in whole seconds, so five messages typed in one second
 * are indistinguishable and sort arbitrarily — which shows up immediately as
 * scrambled bursts in a chat. The tag lives inside the encrypted rumor, so it
 * is visible only to the recipient (who already knows the second), and clients
 * that do not understand it simply ignore an unknown tag.
 *
 * Ignored unless it agrees with `created_at`, so a peer cannot use it to jump
 * the queue.
 */
export function preciseTimestamp(tags: readonly string[][], createdAtSec: number): number {
  const fallback = createdAtSec * 1000
  for (const tag of tags) {
    if (tag[0] !== 'ms' || typeof tag[1] !== 'string') continue
    const ms = Number(tag[1])
    if (!Number.isSafeInteger(ms) || ms <= 0) continue
    if (Math.abs(ms - fallback) > 1000) continue
    return ms
  }
  return fallback
}

export const timestampTag = (ms: number): string[] => ['ms', String(ms)]

/** Read the rumor id this message replies to, if any. */
export function replyToFromTags(tags: readonly string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === 'e' && isHex32(tag[1])) return tag[1]
  }
  return null
}

/**
 * Attachment descriptors ride on the chat rumor as a tag, not as a separate
 * kind.
 *
 * The message stays a plain NIP-17 kind 14 whose content is human-readable
 * text, so another Nostr client shows "Voice message · 0:12" and a sensible
 * conversation rather than an empty bubble or nothing at all. Clients that do
 * not know the tag ignore it, which is exactly the NIP-17 contract.
 *
 * The descriptor carries the key that decrypts the payload, so it is only ever
 * read from inside an already-decrypted rumor.
 */
export const ATTACHMENT_TAG = 'textor-attachment'

/** Cap the tag: it travels in every copy of the message, on every relay. */
export const MAX_ATTACHMENT_TAG_CHARS = 8192

export const attachmentTag = (attachment: unknown): string[] => [ATTACHMENT_TAG, JSON.stringify(attachment)]

/**
 * Pull the raw descriptor JSON out of a rumor's tags.
 *
 * Returns parsed JSON, not a validated descriptor: validation lives in
 * `parseAttachment`, so the protocol layer stays free of media concerns and the
 * bounds are enforced in exactly one place.
 */
export function attachmentFromTags(tags: readonly string[][]): unknown | null {
  for (const tag of tags) {
    if (tag[0] !== ATTACHMENT_TAG) continue
    if (!isStr(tag[1], MAX_ATTACHMENT_TAG_CHARS)) return null
    try {
      return JSON.parse(tag[1])
    } catch {
      return null
    }
  }
  return null
}
