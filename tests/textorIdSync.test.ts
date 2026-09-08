import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity, formatId } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DeviceSync, type DeviceSyncHost } from '@/core/engine/deviceSync'
import * as textorIds from '@/core/identity/textorId'
import { isTextorId, lookUpTextorId, textorIdOf } from '@/core/identity/textorId'
import { unwrapGift } from '@/core/crypto/giftwrap'
import { shortNpub, toNpub } from '@/core/identity/keys'
import { DEFAULT_DM_RELAYS } from '@/core/transport/defaultRelays'
import {
  DEFAULT_SETTINGS,
  PROFILE_UNSET,
  type AppSettings,
  type DeviceMarks,
  type IdentityRecord,
} from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * A Textor ID on real engines (ADR-081): there from the start, the same on every
 * device and after a restore, found by someone who has only been given it, and worked
 * out for each contact from their key, with nothing said to anyone.
 *
 * On the stand-in for scrypt in `setup.ts`: nothing here depends on how the number is
 * worked out, only on who does what with it.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND
/** The chunk that writes it loads about 20 seconds after start, and waits as long again to do anything. */
const settle = (ms = 2 * 60 * SECOND) => vi.advanceTimersByTimeAsync(ms)
const RESTORED = { name: PROFILE_UNSET, about: PROFILE_UNSET, avatar: PROFILE_UNSET }

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
}

const newKey = () => bytesToHex(createIdentity().identity.secretKey)

async function makeDevice(
  network: FakeRelayNetwork,
  name: string,
  secretKeyHex = newKey(),
  identity: Partial<IdentityRecord> = {},
): Promise<Device> {
  const secretKey = hexToBytes(secretKeyHex)
  const vault = await makeVault(`${name}-pw`)
  const pubkey = getPublicKey(secretKey)
  await vault.repo.putIdentity({
    pubkey,
    npub: '',
    secretKeyHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
    ...identity,
  })
  await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(secretKeyHex, pubkey)
  return { pubkey, secretKey, vault, messenger }
}

/** What someone who has only been given the ID gets from the relays. */
const look = (network: FakeRelayNetwork, id: string) =>
  lookUpTextorId(id, async (filter) => network.query(filter))

