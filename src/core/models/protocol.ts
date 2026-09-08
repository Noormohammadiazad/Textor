/**
 * Textor's wire protocol: what goes *inside* a NIP-59 gift wrap.
 *
 * Three rumor kinds only:
 *
 *   kind 14    - a chat message, exactly as NIP-17 defines it. Other Nostr DM
 *                clients (0xchat, Amethyst, ...) can read these, and we can
 *                read theirs. Interoperability is deliberate: a messenger whose
 *                users cannot leave is not a privacy tool.
 *
 *   kind 7     - a reaction, shaped exactly as NIP-25 defines it, but sealed
 *                inside the gift wrap rather than published openly. A public
 *                kind 7 would announce "this pubkey reacted to that event" to
 *                every relay — which is the conversation graph NIP-17 exists to
 *                hide. Sealed, it costs one wrap and leaks nothing.
 *
 *   kind 20014 - a Textor control frame (receipts, typing, presence, WebRTC
 *                signalling for the direct channel and for calls, profile
 *                push, poll votes, checklist changes).
 *                Chosen from the ephemeral range so that a relay which ever saw
 *                one unwrapped would not store it. Clients that do not
 *                understand it ignore it.
 *
 * Every rumor names the people it is for in `p` tags, and NIP-17 defines a
 * conversation as exactly that set plus the author. Two people is a direct
 * conversation; more is a group — see `roomOf`.
 *
 * Every control frame carries an explicit `v`. Anything with a `v` we do not
 * know is dropped rather than guessed at, which is what lets us ship `v: 2`
 * later (a forward-secret message layer, say) without old clients misreading
 * new frames.
 */

import { CALL_END_REASONS, type CallEndReason, type CallMedia } from './call'

export const KIND_CHAT = 14
export const KIND_FILE = 15
export const KIND_REACTION = 7
export const KIND_CONTROL = 20014

export const PROTOCOL_VERSION = 1

/** Rumor kinds we are willing to process at all. */
export const ACCEPTED_RUMOR_KINDS: ReadonlySet<number> = new Set([KIND_CHAT, KIND_REACTION, KIND_CONTROL])

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

/**
 * WebRTC signalling, shaped after NIP-AC.
 *
 * NIP-AC (draft) signals a peer connection with three events — offer, answer
 * and ICE candidate — whose content is the browser's own session description
 * or candidate object, correlated by the id of the event that opened the
 * handshake, and recommends NIP-59 wrapping where who-connects-to-whom should
 * stay off the relays. That is the shape of every `rtc` frame, always sealed:
 *
 *   NIP-AC kind 21603 offer      ->  kind: 'offer',     sdp
 *   NIP-AC kind 21604 answer     ->  kind: 'answer',    sdp
 *   NIP-AC kind 21605 candidate  ->  kind: 'candidate', candidate
 *   NIP-AC `e` tag (session)     ->  `call`, the rumor id of the opening offer
 *
 * Two things ride on the same frame. The direct channel (ADR-008) predates the
 * draft and names its session with a random `sid`, which deployed clients
 * require. A call names its session NIP-AC's way instead, and — because an
 * opening offer carries no `sid` — every client that predates calls drops it
 * at parse time rather than mistaking a call for a data channel and answering
 * it. NIP-AC leaves the call state machine to the application; `ringing` and a
 * `bye` with a reason are that part. See PROTOCOL.md §5 and ADR-046.
 */
export type RtcSignalKind = 'offer' | 'answer' | 'candidate' | 'bye'
export type CallSignalKind = RtcSignalKind | 'ringing'

