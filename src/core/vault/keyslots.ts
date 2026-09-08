import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { assertKdfParams, DEFAULT_KDF_PARAMS, type KdfParams } from '../crypto/kdf'
import { deriveKekOffThread } from '../crypto/kdfClient'
import { open as openSealed, seal } from '../crypto/vaultCrypto'
import { isValidMnemonic, normalizeMnemonic } from '../identity/keys'
import { bytesToHex, hexToBytes, randomBytes, toBytes, utf8ToBytes, wipe } from '../util/bytes'
import { spendPresence, type GateAuthenticator, type Presence } from '../crypto/biometricGate'

/**
 * Ways to open the vault, LUKS-style (ADR-054).
 *
 * The vault's data key is random and wraps nothing but the records (ADR-004),
 * so any number of secrets can each hold a sealed copy of it. Each copy is a
 * slot. Opening any one slot opens the vault; adding or removing a slot seals
 * or drops 32 bytes and never touches a record.
 *
 *   passphrase   scrypt(passphrase, salt), the parameters stored per slot
 *   recovery     HKDF of the twelve words the identity already comes from
 *   biometric    a non-extractable WebCrypto key kept beside the vault, used
 *                only once the platform authenticator — or a security key —
 *                has verified the person (ADR-058, ADR-059)
 *   pin          scrypt of a PIN or a pattern, erased after
 *                `MAX_PIN_FAILURES` wrong tries (ADR-058)
 *   device       a non-extractable WebCrypto key kept beside the vault, so
 *                the vault opens with nothing asked of anyone
 *
 * A vault is as strong as its weakest slot, and the interface says so. The
 * biometric slot and the device slot keep their key in the same place: what
 * differs is what Textor asks before using it, not what a copy of the
 * browser's data needs. So the device slot never sits beside one that asks
 * for something (ADR-059): it would make that one pointless.
 */

export type KeyslotType = 'passphrase' | 'recovery' | 'biometric' | 'pin' | 'device'

/**
 * The everyday ways in that ask the person for something. Opening instantly
 * is only ever the way in when none of these is (ADR-059).
 */
export const GUARDED: readonly KeyslotType[] = ['biometric', 'pin', 'passphrase']

export const isGuarded = (slot: { type: KeyslotType }): boolean => GUARDED.includes(slot.type)

/** A PIN is digits; a pattern is the dots of a 3×3 grid, numbered 1 to 9, in the order drawn. */
export type PinStyle = 'digits' | 'pattern'

interface SlotCommon {
  /** Random, and bound into the slot's AAD, so a sealed key cannot be moved between slots. */
  id: string
  createdAt: number
  /** The data key, sealed under this slot's key. */
  wrapped: Uint8Array
}

export interface PassphraseSlot extends SlotCommon {
  type: 'passphrase'
  salt: string
  params: KdfParams
}

export interface RecoverySlot extends SlotCommon {
  type: 'recovery'
  salt: string
}

/**
 * A key only this browser can use: non-extractable AES-GCM, generated here and
 * stored beside the vault. Script cannot read it out; a copy of the browser
 * profile can use it.
 */
interface LocalKey {
  key: CryptoKey
  iv: Uint8Array
}

export interface BiometricSlot extends SlotCommon, LocalKey {
  type: 'biometric'
  /** The credential whose verification the slot waits for, base64url. */
  credentialId: string
  /** This device's own authenticator, or a security key. */
  authenticator: GateAuthenticator
  /** How the authenticator said it is reached, where it said. */
  transports?: string[]
}

export interface PinSlot extends SlotCommon {
  type: 'pin'
  style: PinStyle
  salt: string
  params: KdfParams
  /** Wrong tries since the last right one. */
  failures: number
}

export interface DeviceSlot extends SlotCommon, LocalKey {
  type: 'device'
}

export type Keyslot = PassphraseSlot | RecoverySlot | BiometricSlot | PinSlot | DeviceSlot