describe('a Textor ID on real engines', () => {
  let network: FakeRelayNetwork
  const all: Device[] = []
  const add = (device: Device) => {
    all.push(device)
    return device
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
  })
  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('is worked out and put up by itself, and found by someone who has only been given it', async () => {
    const device = add(await makeDevice(network, 'laptop'))
    const told = vi.fn()
    device.messenger.events.on('identityChanged', told)
    await settle()
    const id = (await device.vault.repo.getIdentity())?.textorId as string
    expect(id).toBe(await textorIdOf(device.pubkey))
    expect(told).toHaveBeenCalled()
    const { owners } = await look(network, id)
    expect(owners).toEqual([{ pubkey: device.pubkey, relays: ['wss://fake.relay'] }])
  })

  it('is the same on another device of one identity, whichever gets there first', async () => {
    const key = newKey()
    const laptop = add(await makeDevice(network, 'laptop', key))
    const phone = add(await makeDevice(network, 'phone', key))
    await settle()
    const id = (await laptop.vault.repo.getIdentity())?.textorId
    expect(isTextorId(id)).toBe(true)
    expect((await phone.vault.repo.getIdentity())?.textorId).toBe(id)
    expect((await look(network, id as string)).owners.map((owner) => owner.pubkey)).toEqual([laptop.pubkey])
  })

  it('comes back with the twelve words, with every device gone, and is put back up', async () => {
    const key = newKey()
    const first = await makeDevice(network, 'first', key)
    await settle()
    const id = (await first.vault.repo.getIdentity())?.textorId as string
    first.messenger.stop()
    await first.vault.destroy()
    network.events.length = 0
    expect((await look(network, id)).owners).toEqual([])

    const restored = add(await makeDevice(network, 'npub1short', key, { at: RESTORED }))
    // Nothing it writes goes up until it has looked as long as it means to.
    await settle(3 * 60 * SECOND)
    expect((await restored.vault.repo.getIdentity())?.textorId).toBe(id)
    expect((await look(network, id)).owners.map((owner) => owner.pubkey)).toEqual([first.pubkey])
  })

  it("shows a relay no name and no kind 0, and the record is the key's own, under the ID", async () => {
    const device = add(await makeDevice(network, 'laptop'))
    await settle()
    expect(network.events.filter((event) => event.kind === 0)).toEqual([])
    const id = (await device.vault.repo.getIdentity())?.textorId as string
    const records = network.events.filter((event) => event.kind === 30078)
    expect(JSON.stringify(records)).not.toContain('laptop')
    const own = records.filter((event) => event.pubkey === device.pubkey)
    expect(own.map((event) => event.tags[0])).toEqual([['d', `textor/id/v2:${id}`]])
  })

  describe('reaching a contact', () => {
    const held = async (device: Device, of: Device) => device.vault.repo.getContact(of.pubkey)
    /** Every frame sent to this person about an ID: there should be none, as nothing needs saying. */
    const idFramesTo = (device: Device) =>
      network.events
        .filter(
          (event) => event.kind === 1059 && event.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey),
        )
        .filter((event) => {
          try {
            return unwrapGift(event, device.secretKey).content.includes('"t":"id"')
          } catch {
            return false
          }
        })

    it("is worked out by each from the other's key, with nothing said to anyone", async () => {
      const alice = add(await makeDevice(network, 'alice'))
      const bob = add(await makeDevice(network, 'bob'))
      await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
      alice.messenger.noteContact(bob.pubkey, { on: true })
      bob.messenger.noteContact(alice.pubkey, { on: true })
      await alice.messenger.sendMessage(bob.pubkey, 'hello')
      await settle()
      expect((await held(bob, alice))?.textorId).toBe(await textorIdOf(alice.pubkey))
      expect((await held(alice, bob))?.textorId).toBe(await textorIdOf(bob.pubkey))
      expect(idFramesTo(alice)).toEqual([])
      expect(idFramesTo(bob)).toEqual([])
    })

    it('waits for someone who only asked to talk to be accepted', async () => {
      const alice = add(await makeDevice(network, 'alice'))
      const bob = add(await makeDevice(network, 'bob'))
      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: false })
      await settle()
      expect((await held(bob, alice))?.textorId).toBeUndefined()

      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
      bob.messenger.noteContact(alice.pubkey, { on: true })
      await settle()
      expect((await held(bob, alice))?.textorId).toBe(await textorIdOf(alice.pubkey))
    })

    it('is worked out for someone accepted on another device of this identity', async () => {
      const key = newKey()
      const laptop = add(await makeDevice(network, 'laptop', key))
      const phone = add(await makeDevice(network, 'phone', key))
      const carol = add(await makeDevice(network, 'carol'))
      await settle()
      await laptop.vault.repo.upsertContact(carol.pubkey, { accepted: true })
      laptop.messenger.noteContact(carol.pubkey, { on: true })
      for (let round = 0; round < 10 && !(await held(phone, carol))?.textorId; round++)
        await settle(30 * SECOND)
      expect((await held(phone, carol))?.accepted).toBe(true)
      expect((await held(phone, carol))?.textorId).toBe(await textorIdOf(carol.pubkey))
    })

    it('comes back with the twelve words, with every device gone', async () => {
      const key = newKey()
      const peer = add(await makeDevice(network, 'peer'))
      const first = await makeDevice(network, 'first', key)
      await first.vault.repo.upsertContact(peer.pubkey, { accepted: true })
      first.messenger.noteContact(peer.pubkey, { on: true })
      await settle()
      first.messenger.stop()
      await first.vault.destroy()
      peer.messenger.stop()
      // Only what is sealed: whatever went to the inbox has long gone from relays.
      const sealed = network.events.filter((event) => event.kind === 30078)
      network.events.length = 0
      network.events.push(...sealed)

      const restored = add(await makeDevice(network, 'npub1short', key, { at: RESTORED }))
      await settle(3 * 60 * SECOND)
      expect((await restored.vault.repo.getContact(peer.pubkey))?.textorId).toBe(
        await textorIdOf(peer.pubkey),
      )
    })
  })
})

