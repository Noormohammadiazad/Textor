import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { Mutex } from '../util/mutex'
import { bytesToHex, hexToBytes, randomBytes, wipe } from '../util/bytes'
import { MINUTE } from '../util/time'
import { assertKdfParams, DEFAULT_KDF_PARAMS, type KdfParams } from '../crypto/kdf'
import { deriveKekOffThread, disposeKdfWorker } from '../crypto/kdfClient'
import {
  deriveVaultKeys,
  generateDataKey,
  open as openSealed,
  openJson,
  seal,
  sealJson,
  wipeVaultKeys,
  type VaultKeys,
} from '../crypto/vaultCrypto'
import { getDb, META_KEYS, type TextorDatabase } from './db'

const log = createLogger('vault')

export type VaultStatus = 'empty' | 'locked' | 'unlocked'

export type VaultEvents = {
  statusChanged: VaultStatus
  /** Emitted when auto-lock fires, so the UI can explain why it happened. */
  autoLocked: void
}

export class VaultLockedError extends Error {
  constructor() {
    super('vault is locked')
    this.name = 'VaultLockedError'
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase')
    this.name = 'WrongPassphraseError'
  }
}

/**
 * Raised when the vault header is gone. This is not exotic: clearing site data
 * in another tab, a browser evicting storage under pressure, or private-mode
 * quirks all produce it, and the right response is to send the user back to
 * onboarding rather than to an error message on a lock screen for a vault that
 * no longer exists.
 */
export class NoVaultError extends Error {
  constructor() {
    super('no vault on this device')
    this.name = 'NoVaultError'
  }
}

const AAD_DATA_KEY = 'textor/meta/dataKey'

/**
 * Owns the vault key material and the lock lifecycle.
 *
 * Unlocked keys live only in this object's private fields — never in
 * localStorage, sessionStorage, or a service worker. That is what makes a
 * closed tab equivalent to a locked vault, and it is also why the outbox cannot
 * be flushed by a background sync: the worker has nothing to decrypt with. We
 * accept the delivery-latency cost rather than persist a key.
 */
export class Vault {
  readonly events = new Emitter<VaultEvents>()
  readonly db: TextorDatabase

  #keys: VaultKeys | null = null
  #status: VaultStatus = 'locked'
  #autoLockTimer: ReturnType<typeof setTimeout> | null = null
  #autoLockMs = 15 * MINUTE
  #writeLock = new Mutex()

  constructor(db: TextorDatabase = getDb()) {
    this.db = db
  }

  get status(): VaultStatus {
    return this.#status
  }

  get isUnlocked(): boolean {
    return this.#keys !== null
  }