/** What may be known about a slot while the vault is locked. */
export interface KeyslotSummary {
  id: string
  type: KeyslotType
  createdAt: number
  /** For a biometric slot: the credential to ask, and how to reach it. */
  credentialId?: string
  authenticator?: GateAuthenticator
  transports?: string[]
  /** For a PIN slot: which to ask for, and how many tries have gone wrong. */
  style?: PinStyle
  failures?: number
}

/** A secret offered to open a slot. */
export type SlotSecret =
  | { type: 'passphrase'; passphrase: string; onProgress?: (fraction: number) => void }
  | { type: 'recovery'; mnemonic: string }
  | { type: 'biometric'; presence: Presence }
  | { type: 'pin'; code: string; onProgress?: (fraction: number) => void }
  | { type: 'device' }

/** A secret to seal the data key under, as a new slot. */
export type SlotEnrolment =
  | {
      type: 'passphrase'
      passphrase: string
      params?: KdfParams
      onProgress?: (fraction: number) => void
    }
  | { type: 'recovery'; mnemonic: string }
  | { type: 'biometric'; presence: Presence }
  | {
      type: 'pin'
      style: PinStyle
      code: string
      params?: KdfParams
      onProgress?: (fraction: number) => void
    }
  | { type: 'device' }

/** A secret that does not open the slot it was offered to. */
export class WrongSecretError extends Error {
  constructor(
    readonly slot: KeyslotType,
    message = `that ${slot} does not open this vault`,
  ) {
    super(message)
    this.name = 'WrongSecretError'
  }
}

export class WrongPassphraseError extends WrongSecretError {
  constructor() {
    super('passphrase', 'wrong passphrase')
    this.name = 'WrongPassphraseError'
  }
}

/** A wrong PIN or pattern, and how many tries are left: 0 once it has been erased. */
export class WrongPinError extends WrongSecretError {
  constructor(
    /** Null where the PIN is the only way in, and so is never erased. */
    readonly triesLeft: number | null,
  ) {
    super('pin', 'wrong PIN')
    this.name = 'WrongPinError'
  }
}

/**
 * Wrong tries before a PIN slot is erased, and the person must open Textor
 * another way. A PIN's protection is this limit: its derivation stops nobody
 * who has a copy of the browser's data, and six digits fall to them in
 * minutes (ADR-058).
 */
export const MAX_PIN_FAILURES = 10

/**
 * A PIN's derivation is sized for waiting, not for guessing: a copy of the
 * data defeats a PIN at any cost the person would sit through, so it runs at
 * half the passphrase's.
 */
export const PIN_KDF_PARAMS: KdfParams = { algo: 'scrypt', N: 2 ** 15, r: 8, p: 1 }

/** Shortest PIN, and fewest dots in a pattern. */
export const MIN_PIN = { digits: 6, pattern: 4 } as const

const PIN_FORMAT: Record<PinStyle, RegExp> = {
  digits: /^\d{6,16}$/,
  // Four to nine dots, none twice.
  pattern: /^(?!.*(.).*\1)[1-9]{4,9}$/,
}

/** Digits as ASCII, whichever keyboard typed them: Persian and Arabic-Indic become 0–9. */
export const normalizePin = (code: string): string =>
  code
    .replace(/\s+/g, '')
    .replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) & 0xf))

export const isValidPin = (style: PinStyle, code: string): boolean =>
  PIN_FORMAT[style].test(normalizePin(code))

/**
 * The header of a vault made before keyslots: one passphrase, its salt and
 * parameters, and the data key sealed under it, each in its own `meta` row. It
 * reads as a passphrase slot with this id, and becomes an ordinary one the
 * first time it opens.
 */
export const LEGACY_SLOT_ID = 'legacy'
const LEGACY_AAD = 'textor/meta/dataKey'

const INFO_RECOVERY = {
  vault: utf8ToBytes('textor/keyslot/recovery/v1'),
  backup: utf8ToBytes('textor/backup/recovery/v1'),
}