describe('writing a Textor ID', () => {
  let vault: TestVault
  const secretKey = hexToBytes(newKey())
  const self = getPublicKey(secretKey)

  const make = async (identity: Partial<IdentityRecord>, over: Partial<DeviceSyncHost['record']> = {}) => {
    await vault.repo.putIdentity({
      pubkey: self,
      npub: '',
      secretKeyHex: bytesToHex(secretKey),
      name: 'me',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
      ...identity,
    })
    const written: { event: NostrEvent; relays: readonly string[] | undefined }[] = []
    const marks: DeviceMarks = { read: {}, cleared: {} }
    const changed = vi.fn()
    const sync = new DeviceSync({
      self,
      repo: vault.repo,
      marks,
      send: async () => undefined,
      forget: async () => undefined,
      changed,
      callElsewhere: () => undefined,
      restoring: () => false,
      record: {
        secretKey: () => secretKey,
        relays: () => ['wss://mine.example'],
        query: async (_filter, _relays, options) => {
          options.onEose?.('wss://mine.example')
          return []
        },
        write: async (event, relays) => {
          written.push({ event, relays })
        },
        ...over,
      },
    })
    return {
      sync,
      written,
      changed,
      // Of everything written, only these two go to relays named for them.
      idWrites: () => written.filter((entry) => entry.relays !== undefined),
    }
  }
  const state = () => vault.repo.getState<{ publicIdAt?: number }>('device-sync')

  beforeEach(async () => {
    vault = await makeVault('textor ids')
  })
  afterEach(async () => {
    await vault.destroy()
  })

  it('goes on the default relays too, for someone sharing none with this identity', async () => {
    const { sync, idWrites } = await make({})
    await sync.syncRecord()
    expect(idWrites()).toHaveLength(1)
    expect(idWrites()[0]?.relays).toEqual(['wss://mine.example', ...DEFAULT_DM_RELAYS])
    expect(idWrites()[0]?.event.pubkey).toBe(self)
    sync.stop()
  })

  it('works it out once, tells the screens, and keeps it', async () => {
    const { sync, changed } = await make({})
    await sync.syncRecord()
    expect((await vault.repo.getIdentity())?.textorId).toBe(await textorIdOf(self))
    expect(changed).toHaveBeenCalledWith('identity')
    sync.stop()
  })

  it('does not work out again what it has', async () => {
    const id = await textorIdOf(self)
    const { sync, changed, idWrites } = await make({ textorId: id })
    const derive = vi.spyOn(textorIds, 'textorIdOf')
    await sync.syncRecord()
    expect((await vault.repo.getIdentity())?.textorId).toBe(id)
    expect(changed).not.toHaveBeenCalledWith('identity')
    expect(derive).not.toHaveBeenCalled()
    expect(idWrites()).toHaveLength(1)
    derive.mockRestore()
    sync.stop()
  })

  it('works out again one of its own that does not check out, rather than put it up', async () => {
    const { sync, changed, idWrites } = await make({ textorId: 'ZZZZZZZZZZZZZZZZ' })
    await sync.syncRecord()
    const id = await textorIdOf(self)
    expect((await vault.repo.getIdentity())?.textorId).toBe(id)
    expect(changed).toHaveBeenCalledWith('identity')
    expect(idWrites()[0]?.event.tags[0]).toEqual(['d', `textor/id/v2:${id}`])
    sync.stop()
  })

  it('is written again before relays would drop it, and not every time before that', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { sync, idWrites } = await make({})
      await sync.syncRecord()
      expect(idWrites()).toHaveLength(1)
      vi.setSystemTime(Date.now() + 8 * DAY)
      await sync.syncRecord()
      expect(idWrites()).toHaveLength(1)
      vi.setSystemTime(Date.now() + 23 * DAY)
      await sync.syncRecord()
      expect(idWrites()).toHaveLength(2)
      expect(idWrites()[1]?.event.created_at).toBeGreaterThan(idWrites()[0]?.event.created_at as number)
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is looked to soon after starting on a device that has been keeping everything else up to date', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await vault.repo.putState('device-sync', {
        dev: 'a'.repeat(16),
        seen: {},
        helloAt: Date.now(),
        recordAt: Date.now(),
        listedAt: Date.now(),
      })
      const { sync, idWrites } = await make({})
      await sync.start()
      await vi.waitFor(() => expect(idWrites()).toHaveLength(1), { timeout: 60_000, interval: 5_000 })
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is left alone on a device that has written it lately', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await vault.repo.putState('device-sync', {
        dev: 'a'.repeat(16),
        seen: {},
        helloAt: Date.now(),
        recordAt: Date.now(),
        listedAt: Date.now(),
        publicIdAt: Date.now(),
      })
      const { sync, idWrites } = await make({})
      await sync.start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(idWrites()).toEqual([])
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('comes round again with the weekly read, on a device with nothing else to do', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await vault.repo.putState('device-sync', {
        dev: 'a'.repeat(16),
        seen: {},
        helloAt: Date.now(),
        recordAt: Date.now() - 31 * DAY,
        listedAt: Date.now() - 31 * DAY,
        publicIdAt: Date.now() - 31 * DAY,
      })
      const { sync, idWrites } = await make({})
      await sync.start()
      await vi.waitFor(() => expect(idWrites()).toHaveLength(1), { timeout: 60_000, interval: 5_000 })
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a device that has never read the record as due to', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await vault.repo.putState('device-sync', {
        dev: 'a'.repeat(16),
        seen: {},
        helloAt: Date.now(),
        listedAt: Date.now(),
        publicIdAt: Date.now() - 31 * DAY,
      })
      const { sync, idWrites } = await make({})
      await sync.start()
      await vi.waitFor(() => expect(idWrites()).toHaveLength(1), { timeout: 60_000, interval: 5_000 })
      sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not written when it cannot be: locked, or stopped on the way', async () => {
    const locked = await make(
      {},
      {
        // Unlocked for the read, and locked by the time the ID's turn comes.
        secretKey: (() => {
          let calls = 0
          return () => (calls++ === 0 ? secretKey : null)
        })(),
      },
    )
    await locked.sync.syncRecord()
    expect(locked.idWrites()).toEqual([])
    locked.sync.stop()

    // Stopped by the first thing written, on the way to the ID.
    const late: unknown[] = []
    const stopping = await make(
      { name: 'someone', at: { name: Date.now() } },
      {
        write: async (event, relays) => {
          if (relays) late.push(event)
          stopping.sync.stop()
        },
      },
    )
    await stopping.sync.syncRecord()
    expect(late).toEqual([])
  })

  it('tries again later if the record could not be queued', async () => {
    const failing = await make(
      {},
      {
        write: async (_event, relays) => {
          if (relays) throw new Error('queue full')
        },
      },
    )
    await failing.sync.syncRecord()
    expect((await state())?.publicIdAt).toBeUndefined()
    failing.sync.stop()
  })

  it('turns a stand-in for a name into the ID, and leaves a real name alone', async () => {
    const shown = formatId(await textorIdOf(self))
    const blank = await make({ name: shortNpub(toNpub(self)) })
    await blank.sync.syncRecord()
    expect((await vault.repo.getIdentity())?.name).toBe(shown)
    blank.sync.stop()

    // A name that is nothing but what was kept as the ID, however grouped, was the app's.
    for (const [name, kept] of [
      ['7X9K2-M4QHD', '7X9K2M4QHD'],
      ['ZZZZ-ZZZZ-ZZZZ-ZZZZ', 'ZZZZZZZZZZZZZZZZ'],
    ]) {
      await vault.repo.updateIdentity({ name: 'x', textorId: undefined })
      const stale = await make({ name, textorId: kept })
      await stale.sync.syncRecord()
      expect((await vault.repo.getIdentity())?.name).toBe(shown)
      stale.sync.stop()
    }

    await vault.repo.updateIdentity({ name: 'Parisa', textorId: undefined })
    const named = await make({ name: 'Parisa', textorId: 'ZZZZZZZZZZZZZZZZ' })
    await named.sync.syncRecord()
    expect((await vault.repo.getIdentity())?.name).toBe('Parisa')
    named.sync.stop()
  })

  it('works it out as it starts, with no relay needed, for a screen that is waiting', async () => {
    const { sync, changed } = await make({}, { query: () => new Promise(() => undefined) })
    await sync.start()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('identity'))
    expect((await vault.repo.getIdentity())?.textorId).toBe(await textorIdOf(self))
    sync.stop()
  })

  it('works it out with the key out of reach, as it needs only the public one, and writes nothing', async () => {
    const locked = await make({}, { secretKey: () => null })
    await locked.sync.start()
    await vi.waitFor(async () =>
      expect((await vault.repo.getIdentity())?.textorId).toBe(await textorIdOf(self)),
    )
    await locked.sync.syncRecord()
    expect(locked.idWrites()).toEqual([])
    locked.sync.stop()
  })

  it('has nothing to work out once stopped, or for an identity not there', async () => {
    const stopped = await make({})
    stopped.sync.stop()
    await stopped.sync.start()
    await stopped.sync.syncRecord()
    expect((await vault.repo.getIdentity())?.textorId).toBeUndefined()

    const fresh = await makeVault('no identity')
    const sync = new DeviceSync({
      self,
      repo: fresh.repo,
      marks: { read: {}, cleared: {} },
      send: async () => undefined,
      forget: async () => undefined,
      changed: () => undefined,
      callElsewhere: () => undefined,
      restoring: () => false,
      record: {
        secretKey: () => secretKey,
        relays: () => [],
        query: async () => [],
        write: async () => undefined,
      },
    })
    await sync.syncRecord()
    expect(await fresh.repo.getIdentity()).toBeNull()
    sync.stop()
    await fresh.destroy()
  })

  it('survives failing to work it out', async () => {
    const failing = vi.spyOn(textorIds, 'textorIdOf').mockRejectedValueOnce(new Error('out of memory'))
    const { sync } = await make({})
    await sync.start()
    await vi.waitFor(() => expect(failing).toHaveBeenCalled())
    failing.mockRestore()
    sync.stop()
  })

  describe("a contact's ID", () => {
    const peer = getPublicKey(hexToBytes(newKey()))
    const known = () => vault.repo.getContact(peer)

    it('is worked out from their key once they are a contact', async () => {
      const { sync, changed } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.learnIds()
      expect((await known())?.textorId).toBe(await textorIdOf(peer))
      expect(changed).toHaveBeenCalledWith('contacts')
      sync.stop()
    })

    it('is worked out for someone just accepted at once, with no relay answering', async () => {
      const { sync } = await make({}, { query: async () => [] })
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.noteContact(peer, { on: true })
      expect((await known())?.textorId).toBe(await textorIdOf(peer))
      sync.stop()
    })

    it('works out again one held for them that does not check out', async () => {
      const { sync } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, textorId: 'ZZZZZZZZZZZZZZZZ' })
      await sync.learnIds()
      expect((await known())?.textorId).toBe(await textorIdOf(peer))
      sync.stop()
    })

    it('costs nothing for anyone not a contact, or blocked, and is left until later when stopped', async () => {
      const { sync } = await make({})
      const derive = vi.spyOn(textorIds, 'textorIdOf')
      await vault.repo.upsertContact(peer, { accepted: false })
      await sync.learnIds()
      await vault.repo.upsertContact(peer, { accepted: true, blocked: true })
      await sync.learnIds()
      expect(derive).not.toHaveBeenCalledWith(peer)
      expect((await known())?.textorId).toBeUndefined()

      await vault.repo.upsertContact(peer, { blocked: false })
      sync.stop()
      await sync.learnIds()
      expect((await known())?.textorId).toBeUndefined()
      derive.mockRestore()
    })

    it('does not bring back someone removed or blocked while it was being worked out', async () => {
      const { sync } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      const removing = vi.spyOn(textorIds, 'textorIdOf').mockImplementationOnce(async () => {
        await vault.repo.deleteContact(peer)
        return 'ZZZZZZZZZZZZZZZN'
      })
      await sync.learnIds()
      expect(await known()).toBeNull()

      await vault.repo.upsertContact(peer, { accepted: true })
      removing.mockImplementationOnce(async () => {
        await vault.repo.upsertContact(peer, { blocked: true })
        return 'ZZZZZZZZZZZZZZZN'
      })
      await sync.learnIds()
      expect((await known())?.textorId).toBeUndefined()
      removing.mockRestore()
      sync.stop()
    })

    it('gets past one that cannot be worked out', async () => {
      const { sync, changed } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      const failing = vi.spyOn(vault.repo, 'listContacts').mockRejectedValueOnce(new Error('locked'))
      await sync.learnIds()
      failing.mockRestore()
      expect(changed).not.toHaveBeenCalledWith('contacts')
      await sync.learnIds()
      expect((await known())?.textorId).toBe(await textorIdOf(peer))
      sync.stop()
    })

    it('is worked out when a list from another device of ours adds someone', async () => {
      const { sync } = await make({})
      await vault.repo.upsertContact(peer, { accepted: false })
      const learning = vi.spyOn(sync, 'learnIds')
      await sync.receive(
        JSON.stringify({
          v: 1,
          t: 'sync',
          dev: 'b'.repeat(16),
          people: [{ pk: peer, on: true, at: Date.now() }],
        }),
        Date.now(),
      )
      await vi.waitFor(() => expect(learning).toHaveBeenCalled())
      await vi.waitFor(async () => expect((await known())?.textorId).toBe(await textorIdOf(peer)))
      learning.mockRestore()
      sync.stop()
    })

    it('is carried in no list, as each device works it out for itself', async () => {
      const { sync, written } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, textorId: await textorIdOf(peer) })
      await sync.syncRecord()
      expect(JSON.stringify(written)).not.toContain(await textorIdOf(peer))
      sync.stop()
    })
  })

  it('leaves the engine key as it found it', async () => {
    const before = bytesToHex(secretKey)
    const { sync } = await make({})
    await sync.syncRecord()
    expect(bytesToHex(secretKey)).toBe(before)
    sync.stop()
  })
})

