import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, bytesToUtf8, concatBytes, randomBytes, utf8ToBytes, wipe } from '../util/bytes'

/**
 * At-rest encryption for the local vault.
 *
 * Key hierarchy - the passphrase is *not* used to encrypt records directly, so
 * changing it only rewraps one 32-byte key instead of re-encrypting the whole
 * database:
 *
 *   passphrase --scrypt(salt, params)--> KEK
 *   KEK        --XChaCha20-Poly1305---> wraps dataKey (random, 32 bytes)
 *   dataKey    --HKDF-SHA256----------> recordKey   (record bodies)
 *                                       indexKey    (blinded index keys)
 *                                       identityKey (the Nostr secret key)
 *
 * The identity secret gets its own subkey so a later "read-only unlock" or an
 * external signer (NIP-46) can withhold signing capability while still
 * decrypting history.
 */

export const SEALED_VERSION = 1
const NONCE_LEN = 24

export type SealedBlob = Uint8Array

export interface VaultKeys {
  readonly dataKey: Uint8Array
  readonly recordKey: Uint8Array
  readonly indexKey: Uint8Array
  readonly identityKey: Uint8Array
}

const INFO = {
  record: 'textor/vault/record/v1',
  index: 'textor/vault/index/v1',
  identity: 'textor/vault/identity/v1',
} as const

function subkey(dataKey: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, dataKey, undefined, utf8ToBytes(info), 32)
}

export function deriveVaultKeys(dataKey: Uint8Array): VaultKeys {
  if (dataKey.length !== 32) throw new Error('dataKey must be 32 bytes')
  return {
    dataKey,
    recordKey: subkey(dataKey, INFO.record),
    indexKey: subkey(dataKey, INFO.index),
    identityKey: subkey(dataKey, INFO.identity),
  }
}

export function wipeVaultKeys(keys: VaultKeys | null | undefined): void {
  if (!keys) return
  wipe(keys.dataKey, keys.recordKey, keys.indexKey, keys.identityKey)
}

export const generateDataKey = (): Uint8Array => randomBytes(32)

/**
 * Seal bytes under `key`, binding them to `aad`.
 *
 * The AAD is the record's logical address (table + primary key). Binding it
 * means an attacker with write access to IndexedDB cannot move a valid
 * ciphertext to a different row - say, swapping one contact's metadata onto
 * another contact - without the tag failing.
 *
 * Layout: version(1) || nonce(24) || ciphertext+tag
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): SealedBlob {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = xchacha20poly1305(key, nonce, utf8ToBytes(aad))
  return concatBytes(new Uint8Array([SEALED_VERSION]), nonce, cipher.encrypt(plaintext))
}

export function open(key: Uint8Array, blob: SealedBlob, aad: string): Uint8Array {
  if (blob.length < 1 + NONCE_LEN + 16) throw new Error('sealed blob too short')
  const version = blob[0]
  if (version !== SEALED_VERSION) throw new Error(`unsupported sealed blob version ${String(version)}`)
  const nonce = blob.subarray(1, 1 + NONCE_LEN)
  const ciphertext = blob.subarray(1 + NONCE_LEN)
  const cipher = xchacha20poly1305(key, nonce, utf8ToBytes(aad))
  return cipher.decrypt(ciphertext)
}

export function sealJson(key: Uint8Array, value: unknown, aad: string): SealedBlob {
  return seal(key, utf8ToBytes(JSON.stringify(value)), aad)
}

export function openJson<T>(key: Uint8Array, blob: SealedBlob, aad: string): T {
  return JSON.parse(bytesToUtf8(open(key, blob, aad))) as T
}

/**
 * Deterministic, unlinkable primary keys.
 *
 * Dexie indexes are stored in the clear inside IndexedDB. Keying rows by a raw
 * pubkey would hand a device attacker the full social graph without ever
 * breaking a ciphertext. Blinding through HMAC(indexKey, ...) keeps lookups
 * O(1) while making the index meaningless to anyone who cannot unlock.
 */
export function blindId(indexKey: Uint8Array, domain: string, value: string): string {
  return bytesToHex(hmac(sha256, indexKey, utf8ToBytes(domain + ' ' + value))).slice(0, 32)
}

/** Stable id for a 1:1 conversation, independent of who initiated it. */
export function conversationId(indexKey: Uint8Array, a: string, b: string): string {
  return blindId(indexKey, 'convo', [a, b].sort().join(':'))
}

export const contactId = (indexKey: Uint8Array, pubkey: string): string =>
  blindId(indexKey, 'contact', pubkey)

export const seenEventId = (indexKey: Uint8Array, eventId: string): string =>
  blindId(indexKey, 'seen', eventId)
