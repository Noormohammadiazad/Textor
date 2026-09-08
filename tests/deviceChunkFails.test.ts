import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { KIND_CHAT, KIND_CONTROL, recipientTags } from '@/core/models/protocol'
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

  it('passes over a frame from another device, and still keeps its notes (ADR-082)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const network = new FakeRelayNetwork()
    const key = generateSecretKey()
    const laptop = await makeDevice(network, key)
    // Past its first catch-up, which holds frames from our devices back until it ends.
    await settle(30_000)
    expect(laptop.messenger.restoring).toBe(false)
    const own = (kind: number, content: string) =>
      createRumor({ kind, content, tags: recipientTags([laptop.pubkey]) }, key)
    // From another device of ours: what it tells this one, and a note it saved.
    network.publish(
      giftWrap(
        own(KIND_CONTROL, JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16) })),
        key,
        laptop.pubkey,
      ),
    )
    const note = own(KIND_CHAT, 'saved elsewhere')
    network.publish(giftWrap(note, key, laptop.pubkey))
    // The chunk fails as a module load does, in real time as well as on the clock.
    await vi.waitFor(
      async () => {
        await settle()
        const read = warn.mock.calls.filter(([line]) =>
          String(line).includes('could not read a frame from another device'),
        )
        expect(read.length).toBeGreaterThan(0)
        expect(await laptop.vault.repo.getMessage(note.id)).toMatchObject({
          convoId: laptop.vault.repo.conversationId(laptop.pubkey, laptop.pubkey),
          body: 'saved elsewhere',
        })
      },
      { timeout: 10_000, interval: 100 },
    )

    // And one saved here goes out as ever.
    const mine = await laptop.messenger.sendMessage(laptop.pubkey, 'saved here')
    await settle()
    expect((await laptop.vault.repo.getMessage(mine.id))?.status).toBe('sent')
    warn.mockRestore()
  })
})
