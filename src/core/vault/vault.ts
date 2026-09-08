import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { Mutex } from '../util/mutex'
import { constantTimeEqual, toBytes, wipe } from '../util/bytes'
import { MINUTE } from '../util/time'
import type { KdfParams } from '../crypto/kdf'
import { disposeKdfWorker } from '../crypto/kdfClient'
import {
  deriveVaultKeys,
  generateDataKey,
  openJson,
  sealJson,
  wipeVaultKeys,
  type VaultKeys,
} from '../crypto/vaultCrypto'
import { getDb, META_KEYS, type TextorDatabase } from './db'
import {
  isGuarded,
  isRetiredSlot,
  LEGACY_SLOT_ID,
  makeSlot,
  MAX_PIN_FAILURES,
  openSlot,
  parseSlots,
  summarize,
  upgradeLegacySlot,
  WrongPinError,
  WrongSecretError,
  type Keyslot,
  type KeyslotSummary,
  type PassphraseSlot,
  type PinSlot,
  type SlotEnrolment,
  type SlotSecret,
} from './keyslots'

export { toBytes }
export { WrongPassphraseError, WrongPinError, WrongSecretError } from './keyslots'
export type { KeyslotSummary, KeyslotType, PinStyle, SlotEnrolment, SlotSecret } from './keyslots'

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

/** Refused: removing it would leave nothing that opens the vault. */
export class LastKeyslotError extends Error {
  constructor() {
    super('the last way to open this vault cannot be removed')
    this.name = 'LastKeyslotError'
  }
}

/**
 * Refused: opening instantly beside a way in that asks for something would
 * make that way pointless, so it is offered only on a device nothing else
 * guards (ADR-059).
 */
export class InstantOpenError extends Error {
  constructor() {
    super('opening instantly is only for a device no other way in guards')
    this.name = 'InstantOpenError'
  }
}

/**
 * Opening instantly never sits beside a way in that asks for something: the
 * way that asks wins, and the instant slot, key and all, is dropped (ADR-059).
 */
const exclusive = (slots: Keyslot[]): Keyslot[] =>
  slots.some(isGuarded) ? slots.filter((slot) => slot.type !== 'device') : slots