export interface IceCandidateFrame {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

interface SignalFields {
  v: number
  t: 'rtc'
  sdp?: string
  candidate?: IceCandidateFrame
  /**
   * DTLS certificate fingerprint of the offerer/answerer, carried *inside* the
   * encrypted frame. Comparing it against the fingerprint negotiated by the
   * peer connection binds the media path to the identity keys, so a signalling
   * relay cannot substitute its own DTLS endpoint.
   */
  fingerprint?: string
}

/** Signalling for the direct channel. */
export interface RtcFrame extends SignalFields {
  /** Session id, so two racing offers can be resolved deterministically. */
  sid: string
  kind: RtcSignalKind
}

/** Signalling for a call. */
export interface CallFrame extends SignalFields {
  sid?: never
  kind: CallSignalKind
  /**
   * The call this frame belongs to: the rumor id of the offer that opened it,
   * as NIP-AC's `e` tag. Absent on that offer alone, whose own id names it.
   */
  call?: string
  /** What the caller is asking for. On the opening offer only. */
  media?: CallMedia
  /** Why the call ended. On a `bye` only. */
  reason?: CallEndReason
}

/** Whether an `rtc` frame belongs to a call rather than to the direct channel. */
export const isCallFrame = (frame: RtcFrame | CallFrame): frame is CallFrame => frame.sid === undefined

/** The offer that starts a call: the one call frame that names no call. */
export const isOpeningOffer = (frame: CallFrame): frame is CallFrame & { media: CallMedia; sdp: string } =>
  frame.kind === 'offer' && frame.call === undefined

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
  /**
   * Which sealed copy this chunk belongs to (`blobCopy`), since one payload
   * can travel under several keys. Absent from clients that predate it; a
   * chunk without it is matched by the key it authenticates under.
   */
  copy?: string
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
  /** The copy wanted. Absent from clients that predate it: then every copy held is offered. */
  copy?: string
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

/**
 * A vote on a poll, or a change of mind.
 *
 * Carries the whole ballot rather than a delta, so the latest frame from each
 * voter is their vote and nothing has to be replayed in order to count. An
 * empty `choices` withdraws the vote. Tallied locally by every participant —
 * see `src/core/models/interactive.ts`.
 */
export interface VoteFrame {
  v: number
  t: 'vote'
  /** Rumor id of the poll message. */
  poll: string
  /** Option ids chosen. Empty withdraws the vote. */
  choices: string[]
}

/**
 * One change to a shared checklist: tick or untick an item, or add one.
 *
 * Adding carries `label`; ticking carries `done`. Each item settles on the
 * newest change anyone made to it, so two people ticking the same line at
 * once agree on the outcome without talking to each other.
 */
export interface CheckFrame {
  v: number
  t: 'check'
  /** Rumor id of the checklist message. */
  list: string
  item: string
  done?: boolean
  /** Present when the frame adds a new item. */
  label?: string
}

export type ControlFrame =
  | ReceiptFrame
  | TypingFrame
  | PresenceFrame
  | RtcFrame
  | CallFrame
  | ProfileFrame
  | BlobChunkFrame
  | BlobRequestFrame
  | RedactFrame
  | VoteFrame
  | CheckFrame

/** Frames that are part of the conversation's content rather than its plumbing. */
export type InteractiveFrame = VoteFrame | CheckFrame

export const isInteractiveFrame = (frame: ControlFrame): frame is InteractiveFrame =>
  frame.t === 'vote' || frame.t === 'check'

/** Options on one poll. Enough for a real choice, not enough to be a form. */
export const MAX_POLL_OPTIONS = 10
/** Items a checklist may hold, counting those added afterwards. */
export const MAX_CHECKLIST_ITEMS = 50
/** Poll options and checklist items: a line, not a paragraph. */
export const MAX_ITEM_CHARS = 120
/** Short, opaque ids for options and items, chosen by whoever creates them. */
export const isItemId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v)

/**
 * A single line of user text, made safe to show and store: control
 * characters and line breaks become spaces, runs of space collapse, and the
 * result is trimmed and capped. `null` when nothing is left.
 */
// Matching control characters is the point here, so the lint rule against it
// does not apply.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/g

export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const line = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return null
  return [...line].slice(0, max).join('')
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isHex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isCopy = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
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

    case 'rtc':
      return value.sid === undefined ? parseCallFrame(value) : parseDirectFrame(value)

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
      if (value.copy !== undefined && !isCopy(value.copy)) return null
      return {
        v: PROTOCOL_VERSION,
        t: 'blob',
        id: value.id,
        ...(value.copy !== undefined ? { copy: value.copy } : {}),
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
      if (value.copy !== undefined && !isCopy(value.copy)) return null
      return {
        v: PROTOCOL_VERSION,
        t: 'blobreq',
        id: value.id,
        ...(value.copy !== undefined ? { copy: value.copy } : {}),
        need: value.need as number[],
      }
    }

    case 'vote': {
      if (!isHex32(value.poll)) return null
      if (!Array.isArray(value.choices) || value.choices.length > MAX_POLL_OPTIONS) return null
      if (!value.choices.every(isItemId)) return null
      if (new Set(value.choices).size !== value.choices.length) return null
      return { v: PROTOCOL_VERSION, t: 'vote', poll: value.poll, choices: value.choices as string[] }
    }

    case 'check': {
      if (!isHex32(value.list) || !isItemId(value.item)) return null
      const frame: CheckFrame = { v: PROTOCOL_VERSION, t: 'check', list: value.list, item: value.item }
      if (value.done !== undefined) {
        if (typeof value.done !== 'boolean') return null
        frame.done = value.done
      }
      if (value.label !== undefined) {
        const label = cleanLine(value.label, MAX_ITEM_CHARS)
        if (label === null) return null
        frame.label = label
      }
      // A frame that neither adds nor ticks anything is noise.
      if (frame.done === undefined && frame.label === undefined) return null
      return frame
    }

    default:
      return null
  }
}