const aadOf = (slot: Pick<Keyslot, 'id' | 'type'>): string =>
  slot.id === LEGACY_SLOT_ID ? LEGACY_AAD : `textor/keyslot/v1|${slot.type}|${slot.id}`

/**
 * The recovery phrase is 128 bits drawn uniformly at random, so it needs no
 * stretching: scrypt slows the guessing of a secret a person chose, and nobody
 * chose these words. What stretching would buy against someone who knows most
 * of them, they can already buy more cheaply against the public key the words
 * derive.
 */
export const recoveryKey = (
  mnemonic: string,
  salt: Uint8Array,
  purpose: keyof typeof INFO_RECOVERY = 'vault',
): Uint8Array => hkdf(sha256, utf8ToBytes(normalizeMnemonic(mnemonic)), salt, INFO_RECOVERY[purpose], 32)

const localAlgo = (slot: Pick<Keyslot, 'id' | 'type'> & { iv: Uint8Array }): AesGcmParams => ({
  name: 'AES-GCM',
  iv: slot.iv as Uint8Array<ArrayBuffer>,
  additionalData: utf8ToBytes(aadOf(slot)) as Uint8Array<ArrayBuffer>,
})

/** Seal `dataKey` under a new key only this browser can use. */
async function sealLocally(
  dataKey: Uint8Array,
  slot: Pick<Keyslot, 'id' | 'type'>,
): Promise<LocalKey & { wrapped: Uint8Array }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = randomBytes(12)
  const sealed = await crypto.subtle.encrypt(
    localAlgo({ ...slot, iv }),
    key,
    dataKey as Uint8Array<ArrayBuffer>,
  )
  return { key, iv, wrapped: new Uint8Array(sealed) }
}

async function openLocally(slot: BiometricSlot | DeviceSlot): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(localAlgo(slot), slot.key, slot.wrapped as Uint8Array<ArrayBuffer>),
    )
  } catch {
    throw new WrongSecretError(slot.type)
  }
}

function sealWith(kek: Uint8Array, dataKey: Uint8Array, slot: Pick<Keyslot, 'id' | 'type'>): Uint8Array {
  try {
    return seal(kek, dataKey, aadOf(slot))
  } finally {
    wipe(kek)
  }
}

function openWith(kek: Uint8Array, slot: Keyslot, wrong: () => WrongSecretError): Uint8Array {
  try {
    return openSealed(kek, slot.wrapped, aadOf(slot))
  } catch {
    // A failed tag is the only check there is: no verifier is stored, so
    // there is no oracle for guessing beyond the slot's own derivation.
    throw wrong()
  } finally {
    wipe(kek)
  }
}

/** Seal `dataKey` under a new slot. */
export async function makeSlot(
  enrolment: SlotEnrolment,
  dataKey: Uint8Array,
  now = Date.now(),
): Promise<Keyslot> {
  const common = { id: bytesToHex(randomBytes(8)), createdAt: now }
  switch (enrolment.type) {
    case 'passphrase': {
      const params = enrolment.params ?? DEFAULT_KDF_PARAMS
      assertKdfParams(params)
      const salt = randomBytes(32)
      const kek = await deriveKekOffThread(enrolment.passphrase, salt, params, enrolment.onProgress)
      const slot = { ...common, type: 'passphrase' as const, salt: bytesToHex(salt), params }
      return { ...slot, wrapped: sealWith(kek, dataKey, slot) }
    }
    case 'recovery': {
      if (!isValidMnemonic(enrolment.mnemonic)) throw new Error('invalid recovery phrase')
      const salt = randomBytes(32)
      const slot = { ...common, type: 'recovery' as const, salt: bytesToHex(salt) }
      return { ...slot, wrapped: sealWith(recoveryKey(enrolment.mnemonic, salt), dataKey, slot) }
    }
    case 'biometric': {
      // Proof that the authenticator verified the person moments ago: a
      // credential that cannot do that does not become a way in.
      const { presence } = enrolment
      if (!spendPresence(presence, presence.credentialId)) throw new Error('no fresh verification')
      const slot = {
        ...common,
        type: 'biometric' as const,
        credentialId: presence.credentialId,
        authenticator: presence.authenticator,
        ...(presence.transports?.length ? { transports: [...presence.transports] } : {}),
      }
      return { ...slot, ...(await sealLocally(dataKey, slot)) }
    }
    case 'pin': {
      if (!isValidPin(enrolment.style, enrolment.code)) throw new Error(`invalid ${enrolment.style}`)
      const params = enrolment.params ?? PIN_KDF_PARAMS
      assertKdfParams(params)
      const salt = randomBytes(32)
      const code = normalizePin(enrolment.code)
      const kek = await deriveKekOffThread(code, salt, params, enrolment.onProgress)
      const slot = {
        ...common,
        type: 'pin' as const,
        style: enrolment.style,
        salt: bytesToHex(salt),
        params,
        failures: 0,
      }
      return { ...slot, wrapped: sealWith(kek, dataKey, slot) }
    }
    case 'device': {
      const slot = { ...common, type: 'device' as const }
      return { ...slot, ...(await sealLocally(dataKey, slot)) }
    }
  }
}

