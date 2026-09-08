import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import type { CiphersuiteImpl, Hpke, PrivateKey, PublicKey } from 'ts-mls'
import { concatBytes, constantTimeEqual, utf8ToBytes } from '../util/bytes'

/**
 * MLS ciphersuite 0x0001 — MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519, the
 * one every Marmot client must support — built from the audited @noble
 * primitives the rest of the app already uses.
 *
 * ts-mls ships its own providers, but they reach for WebCrypto's X25519 and
 * Ed25519, which not every browser this app supports has, and when they are
 * missing they fail at the first group operation. Nothing here needs more
 * than JavaScript: no WebCrypto curve, no WASM, nothing the CSP has to allow.
 *
 * HPKE (RFC 9180) is the one construction written out below rather than
 * imported, in base mode only: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * AES-128-GCM. It is a composition of those primitives in the order the RFC
 * gives, and it is checked against the reference HPKE implementation that
 * ts-mls depends on, in both directions (`tests/mlsSuite.test.ts`).
 */

const EMPTY = new Uint8Array(0)
const V1 = utf8ToBytes('HPKE-v1')

const i2osp = (value: number, width: number): Uint8Array => {
  const out = new Uint8Array(width)
  for (let i = width - 1, rest = value; i >= 0; i--, rest = Math.floor(rest / 256)) out[i] = rest & 0xff
  return out
}

// suite_id per RFC 9180 §4.1 (KEM) and §5.1 (HPKE): KEM 0x0020, KDF 0x0001, AEAD 0x0001.
const KEM_SUITE = concatBytes(utf8ToBytes('KEM'), i2osp(0x0020, 2))
const HPKE_SUITE = concatBytes(utf8ToBytes('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0001, 2))

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concatBytes(V1, suite, utf8ToBytes(label), ikm), salt)

const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(sha256, prk, concatBytes(i2osp(length, 2), V1, suite, utf8ToBytes(label), info), length)

/**
 * ts-mls types HPKE keys as WebCrypto `CryptoKey`s but never looks inside
 * them: every use goes back through this module. So a key is its raw bytes,
 * tagged, and cast once at the boundary.
 */
interface RawKey {
  readonly type: 'private' | 'public'
  readonly raw: Uint8Array
}
const privateKey = (raw: Uint8Array) => ({ type: 'private', raw }) as unknown as PrivateKey
const publicKey = (raw: Uint8Array) => ({ type: 'public', raw }) as unknown as PublicKey
const rawOf = (key: PrivateKey | PublicKey): Uint8Array => (key as unknown as RawKey).raw

function deriveKeyPair(ikm: Uint8Array): { privateKey: PrivateKey; publicKey: PublicKey } {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm)
  const sk = labeledExpand(KEM_SUITE, prk, 'sk', EMPTY, 32)
  return { privateKey: privateKey(sk), publicKey: publicKey(x25519.getPublicKey(sk)) }
}

/**
 * X25519. A low-order public key forces an all-zero result, which RFC 9180
 * §7.1.4 says to abort on; noble already refuses to return one (RFC 7748 §6.1).
 */
const dh = (sk: Uint8Array, pk: Uint8Array): Uint8Array => x25519.getSharedSecret(sk, pk)

function extractAndExpand(sharedDh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', sharedDh)
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32)
}

function encap(pkR: Uint8Array): { shared: Uint8Array; enc: Uint8Array } {
  const ephemeral = deriveKeyPair(randomBytes(32))
  const enc = rawOf(ephemeral.publicKey)
  return { shared: extractAndExpand(dh(rawOf(ephemeral.privateKey), pkR), concatBytes(enc, pkR)), enc }
}

function decap(enc: Uint8Array, skR: Uint8Array): Uint8Array {
  return extractAndExpand(dh(skR, enc), concatBytes(enc, x25519.getPublicKey(skR)))
}

/** RFC 9180 §5.1, mode_base: no PSK. */
function keySchedule(shared: Uint8Array, info: Uint8Array) {
  const context = concatBytes(
    new Uint8Array([0x00]),
    labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY),
    labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info),
  )
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY)
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, 16),
    nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12),
    exporter: labeledExpand(HPKE_SUITE, secret, 'exp', context, 32),
  }
}

const exportFrom = (exporter: Uint8Array, context: Uint8Array, length: number) =>
  labeledExpand(HPKE_SUITE, exporter, 'sec', context, length)

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function checkLength(key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('HPKE: X25519 keys are 32 bytes')
  return new Uint8Array(key)
}

const hpke: Hpke = {
  async seal(recipient, plaintext, info, aad) {
    const { shared, enc } = encap(rawOf(recipient))
    const ks = keySchedule(shared, info)
    return { ct: gcm(ks.key, ks.nonce, aad ?? EMPTY).encrypt(plaintext), enc }
  },
  async open(recipient, kemOutput, ciphertext, info, aad) {
    const ks = keySchedule(decap(kemOutput, rawOf(recipient)), info)
    return gcm(ks.key, ks.nonce, aad ?? EMPTY).decrypt(ciphertext)
  },
  async exportSecret(recipient, exporterContext, length, info) {
    const { shared, enc } = encap(rawOf(recipient))
    return { enc, secret: exportFrom(keySchedule(shared, info).exporter, exporterContext, length) }
  },
  async importSecret(recipient, exporterContext, kemOutput, length, info) {
    return exportFrom(keySchedule(decap(kemOutput, rawOf(recipient)), info).exporter, exporterContext, length)
  },
  async importPrivateKey(key) {
    return privateKey(checkLength(key))
  },
  async importPublicKey(key) {
    return publicKey(checkLength(key))
  },
  async exportPublicKey(key) {
    return rawOf(key)
  },
  async exportPrivateKey(key) {
    return rawOf(key)
  },
  async encryptAead(key, nonce, aad, plaintext) {
    return gcm(key, nonce, aad ?? EMPTY).encrypt(plaintext)
  },
  async decryptAead(key, nonce, aad, ciphertext) {
    return gcm(key, nonce, aad ?? EMPTY).decrypt(ciphertext)
  },
  async deriveKeyPair(ikm) {
    return deriveKeyPair(ikm)
  },
  async generateKeyPair() {
    return deriveKeyPair(randomBytes(32))
  },
  keyLength: 16,
  nonceLength: 12,
}

/** The ciphersuite every group in this app uses. */
export const SUITE: CiphersuiteImpl = {
  name: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  hash: {
    async digest(data) {
      return sha256(data)
    },
    async mac(key, data) {
      return hmac(sha256, key, data)
    },
    async verifyMac(key, mac, data) {
      return constantTimeEqual(hmac(sha256, key, data), mac)
    },
  },
  kdf: {
    async extract(salt, ikm) {
      return extract(sha256, ikm, salt)
    },
    async expand(prk, info, length) {
      return expand(sha256, prk, info, length)
    },
    size: 32,
  },
  signature: {
    async sign(signKey, message) {
      return ed25519.sign(message, signKey)
    },
    async verify(key, message, signature) {
      try {
        return ed25519.verify(signature, message, key)
      } catch {
        return false
      }
    },
    async keygen() {
      const signKey = ed25519.utils.randomSecretKey()
      return { signKey, publicKey: ed25519.getPublicKey(signKey) }
    },
  },
  hpke,
  rng: { randomBytes },
}

/** MLS signature scheme id for Ed25519 (RFC 9420 §17.1), as Marmot proofs name it. */
export const SIGNATURE_SCHEME = 0x0807
/** MLS ciphersuite id, as Marmot tags and proofs name it. */
export const CIPHERSUITE_ID = 0x0001
