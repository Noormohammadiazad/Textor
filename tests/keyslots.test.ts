import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { DEFAULT_KDF_PARAMS, deriveKek } from '@/core/crypto/kdf'
import { deriveVaultKeys, generateDataKey, seal } from '@/core/crypto/vaultCrypto'
import { confirmBiometric } from '@/core/crypto/biometricGate'
import { enrolBiometric } from '@/core/crypto/biometricEnrol'
import { bytesToB64url, bytesToHex, randomBytes } from '@/core/util/bytes'
import { META_KEYS, TextorDatabase } from '@/core/vault/db'
import {
  canOpenInstantly,
  isRetiredSlot,
  isValidPin,
  LEGACY_SLOT_ID,
  makeSlot,
  MAX_PIN_FAILURES,
  normalizePin,
  openSlot,
  parseSlots,
  PIN_KDF_PARAMS,
  recoveryKey,
  summarize,
  upgradeLegacySlot,
  WrongPassphraseError,
  WrongPinError,
  WrongSecretError,
  type BiometricSlot,
  type DeviceSlot,
  type Keyslot,
  type PassphraseSlot,
  type PinSlot,
  type SlotEnrolment,
  type SlotSecret,
} from '@/core/vault/keyslots'
import { InstantOpenError, LastKeyslotError, NoVaultError, Vault, VaultLockedError } from '@/core/vault/vault'
import { VaultRepo } from '@/core/vault/repo'
import { TEST_KDF } from './helpers'
import { webauthn } from './webauthnFakes'

const { mnemonic: MNEMONIC } = createIdentity()
const { mnemonic: OTHER_MNEMONIC } = createIdentity()
const PASSPHRASE = 'correct horse battery staple'
const PIN = '246810'
const PATTERN = '14789'

/** One way in: how to make it, and the secret that opens it. */
interface Kind {
  name: string
  enrol: () => Promise<SlotEnrolment>
  secret: (credentialId?: string) => Promise<SlotSecret>
}

const KINDS: Kind[] = [
  {
    name: 'passphrase',
    enrol: async () => ({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF }),
    secret: async () => ({ type: 'passphrase', passphrase: PASSPHRASE }),
  },
  {
    name: 'recovery',
    enrol: async () => ({ type: 'recovery', mnemonic: MNEMONIC }),
    secret: async () => ({ type: 'recovery', mnemonic: MNEMONIC }),
  },
  {
    name: 'biometric',
    enrol: async () => ({ type: 'biometric', presence: await enrolBiometric() }),
    secret: async (credentialId) => ({
      type: 'biometric',
      presence: await confirmBiometric({ credentialId: credentialId as string }),
    }),
  },
  {
    name: 'pin',
    enrol: async () => ({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF }),
    secret: async () => ({ type: 'pin', code: PIN }),
  },
  {
    name: 'pattern',
    enrol: async () => ({ type: 'pin', style: 'pattern', code: PATTERN, params: TEST_KDF }),
    secret: async () => ({ type: 'pin', code: PATTERN }),
  },
  {
    name: 'device',
    enrol: async () => ({ type: 'device' }),
    secret: async () => ({ type: 'device' }),
  },
]

const credentialOf = (slot: Keyslot | undefined): string | undefined =>
  (slot as BiometricSlot | undefined)?.credentialId

