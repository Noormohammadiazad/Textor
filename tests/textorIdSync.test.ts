import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DeviceSync, type DeviceSyncHost } from '@/core/engine/deviceSync'
import { deriveTextorId, idSaltOf, lookUpTextorId, textorIdFrom } from '@/core/identity/textorId'
import { isPerson, readRosterRecord, sameRoster } from '@/core/engine/deviceRoster'
import { unwrapGift } from '@/core/crypto/giftwrap'
import { KIND_CONTROL, parseControlFrame } from '@/core/models/protocol'
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
 * A Textor ID on real engines (ADR-079): there from the start, the same on every
 * device and after a restore, and found by someone who has only been given it.
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
    expect(id).toBe(await deriveTextorId(device.secretKey))
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
    expect(id).toBeTruthy()
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

  describe('reaching a contact', () => {
    /** What this person has been told IDs come from, as the frames to them say. */
    const idFramesTo = (device: Device) =>
      network.events
        .filter(
          (event) => event.kind === 1059 && event.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey),
        )
        .flatMap((event) => {
          try {
            const rumor = unwrapGift(event, device.secretKey)
            const frame = rumor.kind === KIND_CONTROL ? parseControlFrame(rumor.content) : null
            return frame?.t === 'id' ? [frame] : []
          } catch {
            return []
          }
        })
    const held = async (device: Device, of: Device) => device.vault.repo.getContact(of.pubkey)
    const mutual = async () => {
      const alice = add(await makeDevice(network, 'alice'))
      const bob = add(await makeDevice(network, 'bob'))
      await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
      return { alice, bob }
    }

    it('gets there when someone is added, is checked, and they hear back', async () => {
      const { alice, bob } = await mutual()
      alice.messenger.noteContact(bob.pubkey, { on: true })
      await settle()
      expect((await held(bob, alice))?.textorId).toBe(await deriveTextorId(alice.secretKey))
      expect((await held(alice, bob))?.textorId).toBe(await deriveTextorId(bob.secretKey))
    })

    it('gets there with the first message, once, however many follow', async () => {
      const { alice, bob } = await mutual()
      await settle()
      await alice.messenger.sendMessage(bob.pubkey, 'hello')
      await alice.messenger.sendMessage(bob.pubkey, 'again')
      await alice.messenger.sendMessage(bob.pubkey, 'and again')
      await settle()
      expect((await held(bob, alice))?.textorId).toBe(await deriveTextorId(alice.secretKey))
      expect(idFramesTo(bob)).toHaveLength(1)
    })

    it('waits out being offline, as the message beside it does', async () => {
      const { alice, bob } = await mutual()
      await settle()
      network.offline = true
      await alice.messenger.sendMessage(bob.pubkey, 'hello')
      // Past when anything allowed to expire would have, at two minutes.
      await settle(3 * 60 * SECOND)
      network.offline = false
      // Retries back off by a random amount, so this watches for it rather than guess how long.
      for (let minute = 0; minute < 30 && !(await held(bob, alice))?.textorId; minute++) {
        await settle(60 * SECOND)
      }
      expect((await held(bob, alice))?.textorId).toBe(await deriveTextorId(alice.secretKey))
    })

    it('goes to nobody who is not being written to, as a relay could read off the contact list', async () => {
      const { alice, bob } = await mutual()
      const quiet = add(await makeDevice(network, 'quiet'))
      await alice.vault.repo.upsertContact(quiet.pubkey, { accepted: true })
      await settle()
      await alice.messenger.sendMessage(bob.pubkey, 'hello')
      await settle()
      expect(idFramesTo(bob).length).toBeGreaterThan(0)
      expect(idFramesTo(quiet)).toEqual([])
    })

    it('is kept for someone who only asked to talk, and worked out once they are accepted', async () => {
      const alice = add(await makeDevice(network, 'alice'))
      const bob = add(await makeDevice(network, 'bob'))
      await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
      await settle()
      alice.messenger.noteContact(bob.pubkey, { on: true })
      await settle()
      const asked = await held(bob, alice)
      expect(asked?.accepted).toBe(false)
      expect(asked?.idSalt).toBe(idSaltOf(alice.secretKey))
      expect(asked?.textorId).toBeUndefined()

      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
      bob.messenger.noteContact(alice.pubkey, { on: true })
      await settle()
      expect((await held(bob, alice))?.textorId).toBe(await deriveTextorId(alice.secretKey))
    })

    it('comes back with the twelve words, with every device gone', async () => {
      const key = newKey()
      const peer = add(await makeDevice(network, 'peer'))
      const first = await makeDevice(network, 'first', key)
      await first.vault.repo.upsertContact(peer.pubkey, { accepted: true })
      await peer.vault.repo.upsertContact(first.pubkey, { accepted: true })
      first.messenger.noteContact(peer.pubkey, { on: true })
      await settle()
      const theirs = (await held(first, peer))?.textorId
      expect(theirs).toBe(await deriveTextorId(peer.secretKey))
      first.messenger.stop()
      await first.vault.destroy()
      peer.messenger.stop()
      // Only what is sealed: the frames that said so have long gone from relays.
      const sealed = network.events.filter((event) => event.kind === 30078)
      network.events.length = 0
      network.events.push(...sealed)

      const restored = add(await makeDevice(network, 'npub1short', key, { at: RESTORED }))
      await settle(3 * 60 * SECOND)
      expect((await restored.vault.repo.getContact(peer.pubkey))?.textorId).toBe(theirs)
    })
  })

  it('shows a relay no name, no key of the identity, and no kind 0', async () => {
    const device = add(await makeDevice(network, 'laptop'))
    await settle()
    expect(network.events.filter((event) => event.kind === 0)).toEqual([])
    const id = (await device.vault.repo.getIdentity())?.textorId as string
    const seen = JSON.stringify(network.events.filter((event) => event.kind === 30078))
    expect(seen).not.toContain(device.pubkey)
    expect(seen).not.toContain(id)
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
    const told: { peer: string; w: string }[] = []
    const marks: DeviceMarks = { read: {}, cleared: {} }
    const changed = vi.fn()
    const sync = new DeviceSync({
      self,
      repo: vault.repo,
      marks,
      send: async () => undefined,
      tell: async (peer, frame) => told.push({ peer, w: frame.w }),
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
      told,
      changed,
      idWrites: () => written.filter((entry) => entry.relays !== undefined),
    }
  }

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
    sync.stop()
  })

  it('works it out once, tells the screens, and keeps it', async () => {
    const { sync, changed } = await make({})
    await sync.syncRecord()
    const id = (await vault.repo.getIdentity())?.textorId
    expect(id).toBe(await deriveTextorId(secretKey))
    expect(changed).toHaveBeenCalledWith('identity')
    sync.stop()
  })

  it('does not work out again what it has', async () => {
    const { sync, changed, idWrites } = await make({ textorId: 'ZZZZZZZZZZ' })
    await sync.syncRecord()
    expect((await vault.repo.getIdentity())?.textorId).toBe('ZZZZZZZZZZ')
    expect(changed).not.toHaveBeenCalledWith('identity')
    expect(idWrites()).toHaveLength(1)
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
        idAt: Date.now(),
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
        idAt: Date.now() - 31 * DAY,
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
        idAt: Date.now() - 31 * DAY,
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
    const state = await vault.repo.getState<{ idAt?: number }>('device-sync')
    expect(state?.idAt).toBeUndefined()
    failing.sync.stop()
  })

  it('turns a stand-in for a name into the ID, and leaves a real name alone', async () => {
    const standIn = shortNpub(toNpub(self))
    const blank = await make({ name: standIn })
    await blank.sync.syncRecord()
    const id = await deriveTextorId(secretKey)
    const shown = `${id.slice(0, 5)}-${id.slice(5)}`
    expect((await vault.repo.getIdentity())?.name).toBe(shown)
    blank.sync.stop()

    await vault.repo.updateIdentity({ name: 'Parisa', textorId: undefined })
    const named = await make({ name: 'Parisa' })
    await named.sync.syncRecord()
    expect((await vault.repo.getIdentity())?.name).toBe('Parisa')
    named.sync.stop()
  })

  it('works it out as it starts, with no relay needed, for a screen that is waiting', async () => {
    const { sync, changed } = await make({}, { query: () => new Promise(() => undefined) })
    await sync.start()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('identity'))
    expect((await vault.repo.getIdentity())?.textorId).toBe(await deriveTextorId(secretKey))
    sync.stop()
  })

  it('has nothing to work out for an identity not there, or locked', async () => {
    const locked = await make({}, { secretKey: () => null })
    await locked.sync.start()
    await locked.sync.syncRecord()
    expect((await vault.repo.getIdentity())?.textorId).toBeUndefined()
    locked.sync.stop()
  })

  it('survives failing to work it out', async () => {
    const { sync } = await make({ pubkey: 'not hex' } as Partial<IdentityRecord>, {
      secretKey: () => new Uint8Array(3),
    })
    await sync.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    sync.stop()
  })

  describe("a contact's ID", () => {
    const peer = getPublicKey(hexToBytes(newKey()))
    const salt = 'ab'.repeat(16)
    const known = () => vault.repo.getContact(peer)

    it('is checked, not taken on trust: it is what the key and salt really give', async () => {
      const { sync, changed } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.receiveId(peer, salt)
      expect((await known())?.textorId).toBe(await textorIdFrom(peer, salt))
      expect(changed).toHaveBeenCalledWith('contacts')
      sync.stop()
    })

    it('cannot be changed by someone who says something else later', async () => {
      const { sync } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.receiveId(peer, salt)
      const first = (await known())?.textorId
      await sync.receiveId(peer, 'cd'.repeat(16))
      expect((await known())?.textorId).toBe(first)
      expect((await known())?.idSalt).toBe(salt)
      sync.stop()
    })

    it('costs nothing for anyone who is not a contact, however many write', async () => {
      const { sync } = await make({})
      const derive = vi.spyOn(await import('@/core/identity/textorId'), 'textorIdFrom')
      for (let round = 0; round < 3; round++) {
        await sync.receiveId(peer, `${round}`.repeat(32))
      }
      expect((await known())?.textorId).toBeUndefined()
      expect((await known())?.accepted).toBe(false)
      derive.mockRestore()
      sync.stop()
    })

    it('is left until later for someone blocked, or when stopped', async () => {
      const blocked = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, blocked: true })
      await blocked.sync.receiveId(peer, salt)
      expect((await known())?.textorId).toBeUndefined()
      blocked.sync.stop()

      await vault.repo.upsertContact(peer, { blocked: false, idSalt: 'ef'.repeat(16) })
      const stopped = await make({})
      stopped.sync.stop()
      await stopped.sync.learnIds()
      expect((await known())?.textorId).toBeUndefined()
    })

    it('works out someone just accepted at once, with no relay answering', async () => {
      const { sync } = await make({}, { query: async () => [] })
      await vault.repo.upsertContact(peer, { accepted: true, idSalt: salt })
      await sync.noteContact(peer, { on: true })
      expect((await known())?.textorId).toBe(await textorIdFrom(peer, salt))
      sync.stop()
    })

    it('tells them ours when it has theirs, if it has been a while, and not if it has not', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, idToldAt: Date.now() - 2 * DAY })
      await sync.receiveId(peer, salt)
      expect(told).toEqual([{ peer, w: idSaltOf(secretKey) }])
      sync.stop()

      const other = getPublicKey(hexToBytes(newKey()))
      const again = await make({})
      await vault.repo.upsertContact(other, { accepted: true, idToldAt: Date.now() - 1000 })
      await again.sync.receiveId(other, salt)
      expect(again.told).toEqual([])
      again.sync.stop()
    })

    it('gets past one that cannot be worked out', async () => {
      const { sync, changed } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, idSalt: salt })
      const failing = vi.spyOn(vault.repo, 'listContacts').mockRejectedValueOnce(new Error('locked'))
      await sync.learnIds()
      failing.mockRestore()
      expect(changed).not.toHaveBeenCalledWith('contacts')
      await sync.learnIds()
      expect((await known())?.textorId).toBe(await textorIdFrom(peer, salt))
      sync.stop()
    })

    it('tells someone just added or accepted, and writes down that it did', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.noteContact(peer, { on: true })
      expect(told).toEqual([{ peer, w: idSaltOf(secretKey) }])
      expect((await known())?.idToldAt).toBeGreaterThan(0)
      sync.stop()
    })

    it('tells nobody for keeping its records up, however long the list', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.syncRecord()
      await sync.syncRecord()
      expect(told).toEqual([])
      sync.stop()
    })

    it('tells nobody for a change that is not an addition', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.noteContact(peer, { name: true })
      await sync.noteContact(peer, { on: false })
      expect(told).toEqual([])
      sync.stop()
    })

    it('tells someone written to only if a contact, unblocked, and not told before', async () => {
      const { sync, told } = await make({})
      await sync.noteWrote(peer)
      await vault.repo.upsertContact(peer, { accepted: false })
      await sync.noteWrote(peer)
      await vault.repo.upsertContact(peer, { accepted: true, blocked: true })
      await sync.noteWrote(peer)
      expect(told).toEqual([])
      await vault.repo.upsertContact(peer, { blocked: false })
      await sync.noteWrote(peer)
      expect(told).toHaveLength(1)
      await sync.noteWrote(peer)
      expect(told).toHaveLength(1)
      sync.stop()
    })

    it('tells them again with a message after a month, in case the last ran out of tries', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true, idToldAt: Date.now() - 29 * DAY })
      await sync.noteWrote(peer)
      expect(told).toEqual([])
      await vault.repo.upsertContact(peer, { idToldAt: Date.now() - 31 * DAY })
      await sync.noteWrote(peer)
      expect(told).toHaveLength(1)
      sync.stop()
    })

    it('puts a new ID in the sealed list soon, for whoever restores next', async () => {
      const { sync, written } = await make({ textorId: 'ZZZZZZZZZZ' })
      await sync.syncRecord()
      const before = written.length
      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.receiveId(peer, salt)
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(before), { timeout: 5000 })
      sync.stop()
    })

    it('tells once for two messages sent together', async () => {
      const { sync, told } = await make({})
      await vault.repo.upsertContact(peer, { accepted: true })
      await Promise.all([sync.noteWrote(peer), sync.noteWrote(peer)])
      expect(told).toHaveLength(1)
      sync.stop()
    })

    it('tells nobody when locked, or stopped', async () => {
      const locked = await make({}, { secretKey: () => null })
      await vault.repo.upsertContact(peer, { accepted: true })
      await locked.sync.noteWrote(peer)
      expect(locked.told).toEqual([])
      locked.sync.stop()
      const stopped = await make({})
      stopped.sync.stop()
      await stopped.sync.noteWrote(peer)
      expect(stopped.told).toEqual([])
      expect((await known())?.idToldAt).toBeUndefined()
    })

    it('goes in the sealed list, so that a restore has it, and a new one means rewriting the list', async () => {
      const person = { pk: 'a'.repeat(64), on: true, at: 5 }
      expect(isPerson({ ...person, id: '7X9K2M4QHD' })).toBe(true)
      for (const id of ['short', '7x9k2m4qhd', '7X9K2M4QHU', 5]) {
        expect(isPerson({ ...person, id } as never)).toBe(false)
      }
      const without = readRosterRecord({ people: [person], block: [] }) as never
      const withId = readRosterRecord({ people: [{ ...person, id: '7X9K2M4QHD' }], block: [] }) as never
      expect(sameRoster(without, withId)).toBe(false)
      expect(sameRoster(withId, withId)).toBe(true)
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
