// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { META_KEYS, TextorDatabase, setDbForTesting } from '@/core/vault/db'
import { InstantOpenError, Vault, WrongPassphraseError, WrongPinError } from '@/core/vault/vault'
import { VaultRepo } from '@/core/vault/repo'
import { makeSlot, MAX_PIN_FAILURES, type Keyslot } from '@/core/vault/keyslots'
import { bytesToHex } from '@/core/util/bytes'
import { FakeSocketNetwork, type FakeWebSocket } from './fakeWebSocket'
import { TEST_KDF } from './helpers'
// Type-only: the module itself is imported at run time, once its database has
// been installed.
import type * as StoreModule from '@/app/store'

/**
 * How the app opens a vault (ADR-054, ADR-058), through the real store against
 * a real database: what boot decides, what each kind of secret does, how a
 * vault made before keyslots gains its recovery slot the first time it opens,
 * and how a retired passkey slot and an erased PIN are handled.
 */

const RELAY = 'wss://relay.test'
const PASSPHRASE = 'unlock flow vault'
const { identity, mnemonic: MNEMONIC } = createIdentity()

let db: TextorDatabase
let store: typeof StoreModule

const state = () => store.useApp.getState()
const types = () =>
  state()
    .keyslots.map((slot) => slot.type)
    .sort()