describe('keyslots', () => {
  beforeEach(() => {
    webauthn()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(KINDS)('seals and opens the data key with a $name slot', async (kind) => {
    const dataKey = generateDataKey()
    const enrolment = await kind.enrol()
    const slot = await makeSlot(enrolment, dataKey, 1234)
    expect(slot.type).toBe(enrolment.type)
    expect(slot.createdAt).toBe(1234)
    expect(await openSlot(slot, await kind.secret(credentialOf(slot)))).toEqual(dataKey)
  })

  it('refuses the wrong secret for every kind of slot', async () => {
    const dataKey = generateDataKey()
    const passphrase = await makeSlot(
      { type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF },
      dataKey,
    )
    await expect(openSlot(passphrase, { type: 'passphrase', passphrase: 'not it' })).rejects.toThrow(
      WrongPassphraseError,
    )

    const recovery = await makeSlot({ type: 'recovery', mnemonic: MNEMONIC }, dataKey)
    await expect(openSlot(recovery, { type: 'recovery', mnemonic: OTHER_MNEMONIC })).rejects.toMatchObject({
      name: 'WrongSecretError',
      slot: 'recovery',
    })
    // Not twelve words at all: refused before any key is derived.
    await expect(openSlot(recovery, { type: 'recovery', mnemonic: 'hello world' })).rejects.toThrow(
      WrongSecretError,
    )

    const pin = await makeSlot({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF }, dataKey)
    await expect(openSlot(pin, { type: 'pin', code: '135791' })).rejects.toMatchObject({ slot: 'pin' })
    // Not a PIN at all: refused before any key is derived.
    await expect(openSlot(pin, { type: 'pin', code: '12' })).rejects.toMatchObject({ slot: 'pin' })

    const device = (await makeSlot({ type: 'device' }, dataKey)) as DeviceSlot
    const tampered = {
      ...device,
      wrapped: device.wrapped.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
    }
    await expect(openSlot(tampered, { type: 'device' })).rejects.toMatchObject({ slot: 'device' })

    // A secret of the wrong kind never reaches a derivation.
    await expect(openSlot(device, { type: 'passphrase', passphrase: PASSPHRASE })).rejects.toThrow(
      WrongSecretError,
    )
  })

  it('opens a biometric slot only with a fresh proof from its own credential, spent once', async () => {
    const dataKey = generateDataKey()
    const slot = (await makeSlot(
      { type: 'biometric', presence: await enrolBiometric() },
      dataKey,
    )) as BiometricSlot
    const presence = await confirmBiometric({ credentialId: slot.credentialId })
    expect(await openSlot(slot, { type: 'biometric', presence })).toEqual(dataKey)
    // The same proof again.
    await expect(openSlot(slot, { type: 'biometric', presence })).rejects.toMatchObject({ slot: 'biometric' })
    // A proof from another credential, or one made up.
    const other = await enrolBiometric()
    await expect(openSlot(slot, { type: 'biometric', presence: other })).rejects.toThrow(WrongSecretError)
    await expect(
      openSlot(slot, {
        type: 'biometric',
        presence: { credentialId: slot.credentialId, authenticator: 'platform' },
      }),
    ).rejects.toThrow(WrongSecretError)
    // The local key and the sealed copy no longer agree.
    const tampered = { ...slot, wrapped: new Uint8Array(slot.wrapped.length) }
    await expect(
      openSlot(tampered, {
        type: 'biometric',
        presence: await confirmBiometric({ credentialId: slot.credentialId }),
      }),
    ).rejects.toMatchObject({ slot: 'biometric' })
  })

  it('reads the recovery phrase however it was typed', async () => {
    const dataKey = generateDataKey()
    const slot = await makeSlot({ type: 'recovery', mnemonic: MNEMONIC }, dataKey)
    const typed = `  ${MNEMONIC.toUpperCase().split(' ').join('   ')}\n`
    expect(await openSlot(slot, { type: 'recovery', mnemonic: typed })).toEqual(dataKey)
  })

  it('reads a PIN in whichever digits it was typed', async () => {
    expect(normalizePin('۲۴۶ ۸۱۰')).toBe('246810')
    expect(normalizePin('٢٤٦٨١٠')).toBe('246810')
    const dataKey = generateDataKey()
    const slot = await makeSlot({ type: 'pin', style: 'digits', code: '۲۴۶۸۱۰', params: TEST_KDF }, dataKey)
    expect(await openSlot(slot, { type: 'pin', code: PIN })).toEqual(dataKey)
  })

  it('knows a PIN and a pattern when it sees one', () => {
    expect(isValidPin('digits', '123456')).toBe(true)
    expect(isValidPin('digits', '1'.repeat(16))).toBe(true)
    expect(isValidPin('digits', '12345')).toBe(false)
    expect(isValidPin('digits', '1'.repeat(17))).toBe(false)
    expect(isValidPin('digits', '12345a')).toBe(false)
    expect(isValidPin('pattern', '1478')).toBe(true)
    expect(isValidPin('pattern', '123456789')).toBe(true)
    expect(isValidPin('pattern', '147')).toBe(false)
    // A dot used twice, or one the grid does not have.
    expect(isValidPin('pattern', '14741')).toBe(false)
    expect(isValidPin('pattern', '1470')).toBe(false)
  })

  it('binds each sealed key to its own slot', async () => {
    const dataKey = generateDataKey()
    const slot = await makeSlot({ type: 'recovery', mnemonic: MNEMONIC }, dataKey)
    // The same bytes under another slot's id: the AAD no longer matches.
    const moved = { ...slot, id: 'aa'.repeat(8) }
    await expect(openSlot(moved, { type: 'recovery', mnemonic: MNEMONIC })).rejects.toThrow(WrongSecretError)
  })

  it('refuses to enrol what cannot hold a key', async () => {
    const dataKey = generateDataKey()
    await expect(makeSlot({ type: 'recovery', mnemonic: 'not a phrase' }, dataKey)).rejects.toThrow(
      /invalid recovery phrase/,
    )
    await expect(
      makeSlot({ type: 'passphrase', passphrase: PASSPHRASE, params: { ...TEST_KDF, N: 3 } }, dataKey),
    ).rejects.toThrow(/N out of range/)
    await expect(makeSlot({ type: 'pin', style: 'digits', code: '1234' }, dataKey)).rejects.toThrow(
      /invalid digits/,
    )
    await expect(makeSlot({ type: 'pin', style: 'pattern', code: '11223' }, dataKey)).rejects.toThrow(
      /invalid pattern/,
    )
    await expect(
      makeSlot({ type: 'pin', style: 'digits', code: PIN, params: { ...TEST_KDF, r: 0 } }, dataKey),
    ).rejects.toThrow(/r out of range/)
    // A proof already spent: no fresh verification, no slot.
    const presence = await enrolBiometric()
    await makeSlot({ type: 'biometric', presence }, dataKey)
    await expect(makeSlot({ type: 'biometric', presence }, dataKey)).rejects.toThrow(/no fresh verification/)
  })

  it('derives a new passphrase or PIN under the current defaults unless told otherwise', async () => {
    const passphrase = (await makeSlot(
      { type: 'passphrase', passphrase: PASSPHRASE },
      generateDataKey(),
    )) as PassphraseSlot
    expect(passphrase.params).toEqual(DEFAULT_KDF_PARAMS)
    const pin = (await makeSlot({ type: 'pin', style: 'digits', code: PIN }, generateDataKey())) as PinSlot
    expect(pin.params).toEqual(PIN_KDF_PARAMS)
    expect(pin.failures).toBe(0)
  })

  it('checks the parameters of a stored passphrase or PIN slot before deriving', async () => {
    const slot = (await makeSlot(
      { type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF },
      generateDataKey(),
    )) as PassphraseSlot
    const absurd = { algo: 'scrypt' as const, N: 2 ** 30, r: 16, p: 16 }
    await expect(
      openSlot({ ...slot, params: absurd }, { type: 'passphrase', passphrase: PASSPHRASE }),
    ).rejects.toThrow(/out of range/)
    const pin = (await makeSlot(
      { type: 'pin', style: 'digits', code: PIN, params: TEST_KDF },
      generateDataKey(),
    )) as PinSlot
    await expect(openSlot({ ...pin, params: absurd }, { type: 'pin', code: PIN })).rejects.toThrow(
      /out of range/,
    )
  })

  it('derives different keys from the same phrase for the vault and for a backup', () => {
    const salt = randomBytes(32)
    expect(recoveryKey(MNEMONIC, salt, 'backup')).not.toEqual(recoveryKey(MNEMONIC, salt))
    expect(recoveryKey(MNEMONIC, salt, 'vault')).toEqual(recoveryKey(MNEMONIC, salt))
  })

  it('says what the lock screen needs, and nothing it does not', async () => {
    const biometric = await makeSlot(
      { type: 'biometric', presence: await enrolBiometric() },
      generateDataKey(),
      5,
    )
    expect(summarize(biometric)).toEqual({
      id: biometric.id,
      type: 'biometric',
      createdAt: 5,
      credentialId: credentialOf(biometric),
      authenticator: 'platform',
      transports: ['internal'],
    })
    const pattern = await makeSlot(
      { type: 'pin', style: 'pattern', code: PATTERN, params: TEST_KDF },
      generateDataKey(),
      6,
    )
    expect(summarize(pattern)).toEqual({
      id: pattern.id,
      type: 'pin',
      createdAt: 6,
      style: 'pattern',
      failures: 0,
    })
    const device = await makeSlot({ type: 'device' }, generateDataKey(), 7)
    expect(summarize(device)).toEqual({ id: device.id, type: 'device', createdAt: 7 })
  })

  it('remembers which authenticator a biometric slot waits for, and how to reach it', async () => {
    const key = (await makeSlot(
      { type: 'biometric', presence: await enrolBiometric('security-key') },
      generateDataKey(),
    )) as BiometricSlot
    expect(key).toMatchObject({ authenticator: 'security-key', transports: ['internal'] })
    expect(parseSlots([key])[0]).toMatchObject({ authenticator: 'security-key', transports: ['internal'] })
    // An authenticator that did not say how it is reached.
    const quiet = await makeSlot(
      {
        type: 'biometric',
        presence: await confirmBiometric({ credentialId: bytesToB64url(randomBytes(16)) }),
      },
      generateDataKey(),
    )
    expect(quiet).not.toHaveProperty('transports')
    // A slot from before security keys could guard one: this device's own.
    const { authenticator: _a, transports: _t, ...older } = key
    const [read] = parseSlots([older]) as [BiometricSlot]
    expect(read.authenticator).toBe('platform')
    expect(read).not.toHaveProperty('transports')
    expect(summarize(read)).not.toHaveProperty('transports')
    // Anything else stored there is not believed.
    for (const transports of ['usb', [], ['usb', 'telepathy'], Array(7).fill('usb')]) {
      expect(parseSlots([{ ...key, authenticator: 'phone', transports }])[0]).toEqual({
        ...older,
        authenticator: 'platform',
      })
    }
  })

  it('reads back every well-formed slot and skips the rest', async () => {
    const dataKey = generateDataKey()
    const good: Keyslot[] = []
    for (const kind of KINDS) good.push(await makeSlot(await kind.enrol(), dataKey))
    const [passphrase, recovery, biometric, pin, , device] = good as [
      Keyslot,
      Keyslot,
      BiometricSlot,
      PinSlot,
      PinSlot,
      DeviceSlot,
    ]
    const stored = [
      ...good.slice(0, 1),
      // IndexedDB may hand bytes back as a bare ArrayBuffer.
      { ...recovery, wrapped: recovery.wrapped.slice().buffer },
      ...good.slice(2),
      null,
      { ...passphrase, id: 7 },
      { ...passphrase, createdAt: 'yesterday' },
      { ...passphrase, salt: 'not hex' },
      { ...passphrase, params: null },
      { ...recovery, salt: 12 },
      { ...pin, style: 'word' },
      { ...pin, salt: 'not hex' },
      { ...pin, params: null },
      { ...pin, failures: -1 },
      { ...pin, failures: 1.5 },
      { ...pin, failures: undefined },
      { ...biometric, credentialId: undefined },
      { ...biometric, credentialId: '' },
      { ...biometric, credentialId: 'x'.repeat(1025) },
      { ...biometric, key: 'not a key' },
      { ...device, key: 'not a key' },
      { ...recovery, wrapped: 'not bytes' },
      { ...device, iv: 'not bytes' },
      { ...recovery, type: 'fingerprint' },
      // A passkey slot from before ADR-058: this build cannot open it.
      {
        id: 'ab'.repeat(8),
        createdAt: 1,
        type: 'webauthn-prf',
        credentialId: 'x',
        salt: 'ab',
        wrapped: new Uint8Array(48),
      },
    ]
    const parsed = parseSlots(stored)
    expect(parsed.map((slot) => slot.id)).toEqual(good.map((slot) => slot.id))
    expect(await openSlot(parsed[1] as Keyslot, { type: 'recovery', mnemonic: MNEMONIC })).toEqual(dataKey)
    expect(parseSlots(undefined)).toEqual([])
    expect(parseSlots({ slots: [] })).toEqual([])
    expect(parsed[3]).toMatchObject({ type: 'pin', style: 'digits', failures: 0 })
  })

  it('knows a slot an earlier build made and this one cannot open', () => {
    expect(isRetiredSlot({ type: 'webauthn-prf' })).toBe(true)
    expect(isRetiredSlot({ type: 'passphrase' })).toBe(false)
    expect(isRetiredSlot(null)).toBe(false)
    expect(isRetiredSlot('webauthn-prf')).toBe(false)
  })

  it('knows whether this browser can open instantly', () => {
    expect(canOpenInstantly()).toBe(true)
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(canOpenInstantly()).toBe(false)
  })
})

/** A header in the shape every vault had before keyslots. */
async function writeLegacyHeader(db: TextorDatabase, passphrase: string): Promise<Uint8Array> {
  const dataKey = generateDataKey()
  const salt = randomBytes(32)
  const kek = await deriveKek(passphrase, salt, TEST_KDF)
  await db.meta.bulkPut([
    { k: META_KEYS.schemaVersion, v: 1 },
    { k: META_KEYS.kdfSalt, v: bytesToHex(salt) },
    { k: META_KEYS.kdfParams, v: TEST_KDF },
    { k: META_KEYS.wrappedDataKey, v: seal(kek, dataKey, 'textor/meta/dataKey') },
    { k: META_KEYS.createdAt, v: 42 },
    { k: META_KEYS.keyEpoch, v: 3 },
  ])
  return dataKey
}

describe('a vault with keyslots', () => {
  let db: TextorDatabase
  let vault: Vault

  beforeEach(() => {
    webauthn()
    db = new TextorDatabase(`keyslots-${Math.random().toString(36).slice(2)}`)
    vault = new Vault(db)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vault.lock()
    await db.delete()
  })

  const types = async () => (await vault.keyslots()).map((slot) => slot.type).sort()
  const credential = async () => (await vault.keyslots()).find((slot) => slot.credentialId)?.credentialId
  const pinSlot = async () => (await vault.keyslots()).find((slot) => slot.type === 'pin')

  it.each(KINDS)('is created with, and opens by, a $name slot', async (kind) => {
    const enrolment = await kind.enrol()
    await vault.create(enrolment)
    const recordKey = vault.keys.recordKey.slice()
    expect(await types()).toEqual([enrolment.type])
    vault.lock()
    await vault.unlockWith(await kind.secret(await credential()))
    expect(vault.keys.recordKey).toEqual(recordKey)
  })

  it('opens by any of its slots, and by none it does not have', async () => {
    await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
    await vault.addSlot({ type: 'biometric', presence: await enrolBiometric() })
    await vault.addSlot({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
    expect(await types()).toEqual(['biometric', 'passphrase', 'pin', 'recovery'])
    const recordKey = vault.keys.recordKey.slice()
    const id = (await credential()) as string

    for (const secret of [
      async () => ({ type: 'passphrase' as const, passphrase: PASSPHRASE }),
      async () => ({ type: 'recovery' as const, mnemonic: MNEMONIC }),
      async () => ({ type: 'biometric' as const, presence: await confirmBiometric({ credentialId: id }) }),
      async () => ({ type: 'pin' as const, code: PIN }),
    ]) {
      vault.lock()
      await vault.unlockWith(await secret())
      expect(vault.keys.recordKey).toEqual(recordKey)
    }

    vault.lock()
    // Verified by a credential this vault has never seen.
    const stranger = await enrolBiometric()
    await expect(vault.unlockWith({ type: 'biometric', presence: stranger })).rejects.toThrow(
      WrongSecretError,
    )
    await expect(vault.unlock('wrong passphrase')).rejects.toThrow(WrongPassphraseError)
    expect(vault.isUnlocked).toBe(false)
  })

  describe('a PIN', () => {
    const wrong = { type: 'pin' as const, code: '135791' }

    const setFailures = async (failures: number) => {
      const row = await db.meta.get(META_KEYS.keyslots)
      const slots = (row?.v as Keyslot[]).map((slot) => (slot.type === 'pin' ? { ...slot, failures } : slot))
      await db.meta.put({ k: META_KEYS.keyslots, v: slots })
    }

    it('counts wrong tries, says how many are left, and forgets them once it opens', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      vault.lock()
      await expect(vault.unlockWith(wrong)).rejects.toMatchObject({
        name: 'WrongPinError',
        slot: 'pin',
        triesLeft: MAX_PIN_FAILURES - 1,
      })
      await expect(vault.unlockWith(wrong)).rejects.toMatchObject({ triesLeft: MAX_PIN_FAILURES - 2 })
      expect((await pinSlot())?.failures).toBe(2)
      await vault.unlockWith({ type: 'pin', code: PIN })
      expect((await pinSlot())?.failures).toBe(0)
    })

    it('is erased by the last wrong try, and the recovery phrase still opens', async () => {
      await vault.create({ type: 'pin', style: 'pattern', code: PATTERN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      vault.lock()
      await setFailures(MAX_PIN_FAILURES - 1)
      await expect(vault.unlockWith({ type: 'pin', code: '1236' })).rejects.toMatchObject({ triesLeft: 0 })
      expect(await types()).toEqual(['recovery'])
      // The right pattern, too late.
      await expect(vault.unlockWith({ type: 'pin', code: PATTERN })).rejects.toThrow(WrongSecretError)
      await vault.unlockWith({ type: 'recovery', mnemonic: MNEMONIC })
    })

    it('is never erased when it is the only way in', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      vault.lock()
      await setFailures(MAX_PIN_FAILURES + 3)
      const error = await vault.unlockWith(wrong).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(WrongPinError)
      expect((error as WrongPinError).triesLeft).toBeNull()
      expect(await types()).toEqual(['pin'])
      await vault.unlockWith({ type: 'pin', code: PIN })
    })

    it('counts a wrong try made to confirm the person, too', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      await expect(vault.verify(wrong)).rejects.toThrow(WrongPinError)
      expect((await pinSlot())?.failures).toBe(1)
      await vault.verify({ type: 'pin', code: PIN })
      expect(vault.isUnlocked).toBe(true)
    })

    it('reports it erased to a try that arrives after another erased it', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      vault.lock()
      await setFailures(MAX_PIN_FAILURES - 1)
      // Two tabs, one wrong try each, at the same moment.
      const results = await Promise.allSettled([vault.unlockWith(wrong), vault.unlockWith(wrong)])
      for (const result of results) {
        expect(result).toMatchObject({ status: 'rejected', reason: { triesLeft: 0 } })
      }
      expect(await types()).toEqual(['recovery'])
    })

    it('does not count what failed for another reason than the PIN', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      vault.lock()
      const row = await db.meta.get(META_KEYS.keyslots)
      const slots = (row?.v as Keyslot[]).map((slot) =>
        slot.type === 'pin' ? { ...slot, params: { ...slot.params, N: 2 ** 30 } } : slot,
      )
      await db.meta.put({ k: META_KEYS.keyslots, v: slots })
      await expect(vault.unlockWith(wrong)).rejects.toThrow(/out of range/)
      expect((await pinSlot())?.failures).toBe(0)
    })
  })

  describe('opening instantly beside a way in that asks for something (ADR-059)', () => {
    const everyGuard: [string, () => Promise<SlotEnrolment>][] = [
      ['biometrics', async () => ({ type: 'biometric', presence: await enrolBiometric() })],
      ['a PIN', async () => ({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })],
      ['a pattern', async () => ({ type: 'pin', style: 'pattern', code: PATTERN, params: TEST_KDF })],
      ['a passphrase', async () => ({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })],
    ]

    it.each(everyGuard)('is purged, key and all, the moment %s is set up', async (_name, enrol) => {
      await vault.create({ type: 'device' })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      await vault.addSlot(await enrol())
      const stored = (await db.meta.get(META_KEYS.keyslots))?.v as Keyslot[]
      expect(stored.some((slot) => slot.type === 'device')).toBe(false)
      expect(stored.some((slot) => 'key' in slot && slot.type !== 'biometric')).toBe(false)
      expect(await types()).not.toContain('device')
    })

    it('is refused while one is there, and offered again once none is', async () => {
      await vault.create({ type: 'pin', style: 'digits', code: PIN, params: TEST_KDF })
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      await expect(vault.addSlot({ type: 'device' })).rejects.toThrow(InstantOpenError)
      expect(await types()).toEqual(['pin', 'recovery'])

      const pin = (await vault.keyslots()).find((slot) => slot.type === 'pin')
      await vault.removeSlot(pin?.id as string)
      await vault.addSlot({ type: 'device' })
      expect(await types()).toEqual(['device', 'recovery'])
      // The recovery phrase is no everyday way in, and sits beside it.
      vault.lock()
      await vault.unlockWith({ type: 'device' })
    })

    it('is refused in the write itself, when another tab set one up meanwhile', async () => {
      await vault.create({ type: 'recovery', mnemonic: MNEMONIC })
      const other = new Vault(db)
      await other.unlockWith({ type: 'recovery', mnemonic: MNEMONIC })
      const adding = vault.addSlot({ type: 'device' })
      await other.addSlot({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
      await expect(adding).rejects.toThrow(InstantOpenError)
      expect(await types()).toEqual(['passphrase', 'recovery'])
      other.lock()
    })

    it('opens nothing where an earlier build left the two side by side, and is tidied away', async () => {
      await vault.create({ type: 'device' })
      const guard = await makeSlot(
        { type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF },
        vault.keys.dataKey,
      )
      const row = await db.meta.get(META_KEYS.keyslots)
      await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), guard] })
      vault.lock()

      await expect(vault.unlockWith({ type: 'device' })).rejects.toMatchObject({ slot: 'device' })
      expect(await vault.tidy()).toEqual({ retired: false })
      expect(await types()).toEqual(['passphrase'])
      await vault.unlock(PASSPHRASE)
    })

    it('is tidied away on unlock too, should another tab put one back', async () => {
      await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
      const device = await makeSlot({ type: 'device' }, vault.keys.dataKey)
      const row = await db.meta.get(META_KEYS.keyslots)
      await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), device] })
      vault.lock()
      await vault.unlock(PASSPHRASE)
      expect(await types()).toEqual(['passphrase'])
    })
  })

  describe('with a slot an earlier build made', () => {
    const retired = {
      id: 'cd'.repeat(8),
      createdAt: 1,
      type: 'webauthn-prf',
      credentialId: 'x',
      salt: 'ab'.repeat(32),
      wrapped: new Uint8Array(48),
    }

    const plant = async () => {
      const row = await db.meta.get(META_KEYS.keyslots)
      await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), retired] })
    }
    const stored = async () => (await db.meta.get(META_KEYS.keyslots))?.v as unknown[]

    it('says so, and drops it, before anything is opened', async () => {
      expect(await vault.tidy()).toEqual({ retired: false })
      await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
      expect(await vault.tidy()).toEqual({ retired: false })
      await plant()
      vault.lock()
      expect(await types()).toEqual(['passphrase'])

      expect(await vault.tidy()).toEqual({ retired: true })
      expect(await stored()).toHaveLength(1)
      expect(await vault.tidy()).toEqual({ retired: false })
      await vault.unlock(PASSPHRASE)
    })

    it('still opens when it cannot be dropped, and tries again next time', async () => {
      await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
      await plant()
      vault.lock()
      vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk full'))
      await vault.unlock(PASSPHRASE)
      expect(vault.isUnlocked).toBe(true)
      expect(await stored()).toHaveLength(2)
      expect(await vault.tidy()).toEqual({ retired: true })
      expect(await stored()).toHaveLength(1)
    })

    it('is read as nothing where the list itself is not one', async () => {
      await db.meta.put({ k: META_KEYS.keyslots, v: 'not a list' })
      expect(await vault.tidy()).toEqual({ retired: false })
    })
  })

  it('keeps one slot of each kind: a new one replaces the old', async () => {
    await vault.create({ type: 'passphrase', passphrase: 'first passphrase', params: TEST_KDF })
    const first = await vault.keyslots()
    const added = await vault.addSlot({
      type: 'passphrase',
      passphrase: 'second passphrase',
      params: TEST_KDF,
    })
    expect(added.type).toBe('passphrase')
    const after = await vault.keyslots()
    expect(after).toHaveLength(1)
    expect(after[0]?.id).not.toBe(first[0]?.id)
    vault.lock()
    await expect(vault.unlock('first passphrase')).rejects.toThrow(WrongPassphraseError)
    await vault.unlock('second passphrase')
  })

  it('removes a slot, but never the last one', async () => {
    await vault.create({ type: 'device' })
    const recovery = await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
    await vault.removeSlot(recovery.id)
    expect(await types()).toEqual(['device'])
    // Unknown ids change nothing.
    await vault.removeSlot('nothing-by-this-id')
    const [device] = await vault.keyslots()
    await expect(vault.removeSlot(device?.id as string)).rejects.toThrow(LastKeyslotError)
    expect(await types()).toEqual(['device'])

    vault.lock()
    await expect(vault.unlockWith({ type: 'recovery', mnemonic: MNEMONIC })).rejects.toThrow(WrongSecretError)
  })

  it('changes nothing while locked', async () => {
    await vault.create({ type: 'device' })
    vault.lock()
    await expect(vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })).rejects.toThrow(VaultLockedError)
    await expect(vault.removeSlot('any')).rejects.toThrow(VaultLockedError)
    await expect(vault.verify({ type: 'device' })).rejects.toThrow(VaultLockedError)
  })

  it('does not save a slot sealed after the vault locked under it', async () => {
    await vault.create({ type: 'device' })
    const adding = vault.addSlot({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    vault.lock()
    await expect(adding).rejects.toThrow(VaultLockedError)
    expect(await types()).toEqual(['device'])
  })

  it('checks a secret against the open vault without closing it', async () => {
    await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
    await vault.verify({ type: 'passphrase', passphrase: PASSPHRASE })
    await vault.verify({ type: 'recovery', mnemonic: MNEMONIC })
    await expect(vault.verify({ type: 'passphrase', passphrase: 'nope' })).rejects.toThrow(
      WrongPassphraseError,
    )
    expect(vault.isUnlocked).toBe(true)
  })

  it('refuses, on verifying, a slot that opens some other vault', async () => {
    await vault.create({ type: 'device' })
    // A slot from elsewhere, planted in this vault's header: it opens, but to
    // a different key, and a check that only asked "did it open" would pass.
    const foreign = await makeSlot({ type: 'recovery', mnemonic: MNEMONIC }, generateDataKey())
    const row = await db.meta.get(META_KEYS.keyslots)
    await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), foreign] })
    await expect(vault.verify({ type: 'recovery', mnemonic: MNEMONIC })).rejects.toMatchObject({
      slot: 'recovery',
    })
  })

  it('changes the passphrase, locked or not, only for someone who knows it', async () => {
    await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
    vault.lock()
    await expect(vault.changePassphrase('wrong', 'next passphrase', { params: TEST_KDF })).rejects.toThrow(
      WrongPassphraseError,
    )
    await vault.changePassphrase(PASSPHRASE, 'next passphrase', { params: TEST_KDF })
    expect(await types()).toEqual(['passphrase', 'recovery'])
    await expect(vault.unlock(PASSPHRASE)).rejects.toThrow(WrongPassphraseError)
    await vault.unlock('next passphrase')
  })

  it('makes nothing when the first slot cannot be made', async () => {
    await expect(vault.create({ type: 'recovery', mnemonic: 'not a phrase' })).rejects.toThrow(/invalid/)
    expect(await vault.exists()).toBe(false)
    expect(vault.isUnlocked).toBe(false)
  })

  it('reports itself open while it is', async () => {
    await vault.create({ type: 'device' })
    expect(await vault.refreshStatus()).toBe('unlocked')
  })

  it('counts slot changes even where the counter was lost', async () => {
    await vault.create({ type: 'device' })
    await db.meta.delete(META_KEYS.keyEpoch)
    await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
    expect((await db.meta.get(META_KEYS.keyEpoch))?.v).toBe(2)
  })

  it('says there is no vault only when there is none', async () => {
    expect(await vault.exists()).toBe(false)
    expect(await vault.keyslots()).toEqual([])
    await expect(vault.unlockWith({ type: 'device' })).rejects.toThrow(NoVaultError)

    // A header whose every slot is unreadable is still a vault: one that
    // nothing here opens.
    await db.meta.put({ k: META_KEYS.keyslots, v: [{ id: 'x' }] })
    expect(await vault.exists()).toBe(true)
    expect(await vault.refreshStatus()).toBe('locked')
    await expect(vault.unlockWith({ type: 'device' })).rejects.toThrow(WrongSecretError)
  })

  describe('made before keyslots', () => {
    it('opens with its passphrase and moves into a passphrase slot', async () => {
      const dataKey = await writeLegacyHeader(db, PASSPHRASE)
      expect(await vault.exists()).toBe(true)
      expect(await vault.keyslots()).toEqual([{ id: LEGACY_SLOT_ID, type: 'passphrase', createdAt: 42 }])

      await vault.unlock(PASSPHRASE)
      expect(vault.keys.recordKey).toEqual(deriveVaultKeys(dataKey.slice()).recordKey)
      const [slot] = await vault.keyslots()
      expect(slot?.type).toBe('passphrase')
      expect(slot?.id).not.toBe(LEGACY_SLOT_ID)
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeUndefined()
      expect(await db.meta.get(META_KEYS.kdfSalt)).toBeUndefined()
      expect((await db.meta.get(META_KEYS.keyEpoch))?.v).toBe(4)

      vault.lock()
      await vault.unlock(PASSPHRASE)
      expect(vault.keys.recordKey).toEqual(deriveVaultKeys(dataKey.slice()).recordKey)
    })

    it('keeps the slots already beside it when it moves', async () => {
      const dataKey = await writeLegacyHeader(db, PASSPHRASE)
      const recovery = await makeSlot({ type: 'recovery', mnemonic: MNEMONIC }, dataKey)
      await db.meta.put({ k: META_KEYS.keyslots, v: [recovery] })
      await vault.unlock(PASSPHRASE)
      expect(await types()).toEqual(['passphrase', 'recovery'])
      vault.lock()
      await vault.unlockWith({ type: 'recovery', mnemonic: MNEMONIC })
    })

    it('stays as it was on a wrong passphrase', async () => {
      await writeLegacyHeader(db, PASSPHRASE)
      await expect(vault.unlock('wrong')).rejects.toThrow(WrongPassphraseError)
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeDefined()
      await expect(
        upgradeLegacySlot((await vault.keyslots().then(() => legacy(db))) as PassphraseSlot, {
          type: 'passphrase',
          passphrase: 'wrong',
        }),
      ).rejects.toThrow(WrongPassphraseError)
    })

    it('still opens, the old way, when the move cannot be saved', async () => {
      const dataKey = await writeLegacyHeader(db, PASSPHRASE)
      vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk full'))
      await vault.unlock(PASSPHRASE)
      expect(vault.keys.recordKey).toEqual(deriveVaultKeys(dataKey.slice()).recordKey)
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeDefined()
      expect(await db.meta.get(META_KEYS.keyslots)).toBeUndefined()
    })

    it('sits beside new slots until something replaces or removes it', async () => {
      await writeLegacyHeader(db, PASSPHRASE)
      await vault.unlockWith({ type: 'passphrase', passphrase: PASSPHRASE })
      // Put the old header back, as a tab still running the old build would.
      await writeLegacyHeader(db, 'older passphrase')
      expect(await types()).toEqual(['passphrase', 'passphrase'])

      // A slot of another kind leaves it be.
      await vault.addSlot({ type: 'recovery', mnemonic: MNEMONIC })
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeDefined()
      expect(await types()).toEqual(['passphrase', 'passphrase', 'recovery'])

      // A new passphrase replaces every passphrase slot, the old header too.
      await vault.addSlot({ type: 'passphrase', passphrase: 'newest passphrase', params: TEST_KDF })
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeUndefined()
      expect(await types()).toEqual(['passphrase', 'recovery'])

      await writeLegacyHeader(db, 'older passphrase')
      await vault.removeSlot(LEGACY_SLOT_ID)
      expect(await db.meta.get(META_KEYS.wrappedDataKey)).toBeUndefined()
      expect(await types()).toEqual(['passphrase', 'recovery'])
    })

    it('is skipped, not fatal, when damaged', async () => {
      await writeLegacyHeader(db, PASSPHRASE)
      await db.meta.put({ k: META_KEYS.wrappedDataKey, v: 'not bytes' })
      expect(await vault.keyslots()).toEqual([])
      expect(await vault.exists()).toBe(true)
      await expect(vault.unlock(PASSPHRASE)).rejects.toThrow(WrongSecretError)
    })

    it('reads a missing creation time as unknown', async () => {
      await writeLegacyHeader(db, PASSPHRASE)
      await db.meta.delete(META_KEYS.createdAt)
      expect((await vault.keyslots())[0]?.createdAt).toBe(0)
    })
  })

  it('keeps records readable across every change of slot', async () => {
    await vault.create({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    const repo = new VaultRepo(vault)
    await repo.upsertContact('c'.repeat(64), { name: 'Dana', accepted: true })
    await vault.addSlot({ type: 'pin', style: 'pattern', code: PATTERN, params: TEST_KDF })
    const [passphraseSlot] = (await vault.keyslots()).filter((slot) => slot.type === 'passphrase')
    await vault.removeSlot(passphraseSlot?.id as string)
    vault.lock()
    await vault.unlockWith({ type: 'pin', code: PATTERN })
    expect((await repo.getContact('c'.repeat(64)))?.name).toBe('Dana')
  })
})

/** The legacy header, as the vault reads it. */
async function legacy(db: TextorDatabase): Promise<Keyslot | undefined> {
  const vault = new Vault(db)
  const [summary] = await vault.keyslots()
  if (summary?.id !== LEGACY_SLOT_ID) return undefined
  const [salt, params, wrapped] = await db.meta.bulkGet([
    META_KEYS.kdfSalt,
    META_KEYS.kdfParams,
    META_KEYS.wrappedDataKey,
  ])
  return {
    id: LEGACY_SLOT_ID,
    type: 'passphrase',
    createdAt: 42,
    salt: salt?.v as string,
    params: params?.v as PassphraseSlot['params'],
    wrapped: wrapped?.v as Uint8Array,
  }
}
