import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DeviceSync, type DeviceSyncHost } from '@/core/engine/deviceSync'
import { DeletionLog, readDeletionRecord } from '@/core/engine/deletionLog'
import { readRosterRecord, sameRoster, type RosterRecord } from '@/core/engine/deviceRoster'
import {
  KIND_APP_DATA,
  MAX_RECORD_BYTES,
  newestWhole,
  openRecord,
  placesTaken,
  recordKeys,
  sealParts,
  sealRecord,
  type OpenedPart,
} from '@/core/engine/profileRecord'
import { InboxSync } from '@/core/engine/inboxSync'
import { DEFAULT_SETTINGS, PROFILE_UNSET, type AppSettings, type IdentityRecord } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * The contact list, for whoever has only the twelve words (ADR-078): real engines
 * with one key, on a fake network that keeps only the newest replaceable event. Who
 * was removed is gone from what is on the relays, and stays gone from what comes back.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE
const settle = (ms = 3 * SECOND) => vi.advanceTimersByTimeAsync(ms)
const RESTORED = { at: { name: PROFILE_UNSET, about: PROFILE_UNSET, avatar: PROFILE_UNSET } }

const newKey = () => bytesToHex(createIdentity().identity.secretKey)
const peerKey = () => getPublicKey(generateSecretKey())

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  pool: FakeRelayPool
}

/** What the relays hold of a list, opened as whoever has the key would. */
function openList(network: FakeRelayNetwork, secretKey: Uint8Array, slot: 'people' | 'gone') {
  const keys = recordKeys(secretKey)
  const parts = network.events
    .filter((event) => event.kind === KIND_APP_DATA)
    .flatMap((event) => {
      const opened = openRecord(event, keys)
      return opened && 'stamp' in opened && opened.slot === slot ? [opened] : []
    })
  return { parts, whole: newestWhole(parts, slot) }
}
const peopleIn = (network: FakeRelayNetwork, secretKey: Uint8Array) =>
  (openList(network, secretKey, 'people').whole?.value as RosterRecord | undefined)?.people.map(
    (person) => person.pk,
  ) ?? []

