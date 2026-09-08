import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { getPublicKey } from 'nostr-tools/pure'
import {
  b64urlToBytes,
  bytesToB64url,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  isHex32,
  utf8ToBytes,
} from '../util/bytes'
import { nowSec } from '../util/time'
import { normalizeRelayList, normalizeRelayUrl } from '../transport/relayUrl'

/**
 * Invites: how two people become contacts without a directory server.
 *
 * An invite carries the inviter's public key, display name, and the relays
 * where they read their inbox, signed by the inviter's key. The signature does
 * not make the channel trustworthy — whoever hands you the invite could have
 * made up the whole thing — but it does stop a *relay* or a forwarding third
 * party from rewriting the relay hints inside an otherwise genuine invite,
 * which would silently black-hole the conversation.
 *
 * Genuine key verification is the safety-number ceremony, not this signature.
 *
 * Encoding is a hand-rolled binary format rather than JSON because the result
 * ends up in a QR code: ~150 bytes here versus ~400 for equivalent JSON, which
 * is the difference between a QR that scans instantly across a table and one
 * that does not.
 *
 * Layout:
 *   u8    version (1)
 *   [32]  pubkey
 *   u32be created_at (unix seconds)
 *   u8    name length, then UTF-8 name
 *   u8    relay count, then per relay: u8 scheme flag, u8 length, UTF-8 body
 *   [64]  schnorr signature over sha256(everything above)
 */

export const INVITE_VERSION = 1
const MAX_NAME_BYTES = 96
const MAX_RELAYS = 6
const MAX_RELAY_BYTES = 160
/** Invites older than this are stale; the relay hints have probably moved. */
export const INVITE_MAX_AGE_SEC = 180 * 24 * 60 * 60

export interface Invite {
  readonly version: number
  readonly pubkey: string
  readonly name: string
  readonly relays: string[]
  readonly createdAt: number
}

class ByteWriter {
  #chunks: Uint8Array[] = []
  u8(v: number): void {
    this.#chunks.push(new Uint8Array([v & 0xff]))
  }
  u32(v: number): void {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, false)
    this.#chunks.push(b)
  }
  bytes(b: Uint8Array): void {
    this.#chunks.push(b)
  }
  lenPrefixed(b: Uint8Array, max: number): void {
    if (b.length > max) throw new Error(`invite field too long (${b.length} > ${max})`)
    this.u8(b.length)
    this.bytes(b)
  }
  done(): Uint8Array {
    return concatBytes(...this.#chunks)
  }
}