describe('opening the vault through the store', () => {
  beforeAll(async () => {
    const network = new FakeSocketNetwork()
    network.relay(RELAY)
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          return network.factory(url) as unknown as FakeWebSocket
        }
      },
    )

    // A vault as every build before keyslots left it: a passphrase and
    // nothing else, even though the identity inside has a recovery phrase.
    db = new TextorDatabase(`unlock-flow-${Math.random().toString(36).slice(2)}`)
    setDbForTesting(db)
    const vault = new Vault(db)
    await vault.create(PASSPHRASE, { params: TEST_KDF })
    const repo = new VaultRepo(vault)
    await repo.putIdentity({
      pubkey: identity.publicKey,
      npub: identity.npub,
      secretKeyHex: bytesToHex(identity.secretKey),
      name: 'Ada',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
      mnemonic: MNEMONIC,
    })
    await repo.upsertRelay(RELAY, { read: true, write: true })
    vault.lock('manual')

    store = await import('@/app/store')
  }, 30_000)

  afterAll(async () => {
    state().lock()
    await db.delete()
    setDbForTesting(null)
    vi.unstubAllGlobals()
  })

  it('boots to the lock screen, knowing how the vault opens', async () => {
    await state().boot()
    expect(state().phase).toBe('locked')
    expect(types()).toEqual(['passphrase'])
    expect(state().autoPrompt).toBe(true)
  })

  it('refuses the wrong passphrase and stays locked', async () => {
    await expect(state().unlock({ type: 'passphrase', passphrase: 'not it' })).rejects.toThrow(
      WrongPassphraseError,
    )
    expect(state().phase).toBe('locked')
  })

  it('opens with the passphrase, and lets the recovery phrase open it from then on', async () => {
    await state().unlock({ type: 'passphrase', passphrase: PASSPHRASE })
    expect(state().phase).toBe('ready')
    expect(types()).toEqual(['passphrase', 'recovery'])
    // Spent: after this, a lock screen waits for a tap.
    expect(state().autoPrompt).toBe(false)
    expect(state().openedWithRecovery).toBe(false)
  })

  it('opens with the recovery phrase alone, and says so', async () => {
    state().lock()
    expect(state().phase).toBe('locked')
    await state().unlock({ type: 'recovery', mnemonic: MNEMONIC })
    expect(state().phase).toBe('ready')
    expect(state().openedWithRecovery).toBe(true)
    state().dismissRecoveryNotice()
    expect(state().openedWithRecovery).toBe(false)
  })

  it('opens by itself at boot once set to open instantly, which nothing else may guard', async () => {
    const vault = store.getVault()
    await expect(vault.addSlot({ type: 'device' })).rejects.toThrow(InstantOpenError)
    const passphrase = state().keyslots.find((slot) => slot.type === 'passphrase')
    await vault.removeSlot(passphrase?.id as string)
    await vault.addSlot({ type: 'device' })
    await state().refreshKeyslots()
    expect(types()).toEqual(['device', 'recovery'])
    state().lock()

    await state().boot()
    expect(state().phase).toBe('ready')
  })

  it('shows the lock screen when this device cannot open it by itself', async () => {
    const row = await db.meta.get(META_KEYS.keyslots)
    const slots = (row?.v as Keyslot[]).map((slot) =>
      slot.type === 'device' ? { ...slot, wrapped: new Uint8Array(slot.wrapped.length) } : slot,
    )
    await db.meta.put({ k: META_KEYS.keyslots, v: slots })
    state().lock()

    await state().boot()
    expect(state().phase).toBe('locked')
    state().consumeAutoPrompt()
    expect(state().autoPrompt).toBe(false)
  })

  it('offers what is left once too many wrong tries erase the PIN', async () => {
    await state().unlock({ type: 'recovery', mnemonic: MNEMONIC })
    await store.getVault().addSlot({ type: 'pin', style: 'digits', code: '246810', params: TEST_KDF })
    await state().refreshKeyslots()
    expect(types()).toContain('pin')
    state().lock()

    const row = await db.meta.get(META_KEYS.keyslots)
    const slots = (row?.v as Keyslot[]).map((slot) =>
      slot.type === 'pin' ? { ...slot, failures: MAX_PIN_FAILURES - 1 } : slot,
    )
    await db.meta.put({ k: META_KEYS.keyslots, v: slots })
    await expect(state().unlock({ type: 'pin', code: '135791' })).rejects.toThrow(WrongPinError)
    expect(types()).not.toContain('pin')
    expect(state().phase).toBe('locked')
  })

  it('does not open instantly where an earlier build left it beside a way that asks, and drops it', async () => {
    await state().unlock({ type: 'recovery', mnemonic: MNEMONIC })
    const vault = store.getVault()
    await vault.addSlot({ type: 'passphrase', passphrase: PASSPHRASE, params: TEST_KDF })
    const device = await makeSlot({ type: 'device' }, vault.keys.dataKey)
    const row = await db.meta.get(META_KEYS.keyslots)
    await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), device] })
    state().lock()

    await state().boot()
    expect(state().phase).toBe('locked')
    expect(types()).toEqual(['passphrase', 'recovery'])
    await state().unlock({ type: 'passphrase', passphrase: PASSPHRASE })
    expect(state().phase).toBe('ready')
    state().lock()
  })

  it('says a retired passkey slot was there, having dropped it at start', async () => {
    const row = await db.meta.get(META_KEYS.keyslots)
    const retired = { id: 'ef'.repeat(8), createdAt: 1, type: 'webauthn-prf', credentialId: 'x', salt: 'ab' }
    await db.meta.put({ k: META_KEYS.keyslots, v: [...(row?.v as Keyslot[]), retired] })
    await state().boot()
    expect(state().passkeyRetired).toBe(true)
    expect(await store.getVault().tidy()).toEqual({ retired: false })

    await state().unlock({ type: 'recovery', mnemonic: MNEMONIC })
    expect(state().phase).toBe('ready')
    // The notice stays until it is dismissed or the vault locks.
    expect(state().passkeyRetired).toBe(true)
    state().lock()
    expect(state().passkeyRetired).toBe(false)
    await state().unlock({ type: 'recovery', mnemonic: MNEMONIC })
    state().dismissRecoveryNotice()
    expect(state().passkeyRetired).toBe(false)
    expect(state().openedWithRecovery).toBe(false)
  })

  it('goes back to onboarding when the vault is gone', async () => {
    await Promise.all(db.tables.map((table) => table.clear()))
    await state().unlock({ type: 'passphrase', passphrase: PASSPHRASE })
    expect(state().phase).toBe('onboarding')
  })

  it('creates a vault that opens instantly, with the recovery phrase beside it', async () => {
    await state().createVault({ name: 'Zed', protection: { type: 'device' }, mnemonic: MNEMONIC })
    expect(state().phase).toBe('ready')
    expect(state().identity?.name).toBe('Zed')
    expect(types()).toEqual(['device', 'recovery'])
  })
})