describe('restoring the contact list from the twelve words', () => {
  let network: FakeRelayNetwork
  let laptop: Device
  const all: Device[] = []

  async function makeDevice(
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
    const pool = new FakeRelayPool(network)
    const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
    await messenger.start(secretKeyHex, pubkey)
    const device = { pubkey, secretKey, vault, messenger, pool }
    all.push(device)
    return device
  }
  const restore = () => makeDevice('npub1short', bytesToHex(laptop.secretKey), RESTORED)
  const addContact = async (device: Device, pubkey: string, name: string, relays: string[] = []) => {
    await device.vault.repo.upsertContact(pubkey, { name, accepted: true, relays })
    device.messenger.noteContact(pubkey, { on: true, name: true })
  }
  const removeContact = async (device: Device, pubkey: string) => {
    await device.vault.repo.deleteContact(pubkey)
    device.messenger.noteContact(pubkey, { on: false })
  }
  /** Every frame gone: a relay that held only the record, or a restore months later. */
  const framesGone = () => {
    for (let i = network.events.length - 1; i >= 0; i--) {
      if (network.events[i]?.kind === 1059) network.events.splice(i, 1)
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    laptop = await makeDevice('Laptop')
    await settle(30 * SECOND)
  })
  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('brings back everyone, with their names, pins and relays, with every device lost', async () => {
    const sara = peerKey()
    const reza = peerKey()
    const blocked = peerKey()
    await addContact(laptop, sara, 'Sara', ['wss://sara.example'])
    await addContact(laptop, reza, 'رضا')
    await laptop.vault.repo.upsertContact(reza, { remoteName: 'Reza R', profileAt: 44, about: 'not kept' })
    laptop.messenger.noteContact(sara, { pin: true })
    await laptop.vault.repo.upsertContact(blocked, { accepted: false, blocked: true, blockedAt: 77 })
    laptop.messenger.noteBlocked(blocked, true)
    await settle(5 * SECOND)
    laptop.messenger.stop()
    framesGone()

    const restored = await restore()
    await settle(5 * SECOND)
    expect(await restored.vault.repo.getContact(sara)).toMatchObject({
      name: 'Sara',
      accepted: true,
      relays: ['wss://sara.example'],
    })
    expect(await restored.vault.repo.getContact(reza)).toMatchObject({
      name: 'رضا',
      remoteName: 'Reza R',
      profileAt: 44,
    })
    const id = restored.vault.repo.conversationId(restored.pubkey, sara)
    expect((await restored.vault.repo.getConversation(id))?.pinned).toBe(true)
    expect((await restored.vault.repo.getContact(blocked))?.blocked).toBe(true)
  })

  it('overwrites the record as soon as someone is removed, leaving nothing of them', async () => {
    const sara = peerKey()
    const reza = peerKey()
    await addContact(laptop, sara, 'Sara')
    await addContact(laptop, reza, 'Reza')
    await settle(3 * SECOND)
    expect(peopleIn(network, laptop.secretKey).sort()).toEqual([reza, sara].sort())

    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    expect(peopleIn(network, laptop.secretKey)).toEqual([reza])
    // Not named, and not kept as a tombstone either, anywhere in what the relays hold.
    const { parts } = openList(network, laptop.secretKey, 'people')
    expect(parts).toHaveLength(1)
    expect(atob(parts[0]!.data)).not.toContain(sara)
  })

  it('does not bring back someone removed, from frames that added them', async () => {
    const sara = peerKey()
    await addContact(laptop, sara, 'Sara')
    await settle(3 * SECOND)
    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    // The frame that added them is still on the relays. The one that removed them
    // is not, as a relay refusing it or a read in the wrong order would leave it.
    const keys = laptop.secretKey
    for (let i = network.events.length - 1; i >= 0; i--) {
      const event = network.events[i] as NostrEvent
      if (event.kind !== 1059) continue
      const removal = await unwrapPeople(event, keys)
      if (removal?.some((person) => person.pk === sara && !person.on)) network.events.splice(i, 1)
    }
    const restored = await restore()
    await settle(30 * SECOND)
    expect(await restored.vault.repo.getContact(sara)).toBeNull()
  })

  it('does not take someone from a frame read after the record, if the record is newer', async () => {
    const sara = peerKey()
    await addContact(laptop, sara, 'Sara')
    await settle(3 * SECOND)
    const adding = network.events
      .filter((event) => event.kind === 1059)
      .filter((event) => event.tags.some((tag) => tag[1] === laptop.pubkey))
    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    // Nothing of the frames for now: the record is all there is when it is read.
    const frames = network.events.filter((event) => event.kind === 1059)
    framesGone()
    const restored = await restore()
    await settle(5 * SECOND)
    expect(restored.messenger.restoring).toBe(false)
    // And here is the frame that added them, late, from a relay catching up.
    const stale = frames.filter((event) => adding.some((held) => held.id === event.id))
    expect(stale.length).toBeGreaterThan(0)
    for (const event of stale) network.publish(event)
    await settle(5 * SECOND)
    expect(await restored.vault.repo.getContact(sara)).toBeNull()
    expect(peopleIn(network, laptop.secretKey)).toEqual([])
  })

  it('does not take someone from a message of ours older than the record, with nothing else to go on', async () => {
    const sara = await makeDevice('Sara')
    await addContact(laptop, sara.pubkey, 'Sara')
    await laptop.messenger.sendMessage(sara.pubkey, 'written before I removed them')
    await settle(3 * SECOND)
    await removeContact(laptop, sara.pubkey)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    sara.messenger.stop()
    // No frame about them at all: only the record, and the message.
    for (let i = network.events.length - 1; i >= 0; i--) {
      const event = network.events[i] as NostrEvent
      if (event.kind === 1059 && (await unwrapPeople(event, laptop.secretKey))) network.events.splice(i, 1)
    }
    const restored = await restore()
    await settle(30 * SECOND)
    expect(await restored.vault.repo.getContact(sara.pubkey)).toBeNull()
    const id = restored.vault.repo.conversationId(restored.pubkey, sara.pubkey)
    expect(await restored.vault.repo.listMessages(id, 10)).toHaveLength(1)
  })

  it('does not let a frame part way through outlast the record that says they are gone', async () => {
    const sara = peerKey()
    await addContact(laptop, sara, 'Sara')
    await settle(3 * SECOND)
    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    for (let i = network.events.length - 1; i >= 0; i--) {
      const event = network.events[i] as NostrEvent
      if (event.kind !== 1059) continue
      const removal = await unwrapPeople(event, laptop.secretKey)
      if (removal?.some((person) => person.pk === sara && !person.on)) network.events.splice(i, 1)
    }
    // Storing them takes a while, and the record is read in the meantime.
    const vault = await makeVault('slow-pw')
    const upsert = vault.repo.upsertContact.bind(vault.repo)
    vi.spyOn(vault.repo, 'upsertContact').mockImplementation(async (pubkey, patch) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return upsert(pubkey, patch)
    })
    const secretKeyHex = bytesToHex(laptop.secretKey)
    await vault.repo.putIdentity({
      pubkey: laptop.pubkey,
      npub: '',
      secretKeyHex,
      name: 'npub1short',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
      ...RESTORED,
    })
    await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
    const pool = new FakeRelayPool(network)
    const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
    await messenger.start(secretKeyHex, laptop.pubkey)
    all.push({ pubkey: laptop.pubkey, secretKey: laptop.secretKey, vault, messenger, pool })
    await settle(30 * SECOND)
    expect(await vault.repo.getContact(sara)).toBeNull()
    expect(peopleIn(network, laptop.secretKey)).toEqual([])
  })

  it('does not bring back someone removed, from messages to them still on the relays', async () => {
    const sara = await makeDevice('Sara')
    await addContact(laptop, sara.pubkey, 'Sara')
    await laptop.messenger.sendMessage(sara.pubkey, 'written before I removed them')
    await settle(3 * SECOND)
    await removeContact(laptop, sara.pubkey)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    sara.messenger.stop()

    const restored = await restore()
    await settle(30 * SECOND)
    expect(await restored.vault.repo.getContact(sara.pubkey)).toBeNull()
    // The history stays, as it did on the device that removed them.
    const id = restored.vault.repo.conversationId(restored.pubkey, sara.pubkey)
    expect(await restored.vault.repo.listMessages(id, 10)).toHaveLength(1)
    // Nor does the device put them back when it next writes the list.
    await addContact(restored, peerKey(), 'New')
    await settle(5 * SECOND)
    expect(peopleIn(network, laptop.secretKey)).not.toContain(sara.pubkey)
  })

  it('leaves someone removed who wrote to us a request at most, and never a contact', async () => {
    const sara = await makeDevice('Sara')
    await addContact(laptop, sara.pubkey, 'Sara')
    await sara.messenger.sendMessage(laptop.pubkey, 'written before they were removed')
    await settle(3 * SECOND)
    await removeContact(laptop, sara.pubkey)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    sara.messenger.stop()

    const restored = await restore()
    await settle(30 * SECOND)
    expect((await restored.vault.repo.getContact(sara.pubkey))?.accepted).toBe(false)
    await addContact(restored, peerKey(), 'New')
    await settle(5 * SECOND)
    expect(peopleIn(network, laptop.secretKey)).not.toContain(sara.pubkey)
  })

  it('still adds someone written to after the record, from another device', async () => {
    await addContact(laptop, peerKey(), 'Anyone')
    await settle(3 * SECOND)
    const restored = await restore()
    await settle(30 * SECOND)
    const fresh = peerKey()
    await laptop.vault.repo.upsertContact(fresh, { accepted: true })
    await laptop.messenger.sendMessage(fresh, 'after the record')
    await settle(5 * SECOND)
    expect((await restored.vault.repo.getContact(fresh))?.accepted).toBe(true)
  })

  it('removes someone a frame brought in, once the record shows they are gone', async () => {
    const sara = peerKey()
    await addContact(laptop, sara, 'Sara')
    await settle(3 * SECOND)
    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    // Read before the record: its frames reached here first, and the removal is lost.
    const query = FakeRelayPool.prototype.query
    let held = true
    const spy = vi.spyOn(FakeRelayPool.prototype, 'query').mockImplementation(async function (
      this: FakeRelayPool,
      filter,
      relays,
      opts,
    ) {
      if (held && filter.kinds?.includes(KIND_APP_DATA)) {
        await new Promise((resolve) => setTimeout(resolve, 8 * SECOND))
        held = false
      }
      return query.call(this, filter, relays, opts)
    })
    const restored = await restore()
    await settle(30 * SECOND)
    spy.mockRestore()
    expect(await restored.vault.repo.getContact(sara)).toBeNull()
  })

  it('writes nothing over the record until it has seen what it holds', async () => {
    await addContact(laptop, peerKey(), 'Sara')
    await settle(3 * SECOND)
    const before = openList(network, laptop.secretKey, 'people').parts[0]?.createdAt
    laptop.messenger.stop()
    // Asked, and nobody has it yet: the frames are not a list, and this must not become one.
    const query = FakeRelayPool.prototype.query
    let hiding = true
    const spy = vi.spyOn(FakeRelayPool.prototype, 'query').mockImplementation(async function (
      this: FakeRelayPool,
      filter,
      relays,
      opts,
    ) {
      if (hiding && filter.kinds?.includes(KIND_APP_DATA)) {
        opts?.onEose?.('wss://fake.relay')
        return []
      }
      return query.call(this, filter, relays, opts)
    })
    const restored = await restore()
    await settle(8 * SECOND)
    await addContact(restored, peerKey(), 'Edited at once')
    await settle(2 * SECOND)
    expect(openList(network, laptop.secretKey, 'people').parts[0]?.createdAt).toBe(before)
    hiding = false
    await settle(MINUTE)
    spy.mockRestore()
    expect((await restored.vault.repo.listContacts()).map((contact) => contact.name).sort()).toEqual([
      'Edited at once',
      'Sara',
    ])
    expect(peopleIn(network, laptop.secretKey)).toHaveLength(2)
  })

  it('takes the newest record a relay offers, not an old one another still holds', async () => {
    const sara = peerKey()
    const reza = peerKey()
    await addContact(laptop, sara, 'Sara')
    await addContact(laptop, reza, 'Reza')
    await settle(3 * SECOND)
    const stale = network.events.find((event) => event.kind === KIND_APP_DATA && isPeople(event, laptop))
    await removeContact(laptop, sara)
    await settle(3 * SECOND)
    laptop.messenger.stop()
    framesGone()
    const query = FakeRelayPool.prototype.query
    const spy = vi.spyOn(FakeRelayPool.prototype, 'query').mockImplementation(async function (
      this: FakeRelayPool,
      filter,
      relays,
      opts,
    ) {
      const events = await query.call(this, filter, relays, opts)
      return filter.kinds?.includes(KIND_APP_DATA) ? [stale as NostrEvent, ...events] : events
    })
    const restored = await restore()
    await settle(5 * SECOND)
    spy.mockRestore()
    expect(await restored.vault.repo.getContact(sara)).toBeNull()
    expect((await restored.vault.repo.getContact(reza))?.name).toBe('Reza')
  })

  it('keeps a list longer than one event can hold, and clears what it no longer needs', async () => {
    const people = Array.from({ length: 60 }, () => peerKey())
    for (const pubkey of people) {
      await laptop.vault.repo.upsertContact(pubkey, {
        name: 'س'.repeat(64),
        remoteName: 'ش'.repeat(128),
        accepted: true,
        relays: [
          'wss://relay-one.example.com',
          'wss://relay-two.example.com',
          'wss://relay-three.example.com',
        ],
      })
    }
    laptop.messenger.noteContact(people[0] as string, { name: true })
    await settle(3 * SECOND)
    const long = openList(network, laptop.secretKey, 'people')
    expect(long.parts.length).toBeGreaterThan(1)
    for (const event of network.events.filter((held) => held.kind === KIND_APP_DATA)) {
      expect(JSON.stringify(event).length).toBeLessThan(65_536)
    }

    const restored = await restore()
    await settle(5 * SECOND)
    expect((await restored.vault.repo.listContacts()).filter((contact) => contact.accepted)).toHaveLength(60)
    restored.messenger.stop()

    for (const pubkey of people.slice(1)) await removeContact(laptop, pubkey)
    await settle(5 * SECOND)
    const short = openList(network, laptop.secretKey, 'people')
    expect((short.whole?.value as RosterRecord).people.map((person) => person.pk)).toEqual([people[0]])
    expect(short.parts.filter((part) => part.data)).toHaveLength(1)
    expect(short.parts.length).toBe(long.parts.length)
    expect(placesTaken(short.parts, 'people')).toBe(1)
  })

  it('writes each record with a later time than the last, or a relay would keep the old one', async () => {
    const times = new Map<string, number[]>()
    const publish = laptop.pool.publish.bind(laptop.pool)
    const spy = vi.spyOn(laptop.pool, 'publish').mockImplementation(async (event, relays) => {
      if (event.kind === KIND_APP_DATA) {
        const d = event.tags.find((tag) => tag[0] === 'd')?.[1] as string
        times.set(d, [...(times.get(d) ?? []), event.created_at])
      }
      return publish(event, relays)
    })
    const sara = peerKey()
    await addContact(laptop, sara, 'Sara')
    await settle(2 * SECOND)
    await removeContact(laptop, sara)
    await settle(2 * SECOND)
    await addContact(laptop, sara, 'Sara again')
    await settle(2 * SECOND)
    spy.mockRestore()
    const lists = [...times.values()].filter((list) => list.length >= 3)
    expect(lists.length).toBeGreaterThan(0)
    for (const list of lists) expect(new Set(list).size).toBe(list.length)
    expect(peopleIn(network, laptop.secretKey)).toEqual([sara])
  })

  async function unwrapPeople(event: NostrEvent, secretKey: Uint8Array) {
    const { unwrapGift } = await import('@/core/crypto/giftwrap')
    try {
      const frame = JSON.parse(unwrapGift(event, secretKey).content) as {
        people?: { pk: string; on: boolean }[]
      }
      return frame.people ?? null
    } catch {
      return null
    }
  }
  function isPeople(event: NostrEvent, device: Device): boolean {
    const opened = openRecord(event, recordKeys(device.secretKey))
    return Boolean(opened && 'stamp' in opened && opened.slot === 'people')
  }
})