/**
 * The session description, candidate and fingerprint, common to both kinds of
 * `rtc` frame. Returns false when any of them is malformed.
 */
function readSignal(value: Record<string, unknown>, frame: SignalFields): boolean {
  // SDP blobs are bounded: a legitimate offer is a few KB, and an unbounded
  // one is a memory-exhaustion vector.
  if (value.sdp !== undefined) {
    if (!isStr(value.sdp, 64_000)) return false
    frame.sdp = value.sdp
  }
  if (value.candidate !== undefined) {
    const c = value.candidate
    if (!isRecord(c) || !isStr(c.candidate, 1024)) return false
    if (c.sdpMid !== null && typeof c.sdpMid !== 'string') return false
    if (c.sdpMLineIndex !== null && typeof c.sdpMLineIndex !== 'number') return false
    frame.candidate = {
      candidate: c.candidate,
      sdpMid: (c.sdpMid as string | null) ?? null,
      sdpMLineIndex: (c.sdpMLineIndex as number | null) ?? null,
    }
  }
  if (value.fingerprint !== undefined) {
    if (!isStr(value.fingerprint, 512)) return false
    frame.fingerprint = value.fingerprint
  }
  return true
}

const isSignalKind = (kind: unknown): kind is RtcSignalKind =>
  kind === 'offer' || kind === 'answer' || kind === 'candidate' || kind === 'bye'

function parseDirectFrame(value: Record<string, unknown>): RtcFrame | null {
  if (!isStr(value.sid, 64) || !isSignalKind(value.kind)) return null
  // A frame is for the direct channel or for a call, never both: one naming
  // both would be routed by whichever field the reader happened to check.
  if (value.call !== undefined || value.media !== undefined || value.reason !== undefined) return null
  const frame: RtcFrame = { v: PROTOCOL_VERSION, t: 'rtc', sid: value.sid, kind: value.kind }
  return readSignal(value, frame) ? frame : null
}

function parseCallFrame(value: Record<string, unknown>): CallFrame | null {
  const kind = value.kind
  if (!isSignalKind(kind) && kind !== 'ringing') return null
  const frame: CallFrame = { v: PROTOCOL_VERSION, t: 'rtc', kind }
  if (!readSignal(value, frame)) return null

  if (value.call === undefined) {
    // Only the opening offer names no call, and it must say what it is for.
    if (kind !== 'offer' || (value.media !== 'audio' && value.media !== 'video')) return null
    frame.media = value.media
  } else {
    if (!isHex32(value.call) || value.media !== undefined) return null
    frame.call = value.call
  }

  if (value.reason !== undefined) {
    if (kind !== 'bye' || !CALL_END_REASONS.includes(value.reason as CallEndReason)) return null
    frame.reason = value.reason as CallEndReason
  }

  // Each signal carries exactly its own payload, so a frame cannot be read two
  // ways — a candidate that is also an answer, say.
  const describes = kind === 'offer' || kind === 'answer'
  if (describes !== (frame.sdp !== undefined)) return null
  if ((kind === 'candidate') !== (frame.candidate !== undefined)) return null
  if (!describes && frame.fingerprint !== undefined) return null
  return frame
}

export const encodeControlFrame = (frame: ControlFrame): string => JSON.stringify(frame)

/** Read the `p` tag naming the counterparty of a chat rumor. */
export function recipientFromTags(tags: readonly string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === 'p' && isHex32(tag[1])) return tag[1]
  }
  return null
}