/** Open a slot. Returns the data key, or throws `WrongSecretError`. */
export async function openSlot(slot: Keyslot, secret: SlotSecret): Promise<Uint8Array> {
  if (slot.type !== secret.type) throw new WrongSecretError(secret.type)
  switch (secret.type) {
    case 'passphrase': {
      const kek = await passphraseKek(slot as PassphraseSlot, secret)
      return openWith(kek, slot, () => new WrongPassphraseError())
    }
    case 'recovery': {
      if (!isValidMnemonic(secret.mnemonic)) throw new WrongSecretError('recovery')
      const kek = recoveryKey(secret.mnemonic, hexToBytes((slot as RecoverySlot).salt))
      return openWith(kek, slot, () => new WrongSecretError('recovery'))
    }
    case 'biometric': {
      const biometric = slot as BiometricSlot
      // No proof, a spent one, a stale one, or one for another credential.
      if (!spendPresence(secret.presence, biometric.credentialId)) throw new WrongSecretError('biometric')
      return openLocally(biometric)
    }
    case 'pin': {
      const pin = slot as PinSlot
      // Not a PIN at all: refused before anything is derived.
      if (!isValidPin(pin.style, secret.code)) throw new WrongSecretError('pin')
      const kek = await stretch(normalizePin(secret.code), pin, secret.onProgress)
      return openWith(kek, slot, () => new WrongSecretError('pin'))
    }
    case 'device':
      return openLocally(slot as DeviceSlot)
  }
}

function passphraseKek(
  slot: PassphraseSlot,
  secret: Extract<SlotSecret, { type: 'passphrase' }>,
): Promise<Uint8Array> {
  return stretch(secret.passphrase, slot, secret.onProgress)
}

function stretch(
  secret: string,
  slot: PassphraseSlot | PinSlot,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  // A tampered header must not make us allocate gigabytes.
  assertKdfParams(slot.params)
  return deriveKekOffThread(secret, hexToBytes(slot.salt), slot.params, onProgress)
}

/**
 * Open a pre-keyslot header, and reseal its data key as an ordinary
 * passphrase slot under the same passphrase. The key the passphrase derives is
 * reused: deriving it twice would double the one unlock that pays for this.
 */
export async function upgradeLegacySlot(
  legacy: PassphraseSlot,
  secret: Extract<SlotSecret, { type: 'passphrase' }>,
): Promise<{ dataKey: Uint8Array; slot: PassphraseSlot }> {
  const kek = await passphraseKek(legacy, secret)
  try {
    const dataKey = openWith(kek.slice(), legacy, () => new WrongPassphraseError())
    const slot = { ...legacy, id: bytesToHex(randomBytes(8)) }
    return { dataKey, slot: { ...slot, wrapped: seal(kek, dataKey, aadOf(slot)) } }
  } finally {
    wipe(kek)
  }
}