describe('the engine in pieces', () => {
  let vault: TestVault
  const secret = hexToBytes(newKey())
  const self = getPublicKey(secret)
  const keys = recordKeys(secret)
  let relay: FakeRelayNetwork
  let restoring: boolean

  const make = (over: Partial<DeviceSyncHost> = {}) => {
    const changed: string[] = []
    const sync = new DeviceSync({
      self,
      repo: vault.repo,
      marks: { read: {}, cleared: {} },
      send: async () => undefined,
      forget: async (message) => {
        await vault.repo.deleteMessageAndPayload(message.id)
      },
      changed: (what) => changed.push(what),
      callElsewhere: () => undefined,
      restoring: () => restoring,
      record: {
        secretKey: () => secret,
        relays: () => ['wss://a'],
        query: async (filter, _relays, { onEose }) => {
          onEose?.('wss://a')
          return relay.query(filter)
        },
        write: async (event) => relay.publish(event),
      },
      ...over,
    })
    return { sync, changed }
  }
  const person = (pk: string, at: number, over: object = {}) => ({ pk, on: true, at, ...over })
  const openRecordSlot = (event: NostrEvent) => openRecord(event, keys)?.slot
  const publishList = (people: object[], stamp: number, sec = 1000, block: object[] = []) => {
    for (const event of sealParts('people', { people, block }, stamp, keys, sec)) relay.publish(event)
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vault = await makeVault('pieces')
    relay = new FakeRelayNetwork()
    restoring = false
    await vault.repo.putIdentity({
      pubkey: self,
      npub: '',
      secretKeyHex: bytesToHex(secret),
      name: 'Me',
      about: '',
      createdAt: Date.now() - DAY,
      mnemonicBackedUp: true,
    })
  })
  afterEach(async () => {
    await settle(10)
    await vault.destroy()
    vi.useRealTimers()
  })

  const known = (over: object = {}) =>
    vault.repo.putState('device-sync', {
      dev: 'a'.repeat(16),
      seen: {},
      helloAt: Date.now(),
      recordAt: Date.now(),
      listedAt: Date.now(),
      ...over,
    })

  describe('a device that has been around', () => {
    it('keeps someone the record leaves out, who may only be someone its writer has not heard of', async () => {
      await known({ listedAt: undefined })
      const added = peerKey()
      await vault.repo.upsertContact(added, { accepted: true, name: 'Added offline' })
      publishList([], Date.now() + 5)
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(await vault.repo.getContact(added)).toBeTruthy()
      // And it adds them back, since the record does not say so.
      expect(peopleIn(relay, secret)).toEqual([added])
    })

    it('after being away for weeks, takes the record at its word for those it had read in one', async () => {
      const long = Date.now() - 40 * DAY
      const removed = peerKey()
      const offline = peerKey()
      const kept = peerKey()
      await vault.repo.upsertContact(removed, { accepted: true })
      await vault.repo.upsertContact(kept, { accepted: true })
      await vault.repo.putState('device-roster', {
        clock: long,
        mark: long,
        people: {
          [removed]: { on: true, at: long - 5, nameAt: 0, pinAt: 0 },
          [kept]: { on: true, at: long - 5, nameAt: 0, pinAt: 0 },
          [offline]: { on: true, at: long + 5, nameAt: 0, pinAt: 0 },
        },
      })
      await vault.repo.upsertContact(offline, { accepted: true, name: 'Added since' })
      await known({ recordAt: long, listedAt: long })
      publishList([person(kept, long - 5)], Date.now() - DAY)
      const { sync, changed } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(await vault.repo.getContact(removed)).toBeNull()
      expect(await vault.repo.getContact(kept)).toBeTruthy()
      expect(await vault.repo.getContact(offline)).toBeTruthy()
      expect(changed).toContain('contacts')
      expect(peopleIn(relay, secret).sort()).toEqual([kept, offline].sort())
    })

    it('reads the records if it has no note of when it last did', async () => {
      await known({ recordAt: undefined })
      const query = vi.fn<DeviceSyncHost['record']['query']>(async () => [])
      const { sync } = make({
        record: { secretKey: () => secret, relays: () => ['wss://a'], query, write: async () => undefined },
      })
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(query).toHaveBeenCalled()
    })

    it('takes a block the record names, and leaves a removal of someone it never held', async () => {
      await known({ listedAt: undefined })
      const blocked = peerKey()
      publishList([], Date.now(), 1000, [{ pk: blocked, on: true, at: Date.now() }])
      const { sync, changed } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect((await vault.repo.getContact(blocked))?.blocked).toBe(true)
      expect(changed).toContain('contacts')
    })

    it('does not write when it says just what the relays hold, until that is a month old', async () => {
      await known({ listedAt: undefined })
      const sara = peerKey()
      await vault.repo.upsertContact(sara, { accepted: true })
      const first = make()
      await first.sync.start()
      await settle(21 * SECOND)
      first.sync.stop()
      const listEvents = () => openList(relay, secret, 'people').parts.map((part) => part.createdAt)
      const written = listEvents()
      expect(written).toHaveLength(1)

      await known({ recordAt: Date.now() - 8 * DAY })
      const again = make()
      await again.sync.start()
      await settle(21 * SECOND)
      again.sync.stop()
      expect(listEvents()).toEqual(written)

      vi.setSystemTime(Date.now() + 31 * DAY)
      await known({ recordAt: Date.now() - 8 * DAY })
      const later = make()
      await later.sync.start()
      await settle(21 * SECOND)
      later.sync.stop()
      expect(listEvents()).toHaveLength(1)
      expect(listEvents()).not.toEqual(written)
    })

    it('writes what was deleted once, adds up from elsewhere, and refreshes it monthly', async () => {
      await known()
      const local = 'a'.repeat(64)
      const elsewhere = 'b'.repeat(64)
      const { sync } = make()
      await sync.start()
      await sync.noteDeleted(local)
      await settle(2 * SECOND)
      const list = () => openList(relay, secret, 'gone').whole?.value as { ids: [string, number][] }
      expect(list().ids.map(([id]) => id)).toEqual([local])
      sync.stop()

      for (const event of sealParts(
        'gone',
        { ids: [[elsewhere, Date.now()]], clear: [] },
        Date.now() + 9,
        keys,
        Math.floor(Date.now() / 1000) + 5,
      )) {
        relay.publish(event)
      }
      await known({ recordAt: Date.now() - 8 * DAY })
      const message = {
        id: elsewhere,
        convoId: vault.repo.conversationId(self, peerKey()),
        direction: 'in' as const,
        status: 'delivered' as const,
        ts: Date.now(),
        order: Date.now(),
        tsCoarse: 0,
        body: 'gone elsewhere',
        authorPubkey: peerKey(),
        via: 'relay' as const,
      }
      await vault.repo.putMessage(message as never)
      const next = make()
      await next.sync.start()
      await settle(21 * SECOND)
      next.sync.stop()
      expect(await vault.repo.getMessage(elsewhere)).toBeNull()
      expect(next.changed).toContain('conversations')
      expect(await vault.repo.isWithdrawn(elsewhere, self)).toBe(true)
      expect(
        list()
          .ids.map(([id]) => id)
          .sort(),
      ).toEqual([local, elsewhere].sort())
    })

    it('takes a conversation deleted, from the record', async () => {
      await known({ listedAt: undefined })
      const peer = peerKey()
      const { sync, changed } = make()
      const conversation = await vault.repo.ensureConversation(self, peer)
      for (const event of sealParts(
        'gone',
        { ids: [], clear: [{ with: [peer], key: Date.now() + 5, at: Date.now() }] },
        Date.now(),
        keys,
        1000,
      )) {
        relay.publish(event)
      }
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(await vault.repo.getConversation(conversation.id)).toBeNull()
      expect(changed).toContain('conversations')
    })

    it('writes a conversation deleted here, and a block, so a restore knows of them', async () => {
      await known()
      const peer = peerKey()
      const conversation = await vault.repo.ensureConversation(self, peer)
      const { sync } = make()
      await sync.start()
      await sync.noteCleared(conversation)
      await sync.noteBlocked(peer, true)
      await sync.noteGone('c'.repeat(64), peer)
      await settle(2 * SECOND)
      sync.stop()
      const gone = openList(relay, secret, 'gone').whole?.value as {
        ids: [string, number][]
        clear: { with: string[] }[]
      }
      expect(gone.clear[0]?.with).toEqual([peer])
      expect(gone.ids.map(([id]) => id)).toEqual(['c'.repeat(64)])
      const people = openList(relay, secret, 'people').whole?.value as RosterRecord
      expect(people.block.map((entry) => entry.pk)).toEqual([peer])
    })

    it('asks relays to delete the version of the list it replaces, for any that would not take this', async () => {
      await known()
      const sara = peerKey()
      const written: NostrEvent[] = []
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async (filter, _relays, { onEose }) => {
            onEose?.('wss://a')
            return relay.query(filter)
          },
          write: async (event) => {
            written.push(event)
            relay.publish(event)
          },
        },
      })
      await sync.start()
      await vault.repo.upsertContact(sara, { accepted: true })
      await sync.noteContact(sara, { on: true })
      await sync.syncRecord()
      expect(written.filter((event) => event.kind === 5)).toEqual([])
      const first = written.find((event) => openRecordSlot(event) === 'people') as NostrEvent

      await vault.repo.deleteContact(sara)
      await sync.noteContact(sara, { on: false })
      await sync.syncRecord()
      sync.stop()
      const [deletion, ...more] = written.filter((event) => event.kind === 5)
      expect(more).toEqual([])
      expect(deletion?.pubkey).toBe(keys.pubkey)
      expect(deletion?.tags).toContainEqual(['e', first.id])
      expect(deletion?.tags).toContainEqual(['k', String(KIND_APP_DATA)])
      expect(peopleIn(relay, secret)).toEqual([])
    })

    it('does not ask that for the list of what was deleted, which only adds up', async () => {
      await known()
      const written: NostrEvent[] = []
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async (filter, _relays, { onEose }) => {
            onEose?.('wss://a')
            return relay.query(filter)
          },
          write: async (event) => {
            written.push(event)
            relay.publish(event)
          },
        },
      })
      await sync.start()
      await sync.noteDeleted('a'.repeat(64))
      await sync.syncRecord()
      await sync.noteDeleted('b'.repeat(64))
      await sync.syncRecord()
      sync.stop()
      expect(written.filter((event) => event.kind === 5)).toEqual([])
    })

    it('writes later each time, however quickly, or a relay could keep the older', async () => {
      await known()
      const fixed = Date.now()
      const written: NostrEvent[] = []
      const { sync } = make({
        now: () => fixed,
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async (filter, _relays, { onEose }) => {
            onEose?.('wss://a')
            return relay.query(filter)
          },
          write: async (event) => {
            written.push(event)
            relay.publish(event)
          },
        },
      })
      await sync.start()
      await sync.noteDeleted('a'.repeat(64))
      await sync.syncRecord()
      await sync.noteDeleted('b'.repeat(64))
      await sync.syncRecord()
      await sync.noteContact(peerKey(), { on: false })
      sync.stop()
      const times = written
        .filter((event) => openRecordSlot(event) === 'gone')
        .map((event) => event.created_at)
      expect(times).toHaveLength(2)
      expect(times[1]).toBeGreaterThan(times[0] as number)
    })

    it('leaves aside what will not read, and reads what will', async () => {
      await known({ listedAt: undefined })
      const sara = peerKey()
      await vault.repo.upsertContact(sara, { accepted: true })
      for (const event of sealParts('people', { not: 'a list' }, Date.now(), keys, 1000)) relay.publish(event)
      for (const event of sealParts('gone', { not: 'a list' }, Date.now(), keys, 1000)) relay.publish(event)
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(peopleIn(relay, secret)).toEqual([sara])
    })
  })

  describe('a profile told twice at once', () => {
    it('keeps the stamps of both, from a frame and a record arriving together', async () => {
      await known()
      const { sync } = make()
      await sync.start()
      const now = Date.now()
      const frame = (me: object) => JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16), me })
      await Promise.all([
        sync.receive(frame({ name: 'Named', at: { name: now } }), now),
        sync.receive(frame({ about: 'Told', at: { about: now + 1 } }), now),
      ])
      sync.stop()
      const identity = (await vault.repo.getIdentity()) as IdentityRecord
      expect(identity).toMatchObject({ name: 'Named', about: 'Told' })
      expect(identity.at).toMatchObject({ name: now, about: now + 1 })
    })
  })

  describe('a device restored', () => {
    const restoredIdentity = () => vault.repo.updateIdentity(RESTORED)

    it('says when it has heard from a relay, so what was held can be committed', async () => {
      restoring = true
      await restoredIdentity()
      let answer = false
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async (_filter, _relays, { onEose }) => {
            if (answer) onEose?.('wss://a')
            return []
          },
          write: async () => undefined,
        },
      })
      await sync.start()
      const done = vi.fn()
      void sync.firstLook.then(done)
      await settle(2 * SECOND)
      expect(done).not.toHaveBeenCalled()
      answer = true
      await settle(8 * SECOND)
      expect(done).toHaveBeenCalled()
      sync.stop()
    })

    it('gives up waiting once it has stopped asking', async () => {
      restoring = true
      await restoredIdentity()
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async () => [],
          write: async () => undefined,
        },
      })
      await sync.start()
      const done = vi.fn()
      void sync.firstLook.then(done)
      await settle(2 * MINUTE)
      expect(done).toHaveBeenCalled()
      sync.stop()
    })

    it('does not count as heard what only one relay of many says, and writes nothing on it', async () => {
      restoring = true
      await restoredIdentity()
      const sara = peerKey()
      await vault.repo.upsertContact(sara, { accepted: true })
      const write = vi.fn(async () => undefined)
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a', 'wss://b', 'wss://c', 'wss://d'],
          query: async (_filter, _relays, { onEose }) => {
            onEose?.('wss://a')
            return []
          },
          write,
        },
      })
      await sync.start()
      await settle(3 * MINUTE)
      sync.stop()
      expect(write).not.toHaveBeenCalled()
    })

    it('waits for all of a list, rather than settling for an older one', async () => {
      restoring = true
      await restoredIdentity()
      const sara = peerKey()
      const reza = peerKey()
      const older = sealParts('people', { people: [person(sara, 5)], block: [] }, 100, keys, 1000)
      // Far too long for one event, and only its first part has reached anywhere.
      const big = Array.from({ length: 700 }, () =>
        person(peerKey(), 200, { name: 'n'.repeat(64), nameAt: 200 }),
      )
      const newer = sealParts('people', { people: [person(reza, 200), ...big], block: [] }, 200, keys, 2000)
      expect(newer.length).toBeGreaterThan(1)
      const served = [older[0] as NostrEvent, newer[0] as NostrEvent]
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async (_filter, _relays, { onEose }) => {
            onEose?.('wss://a')
            return served
          },
          write: async () => undefined,
        },
      })
      await sync.start()
      await settle(5 * SECOND)
      expect(await vault.repo.getContact(sara)).toBeNull()
      expect(await vault.repo.getContact(reza)).toBeNull()
      served.push(...newer.slice(1))
      await settle(30 * SECOND)
      sync.stop()
      expect(await vault.repo.getContact(reza)).toBeTruthy()
      expect(await vault.repo.getContact(sara)).toBeNull()
    }, 30_000)
  })

  describe('a list as a record', () => {
    it('holds whoever fits, newest first, when there are too many', async () => {
      await known()
      const first = make()
      await first.sync.start()
      const now = Date.now()
      const stamps: Record<string, object> = {}
      const newest = peerKey()
      const name = 'ن'.repeat(128)
      const contacts = Array.from({ length: 800 }, () => peerKey())
      for (const [index, pubkey] of contacts.entries()) {
        stamps[pubkey] = { on: true, at: now - index - 10, nameAt: 1, pinAt: 0 }
      }
      stamps[newest] = { on: true, at: now, nameAt: 1, pinAt: 0 }
      await vault.repo.putState('device-roster', { clock: now, people: stamps })
      first.sync.stop()
      const everyone = new Map(
        [newest, ...contacts].map((pubkey) => [
          pubkey,
          {
            id: pubkey,
            pubkey,
            npub: '',
            name,
            remoteName: name,
            relays: Array.from({ length: 8 }, (_, i) => `wss://relay-number-${i}.example.com`),
            verification: 'unverified' as const,
            source: 'manual' as const,
            accepted: true,
            addedAt: 1,
            lastSeenAt: 1,
            blocked: false,
          },
        ]),
      )
      const list = vi.spyOn(vault.repo, 'listContacts').mockResolvedValue([...everyone.values()])
      const get = vi
        .spyOn(vault.repo, 'getContact')
        .mockImplementation(async (pubkey) => everyone.get(pubkey) ?? null)
      await known({ listedAt: undefined })
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      list.mockRestore()
      get.mockRestore()
      const { whole, parts } = openList(relay, secret, 'people')
      const people = (whole?.value as RosterRecord).people
      expect(people.length).toBeLessThan(801)
      expect(people[0]?.pk).toBe(newest)
      expect(parts.length).toBeLessThanOrEqual(8)
      expect(JSON.stringify(whole?.value).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    }, 60_000)

    it('says when two records say the same, whatever their hints', () => {
      const a: RosterRecord = { people: [{ pk: 'a', on: true, at: 1, relays: ['x'] }], block: [] }
      const b: RosterRecord = { people: [{ pk: 'a', on: true, at: 1 }], block: [] }
      const c: RosterRecord = { people: [{ pk: 'a', on: true, at: 2 }], block: [] }
      const d: RosterRecord = {
        people: [{ pk: 'a', on: true, at: 1 }],
        block: [{ pk: 'b', on: true, at: 1 }],
      }
      expect(sameRoster(a, b)).toBe(true)
      expect(sameRoster(a, c)).toBe(false)
      expect(sameRoster(a, d)).toBe(false)
    })

    it.each([
      ['nothing', undefined],
      ['not a list', { people: 1, block: [] }],
      ['no block', { people: [] }],
      ['someone not a contact', { people: [{ pk: 'a'.repeat(64), on: false, at: 1 }], block: [] }],
      ['a bad person', { people: [{ pk: 'x', on: true, at: 1 }], block: [] }],
      ['an empty entry', { people: [null], block: [] }],
      ['a bad block', { people: [], block: [{ pk: 'x', on: true, at: 1 }] }],
      ['an empty block', { people: [], block: [null] }],
    ])('refuses as a list %s', (_label, value) => {
      expect(readRosterRecord(value)).toBeNull()
    })

    it('reads a good one', () => {
      const value = { people: [{ pk: 'a'.repeat(64), on: true, at: 1 }], block: [] }
      expect(readRosterRecord(value)).toEqual(value)
    })
  })

  describe('parts of a list', () => {
    const part = (over: Partial<OpenedPart>): OpenedPart => ({
      id: 'x',
      slot: 'people',
      stamp: 1,
      index: 0,
      count: 1,
      data: '',
      createdAt: 1,
      ...over,
    })

    it('finds nothing in nothing, in what is missing, or in what will not read', () => {
      expect(newestWhole([], 'people')).toBeNull()
      expect(newestWhole([part({ count: 2, data: 'e30=' })], 'people')).toBeNull()
      expect(newestWhole([part({ data: '!!!' })], 'people')).toBeNull()
      expect(newestWhole([part({ data: 'bm90IGpzb24=' })], 'people')).toBeNull()
      expect(newestWhole([part({ slot: 'gone', data: 'e30=' })], 'people')).toBeNull()
    })

    it('reads the newest, and ignores what a shorter one no longer uses', () => {
      expect(
        newestWhole(
          [
            part({ stamp: 1, data: 'e30=' }),
            part({ stamp: 2, data: 'eyJhIjoxfQ==' }),
            part({ stamp: 2, index: 1, data: '' }),
          ],
          'people',
        ),
      ).toEqual({ stamp: 2, value: { a: 1 } })
    })

    it('counts only places that hold something', () => {
      expect(placesTaken([part({ data: 'x' }), part({ index: 3, data: '' })], 'people')).toBe(1)
      expect(placesTaken([part({ slot: 'gone', data: 'x' })], 'people')).toBe(0)
    })

    it.each([
      ['a stamp that is no time', { slot: 'people', s: -1, i: 0, n: 1, data: '' }],
      ['a place that is none', { slot: 'people', s: 1, i: -1, n: 1, data: '' }],
      ['a place too far', { slot: 'people', s: 1, i: 99, n: 1, data: '' }],
      ['no count', { slot: 'people', s: 1, i: 0, n: 0, data: '' }],
      ['a count that is none', { slot: 'people', s: 1, i: 0, n: 'x', data: '' }],
      ['no data', { slot: 'gone', s: 1, i: 0, n: 1, data: 3 }],
    ])('will not open %s', async (_label, body) => {
      const nip44 = await import('nostr-tools/nip44')
      const base = sealRecord('me', { at: {} }, keys, 1)
      const forged = { ...base, content: nip44.encrypt(JSON.stringify(body), keys.sealKey) }
      expect(openRecord(forged, keys)).toBeNull()
    })
  })

  describe('what was deleted', () => {
    const repo = () => {
      const stored = new Map<string, unknown>()
      return {
        getState: async <T>(name: string) => (stored.get(name) as T) ?? null,
        putState: async (name: string, value: unknown) => {
          stored.set(name, JSON.parse(JSON.stringify(value)))
        },
      }
    }
    const id = (n: number) => n.toString(16).padStart(64, '0')

    it('survives a restart, and forgets what can no longer come back', async () => {
      const store = repo()
      let now = 1_000_000
      const log = new DeletionLog(store, () => now)
      await log.note(id(1))
      await log.noteClear({ with: ['a'.repeat(64)], key: 5 })
      const again = new DeletionLog(store, () => now)
      await again.load()
      expect(again.record().ids.map(([held]) => held)).toEqual([id(1)])
      expect(again.record().clear).toHaveLength(1)
      now += 91 * DAY
      expect(again.record()).toEqual({ ids: [], clear: [] })
    })

    it('keeps the newest when there are too many', async () => {
      let now = 1_000_000
      const log = new DeletionLog(repo(), () => now)
      await log.merge({
        ids: Array.from({ length: 3000 }, (_, i): [string, number] => [id(i), now + i]),
        clear: Array.from({ length: 300 }, (_, i) => ({ with: [id(i)], key: 1, at: now + i })),
      })
      const { ids, clear } = log.record()
      expect(ids).toHaveLength(2500)
      expect(ids[0]?.[0]).toBe(id(2999))
      expect(clear).toHaveLength(200)
      expect(clear[0]?.with).toEqual([id(299)])
      now += 1
    })

    it('adds up, says what was new, and whether a record says it all', async () => {
      const log = new DeletionLog(repo(), () => 1000)
      await log.note(id(1))
      await log.noteClear({ with: [id(9)], key: 5 })
      const told = await log.merge({
        ids: [
          [id(1), 2000],
          [id(2), 900],
        ],
        clear: [
          { with: [id(9)], key: 4, at: 900 },
          { with: [id(8)], key: 4, at: 900 },
        ],
      })
      expect(told.ids).toEqual([id(2)])
      expect(told.clear).toEqual([{ with: [id(8)], key: 4 }])
      const whole = log.record()
      expect(log.isIn(whole)).toBe(true)
      expect(log.isIn({ ids: [], clear: whole.clear })).toBe(false)
      expect(log.isIn({ ids: whole.ids, clear: [] })).toBe(false)
      // Nothing new: nothing written.
      const quiet = await log.merge(whole)
      expect(quiet).toEqual({ ids: [], clear: [] })
    })

    it.each([
      ['nothing', undefined],
      ['not lists', { ids: 1, clear: [] }],
      ['no clear', { ids: [] }],
      ['an id that is none', { ids: [['x', 1]], clear: [] }],
      ['a time that is none', { ids: [['a'.repeat(64), -1]], clear: [] }],
      ['an entry that is none', { ids: [1], clear: [] }],
      ['a clear that is none', { ids: [], clear: [null] }],
      ['a clear naming nobody', { ids: [], clear: [{ with: [], key: 1, at: 1 }] }],
      ['a clear naming no list', { ids: [], clear: [{ with: 'x', key: 1, at: 1 }] }],
      [
        'a clear naming too many',
        { ids: [], clear: [{ with: Array(99).fill('a'.repeat(64)), key: 1, at: 1 }] },
      ],
      ['a clear naming a bad key', { ids: [], clear: [{ with: ['x'], key: 1, at: 1 }] }],
      ['a clear with no point', { ids: [], clear: [{ with: ['a'.repeat(64)], key: -1, at: 1 }] }],
      ['a clear with no time', { ids: [], clear: [{ with: ['a'.repeat(64)], key: 1, at: -1 }] }],
    ])('refuses as a record %s', (_label, value) => {
      expect(readDeletionRecord(value)).toBeNull()
    })

    it('reads a good record', () => {
      const value = { ids: [['a'.repeat(64), 1]], clear: [{ with: ['b'.repeat(64)], key: 1, at: 1 }] }
      expect(readDeletionRecord(value)).toEqual(value)
    })
  })

  describe('an inbox holding its marks', () => {
    it('writes nothing down while what was read is not yet kept', async () => {
      const save = vi.fn(async () => undefined)
      const pool = new FakeRelayPool(new FakeRelayNetwork())
      const inbox = new InboxSync({
        pool,
        pubkey: self,
        store: {
          load: async () => ({ lastSyncSec: 0, floorSec: 0, relays: {} }) as never,
          save,
          items: async () => [],
        },
        onWrap: () => undefined,
      })
      inbox.hold(true)
      await inbox.start()
      await inbox.catchUp()
      inbox.tick()
      await settle(5 * MINUTE)
      inbox.tick()
      expect(save).not.toHaveBeenCalled()
      inbox.hold(false)
      expect(save).toHaveBeenCalledTimes(1)
      inbox.stop()
      pool.destroy()
    })
  })
})
