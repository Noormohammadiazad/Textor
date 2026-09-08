import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextorDatabase } from '@/core/vault/db'
import { Vault, VaultLockedError, WrongPassphraseError } from '@/core/vault/vault'
import { VaultRepo } from '@/core/vault/repo'
import { makeVault, TEST_KDF, type TestVault } from './helpers'

describe('vault lifecycle', () => {
  let db: TextorDatabase

  beforeEach(() => {
    db = new TextorDatabase(`lifecycle-${Math.random().toString(36).slice(2)}`)
  })
  afterEach(async () => {
    await db.delete()
  })

  it('reports an empty vault before creation', async () => {
    const vault = new Vault(db)
    expect(await vault.refreshStatus()).toBe('empty')
    expect(vault.isUnlocked).toBe(false)
  })

  it('creates, locks, and unlocks', async () => {
    const vault = new Vault(db)
    await vault.create('hunter2 hunter2', { params: TEST_KDF })
    expect(vault.status).toBe('unlocked')

    vault.lock()
    expect(vault.status).toBe('locked')
    expect(vault.isUnlocked).toBe(false)
    expect(() => vault.keys).toThrow(VaultLockedError)

    await vault.unlock('hunter2 hunter2')
    expect(vault.isUnlocked).toBe(true)
  })

  it('rejects the wrong passphrase', async () => {
    const vault = new Vault(db)
    await vault.create('right passphrase', { params: TEST_KDF })
    vault.lock()
    await expect(vault.unlock('wrong passphrase')).rejects.toThrow(WrongPassphraseError)
    expect(vault.isUnlocked).toBe(false)
  })

  it('normalises Unicode so the same typed passphrase always unlocks', async () => {
    // "é" as one codepoint vs. "e" + combining accent: a Persian or European
    // keyboard may produce either, and both must open the same vault.
    const composed = 'passphrase-é'
    const decomposed = 'passphrase-é'
    const vault = new Vault(db)
    await vault.create(composed, { params: TEST_KDF })
    vault.lock()
    await expect(vault.unlock(decomposed)).resolves.toBeUndefined()
  })

  it('refuses to create a second vault over an existing one', async () => {
    const vault = new Vault(db)
    await vault.create('one', { params: TEST_KDF })
    await expect(vault.create('two', { params: TEST_KDF })).rejects.toThrow(/already exists/)
  })

  it('derives the same keys after a lock/unlock cycle', async () => {
    const vault = new Vault(db)
    await vault.create('stable keys please', { params: TEST_KDF })
    const before = new Uint8Array(vault.keys.recordKey)
    vault.lock()
    await vault.unlock('stable keys please')
    expect(vault.keys.recordKey).toEqual(before)
  })

  it('zeroises key material on lock', async () => {
    const vault = new Vault(db)
    await vault.create('wipe me', { params: TEST_KDF })
    const handle = vault.keys.recordKey
    expect(handle.some((byte) => byte !== 0)).toBe(true)
    vault.lock()
    expect(handle.every((byte) => byte === 0)).toBe(true)
  })

  it('rejects a tampered KDF parameter block', async () => {
    const vault = new Vault(db)
    await vault.create('params', { params: TEST_KDF })
    vault.lock()
    await db.meta.put({ k: 'kdfParams', v: { algo: 'scrypt', N: 3, r: 8, p: 1 } })
    await expect(vault.unlock('params')).rejects.toThrow(/N out of range/)
  })

  it('rejects an absurd memory cost that would exhaust the device', async () => {
    const vault = new Vault(db)
    await vault.create('params', { params: TEST_KDF })
    vault.lock()
    await db.meta.put({ k: 'kdfParams', v: { algo: 'scrypt', N: 2 ** 30, r: 16, p: 16 } })
    await expect(vault.unlock('params')).rejects.toThrow(/out of range/)
  })
})