/**
 * Owns the vault key material and the lock lifecycle.
 *
 * Unlocked keys live only in this object's private fields — never in
 * localStorage, sessionStorage, or a service worker. A closed tab is a locked
 * vault. What opens it again is a keyslot (ADR-054): a passphrase, the recovery
 * phrase, a PIN or pattern, a local key behind the platform's biometrics or a
 * security key (ADR-058), or — where nothing else guards the device — a local
 * key with nothing in front of it (ADR-059). That last one is the only slot a
 * page can open unattended, and even it is never handed to the service worker,
 * which keeps the outbox waiting for an open tab (ADR-007).
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
    return this.#setStatus((await this.exists()) ? 'locked' : 'empty')
  }

  async exists(): Promise<boolean> {
    const [slots, legacy] = await Promise.all([
      this.db.meta.get(META_KEYS.keyslots),
      this.db.meta.get(META_KEYS.wrappedDataKey),
    ])
    return slots !== undefined || legacy !== undefined
  }

  /** The ways this vault opens. Readable while locked: the lock screen is built from it. */
  async keyslots(): Promise<KeyslotSummary[]> {
    return (await this.#readSlots()).map(summarize)
  }

  /**
   * Create a brand new vault, opened by `first`. The data key is random and
   * independent of every slot, so a slot added or removed later seals or drops
   * 32 bytes instead of rewriting every record. A string is a passphrase.
   */
  async create(
    first: string | SlotEnrolment,
    opts: { params?: KdfParams; onProgress?: (fraction: number) => void } = {},
  ): Promise<void> {
    if (await this.exists()) throw new Error('vault already exists')
    const enrolment: SlotEnrolment =
      typeof first === 'string'
        ? { type: 'passphrase', passphrase: first, params: opts.params, onProgress: opts.onProgress }
        : first
    const dataKey = generateDataKey()
    try {
      const slot = await makeSlot(enrolment, dataKey)
      await this.db.meta.bulkPut([
        { k: META_KEYS.schemaVersion, v: 2 },
        { k: META_KEYS.keyslots, v: [slot] },
        { k: META_KEYS.createdAt, v: Date.now() },
        { k: META_KEYS.keyEpoch, v: 1 },
      ])
    } catch (err) {
      wipe(dataKey)
      throw err
    }
    this.#adopt(dataKey)
  }

  /** Open with a passphrase. */
  unlock(passphrase: string, onProgress?: (fraction: number) => void): Promise<void> {
    return this.unlockWith({ type: 'passphrase', passphrase, onProgress })
  }

  /** Open with any slot's secret. Throws `WrongSecretError` if it does not open one. */
  async unlockWith(secret: SlotSecret): Promise<void> {
    this.#adopt(await this.#open(secret))
    // Another tab running an earlier build may have written what this one
    // does not allow since the app started.
    await this.tidy()
  }

  /**
   * Bring the stored slots in line with what this build allows. It only ever
   * takes ways in away, so it runs while locked too — at start, before
   * anything is opened:
   *
   *   - a slot an earlier build made and this one cannot open, a passkey's
   *     PRF output (ADR-058);
   *   - opening instantly, beside a way in that asks for something (ADR-059).
   *
   * Says whether a retired slot was there, so the lock screen can say why the
   * passkey no longer works. A failure to write is logged, and tried again at
   * the next start or unlock.
   */
  async tidy(): Promise<{ retired: boolean }> {
    const row = await this.db.meta.get(META_KEYS.keyslots)
    const retired = Array.isArray(row?.v) && row.v.some(isRetiredSlot)
    const slots = await this.#readSlots()
    const instantBesideGuard = slots.some((slot) => slot.type === 'device') && slots.some(isGuarded)
    if (retired || instantBesideGuard) {
      try {
        await this.#saveSlots((current) => current)
        log.info('keyslots tidied')
      } catch (err) {
        log.warn('keyslots could not be tidied', err)
      }
    }
    return { retired }
  }

  /**
   * Check a secret against the open vault, without changing what is open: the
   * re-authentication asked for before something sensitive, like showing the
   * recovery phrase or adding a way in.
   */
  async verify(secret: SlotSecret): Promise<void> {
    this.#requireUnlocked()
    const dataKey = await this.#open(secret)
    try {
      if (!constantTimeEqual(dataKey, this.keys.dataKey)) throw new WrongSecretError(secret.type)
    } finally {
      wipe(dataKey)
    }
  }

  /**
   * Seal the open vault's data key under a new slot. It replaces any slot of
   * the same kind: one passphrase, one PIN or pattern, one biometric, one
   * device key, one recovery phrase.
   *
   * A way in that asks for something removes opening instantly, in the same
   * write; opening instantly is refused beside one (ADR-059).
   */
  async addSlot(enrolment: SlotEnrolment): Promise<KeyslotSummary> {
    // A copy: locking during a slow derivation wipes the live key in place,
    // and a slot sealed around zeros would open to nothing.
    const dataKey = this.keys.dataKey.slice()
    try {
      const slot = await makeSlot(enrolment, dataKey)
      if (!this.#keys || !constantTimeEqual(dataKey, this.#keys.dataKey)) throw new VaultLockedError()
      await this.#saveSlots((slots) => {
        const rest = slots.filter((other) => other.type !== slot.type)
        // Checked in the write itself: another tab may have added one since.
        if (slot.type === 'device' && rest.some(isGuarded)) throw new InstantOpenError()
        return [...rest, slot]
      })
      return summarize(slot)
    } finally {
      wipe(dataKey)
    }
  }

  /**
   * Remove a slot. It stops opening the vault from now on — but a copy of this
   * device's data taken earlier still holds the old sealed key, and opens with
   * the old secret. Only a new data key would change that.
   */
  async removeSlot(id: string): Promise<void> {
    this.#requireUnlocked()
    await this.#saveSlots((slots) => {
      const rest = slots.filter((slot) => slot.id !== id)
      if (rest.length === 0) throw new LastKeyslotError()
      return rest
    })
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
   * Replace the passphrase slot, proving the current passphrase first. Record
   * ciphertexts are untouched, so this is instant regardless of history size,
   * and a new passphrase is derived under the current defaults, so a vault
   * created years ago picks up stronger parameters for free.
   */
  async changePassphrase(
    currentPassphrase: string,
    nextPassphrase: string,
    opts: { params?: KdfParams; onProgress?: (fraction: number) => void } = {},
  ): Promise<void> {
    const dataKey = await this.#open({ type: 'passphrase', passphrase: currentPassphrase })
    try {
      const slot = await makeSlot({ type: 'passphrase', passphrase: nextPassphrase, ...opts }, dataKey)
      await this.#saveSlots((slots) => [...slots.filter((other) => other.type !== 'passphrase'), slot])
    } finally {
      // The live session keeps working: the data key itself did not change.
      wipe(dataKey)
    }
  }

  async #open(secret: SlotSecret): Promise<Uint8Array> {
    const slots = await this.#readSlots()
    if (slots.length === 0 && !(await this.exists())) throw new NoVaultError()
    const slot = slots.find((candidate) => candidate.type === secret.type)
    if (!slot) throw new WrongSecretError(secret.type)
    // An instant slot beside a way in that asks for something, left by an
    // earlier build or another tab, opens nothing; the next write drops it.
    if (slot.type === 'device' && slots.some(isGuarded)) throw new WrongSecretError('device')
    if (slot.type === 'pin') return this.#openPin(slot, secret)
    if (slot.id !== LEGACY_SLOT_ID || secret.type !== 'passphrase') return openSlot(slot, secret)

    const upgraded = await upgradeLegacySlot(slot as PassphraseSlot, secret)
    try {
      await this.#saveSlots((current) =>
        current.map((other) => (other.id === LEGACY_SLOT_ID ? upgraded.slot : other)),
      )
      log.info('vault header moved to keyslots')
    } catch (err) {
      // Still opens the old way next time; try again then.
      log.warn('vault header could not be moved to keyslots', err)
    }
    return upgraded.dataKey
  }

  /**
   * Open a PIN slot, counting the tries. A wrong one is recorded before it is
   * reported, and the `MAX_PIN_FAILURES`th erases the slot — unless it is the
   * only way in, which a lockout must never destroy. A right one clears the
   * count. Opening to confirm the person, from Settings, counts the same way.
   */
  async #openPin(slot: PinSlot, secret: SlotSecret): Promise<Uint8Array> {
    let dataKey: Uint8Array
    try {
      dataKey = await openSlot(slot, secret)
    } catch (err) {
      if (!(err instanceof WrongSecretError)) throw err
      let triesLeft: number | null = 0
      await this.#saveSlots((slots) => {
        const current = slots.find((other) => other.id === slot.id) as PinSlot | undefined
        // Erased meanwhile, by another tab's wrong try.
        if (!current) return slots
        const failures = current.failures + 1
        const others = slots.some((other) => other.id !== slot.id)
        if (failures >= MAX_PIN_FAILURES && others) return slots.filter((other) => other.id !== slot.id)
        triesLeft = others ? MAX_PIN_FAILURES - failures : null
        return slots.map((other) => (other.id === slot.id ? { ...current, failures } : other))
      })
      if (triesLeft === 0) log.warn('PIN erased after too many wrong tries')
      throw new WrongPinError(triesLeft)
    }
    if (slot.failures > 0) {
      await this.#saveSlots((slots) =>
        slots.map((other) => (other.id === slot.id ? { ...slot, failures: 0 } : other)),
      )
    }
    return dataKey
  }

  /** Every slot, including a pre-keyslot header read as one. */
  async #readSlots(): Promise<Keyslot[]> {
    const rows = await this.db.meta.bulkGet([
      META_KEYS.keyslots,
      META_KEYS.kdfSalt,
      META_KEYS.kdfParams,
      META_KEYS.wrappedDataKey,
      META_KEYS.createdAt,
    ])
    const [slotsRow, saltRow, paramsRow, wrappedRow, createdRow] = rows
    const slots = parseSlots(slotsRow?.v)
    if (saltRow && paramsRow && wrappedRow) {
      try {
        slots.push({
          id: LEGACY_SLOT_ID,
          type: 'passphrase',
          createdAt: (createdRow?.v as number | undefined) ?? 0,
          salt: String(saltRow.v),
          params: paramsRow.v as KdfParams,
          wrapped: toBytes(wrappedRow.v),
        })
      } catch {
        log.warn('the pre-keyslot vault header is damaged')
      }
    }
    return slots
  }

  /**
   * Rewrite the slot list in one transaction, so two tabs changing it at once
   * cannot drop each other's change. Every write keeps opening instantly apart
   * from any way in that asks for something, and writes only the slots this
   * build can read. A pre-keyslot header stays where it is until something
   * replaces or removes it.
   */
  async #saveSlots(change: (slots: Keyslot[]) => Keyslot[]): Promise<void> {
    await this.db.transaction('rw', this.db.meta, async () => {
      const next = exclusive(change(await this.#readSlots()))
      const epoch = ((await this.db.meta.get(META_KEYS.keyEpoch))?.v as number | undefined) ?? 1
      await this.db.meta.bulkPut([
        { k: META_KEYS.schemaVersion, v: 2 },
        { k: META_KEYS.keyslots, v: next.filter((slot) => slot.id !== LEGACY_SLOT_ID) },
        { k: META_KEYS.keyEpoch, v: epoch + 1 },
      ])
      if (!next.some((slot) => slot.id === LEGACY_SLOT_ID)) {
        await this.db.meta.bulkDelete([META_KEYS.kdfSalt, META_KEYS.kdfParams, META_KEYS.wrappedDataKey])
      }
    })
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

  #requireUnlocked(): void {
    if (!this.#keys) throw new VaultLockedError()
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