/** Every distinct well-formed pubkey named in a `p` tag, in the order given. */
export function recipientsFromTags(tags: readonly string[][]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    if (tag[0] === 'p' && isHex32(tag[1]) && !out.includes(tag[1])) out.push(tag[1])
  }
  return out
}

/**
 * The most people a conversation may hold, the sender included.
 *
 * NIP-17 groups have no server: every message is sealed and wrapped once per
 * member, so each extra person adds another wrap to every message, another
 * write to every relay, and another receipt coming back. Eight keeps a
 * message to eight wraps and a reply storm to something a phone on a slow
 * link can absorb. It is also the size at which "compare safety numbers with
 * everyone" is still something people actually do. See ADR-044.
 */
export const MAX_GROUP_MEMBERS = 8

/**
 * The most people a forward-secret group may hold, the sender included.
 *
 * Not a fan-out limit — a message to an MLS group is encrypted and published
 * once, however many read it — but what a phone can carry: a Welcome holds
 * the whole ratchet tree, and every commit re-encrypts a path to every
 * branch. A hundred keeps both small. See ADR-049.
 */
export const MAX_MLS_MEMBERS = 100

/** Inside MLS, Marmot's app kinds: chat (9), NIP-25 reaction, NIP-09 deletion. */
export const KIND_GROUP_CHAT = 9
export const KIND_DELETION = 5
/** A Marmot Welcome, which arrives gift-wrapped in the inbox like any rumor. */
export const KIND_MLS_WELCOME = 444

/**
 * Tags of a chat message in a forward-secret group, in one fixed order so a
 * message rebuilt from storage — to resend after a lost commit race — has the
 * id it had the first time. No `p` tags: the group is the MLS group.
 */
export function groupChatTags(shape: { ts: number; replyTo?: string; rootId?: string }): string[][] {
  const tags: string[][] = []
  if (shape.replyTo) tags.push(...threadTags(shape.rootId ?? shape.replyTo, shape.replyTo))
  tags.push(timestampTag(shape.ts))
  return tags
}

/**
 * Who a rumor is between, as NIP-17 defines a room: its author plus every
 * `p` tag. Returns everyone except `self`, sorted — one entry for a direct
 * conversation, more for a group — or `null` when the rumor is not ours to
 * read:
 *
 *  - an inbound rumor that names recipients but not us was misdelivered;
 *  - a copy of our own that names nobody else has no conversation to go in;
 *  - a room larger than `MAX_GROUP_MEMBERS` is refused outright. Accepting
 *    one would let anyone make this client fan every reply out to hundreds of
 *    keys, and a group that can be read but never answered is worse than a
 *    clear refusal.
 *
 * An inbound rumor with no `p` tag at all is read as addressed to us, which is
 * how the earliest NIP-17 clients sent them.
 */
export function roomOf(rumor: { pubkey: string; tags: readonly string[][] }, self: string): string[] | null {
  const named = recipientsFromTags(rumor.tags)
  const others = new Set<string>()
  if (rumor.pubkey === self) {
    for (const pubkey of named) if (pubkey !== self) others.add(pubkey)
  } else {
    if (named.length > 0 && !named.includes(self)) return null
    others.add(rumor.pubkey)
    for (const pubkey of named) if (pubkey !== self) others.add(pubkey)
  }
  if (others.size === 0 || others.size + 1 > MAX_GROUP_MEMBERS) return null
  return [...others].sort()
}

/** A `p` tag for each recipient, in a stable order so a rebuilt rumor hashes the same. */
export const recipientTags = (recipients: readonly string[]): string[][] =>
  [...recipients].sort().map((pubkey) => ['p', pubkey])

/**
 * NIP-17's group name. Any member may set it by sending a message that carries
 * a new one; the newest wins.
 */
export const SUBJECT_TAG = 'subject'
export const MAX_SUBJECT_CHARS = 80

export function subjectFromTags(tags: readonly string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === SUBJECT_TAG) return cleanLine(tag[1], MAX_SUBJECT_CHARS)
  }
  return null
}

export const subjectTag = (subject: string): string[] => [SUBJECT_TAG, subject]

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
  return threadFromTags(tags).replyTo
}

