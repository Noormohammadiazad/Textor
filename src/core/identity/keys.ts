import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { generateSeedWords, privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06'
import type { DecodedResult } from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes, isHex32 } from '../util/bytes'

/**
 * `nip19.decode` is overloaded on template-literal prefixes, which does not
 * help when the input is arbitrary user text. One narrow cast here keeps every
 * call site honestly typed against the full union.
 */
function decodeNip19(value: string): DecodedResult | null {
  try {
    return (nip19.decode as (code: string) => DecodedResult)(value)
  } catch {
    return null
  }
}

/**
 * Identity is a secp256k1 keypair and nothing else — no account, no phone
 * number, no server that could be compelled to reveal one.
 *
 * The secret key is derived from a BIP-39 mnemonic along NIP-06's path
 * (m/44'/1237'/0'/0/0) so the twelve words are a complete, portable backup that
 * other Nostr clients can also restore.
 */

export interface Identity {
  readonly secretKey: Uint8Array
  readonly publicKey: string
  readonly npub: string
}

export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes')
  const publicKey = getPublicKey(secretKey)
  return { secretKey, publicKey, npub: nip19.npubEncode(publicKey) }
}

/** Create a fresh identity plus the mnemonic that reproduces it. */
export function createIdentity(): { identity: Identity; mnemonic: string } {
  const mnemonic = generateSeedWords()
  return { identity: identityFromMnemonic(mnemonic), mnemonic }
}

export function identityFromMnemonic(mnemonic: string, passphrase?: string): Identity {
  const normalized = normalizeMnemonic(mnemonic)
  if (!validateWords(normalized)) throw new Error('invalid recovery phrase')
  return identityFromSecretKey(privateKeyFromSeedWords(normalized, passphrase))
}

/** For users importing an existing Nostr key rather than creating one. */
export function identityFromNsec(nsec: string): Identity {
  const trimmed = nsec.trim()
  if (isHex32(trimmed)) return identityFromSecretKey(hexToBytes(trimmed))
  const decoded = decodeNip19(trimmed)
  if (decoded?.type !== 'nsec') throw new Error('not an nsec')
  return identityFromSecretKey(decoded.data)
}

export const isValidMnemonic = (mnemonic: string): boolean => validateWords(normalizeMnemonic(mnemonic))

/** Collapse whitespace and normalise case so a pasted phrase validates. */
export const normalizeMnemonic = (mnemonic: string): string =>
  mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/** Keys generated without a mnemonic (used only where a throwaway key is fine). */
export const randomSecretKey = (): Uint8Array => generateSecretKey()

export const toNpub = (pubkeyHex: string): string => nip19.npubEncode(pubkeyHex)
export const toNsec = (secretKey: Uint8Array): string => nip19.nsecEncode(secretKey)
export const secretKeyToHex = (secretKey: Uint8Array): string => bytesToHex(secretKey)

/**
 * Accept anything a user might paste and return a 32-byte hex pubkey:
 * npub, nprofile, a bare hex key, or a `nostr:` URI.
 */
export function parsePubkey(input: string): string | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  if (isHex32(raw)) return raw
  const decoded = decodeNip19(raw)
  if (decoded?.type === 'npub') return decoded.data
  if (decoded?.type === 'nprofile') return decoded.data.pubkey
  return null
}

/** Relay hints travel with an nprofile; surface them when a user pastes one. */
export function parseProfilePointer(input: string): { pubkey: string; relays: string[] } | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  if (isHex32(raw)) return { pubkey: raw, relays: [] }
  const decoded = decodeNip19(raw)
  if (decoded?.type === 'npub') return { pubkey: decoded.data, relays: [] }
  if (decoded?.type === 'nprofile') return { pubkey: decoded.data.pubkey, relays: decoded.data.relays ?? [] }
  return null
}

/** Short, stable label for a key when the user has not named the contact. */
export function shortNpub(npubOrHex: string): string {
  const npub = npubOrHex.startsWith('npub1') ? npubOrHex : toNpub(npubOrHex)
  return `${npub.slice(0, 10)}...${npub.slice(-6)}`
}
