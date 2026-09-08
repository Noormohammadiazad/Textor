import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { DEFAULT_SETTINGS, PROFILE_UNSET, type AppSettings } from '@/core/models/types'
import { bytesToHex } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * The device sync chunk is fetched on first use, so it can fail to load: a flaky
 * connection, or a version since replaced. Nothing that matters may wait on it.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const settle = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

describe('with the device sync chunk failing to load', () => {
  const stops: (() => Promise<void> | void)[] = []

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.doMock('@/core/engine/deviceSync', () => {
      throw new Error('the chunk did not load')
    })
  })
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    vi.doUnmock('@/core/engine/deviceSync')
    vi.resetModules()
    vi.useRealTimers()
  })

  async function makeDevice(network: FakeRelayNetwork, secretKey: Uint8Array, restored = false) {
    const { Messenger } = await import('@/core/engine/messenger')
    const vault: TestVault = await makeVault('chunk-pw')
    const pubkey = getPublicKey(secretKey)
    const secretKeyHex = bytesToHex(secretKey)
    await vault.repo.putIdentity({
      pubkey,
      npub: '',
      secretKeyHex,
      name: 'Me',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
      ...(restored ? { at: { name: PROFILE_UNSET, about: PROFILE_UNSET, avatar: PROFILE_UNSET } } : {}),
    })
    await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
    const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
    await messenger.start(secretKeyHex, pubkey)
    stops.push(async () => {
      messenger.stop()
      await vault.destroy()
    })
    return { pubkey, vault, messenger }
  }

  it('still restores, deletes, and adds someone written to on another device', async () => {
    const network = new FakeRelayNetwork()
    const key = generateSecretKey()
    const peer = getPublicKey(generateSecretKey())
    const laptop = await makeDevice(network, key)
    await laptop.vault.repo.upsertContact(peer, { accepted: true })
    const deleted = await laptop.messenger.sendMessage(peer, 'then deleted')
    await laptop.messenger.sendMessage(peer, 'kept')
    await settle()

    // Deleting does not wait on the chunk, though relays cannot be asked to act on it.
    await laptop.messenger.redactMessage(peer, deleted.id)
    await settle()
    expect(await laptop.vault.repo.getMessage(deleted.id)).toBeNull()

    // Nor does restoring: it stops waiting for the records, commits, and shows it.
    const restored = await makeDevice(network, key, true)
    await settle(30_000)
    expect(restored.messenger.restoring).toBe(false)
    const id = restored.vault.repo.conversationId(restored.pubkey, peer)
    const bodies = (await restored.vault.repo.listMessages(id, 10)).map((message) => message.body)
    expect(bodies).toEqual(['kept'])
    // With nothing to say otherwise, what we wrote to them makes them a contact, as it always has.
    expect((await restored.vault.repo.getContact(peer))?.accepted).toBe(true)
  })
})