/**
 * Where a message sits in a thread, per NIP-10.
 *
 * NIP-10 has two schemes. The current one marks each `e` tag — `root`, `reply`
 * or `mention` — and the deprecated positional one infers from order: a lone
 * `e` tag is both root and reply, and with several the first is the root and
 * the last is the parent. Both are read here, because other clients still send
 * both, and only the marked form is written.
 *
 * `mention` is deliberately ignored: quoting a message is not replying to it,
 * and treating it as a parent would graft unrelated messages into a thread.
 */
export function threadFromTags(tags: readonly string[][]): {
  root: string | null
  replyTo: string | null
} {
  const positional: string[] = []
  let root: string | null = null
  let replyTo: string | null = null

  for (const tag of tags) {
    if (tag[0] !== 'e' || !isHex32(tag[1])) continue
    const marker = tag[3]
    if (marker === 'root') root ??= tag[1]
    else if (marker === 'reply') replyTo ??= tag[1]
    else if (marker === 'mention') continue
    else positional.push(tag[1])
  }

  if (!root && !replyTo && positional.length > 0) {
    // Deprecated scheme: one tag is a reply to the root itself.
    replyTo = positional[positional.length - 1] ?? null
    root = positional.length > 1 ? (positional[0] ?? null) : replyTo
  }
  // A reply whose parent is the thread root carries only a root marker.
  replyTo ??= root
  root ??= replyTo
  return { root, replyTo }
}

/**
 * Tags placing a reply in its thread.
 *
 * The root is carried explicitly so a client can group a conversation without
 * walking every parent link — which, in an encrypted history, would mean
 * decrypting the whole chain to draw one thread.
 */
export function threadTags(rootId: string, replyTo: string): string[][] {
  if (rootId === replyTo) return [['e', rootId, '', 'root']]
  return [
    ['e', rootId, '', 'root'],
    ['e', replyTo, '', 'reply'],
  ]
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

/**
 * Reaction payloads.
 *
 * NIP-25 puts arbitrary user-generated content in a reaction, including custom
 * emoji shortcodes that resolve to remote image URLs. Textor accepts neither:
 * the content must be a short literal emoji (or NIP-25's `+`/`-`), because a
 * shortcode would either render as meaningless text or invite a remote fetch,
 * and the Content-Security-Policy forbids the fetch outright.
 */
export const MAX_REACTION_CHARS = 16

/**
 * Whether a reaction body is one this client will store and show.
 *
 * Deliberately permissive about *which* emoji — new ones are added to Unicode
 * every year and an allow-list would rot — and strict about everything else:
 * no whitespace, no control characters, no letters or digits, and short enough
 * that it cannot smuggle a sentence into a reaction bar.
 */
export function isReactionBody(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const body = value.trim()
  if (body.length === 0 || body.length > MAX_REACTION_CHARS) return false
  if (body === '+' || body === '-') return true
  for (const char of body) {
    const cp = char.codePointAt(0)
    if (cp === undefined || !isEmojiCodepoint(cp)) return false
  }
  return true
}

/**
 * Codepoints that may appear in an emoji sequence.
 *
 * Ranges rather than an allow-list of characters: Unicode adds emoji every
 * year, and a list would reject next year's while pretending to be exhaustive.
 * Letters, digits and punctuation are outside every range here, which is what
 * stops a reaction from carrying a sentence.
 */
function isEmojiCodepoint(cp: number): boolean {
  // Joiners and presentation selectors, which glue sequences together.
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return true
  // Skin-tone modifiers.
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true
  // Arrows, dingbats, miscellaneous symbols and the pictographic planes.
  if (cp >= 0x2190 && cp <= 0x2bff) return true
  if (cp >= 0x1f000 && cp <= 0x1faff) return true
  return false
}

/** The rumor id a reaction applies to: NIP-25's `e` tag. */
export function reactionTargetFromTags(tags: readonly string[][]): string | null {
  return replyToFromTags(tags)
}

/**
 * Tags for a reaction rumor.
 *
 * `p` names the people in the conversation as every rumor does, `e` the
 * message being reacted to, and `k` its kind — all three exactly as NIP-25
 * specifies, so a client that understands sealed reactions reads ours without
 * special cases. In a group every member is named, which is what places the
 * reaction in the right room on arrival.
 */
export function reactionTags(
  recipients: string | readonly string[],
  targetId: string,
  targetKind = KIND_CHAT,
): string[][] {
  return [
    ...recipientTags(typeof recipients === 'string' ? [recipients] : recipients),
    ['e', targetId],
    ['k', String(targetKind)],
  ]
}
