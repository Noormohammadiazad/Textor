import { base64url, base64, hex } from '@scure/base'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const utf8ToBytes = (s: string): Uint8Array => encoder.encode(s)
export const bytesToUtf8 = (b: Uint8Array): string => decoder.decode(b)

export const bytesToHex = (b: Uint8Array): string => hex.encode(b)
export const hexToBytes = (s: string): Uint8Array => hex.decode(s.toLowerCase())

export const bytesToB64url = (b: Uint8Array): string => base64url.encode(b).replace(/=+$/, '')
export const b64urlToBytes = (s: string): Uint8Array =>
  base64url.decode(s + '='.repeat((4 - (s.length % 4)) % 4))

export const bytesToB64 = (b: Uint8Array): string => base64.encode(b)
export const b64ToBytes = (s: string): Uint8Array => base64.decode(s)

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

/** Overwrite a secret buffer in place. Best-effort: JS gives no real guarantees. */
export function wipe(...arrays: (Uint8Array | undefined | null)[]): void {
  for (const a of arrays) if (a) a.fill(0)
}

/** Length-independent comparison for equal-length buffers; used on MACs and keys. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export function isHex32(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

/**
 * Maximum bytes `crypto.getRandomValues` will fill in one call, per the Web
 * Crypto spec. Asking for more throws QuotaExceededError rather than returning
 * short, so anything larger has to be filled a block at a time.
 */
const RANDOM_BLOCK = 65_536

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let offset = 0; offset < n; offset += RANDOM_BLOCK) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + RANDOM_BLOCK, n)))
  }
  return out
}

/** Unbiased integer in [0, max) via rejection sampling. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 0x1_00_00_00_00) throw new Error('randomInt: bad range')
  const limit = Math.floor(0x1_00_00_00_00 / max) * max
  const buf = new Uint32Array(1)
  let v: number
  do {
    crypto.getRandomValues(buf)
    v = buf[0] as number
  } while (v >= limit)
  return v % max
}