describe('the chunk an ID is worked out in', () => {
  it('is asked for again once it has failed to load, rather than given up on', async () => {
    // A copy of the engine of its own, whose first try at the chunk fails as it would offline.
    vi.resetModules()
    let offline = true
    vi.doMock('@/core/identity/textorId', async (original) => {
      if (offline) throw new Error('could not load the chunk')
      return original()
    })
    const { DeviceSync: Fresh } = await import('@/core/engine/deviceSync')
    const vault = await makeVault('chunk')
    const peer = getPublicKey(hexToBytes(newKey()))
    await vault.repo.upsertContact(peer, { accepted: true })
    const sync = new Fresh({
      self: getPublicKey(hexToBytes(newKey())),
      repo: vault.repo,
      marks: { read: {}, cleared: {} },
      send: async () => undefined,
      forget: async () => undefined,
      changed: () => undefined,
      callElsewhere: () => undefined,
      restoring: () => false,
      record: {
        secretKey: () => null,
        relays: () => [],
        query: async () => [],
        write: async () => undefined,
      },
    })
    await sync.learnIds()
    expect((await vault.repo.getContact(peer))?.textorId).toBeUndefined()

    offline = false
    await sync.learnIds()
    const real = await vi.importActual<typeof textorIds>('@/core/identity/textorId')
    expect((await vault.repo.getContact(peer))?.textorId).toBe(await real.textorIdOf(peer))
    sync.stop()
    await vault.destroy()
    vi.doUnmock('@/core/identity/textorId')
    vi.resetModules()
  })
})
