import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '../util/bytes'

/**
 * Out-of-band verification code for a pair of identities.
 *
 * Both sides compute the same value from the two public keys alone, so it can
 * be compared over a phone call or in person. Matching codes prove the two apps
 * agree on which keys they are talking to — the only defence against a
 * malicious invite substituted in transit.
 *
 * Rendered as 12 groups of 5 digits plus a short emoji strip, which is far
 * easier to compare at a glance than 64 hex characters.
 */

// prettier-ignore
const EMOJI = [
  '\u{1F436}', '\u{1F431}', '\u{1F42D}', '\u{1F439}', '\u{1F430}', '\u{1F98A}', '\u{1F43B}', '\u{1F43C}',
  '\u{1F428}', '\u{1F42F}', '\u{1F981}', '\u{1F42E}', '\u{1F437}', '\u{1F438}', '\u{1F435}', '\u{1F414}',
  '\u{1F427}', '\u{1F426}', '\u{1F424}', '\u{1F986}', '\u{1F985}', '\u{1F989}', '\u{1F987}', '\u{1F43A}',
  '\u{1F417}', '\u{1F434}', '\u{1F984}', '\u{1F41D}', '\u{1F41B}', '\u{1F98B}', '\u{1F40C}', '\u{1F41E}',
  '\u{1F41C}', '\u{1F982}', '\u{1F422}', '\u{1F40D}', '\u{1F98E}', '\u{1F419}', '\u{1F991}', '\u{1F990}',
  '\u{1F980}', '\u{1F421}', '\u{1F420}', '\u{1F41F}', '\u{1F42C}', '\u{1F433}', '\u{1F988}', '\u{1F40A}',
  '\u{1F335}', '\u{1F384}', '\u{1F332}', '\u{1F333}', '\u{1F334}', '\u{1F331}', '\u{1F33F}', '\u{1F340}',
  '\u{1F38B}', '\u{1F341}', '\u{1F344}', '\u{1F33E}', '\u{1F490}', '\u{1F337}', '\u{1F339}', '\u{1F33B}',
] as const

function digest(pubkeyA: string, pubkeyB: string): Uint8Array {
  const [first, second] = [pubkeyA, pubkeyB].sort() as [string, string]
  // Domain separation stops this digest from ever colliding with another
  // protocol hash computed over the same two keys.
  return sha256(concatBytes(utf8ToBytes('textor/safety-number/v1'), hexToBytes(first), hexToBytes(second)))
}

export interface SafetyNumber {
  /** 12 groups of 5 digits. */
  readonly groups: string[]
  /** 8 emoji — a fast visual pre-check before reading digits aloud. */
  readonly emoji: string[]
  /** Digits with no separators, for QR comparison. */
  readonly compact: string
}

export function safetyNumber(pubkeyA: string, pubkeyB: string): SafetyNumber {
  const hash = digest(pubkeyA, pubkeyB)

  // 12 groups x 5 digits, each derived from a distinct 20-bit window.
  const groups: string[] = []
  for (let i = 0; i < 12; i++) {
    const off = i * 2
    const chunk =
      ((hash[off] as number) << 12) | ((hash[off + 1] as number) << 4) | ((hash[off + 2] as number) >> 4)
    groups.push(String(chunk % 100000).padStart(5, '0'))
  }

  const emoji: string[] = []
  for (let i = 0; i < 8; i++) emoji.push(EMOJI[(hash[24 + i] as number) % EMOJI.length] as string)

  return { groups, emoji, compact: groups.join('') }
}