class ByteReader {
  #offset = 0
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number {
    return this.buf.length - this.#offset
  }
  u8(): number {
    if (this.remaining < 1) throw new Error('invite truncated')
    return this.buf[this.#offset++] as number
  }
  u32(): number {
    if (this.remaining < 4) throw new Error('invite truncated')
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.#offset, 4).getUint32(0, false)
    this.#offset += 4
    return v
  }
  take(n: number): Uint8Array {
    if (this.remaining < n) throw new Error('invite truncated')
    const out = this.buf.subarray(this.#offset, this.#offset + n)
    this.#offset += n
    return out
  }
  lenPrefixed(max: number): Uint8Array {
    const n = this.u8()
    if (n > max) throw new Error('invite field too long')
    return this.take(n)
  }
  rest(): Uint8Array {
    return this.buf.subarray(this.#offset)
  }
}

/** `wss://` is the overwhelmingly common case; flag it instead of spelling it. */
function packRelay(url: string): { flag: number; body: string } {
  if (url.startsWith('wss://')) return { flag: 0, body: url.slice(6) }
  if (url.startsWith('ws://')) return { flag: 1, body: url.slice(5) }
  return { flag: 2, body: url }
}

function unpackRelay(flag: number, body: string): string {
  if (flag === 0) return `wss://${body}`
  if (flag === 1) return `ws://${body}`
  if (flag === 2) return body
  throw new Error('unknown relay scheme flag')
}

function serializeBody(invite: Invite): Uint8Array {
  const w = new ByteWriter()
  w.u8(invite.version)
  w.bytes(hexToBytes(invite.pubkey))
  w.u32(invite.createdAt)
  w.lenPrefixed(utf8ToBytes(invite.name), MAX_NAME_BYTES)
  const relays = invite.relays.slice(0, MAX_RELAYS)
  w.u8(relays.length)
  for (const relay of relays) {
    const { flag, body } = packRelay(relay)
    w.u8(flag)
    w.lenPrefixed(utf8ToBytes(body), MAX_RELAY_BYTES)
  }
  return w.done()
}

export function createInvite(
  secretKey: Uint8Array,
  opts: { name: string; relays: string[]; createdAt?: number },
): string {
  const invite: Invite = {
    version: INVITE_VERSION,
    pubkey: getPublicKey(secretKey),
    // Trim rather than reject: a long display name should not block sharing.
    name: truncateUtf8(opts.name.trim(), MAX_NAME_BYTES),
    relays: normalizeRelayList(opts.relays, MAX_RELAYS),
    createdAt: opts.createdAt ?? nowSec(),
  }
  const body = serializeBody(invite)
  const signature = schnorr.sign(sha256(body), secretKey)
  return bytesToB64url(concatBytes(body, signature))
}

export class InviteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InviteError'
  }
}

export function decodeInvite(encoded: string): Invite {
  let raw: Uint8Array
  try {
    raw = b64urlToBytes(encoded.trim())
  } catch {
    throw new InviteError('invite is not valid base64url')
  }
  if (raw.length < 1 + 32 + 4 + 1 + 1 + 64) throw new InviteError('invite is too short')

  const body = raw.subarray(0, raw.length - 64)
  const signature = raw.subarray(raw.length - 64)

  const r = new ByteReader(body)
  const version = r.u8()
  if (version !== INVITE_VERSION) throw new InviteError(`unsupported invite version ${version}`)

  const pubkey = bytesToHex(r.take(32))
  const createdAt = r.u32()
  let name: string
  try {
    name = bytesToUtf8(r.lenPrefixed(MAX_NAME_BYTES))
  } catch {
    throw new InviteError('invite name is malformed')
  }

  const relayCount = r.u8()
  if (relayCount > MAX_RELAYS) throw new InviteError('invite lists too many relays')
  const relays: string[] = []
  for (let i = 0; i < relayCount; i++) {
    const flag = r.u8()
    const bodyBytes = r.lenPrefixed(MAX_RELAY_BYTES)
    const url = normalizeRelayUrl(unpackRelay(flag, bytesToUtf8(bodyBytes)))
    if (url) relays.push(url)
  }
  if (r.remaining !== 0) throw new InviteError('invite has trailing data')

  if (!schnorr.verify(signature, sha256(body), hexToBytes(pubkey))) {
    throw new InviteError('invite signature does not verify')
  }

  return { version, pubkey, name, relays, createdAt }
}

/** True when an invite is old enough that its relay hints should be distrusted. */
export const isInviteStale = (invite: Invite, now = nowSec()): boolean =>
  now - invite.createdAt > INVITE_MAX_AGE_SEC

/** `https://host/#/i/<payload>` — the fragment never reaches the web server. */
export function inviteLink(encoded: string, origin?: string): string {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '/')
  return `${base.replace(/[#?].*$/, '')}#/i/${encoded}`
}

/** Pull the payload out of a full link, a bare fragment, or a raw payload. */
export function extractInvitePayload(input: string): string | null {
  const text = input.trim()
  const match = text.match(/#\/i\/([A-Za-z0-9_-]+)/)
  if (match?.[1]) return match[1]
  if (/^[A-Za-z0-9_-]{80,}$/.test(text)) return text
  return null
}

function truncateUtf8(value: string, maxBytes: number): string {
  let out = value
  while (utf8ToBytes(out).length > maxBytes) out = out.slice(0, -1)
  return out
}

export const isValidPubkeyHex = isHex32