describe('auto-lock', () => {
  let db: TextorDatabase
  let vault: Vault

  // scrypt yields through timers while it runs, so the vault has to be created
  // on real timers; only the idle countdown is simulated.
  beforeEach(async () => {
    db = new TextorDatabase(`autolock-${Math.random().toString(36).slice(2)}`)
    vault = new Vault(db)
    await vault.create('auto lock tests', { params: TEST_KDF })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await db.delete()
  })

  it('locks after the configured idle period', async () => {
    vi.useFakeTimers()
    vault.configureAutoLock(15)
    expect(vault.isUnlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000)
    expect(vault.isUnlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(vault.isUnlocked).toBe(false)
    expect(vault.status).toBe('locked')
  })

  it('activity restarts the countdown', async () => {
    vi.useFakeTimers()
    vault.configureAutoLock(10)

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
      vault.touch()
    }
    expect(vault.isUnlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
    expect(vault.isUnlocked).toBe(false)
  })

  it('never locks when the timeout is disabled', async () => {
    vi.useFakeTimers()
    vault.configureAutoLock(0)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(vault.isUnlocked).toBe(true)
  })

  it('announces an automatic lock separately from a manual one', async () => {
    let autoLocked = false
    vault.events.on('autoLocked', () => {
      autoLocked = true
    })

    vi.useFakeTimers()
    vault.configureAutoLock(1)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    // The UI explains *why* the vault locked, so the two must be distinguishable.
    expect(autoLocked).toBe(true)
  })

  it('does not announce an auto-lock for a manual one', async () => {
    let autoLocked = false
    vault.events.on('autoLocked', () => {
      autoLocked = true
    })

    vault.lock('manual')
    expect(vault.isUnlocked).toBe(false)
    expect(autoLocked).toBe(false)
  })
})

describe('passphrase change', () => {
  it('rewraps the data key without touching records', async () => {
    const t = await makeVault('old passphrase')
    const identity = {
      pubkey: 'a'.repeat(64),
      npub: 'npub1test',
      secretKeyHex: 'b'.repeat(64),
      name: 'Sara',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
    }
    await t.repo.putIdentity(identity)

    await t.vault.changePassphrase('old passphrase', 'new passphrase', { params: TEST_KDF })

    // Still unlocked and still reading the same records: the data key never
    // changed, only its wrapping.
    expect(await t.repo.getIdentity()).toEqual(identity)

    t.vault.lock()
    await expect(t.vault.unlock('old passphrase')).rejects.toThrow(WrongPassphraseError)
    await t.vault.unlock('new passphrase')
    expect(await t.repo.getIdentity()).toEqual(identity)
    await t.destroy()
  })

  it('rejects a wrong current passphrase', async () => {
    const t = await makeVault('actual')
    await expect(t.vault.changePassphrase('guess', 'whatever', { params: TEST_KDF })).rejects.toThrow(
      WrongPassphraseError,
    )
    await t.destroy()
  })
})

describe('at-rest guarantees', () => {
  let t: TestVault

  beforeEach(async () => {
    t = await makeVault()
  })
  afterEach(async () => {
    await t.destroy()
  })

  it('never writes a message body in the clear', async () => {
    const convo = await t.repo.ensureConversation('a'.repeat(64), 'b'.repeat(64))
    await t.repo.putMessage({
      id: 'c'.repeat(64),
      convoId: convo.id,
      direction: 'out',
      status: 'sent',
      ts: Date.now(),
      tsCoarse: 0,
      body: 'THE-SECRET-PLAINTEXT',
      authorPubkey: 'a'.repeat(64),
    })

    const raw = await t.db.messages.toArray()
    const dump = JSON.stringify(raw)
    expect(dump).not.toContain('THE-SECRET-PLAINTEXT')
    expect(dump).not.toContain('b'.repeat(64))
  })

  it('never writes a contact pubkey into an index', async () => {
    const pubkey = 'dead'.repeat(16)
    await t.repo.upsertContact(pubkey, { name: 'Sara', source: 'invite', accepted: true })

    const rows = await t.db.contacts.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).not.toContain(pubkey)
    expect(JSON.stringify(rows.map((r) => ({ ...r, enc: undefined })))).not.toContain('Sara')
  })

  it('stores only hour-granularity timestamps in the message index', async () => {
    const convo = await t.repo.ensureConversation('a'.repeat(64), 'b'.repeat(64))
    const ts = Date.UTC(2026, 0, 15, 13, 47, 23, 456)
    await t.repo.putMessage({
      id: 'e'.repeat(64),
      convoId: convo.id,
      direction: 'in',
      status: 'delivered',
      ts,
      tsCoarse: 0,
      body: 'x',
      authorPubkey: 'b'.repeat(64),
    })

    const row = await t.db.messages.get('e'.repeat(64))
    expect(row?.tsCoarse).toBe(Date.UTC(2026, 0, 15, 13, 0, 0, 0))
    // The exact time survives inside the ciphertext.
    expect((await t.repo.getMessage('e'.repeat(64)))?.ts).toBe(ts)
  })

  it('cannot read records after locking', async () => {
    await t.repo.upsertContact('f'.repeat(64), { name: 'x' })
    t.vault.lock()
    await expect(t.repo.listContacts()).rejects.toThrow(VaultLockedError)
  })

  it('gives two vaults different blinded ids for the same pubkey', async () => {
    const other = await makeVault('different passphrase')
    const pubkey = '9'.repeat(64)
    expect(new VaultRepo(t.vault).contactId(pubkey)).not.toBe(new VaultRepo(other.vault).contactId(pubkey))
    await other.destroy()
  })
})