  get keys(): VaultKeys {
    if (!this.#keys) throw new VaultLockedError()
    return this.#keys
  }

  /** Serialise multi-step writes so concurrent callers cannot interleave. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.#writeLock.run(fn)
  }

  async refreshStatus(): Promise<VaultStatus> {
    if (this.#keys) return this.#setStatus('unlocked')
    const wrapped = await this.db.meta.get(META_KEYS.wrappedDataKey)
    return this.#setStatus(wrapped ? 'locked' : 'empty')
  }

  async exists(): Promise<boolean> {
    return (await this.db.meta.get(META_KEYS.wrappedDataKey)) !== undefined
  }

  /**
   * Create a brand new vault. The data key is random and independent of the
   * passphrase, so `changePassphrase` later rewraps 32 bytes instead of
   * rewriting every record.
   */
  async create(
    passphrase: string,
    opts: { params?: KdfParams; onProgress?: (fraction: number) => void } = {},
  ): Promise<void> {
    if (await this.exists()) throw new Error('vault already exists')
    const params = opts.params ?? DEFAULT_KDF_PARAMS
    assertKdfParams(params)

    const salt = randomBytes(32)
    const kek = await deriveKekOffThread(passphrase, salt, params, opts.onProgress)
    const dataKey = generateDataKey()
    try {
      const wrapped = seal(kek, dataKey, AAD_DATA_KEY)
      await this.db.meta.bulkPut([
        { k: META_KEYS.schemaVersion, v: 1 },
        { k: META_KEYS.kdfSalt, v: bytesToHex(salt) },
        { k: META_KEYS.kdfParams, v: params },
        { k: META_KEYS.wrappedDataKey, v: wrapped },
        { k: META_KEYS.createdAt, v: Date.now() },
        { k: META_KEYS.keyEpoch, v: 1 },
      ])
      this.#adopt(dataKey)
    } finally {
      wipe(kek)
    }
  }

  async unlock(passphrase: string, onProgress?: (fraction: number) => void): Promise<void> {
    const [saltRow, paramsRow, wrappedRow] = await Promise.all([
      this.db.meta.get(META_KEYS.kdfSalt),
      this.db.meta.get(META_KEYS.kdfParams),
      this.db.meta.get(META_KEYS.wrappedDataKey),
    ])
    if (!saltRow || !paramsRow || !wrappedRow) throw new NoVaultError()

    const params = paramsRow.v as KdfParams
    assertKdfParams(params)
    const salt = hexToBytes(saltRow.v as string)
    const wrapped = toBytes(wrappedRow.v)

    const kek = await deriveKekOffThread(passphrase, salt, params, onProgress)
    try {
      let dataKey: Uint8Array
      try {
        dataKey = openSealed(kek, wrapped, AAD_DATA_KEY)
      } catch {
        // A failed Poly1305 tag is the only passphrase check there is; we store
        // no separate verifier, which means no oracle for offline guessing
        // beyond the KDF itself.
        throw new WrongPassphraseError()
      }
      this.#adopt(dataKey)
    } finally {
      wipe(kek)
    }
  }

  lock(reason: 'manual' | 'auto' = 'manual'): void {
    if (!this.#keys) return
    wipeVaultKeys(this.#keys)
    this.#keys = null
    this.#clearAutoLock()
    disposeKdfWorker()
    log.info(`locked (${reason})`)
    this.#setStatus('locked')
    if (reason === 'auto') this.events.emit('autoLocked', undefined)
  }

  /**
   * Rewrap the data key under a new passphrase. Record ciphertexts are
   * untouched, so this is instant regardless of history size.
   */
  async changePassphrase(
    currentPassphrase: string,
    nextPassphrase: string,
    opts: { params?: KdfParams; onProgress?: (fraction: number) => void } = {},
  ): Promise<void> {
    const [saltRow, paramsRow, wrappedRow] = await Promise.all([
      this.db.meta.get(META_KEYS.kdfSalt),
      this.db.meta.get(META_KEYS.kdfParams),
      this.db.meta.get(META_KEYS.wrappedDataKey),
    ])
    if (!saltRow || !paramsRow || !wrappedRow) throw new NoVaultError()

    const oldParams = paramsRow.v as KdfParams
    const oldKek = await deriveKekOffThread(currentPassphrase, hexToBytes(saltRow.v as string), oldParams)
    let dataKey: Uint8Array
    try {
      dataKey = openSealed(oldKek, toBytes(wrappedRow.v), AAD_DATA_KEY)
    } catch {
      throw new WrongPassphraseError()
    } finally {
      wipe(oldKek)
    }

    // A new salt on every change keeps two generations of the same passphrase
    // from producing the same KEK.
    const newSalt = randomBytes(32)
    // Changing the passphrase also re-derives under the *current* defaults, so
    // a vault created years ago picks up stronger parameters for free.
    const newParams = opts.params ?? DEFAULT_KDF_PARAMS
    assertKdfParams(newParams)
    const newKek = await deriveKekOffThread(nextPassphrase, newSalt, newParams, opts.onProgress)
    try {
      const epoch = ((await this.db.meta.get(META_KEYS.keyEpoch))?.v as number | undefined) ?? 1
      await this.db.meta.bulkPut([
        { k: META_KEYS.kdfSalt, v: bytesToHex(newSalt) },
        { k: META_KEYS.kdfParams, v: newParams },
        { k: META_KEYS.wrappedDataKey, v: seal(newKek, dataKey, AAD_DATA_KEY) },
        { k: META_KEYS.keyEpoch, v: epoch + 1 },
      ])
    } finally {
      wipe(newKek)
      // The live session keeps working: the data key itself did not change.
      wipe(dataKey)
    }
  }

  // --- sealing helpers, used by every repository ---------------------------

  sealRecord(value: unknown, aad: string): Uint8Array {
    return sealJson(this.keys.recordKey, value, aad)
  }

  openRecord<T>(blob: Uint8Array, aad: string): T {
    return openJson<T>(this.keys.recordKey, toBytes(blob), aad)
  }

  /** The identity secret uses its own subkey — see crypto/vaultCrypto.ts. */
  sealIdentity(value: unknown, aad: string): Uint8Array {
    return sealJson(this.keys.identityKey, value, aad)
  }

  openIdentity<T>(blob: Uint8Array, aad: string): T {
    return openJson<T>(this.keys.identityKey, toBytes(blob), aad)
  }

  // --- auto-lock ------------------------------------------------------------

  configureAutoLock(minutes: number): void {
    this.#autoLockMs = Math.max(0, minutes) * MINUTE
    this.touch()
  }

  /** Called on user activity; restarts the idle countdown. */
  touch(): void {
    this.#clearAutoLock()
    if (!this.#keys || this.#autoLockMs <= 0) return
    this.#autoLockTimer = setTimeout(() => this.lock('auto'), this.#autoLockMs)
  }

  #clearAutoLock(): void {
    if (this.#autoLockTimer) clearTimeout(this.#autoLockTimer)
    this.#autoLockTimer = null
  }

  #adopt(dataKey: Uint8Array): void {
    wipeVaultKeys(this.#keys)
    this.#keys = deriveVaultKeys(dataKey)
    this.#setStatus('unlocked')
    this.touch()
  }

  #setStatus(status: VaultStatus): VaultStatus {
    if (this.#status !== status) {
      this.#status = status
      this.events.emit('statusChanged', status)
    }
    return status
  }
}

/**
 * IndexedDB hands back ArrayBuffer in some engines and Uint8Array in others,
 * and structured-clone round trips can widen the view. Normalise on read.
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('expected binary vault field')
}