export function summarize(slot: Keyslot): KeyslotSummary {
  const summary: KeyslotSummary = { id: slot.id, type: slot.type, createdAt: slot.createdAt }
  if (slot.type === 'biometric') {
    summary.credentialId = slot.credentialId
    summary.authenticator = slot.authenticator
    if (slot.transports) summary.transports = [...slot.transports]
  }
  if (slot.type === 'pin') {
    summary.style = slot.style
    summary.failures = slot.failures
  }
  return summary
}

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{2})+$/.test(value)

const STYLES: readonly unknown[] = ['digits', 'pattern'] satisfies PinStyle[]

const TRANSPORTS: readonly unknown[] = ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal']

/** Transports as stored, if they are a short list of known ones; otherwise none. */
function transportsOf(value: unknown): { transports?: string[] } {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 6 &&
    value.every((t) => TRANSPORTS.includes(t))
    ? { transports: [...(value as string[])] }
    : {}
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * Kinds of slot an earlier build made and this one cannot open: a passkey's
 * PRF output (ADR-054 to ADR-057, retired by ADR-058). Read only to say so,
 * and dropped the next time the slots are saved.
 */
export const isRetiredSlot = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'webauthn-prf'

/**
 * Read slots back from storage, dropping any that are malformed. `meta` is the
 * one table stored in the clear, so its contents are checked rather than
 * trusted: a damaged slot must not stop the others from opening.
 */
export function parseSlots(value: unknown): Keyslot[] {
  if (!Array.isArray(value)) return []
  const slots: Keyslot[] = []
  for (const raw of value as Record<string, unknown>[]) {
    try {
      if (typeof raw.id !== 'string' || typeof raw.createdAt !== 'number') continue
      const common = { id: raw.id, createdAt: raw.createdAt, wrapped: toBytes(raw.wrapped) }
      if (raw.type === 'passphrase' && isHex(raw.salt) && typeof raw.params === 'object' && raw.params) {
        slots.push({ ...common, type: 'passphrase', salt: raw.salt, params: raw.params as KdfParams })
      } else if (raw.type === 'recovery' && isHex(raw.salt)) {
        slots.push({ ...common, type: 'recovery', salt: raw.salt })
      } else if (
        raw.type === 'pin' &&
        STYLES.includes(raw.style) &&
        isHex(raw.salt) &&
        typeof raw.params === 'object' &&
        raw.params &&
        isCount(raw.failures)
      ) {
        slots.push({
          ...common,
          type: 'pin',
          style: raw.style as PinStyle,
          salt: raw.salt,
          params: raw.params as KdfParams,
          failures: raw.failures,
        })
      } else if (
        raw.type === 'biometric' &&
        raw.key instanceof CryptoKey &&
        typeof raw.credentialId === 'string' &&
        raw.credentialId.length > 0 &&
        raw.credentialId.length <= 1024
      ) {
        slots.push({
          ...common,
          type: 'biometric',
          credentialId: raw.credentialId,
          // Slots from before security keys could guard one have no field: this device's own.
          authenticator: raw.authenticator === 'security-key' ? 'security-key' : 'platform',
          ...transportsOf(raw.transports),
          key: raw.key,
          iv: toBytes(raw.iv),
        })
      } else if (raw.type === 'device' && raw.key instanceof CryptoKey) {
        slots.push({ ...common, type: 'device', key: raw.key, iv: toBytes(raw.iv) })
      }
    } catch {
      // Not bytes where bytes belong: skip this slot, keep the rest.
    }
  }
  return slots
}

/**
 * Whether this browser can hold a non-extractable key, for opening instantly
 * or behind biometrics. WebCrypto exists only in a secure context; everything
 * else in the vault is pure JavaScript, so those are the only slots that need
 * it.
 */
export const canOpenInstantly = (): boolean => typeof globalThis.crypto?.subtle?.generateKey === 'function'
