import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DeviceSync, parseSyncFrame, type DeviceSyncHost } from '@/core/engine/deviceSync'
import { takeForFrame, wins } from '@/core/engine/deviceRoster'
import {
  KIND_APP_DATA,
  openRecord,
  readProfile,
  recordKeys,
  RECORD_TTL_SEC,
  sealRecord,
  wipeRecordKeys,
  type OpenedRecord,
} from '@/core/engine/profileRecord'
import { createRumor, giftWrap, unwrapGift } from '@/core/crypto/giftwrap'
import {
  DEFAULT_SETTINGS,
  MAX_RECORD_AVATAR,
  PROFILE_UNSET,
  type AppSettings,
  type IdentityRecord,
} from '@/core/models/types'
import {
  KIND_CONTROL,
  parseControlFrame,
  PROTOCOL_VERSION,
  recipientTags,
  type ProfileFrame,
  type SyncFrame,
  type SyncPerson,
} from '@/core/models/protocol'
import { stampProfile } from '@/core/models/timeline'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * This identity's own profile and contact list, across its devices and through
 * a restore from the twelve words (ADR-077): real engines with one key, on a fake
 * relay network that keeps only the newest replaceable event, as relays do.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE
const settle = (ms = 3 * SECOND) => vi.advanceTimersByTimeAsync(ms)

const PICTURE = `data:image/jpeg;base64,${'A'.repeat(20_000)}`
const RESTORED = { name: PROFILE_UNSET, about: PROFILE_UNSET, avatar: PROFILE_UNSET }

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  pool: FakeRelayPool
}

const newKey = () => bytesToHex(createIdentity().identity.secretKey)
const peerKey = () => getPublicKey(hexToBytes(newKey()))

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
  const pool = new FakeRelayPool(network)
  const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
  await messenger.start(secretKeyHex, pubkey)
  return { pubkey, secretKey, vault, messenger, pool }
}

const syncFrames = (network: FakeRelayNetwork, device: Device): SyncFrame[] =>
  network.events
    .filter((event) => event.kind === 1059 && event.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey))
    .flatMap((event) => {
      try {
        const rumor = unwrapGift(event, device.secretKey)
        const frame = JSON.parse(rumor.content) as SyncFrame
        return rumor.kind === KIND_CONTROL && frame.t === 'sync' ? [frame] : []
      } catch {
        return []
      }
    })

/** Those of the profile, by the key that signs them, which is not the identity's: its ID's record is (ADR-081). */
const profileRecords = (network: FakeRelayNetwork, device: Device): NostrEvent[] =>
  network.events.filter(
    (event) => event.kind === KIND_APP_DATA && event.pubkey === recordKeys(device.secretKey).pubkey,
  )

const setProfile = async (device: Device, patch: Partial<IdentityRecord>) => {
  const held = (await device.vault.repo.getIdentity())?.at
  await device.vault.repo.updateIdentity({
    ...patch,
    at: stampProfile(held, Object.keys(patch), Date.now()),
  })
  device.messenger.noteProfile()
}

const identityOf = async (device: Device) => (await device.vault.repo.getIdentity()) as IdentityRecord

/** A frame as a device of this identity writes it, however old: a catch-up read gives no order. */
function inject(network: FakeRelayNetwork, from: Device, frame: object): void {
  const rumor = createRumor(
    { kind: KIND_CONTROL, content: JSON.stringify(frame), tags: recipientTags([from.pubkey]) },
    from.secretKey,
  )
  network.publish(giftWrap(rumor, from.secretKey, from.pubkey))
}

describe('stamping a profile', () => {
  it('stamps the parts set, just past everything held', () => {
    expect(stampProfile(undefined, ['name'], 500)).toEqual({ name: 500 })
    expect(stampProfile({ name: 900, about: 3 }, ['about', 'avatar'], 500)).toEqual({
      name: 900,
      about: 901,
      avatar: 901,
    })
    expect(stampProfile({ name: 3 }, ['mnemonicBackedUp'], 500)).toEqual({ name: 3 })
  })
})

describe('the profile record', () => {
  const secret = hexToBytes(newKey())

  it('has keys of its own, the same on every device of one identity and no other', () => {
    const one = recordKeys(secret)
    const again = recordKeys(secret)
    const other = recordKeys(hexToBytes(newKey()))
    expect(again.pubkey).toBe(one.pubkey)
    expect(again.d).toEqual(one.d)
    expect(other.pubkey).not.toBe(one.pubkey)
    expect(one.pubkey).not.toBe(getPublicKey(secret))
    expect(one.d.me).not.toBe(one.d.avatar)
    wipeRecordKeys(one)
    expect(one.signer.every((byte) => byte === 0)).toBe(true)
    expect(one.sealKey.every((byte) => byte === 0)).toBe(true)
  })

  it('shows a relay nothing but an opaque event from a key seen nowhere else', () => {
    const keys = recordKeys(secret)
    const event = sealRecord('me', { name: 'Parisa', about: 'hello', at: { name: 5 } }, keys, 1000)
    expect(event.kind).toBe(KIND_APP_DATA)
    expect(event.pubkey).toBe(keys.pubkey)
    expect(event.created_at).toBe(1000)
    expect(event.tags).toEqual([
      ['d', keys.d.me],
      ['expiration', String(1000 + RECORD_TTL_SEC)],
    ])
    expect(event.content).not.toContain('Parisa')
    expect(JSON.stringify(event)).not.toContain(getPublicKey(secret))
  })

  it('opens only with the key it was sealed with', () => {
    const keys = recordKeys(secret)
    const event = sealRecord('avatar', { avatar: PICTURE, at: { avatar: 5 } }, keys, 1000)
    expect(openRecord(event, keys)).toEqual({
      slot: 'avatar',
      profile: { avatar: PICTURE, at: { avatar: 5 } },
      createdAt: 1000,
    })
    expect(openRecord(event, recordKeys(hexToBytes(newKey())))).toBeNull()
  })

  it('stays under the size some relays hold to, at the largest picture it takes', () => {
    const avatar = `data:image/jpeg;base64,${'A'.repeat(MAX_RECORD_AVATAR - 23)}`
    const event = sealRecord('avatar', { avatar, at: { avatar: 5 } }, recordKeys(secret), 1000)
    expect(JSON.stringify(event).length).toBeLessThan(65_536)
  })

  it('refuses what is not a record', () => {
    const keys = recordKeys(secret)
    const notSlot = sealRecord('me', { at: {} }, keys, 1)
    const forged = { ...notSlot, content: 'not sealed' }
    expect(openRecord(forged, keys)).toBeNull()
    const sneaky = sealRecord(
      'other' as 'me',
      { at: {} },
      { ...keys, d: { ...keys.d, other: 'x' } as never },
      1,
    )
    expect(openRecord(sneaky, keys)).toBeNull()
    const noProfile = sealRecord('me', { name: '', at: {} }, keys, 1)
    expect(openRecord(noProfile, keys)).toBeNull()
  })

  it.each([
    ['nothing', null],
    ['not an object', 'x'],
    ['no stamps', { name: 'a' }],
    ['stamps not an object', { at: 1 }],
    ['a stamp that is no time', { at: { name: -1 } }],
    ['a stamp that is no number', { at: { name: 'x' } }],
    ['an empty name', { name: '', at: {} }],
    ['a name that is no string', { name: 1, at: {} }],
    ['a name too long', { name: 'a'.repeat(129), at: {} }],
    ['an about too long', { about: 'a'.repeat(513), at: {} }],
    ['an about that is no string', { about: 1, at: {} }],
    ['a picture that is no string', { avatar: 1, at: {} }],
    ['a picture too long', { avatar: `data:image/png;base64,${'A'.repeat(65_536)}`, at: {} }],
    ['a picture of the wrong kind', { avatar: 'data:text/html;base64,AAAA', at: {} }],
  ])('refuses a profile with %s', (_label, raw) => {
    expect(readProfile(raw)).toBeNull()
  })

  it('takes a profile whole, and no picture as no picture', () => {
    expect(readProfile({ avatar: '', about: '', at: { avatar: 3, name: undefined } })).toEqual({
      avatar: '',
      about: '',
      at: { avatar: 3 },
    })
    expect(readProfile({ name: 'a', avatar: PICTURE, at: { name: 2 } })).toEqual({
      name: 'a',
      avatar: PICTURE,
      at: { name: 2 },
    })
  })
})

describe('picking between two', () => {
  it('takes the later, and on a tie the same one everywhere', () => {
    expect(wins(2, 'a', 1, 'b')).toBe(true)
    expect(wins(1, 'b', 2, 'a')).toBe(false)
    expect(wins(1, 'b', 1, 'a')).toBe(true)
    expect(wins(1, 'a', 1, 'b')).toBe(false)
    expect(wins(1, 'a', 1, 'a')).toBe(false)
  })

  it('fits frames by size, and always takes at least one', () => {
    const person = (name: string): SyncPerson => ({ pk: 'a'.repeat(64), on: true, at: 1, name, nameAt: 1 })
    const big = [person('س'.repeat(6000)), person('b'), person('c')]
    expect(takeForFrame(big)).toHaveLength(1)
    expect(big).toHaveLength(2)
    expect(takeForFrame(big)).toHaveLength(2)
    expect(takeForFrame(big)).toEqual([])
    const many = Array.from({ length: 70 }, () => person('b'))
    expect(takeForFrame(many)).toHaveLength(64)
  })
})

describe('reading a sync frame', () => {
  const pk = 'a'.repeat(64)
  const frame = (over: object) =>
    JSON.stringify({ v: PROTOCOL_VERSION, t: 'sync', dev: 'a'.repeat(16), ...over })

  it('reads a person and a profile', () => {
    const person: SyncPerson = {
      pk,
      on: true,
      at: 5,
      name: 'Sara',
      nameAt: 5,
      pin: true,
      pinAt: 5,
      remote: 'S',
      about: 'x',
      profileAt: 5,
      relays: ['wss://a.example'],
    }
    const parsed = parseSyncFrame(frame({ people: [person], me: { name: 'Me', at: { name: 3 } } }))
    expect(parsed?.people).toEqual([person])
    expect(parsed?.me).toEqual({ name: 'Me', at: { name: 3 } })
    expect(parseSyncFrame(frame({}))?.me).toBeUndefined()
  })

  it.each([
    ['a person with a bad key', { people: [{ pk: 'x', on: true, at: 5 }] }],
    ['a person undecided', { people: [{ pk, at: 5 }] }],
    ['a person with no stamp', { people: [{ pk, on: true }] }],
    ['a name without its stamp', { people: [{ pk, on: true, at: 5, name: 'a' }] }],
    ['a stamp without its name', { people: [{ pk, on: true, at: 5, nameAt: 5 }] }],
    ['a name too long', { people: [{ pk, on: true, at: 5, name: 'a'.repeat(129), nameAt: 5 }] }],
    ['a pin without its stamp', { people: [{ pk, on: true, at: 5, pin: true }] }],
    ['a pin that is no pin', { people: [{ pk, on: true, at: 5, pin: 'yes', pinAt: 5 }] }],
    ['a pin with a bad stamp', { people: [{ pk, on: true, at: 5, pin: true, pinAt: -1 }] }],
    ['their name without its stamp', { people: [{ pk, on: true, at: 5, remote: 'a' }] }],
    ['their name too long', { people: [{ pk, on: true, at: 5, remote: 'a'.repeat(129), profileAt: 5 }] }],
    ['an about too long', { people: [{ pk, on: true, at: 5, about: 'a'.repeat(513) }] }],
    ['relays that are not a list', { people: [{ pk, on: true, at: 5, relays: 'x' }] }],
    ['too many relays', { people: [{ pk, on: true, at: 5, relays: Array(9).fill('wss://a') }] }],
    ['a relay too long', { people: [{ pk, on: true, at: 5, relays: ['a'.repeat(513)] }] }],
    ['too many people', { people: Array(65).fill({ pk, on: true, at: 5 }) }],
    ['a bad profile', { me: { name: '', at: {} } }],
  ])('refuses %s', (_label, over) => {
    expect(parseSyncFrame(frame(over))).toBeNull()
  })
})

describe('a profile frame', () => {
  it('may say when the profile changed', () => {
    const base = { v: PROTOCOL_VERSION, t: 'profile' }
    expect((parseControlFrame(JSON.stringify({ ...base, at: 5 })) as ProfileFrame).at).toBe(5)
    expect(parseControlFrame(JSON.stringify({ ...base, at: -1 }))).toBeNull()
    expect(parseControlFrame(JSON.stringify({ ...base, at: 'x' }))).toBeNull()
  })
})

describe('one identity on two devices', () => {
  let network: FakeRelayNetwork
  let laptop: Device
  let phone: Device
  const all: Device[] = []
  const add = (device: Device): Device => {
    all.push(device)
    return device
  }
  const introduce = () => settle(2 * MINUTE)

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    laptop = add(await makeDevice(network, 'Laptop'))
    phone = add(await makeDevice(network, 'Phone', bytesToHex(laptop.secretKey)))
  })

  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  describe('their own profile', () => {
    it('reaches the other device, and tells the screens there', async () => {
      await introduce()
      const told = vi.fn()
      phone.messenger.events.on('identityChanged', told)
      await setProfile(laptop, { name: 'Parisa', about: 'on the road' })
      await settle()
      const identity = await identityOf(phone)
      expect(identity.name).toBe('Parisa')
      expect(identity.about).toBe('on the road')
      expect(told).toHaveBeenCalled()
    })

    it('keeps both of two changes made apart, each part by its own time', async () => {
      await introduce()
      await setProfile(laptop, { name: 'From the laptop' })
      await settle(100)
      await setProfile(phone, { about: 'From the phone' })
      await settle()
      for (const device of [laptop, phone]) {
        const identity = await identityOf(device)
        expect(identity.name).toBe('From the laptop')
        expect(identity.about).toBe('From the phone')
      }
    })

    it('lets the later change stand, whichever arrives last', async () => {
      await introduce()
      await setProfile(laptop, { name: 'Older' })
      await settle(50)
      await setProfile(phone, { name: 'Newer' })
      await settle()
      expect((await identityOf(laptop)).name).toBe('Newer')
      expect((await identityOf(phone)).name).toBe('Newer')
    })

    it('sends a picture through the record, never in a frame', async () => {
      await introduce()
      await setProfile(laptop, { avatar: PICTURE })
      await settle(20 * SECOND)
      expect((await identityOf(phone)).avatar).toBe(PICTURE)
      const frames = syncFrames(network, laptop)
      expect(frames.some((frame) => frame.me?.at.avatar)).toBe(true)
      expect(JSON.stringify(frames)).not.toContain('data:image')
      // And the record stays where the other found it.
      expect(network.events.filter((event) => event.kind === KIND_APP_DATA).length).toBeGreaterThan(0)
    })

    it('takes a picture away everywhere', async () => {
      await introduce()
      await setProfile(laptop, { avatar: PICTURE })
      await settle(20 * SECOND)
      await setProfile(laptop, { avatar: undefined })
      await settle(20 * SECOND)
      expect((await identityOf(phone)).avatar).toBeUndefined()
      expect((await identityOf(phone)).at?.avatar).toBeGreaterThan(PROFILE_UNSET)
    })

    it('does not write the picture again when only the name changed', async () => {
      await introduce()
      await setProfile(laptop, { avatar: PICTURE })
      await settle(20 * SECOND)
      const before = network.events.filter((event) => event.kind === KIND_APP_DATA)
      await setProfile(laptop, { name: 'Renamed' })
      await settle(20 * SECOND)
      const after = network.events.filter((event) => event.kind === KIND_APP_DATA)
      const biggest = (events: NostrEvent[]) =>
        events.reduce((a, b) => (a.content.length > b.content.length ? a : b))
      expect(biggest(after).id).toBe(biggest(before).id)
    })
  })

  describe('restoring from the twelve words', () => {
    const restore = (over: Partial<IdentityRecord> = {}) =>
      makeDevice(network, 'npub1short', bytesToHex(laptop.secretKey), { at: RESTORED, ...over })

    it('brings back the name, the bio and the picture at once, with nobody else online', async () => {
      await setProfile(laptop, { name: 'Parisa', about: 'on the road', avatar: PICTURE })
      await settle(30 * SECOND)
      laptop.messenger.stop()
      phone.messenger.stop()

      const restored = add(await restore())
      const told = vi.fn()
      restored.messenger.events.on('identityChanged', told)
      await settle(100)
      const identity = await identityOf(restored)
      expect(identity.name).toBe('Parisa')
      expect(identity.about).toBe('on the road')
      expect(identity.avatar).toBe(PICTURE)
      expect(told).toHaveBeenCalled()
    })

    it('leaves nothing readable on a relay along the way', async () => {
      await setProfile(laptop, { name: 'Parisa', about: 'on the road', avatar: PICTURE })
      await settle(30 * SECOND)
      const restored = add(await restore())
      await settle(5 * SECOND)
      expect((await identityOf(restored)).name).toBe('Parisa')

      expect(network.events.filter((event) => event.kind === 0)).toEqual([])
      // The ID's record alone is the key's own, by design, and says only where it reads
      // (ADR-081). Every other record is sealed, from a key nothing ties to this one.
      const ofId = (event: { tags: string[][] }) => event.tags[0]?.[1]?.startsWith('textor/id/') === true
      const records = network.events.filter((event) => event.kind === KIND_APP_DATA && !ofId(event))
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        expect(record.pubkey).not.toBe(laptop.pubkey)
        expect(record.tags.some((tag) => tag[0] === 'p')).toBe(false)
        expect(JSON.stringify(record)).not.toContain(laptop.pubkey)
        expect(record.content).not.toContain('Parisa')
      }
      const idRecords = network.events.filter((event) => event.kind === KIND_APP_DATA && ofId(event))
      expect(idRecords.map((record) => record.pubkey)).toContain(laptop.pubkey)
      for (const record of idRecords) expect(record.content).not.toContain('Parisa')
    })

    it('never tells or writes what it has only as a stand-in', async () => {
      const network2 = new FakeRelayNetwork()
      const restored = add(await makeDevice(network2, 'npub1short', newKey(), { at: RESTORED }))
      await settle(2 * MINUTE)
      expect(profileRecords(network2, restored)).toEqual([])
      expect(syncFrames(network2, restored).some((frame) => frame.me)).toBe(false)
      expect((await identityOf(restored)).name).toBe('npub1short')
    })

    it('says who it is at once, so another device can tell it the rest', async () => {
      await laptop.vault.repo.upsertContact(peerKey(), { accepted: true, name: 'Sara' })
      await settle(30 * SECOND)
      const restored = add(await restore())
      await settle(5 * SECOND)
      expect((await restored.vault.repo.listContacts()).map((contact) => contact.name)).toContain('Sara')
    })

    it('tells a second new device too, if a little later', async () => {
      await introduce()
      await settle(6 * MINUTE)
      await laptop.vault.repo.upsertContact(peerKey(), { accepted: true, name: 'Sara' })
      const first = add(await restore())
      await settle(5 * SECOND)
      const second = add(await restore())
      await settle(5 * SECOND)
      expect((await first.vault.repo.listContacts()).map((contact) => contact.name)).toContain('Sara')
      await settle(6 * MINUTE)
      expect((await second.vault.repo.listContacts()).map((contact) => contact.name)).toContain('Sara')
    })

    it('looks again, for a record it could not find the first time', async () => {
      const network2 = new FakeRelayNetwork()
      const key = newKey()
      const restored = add(await makeDevice(network2, 'npub1short', key, { at: RESTORED }))
      await settle(2 * SECOND)
      const keys = recordKeys(hexToBytes(key))
      network2.publish(sealRecord('me', { name: 'Parisa', at: { name: Date.now() } }, keys, 1000))
      await settle(40 * SECOND)
      expect((await identityOf(restored)).name).toBe('Parisa')
    })

    it('goes on looking for a picture its record says exists, where the first relays held only that', async () => {
      const network2 = new FakeRelayNetwork()
      const key = newKey()
      const keys = recordKeys(hexToBytes(key))
      const at = Date.now()
      network2.publish(sealRecord('me', { name: 'Parisa', at: { name: at, avatar: at } }, keys, 1000))
      const restored = add(await makeDevice(network2, 'npub1short', key, { at: RESTORED }))
      await settle(2 * SECOND)
      expect((await identityOf(restored)).name).toBe('Parisa')
      expect((await identityOf(restored)).avatar).toBeUndefined()
      network2.publish(sealRecord('avatar', { avatar: PICTURE, at: { avatar: at } }, keys, 1000))
      await settle(10 * SECOND)
      expect((await identityOf(restored)).avatar).toBe(PICTURE)
    })

    it('keeps looking when no relay answered at first, rather than waiting minutes', async () => {
      const network2 = new FakeRelayNetwork()
      const key = newKey()
      const keys = recordKeys(hexToBytes(key))
      network2.publish(sealRecord('me', { name: 'Parisa', at: { name: Date.now() } }, keys, 1000))
      const answers = { up: false }
      const query = FakeRelayPool.prototype.query
      const spy = vi.spyOn(FakeRelayPool.prototype, 'query').mockImplementation(async function (
        this: FakeRelayPool,
        filter,
        relays,
        opts,
      ) {
        const asksRecord = filter.kinds?.includes(KIND_APP_DATA)
        return asksRecord && !answers.up ? [] : query.call(this, filter, relays, opts)
      })
      const restored = add(await makeDevice(network2, 'npub1short', key, { at: RESTORED }))
      await settle(20 * SECOND)
      expect((await identityOf(restored)).name).toBe('npub1short')
      answers.up = true
      await settle(70 * SECOND)
      spy.mockRestore()
      expect((await identityOf(restored)).name).toBe('Parisa')
    })

    it('gives up looking after a few minutes, without writing anything', async () => {
      const network2 = new FakeRelayNetwork()
      const restored = add(await makeDevice(network2, 'npub1short', newKey(), { at: RESTORED }))
      const query = vi.spyOn(restored.pool, 'query')
      await settle(9 * MINUTE)
      const looks = () => query.mock.calls.filter(([filter]) => filter.kinds?.includes(KIND_APP_DATA))
      // The first, and four more.
      expect(looks()).toHaveLength(5)
      expect(looks().map(([, , options]) => options?.graceMs)).toEqual(Array(5).fill(3000))
      await settle(20 * MINUTE)
      expect(looks()).toHaveLength(5)
      expect(profileRecords(network2, restored)).toEqual([])
      query.mockRestore()
    })

    it('gives way to the record only until the person sets it themselves', async () => {
      await setProfile(laptop, { name: 'Old name' })
      await settle(10 * SECOND)
      const restored = add(await restore())
      await settle(5 * SECOND)
      await setProfile(restored, { name: 'New name' })
      await settle(10 * SECOND)
      expect((await identityOf(laptop)).name).toBe('New name')
    })
  })

  describe('the contact list', () => {
    const sara = peerKey()

    it('brings someone added on one device to the other, with name and relays', async () => {
      await introduce()
      await laptop.vault.repo.upsertContact(sara, {
        name: 'Sara',
        accepted: true,
        relays: ['wss://sara.example'],
      })
      const told = vi.fn()
      phone.messenger.events.on('contactsChanged', told)
      laptop.messenger.noteContact(sara, { on: true, name: true })
      await settle()
      const contact = await phone.vault.repo.getContact(sara)
      expect(contact).toMatchObject({ name: 'Sara', accepted: true, relays: ['wss://sara.example'] })
      expect(told).toHaveBeenCalled()
    })

    it('carries a rename, and adds up relay hints rather than replacing them', async () => {
      await introduce()
      for (const [device, relays] of [
        [laptop, ['wss://a.example']],
        [phone, ['wss://b.example']],
      ] as const) {
        await device.vault.repo.upsertContact(sara, { name: 'Sara', accepted: true, relays: [...relays] })
      }
      await laptop.vault.repo.upsertContact(sara, { name: 'Sara from work' })
      laptop.messenger.noteContact(sara, { name: true })
      await settle()
      const contact = await phone.vault.repo.getContact(sara)
      expect(contact?.name).toBe('Sara from work')
      expect(contact?.relays).toEqual(['wss://b.example', 'wss://a.example'])
    })

    it('removes them everywhere, and a late frame does not bring them back', async () => {
      await introduce()
      await laptop.vault.repo.upsertContact(sara, { name: 'Sara', accepted: true })
      laptop.messenger.noteContact(sara, { on: true, name: true })
      await settle()
      expect(await phone.vault.repo.getContact(sara)).toBeTruthy()
      const added = syncFrames(network, laptop).find((frame) => frame.people?.some((p) => p.pk === sara))

      await laptop.vault.repo.deleteContact(sara)
      laptop.messenger.noteContact(sara, { on: false })
      await settle()
      expect(await phone.vault.repo.getContact(sara)).toBeNull()

      // The frame that added them, read again, as a catch-up may.
      inject(network, laptop, added as SyncFrame)
      await settle()
      expect(await phone.vault.repo.getContact(sara)).toBeNull()
    })

    it('lets them be added again afterwards', async () => {
      await introduce()
      await laptop.vault.repo.upsertContact(sara, { name: 'Sara', accepted: true })
      laptop.messenger.noteContact(sara, { on: true, name: true })
      await settle()
      await laptop.vault.repo.deleteContact(sara)
      laptop.messenger.noteContact(sara, { on: false })
      await settle()
      await phone.vault.repo.upsertContact(sara, { name: 'Sara again', accepted: true })
      phone.messenger.noteContact(sara, { on: true, name: true })
      await settle()
      expect((await laptop.vault.repo.getContact(sara))?.name).toBe('Sara again')
    })

    it('leaves alone someone only asking to talk, who was removed elsewhere', async () => {
      await introduce()
      await laptop.vault.repo.upsertContact(sara, { accepted: true })
      laptop.messenger.noteContact(sara, { on: false })
      await phone.vault.repo.upsertContact(sara, { accepted: false, source: 'incoming' })
      await settle()
      expect((await phone.vault.repo.getContact(sara))?.source).toBe('incoming')
    })

    it('accepts on the other device someone accepted here', async () => {
      await introduce()
      for (const device of [laptop, phone]) {
        await device.vault.repo.upsertContact(sara, { accepted: false, source: 'incoming' })
      }
      await laptop.vault.repo.upsertContact(sara, { accepted: true })
      laptop.messenger.noteContact(sara, { on: true })
      await settle()
      expect((await phone.vault.repo.getContact(sara))?.accepted).toBe(true)
    })

    it('pins and unpins everywhere, and pins a conversation not begun yet', async () => {
      await introduce()
      await laptop.vault.repo.upsertContact(sara, { accepted: true })
      const told = vi.fn()
      laptop.messenger.events.on('conversationsChanged', told)
      const toldThere = vi.fn()
      phone.messenger.events.on('conversationsChanged', toldThere)
      laptop.messenger.noteContact(sara, { pin: true })
      await settle()
      const id = phone.vault.repo.conversationId(phone.pubkey, sara)
      expect((await phone.vault.repo.getConversation(id))?.pinned).toBe(true)
      expect(told).toHaveBeenCalled()
      expect(toldThere).toHaveBeenCalled()

      laptop.messenger.noteContact(sara, { pin: false })
      await settle()
      expect((await phone.vault.repo.getConversation(id))?.pinned).toBe(false)
      const here = laptop.vault.repo.conversationId(laptop.pubkey, sara)
      expect((await laptop.vault.repo.getConversation(here))?.pinned).toBe(false)
    })

    it('keeps two changes made apart to the same person', async () => {
      await introduce()
      for (const device of [laptop, phone]) await device.vault.repo.upsertContact(sara, { accepted: true })
      await laptop.vault.repo.upsertContact(sara, { name: 'Sara' })
      laptop.messenger.noteContact(sara, { name: true })
      phone.messenger.noteContact(sara, { pin: true })
      await settle()
      for (const device of [laptop, phone]) {
        const id = device.vault.repo.conversationId(device.pubkey, sara)
        expect((await device.vault.repo.getContact(sara))?.name).toBe('Sara')
        expect((await device.vault.repo.getConversation(id))?.pinned).toBe(true)
      }
    })

    it('tells a new device the whole list, what was removed, and who is blocked', async () => {
      await introduce()
      const removed = peerKey()
      const blocked = peerKey()
      const stranger = peerKey()
      await laptop.vault.repo.upsertContact(sara, {
        accepted: true,
        name: 'Sara',
        remoteName: 'S',
        about: 'hi',
      })
      await laptop.vault.repo.upsertContact(removed, { accepted: true })
      await laptop.vault.repo.upsertContact(blocked, { accepted: true, blocked: true, blockedAt: 5 })
      await laptop.vault.repo.upsertContact(stranger, { accepted: false, blocked: true })
      laptop.messenger.noteContact(sara, { pin: true })
      await settle()
      await laptop.vault.repo.deleteContact(removed)
      laptop.messenger.noteContact(removed, { on: false })
      await settle()
      await settle(2 * 60 * MINUTE)

      const before = syncFrames(network, laptop).length
      const tablet = add(await makeDevice(network, 'Tablet', bytesToHex(laptop.secretKey)))
      await settle(2 * MINUTE)
      const answers = syncFrames(network, laptop).slice(before)
      expect(answers.flatMap((frame) => frame.people ?? [])).toContainEqual({
        pk: removed,
        on: false,
        at: expect.any(Number),
      })
      expect(await tablet.vault.repo.getContact(sara)).toMatchObject({
        name: 'Sara',
        remoteName: 'S',
        about: 'hi',
        profileAt: 1,
      })
      expect((await tablet.vault.repo.getContact(blocked))?.blocked).toBe(true)
      expect((await tablet.vault.repo.getContact(stranger))?.blocked).toBe(true)
      const id = tablet.vault.repo.conversationId(tablet.pubkey, sara)
      expect((await tablet.vault.repo.getConversation(id))?.pinned).toBe(true)
    })

    it('fits a long list into frames every relay will keep', async () => {
      await introduce()
      for (let i = 0; i < 40; i++) {
        await laptop.vault.repo.upsertContact(peerKey(), {
          accepted: true,
          name: 'س'.repeat(64),
          remoteName: 'ش'.repeat(128),
          about: 'ص'.repeat(512),
          relays: Array.from({ length: 8 }, (_, j) => `wss://relay-${j}.example.com`),
        })
      }
      await settle(2 * 60 * MINUTE)
      const tablet = add(await makeDevice(network, 'Tablet', bytesToHex(laptop.secretKey)))
      await settle(2 * MINUTE)
      expect((await tablet.vault.repo.listContacts()).filter((c) => c.accepted)).toHaveLength(40)
      const wraps = network.events.filter((event) => event.kind === 1059)
      expect(Math.max(...wraps.map((event) => JSON.stringify(event).length))).toBeLessThan(65_536)
    })
  })
})

describe('the engine in pieces', () => {
  let vault: TestVault
  const secret = hexToBytes(newKey())
  const self = getPublicKey(secret)
  const peer = peerKey()
  let relay: FakeRelayNetwork
  let answering: boolean
  let accepting: boolean

  const make = (over: Partial<DeviceSyncHost> = {}) => {
    const sent: SyncFrame[] = []
    const changed: string[] = []
    const sync = new DeviceSync({
      self,
      repo: vault.repo,
      marks: { read: {}, cleared: {} },
      send: async (frame) => sent.push(frame),
      forget: async () => undefined,
      changed: (what) => changed.push(what),
      callElsewhere: () => undefined,
      restoring: () => false,
      record: {
        secretKey: () => secret,
        relays: () => ['wss://a'],
        query: async (filter, _relays, { onEose }) => {
          if (answering) onEose?.('wss://a')
          return relay.query(filter)
        },
        write: async (event, relays) => {
          // Only the record of the Textor ID names relays of its own: see `textorId.test.ts`.
          if (relays) return
          if (!accepting) throw new Error('could not queue')
          relay.publish(event)
        },
      },
      ...over,
    })
    return { sync, sent, changed }
  }
  const records = () => relay.events.filter((event) => event.kind === KIND_APP_DATA)
  const frame = (over: object) => JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16), ...over })
  const known = (seen: Record<string, number> = {}, over: object = {}) =>
    vault.repo.putState('device-sync', {
      dev: 'a'.repeat(16),
      seen,
      helloAt: Date.now(),
      recordAt: Date.now(),
      listedAt: Date.now(),
      ...over,
    })

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vault = await makeVault('pieces')
    relay = new FakeRelayNetwork()
    answering = true
    accepting = true
    await vault.repo.putIdentity({
      pubkey: self,
      npub: '',
      secretKeyHex: bytesToHex(secret),
      name: 'Me',
      about: '',
      createdAt: Date.now() - DAY,
      mnemonicBackedUp: true,
      // Already worked out, so that it is not among what these tests see change.
      textorId: 'ZZZZZZZZZZZZZZZN',
    })
  })
  afterEach(async () => {
    await settle(10)
    await vault.destroy()
    vi.useRealTimers()
  })

  describe('the record', () => {
    it('writes nothing when no relay answered, and tries again', async () => {
      answering = false
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      expect(records()).toEqual([])
      answering = true
      await settle(11 * MINUTE)
      expect(records().length).toBe(1)
      sync.stop()
    })

    it('tries again when no relay took it', async () => {
      accepting = false
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      expect(records()).toEqual([])
      accepting = true
      await settle(11 * MINUTE)
      expect(records().length).toBe(1)
      sync.stop()
    })

    it('tries again after a failure, and picks that up after a restart', async () => {
      let failing = true
      const host = make()
      const { sync } = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: async () => {
            if (failing) throw new Error('down')
            return []
          },
          write: async () => undefined,
        },
      })
      await sync.start()
      await settle(21 * SECOND)
      failing = false
      await settle(11 * MINUTE)
      sync.stop()
      host.sync.stop()
      expect((await vault.repo.getState<{ recordDue?: boolean }>('device-sync'))?.recordDue).toBe(true)
    })

    it('reads about weekly, and leaves a recent record alone', async () => {
      const first = make()
      await first.sync.start()
      await settle(21 * SECOND)
      first.sync.stop()
      const written = records().map((event) => event.id)

      const query = vi.fn(async () => relay.query({ kinds: [KIND_APP_DATA] }))
      const soon = make({
        record: { secretKey: () => secret, relays: () => ['wss://a'], query, write: async () => undefined },
      })
      await soon.sync.start()
      await settle(MINUTE)
      soon.sync.stop()
      expect(query).not.toHaveBeenCalled()

      vi.setSystemTime(Date.now() + 8 * DAY)
      const later = make()
      await later.sync.start()
      await settle(MINUTE)
      later.sync.stop()
      expect(records().map((event) => event.id)).toEqual(written)
    })

    it('writes a month-old record again, so relays keep it', async () => {
      const first = make()
      await first.sync.start()
      await settle(21 * SECOND)
      first.sync.stop()
      const written = records().map((event) => event.id)
      vi.setSystemTime(Date.now() + 31 * DAY)
      const later = make()
      await later.sync.start()
      await settle(MINUTE)
      later.sync.stop()
      expect(records().map((event) => event.id)).not.toEqual(written)
      expect(records()).toHaveLength(1)
    })

    it('takes what is newer in the record, and puts back what it has newer', async () => {
      const keys = recordKeys(secret)
      const now = Date.now()
      relay.publish(
        sealRecord('me', { name: 'Older', about: 'Newer', at: { name: 5, about: now } }, keys, 1000),
      )
      await vault.repo.updateIdentity({ name: 'Newer', at: { name: now - 10 } })
      const { sync, changed } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      const identity = (await vault.repo.getIdentity()) as IdentityRecord
      expect(identity.name).toBe('Newer')
      expect(identity.about).toBe('Newer')
      expect(changed).toContain('identity')
      const opened = openRecord(records()[0] as NostrEvent, keys) as OpenedRecord
      expect(opened.profile).toMatchObject({ name: 'Newer', about: 'Newer' })
    })

    it('takes the newest of copies that differ, and ignores what will not open', async () => {
      const keys = recordKeys(secret)
      const query: DeviceSyncHost['record']['query'] = async (_filter, _relays, { onEose }) => {
        onEose?.('wss://a')
        return [
          sealRecord('me', { name: 'Newest', at: { name: 9000 } }, keys, 2000),
          sealRecord('me', { name: 'Older', at: { name: 10 } }, keys, 1000),
          sealRecord('me', { name: 'Middle', at: { name: 100 } }, keys, 1500),
          { ...sealRecord('me', { at: {} }, keys, 3000), content: 'not sealed' },
        ]
      }
      await vault.repo.updateIdentity({ at: { name: 1, about: 1, avatar: 1 } })
      const write = vi.fn(async () => undefined)
      const { sync } = make({ record: { secretKey: () => secret, relays: () => ['wss://a'], query, write } })
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(((await vault.repo.getIdentity()) as IdentityRecord).name).toBe('Newest')
    })

    it('does not write a picture too large for relays to keep, and keeps its record', async () => {
      const keys = recordKeys(secret)
      const large = `data:image/jpeg;base64,${'A'.repeat(MAX_RECORD_AVATAR)}`
      await vault.repo.updateIdentity({ avatar: large, at: { avatar: Date.now() } })
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(records().map((event) => openRecord(event, keys)?.slot)).toEqual(['me'])
    })

    it('writes no picture record for a picture never set', async () => {
      const keys = recordKeys(secret)
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      expect(records().map((event) => openRecord(event, keys)?.slot)).toEqual(['me'])
    })

    it('writes nothing when there is nothing but stand-ins', async () => {
      await vault.repo.updateIdentity({ at: { name: 1, about: 1, avatar: 1 } })
      const { sync } = make()
      await sync.start()
      await settle(2 * MINUTE)
      sync.stop()
      expect(records()).toEqual([])
    })

    it('writes the record of just the bio when the name is a stand-in', async () => {
      const keys = recordKeys(secret)
      await vault.repo.updateIdentity({ about: 'Hi', at: { name: 1, about: Date.now(), avatar: 1 } })
      const { sync } = make()
      await sync.start()
      await settle(21 * SECOND)
      sync.stop()
      const opened = openRecord(records()[0] as NostrEvent, keys) as OpenedRecord
      expect(opened.profile).toEqual({ about: 'Hi', at: { about: expect.any(Number) } })
    })

    it('does nothing with no key, or after stopping, or with no identity', async () => {
      const query = vi.fn(async () => [])
      const none = make({
        record: { secretKey: () => null, relays: () => [], query, write: async () => undefined },
      })
      await none.sync.start()
      await settle(21 * SECOND)
      none.sync.stop()
      expect(query).not.toHaveBeenCalled()

      let finish: (events: NostrEvent[]) => void = () => undefined
      const slow = make({
        record: {
          secretKey: () => secret,
          relays: () => ['wss://a'],
          query: () => new Promise((resolve) => (finish = resolve)),
          write: async () => {
            throw new Error('should not write')
          },
        },
      })
      await slow.sync.start()
      await settle(21 * SECOND)
      slow.sync.stop()
      finish([])
      await settle(21 * SECOND)
      await slow.sync.syncRecord()

      const spy = vi.spyOn(vault.repo, 'getIdentity').mockResolvedValue(null)
      const nobody = make()
      await nobody.sync.start()
      await settle(21 * SECOND)
      nobody.sync.stop()
      spy.mockRestore()
      expect(records()).toEqual([])
    })

    it('does not look again once stopped', async () => {
      await known()
      const query = vi.fn(async () => [])
      const { sync } = make({
        record: { secretKey: () => secret, relays: () => ['wss://a'], query, write: async () => undefined },
      })
      await sync.start()
      sync.stop()
      sync.noteProfile()
      await settle(MINUTE)
      expect(query).not.toHaveBeenCalled()
    })

    it('looks again for a picture a frame says is newer, a few times, then stops', async () => {
      await known()
      const query = vi.fn<DeviceSyncHost['record']['query']>(async (_filter, _relays, { onEose }) => {
        onEose?.('wss://a')
        return []
      })
      const { sync } = make({
        record: { secretKey: () => secret, relays: () => ['wss://a'], query, write: async () => undefined },
      })
      await sync.start()
      const stamp = Date.now() + 5
      await sync.receive(frame({ me: { at: { avatar: stamp } } }), Date.now())
      await sync.receive(frame({ me: { at: { avatar: stamp } } }), Date.now())
      await settle(30 * MINUTE)
      sync.stop()
      expect(query.mock.calls.length).toBe(4)
    })

    it('finds the picture on a later look', async () => {
      await known()
      const keys = recordKeys(secret)
      const { sync, changed } = make()
      await sync.start()
      const stamp = Date.now() + 5
      await sync.receive(frame({ me: { at: { avatar: stamp } } }), Date.now())
      await settle(10 * SECOND)
      relay.publish(sealRecord('avatar', { avatar: PICTURE, at: { avatar: stamp } }, keys, 1000))
      await settle(MINUTE)
      sync.stop()
      expect(((await vault.repo.getIdentity()) as IdentityRecord).avatar).toBe(PICTURE)
      expect(changed).toContain('identity')
    })
  })

  describe('a profile from another device', () => {
    it('is not believed from a clock far ahead', async () => {
      await known()
      const { sync } = make()
      await sync.start()
      const far = Date.now() + 2 * DAY
      await sync.receive(frame({ me: { name: 'Future', at: { name: far, avatar: far } } }), Date.now())
      sync.stop()
      expect(((await vault.repo.getIdentity()) as IdentityRecord).name).toBe('Me')
    })

    it('is not taken when older, and goes by value on a tie', async () => {
      await known()
      const { sync, changed } = make()
      await sync.start()
      const held = (await vault.repo.getIdentity()) as IdentityRecord
      await sync.receive(frame({ me: { name: 'Older', at: { name: held.createdAt - 1 } } }), Date.now())
      expect(changed).toEqual([])
      await sync.receive(frame({ me: { name: 'A', at: { name: held.createdAt } } }), Date.now())
      expect(changed).toEqual([])
      await sync.receive(frame({ me: { name: 'Z', at: { name: held.createdAt } } }), Date.now())
      expect(changed).toEqual(['identity'])
      sync.stop()
      expect(((await vault.repo.getIdentity()) as IdentityRecord).name).toBe('Z')
    })

    it('has nothing to land on with no identity', async () => {
      await known()
      const { sync, changed } = make()
      await sync.start()
      const spy = vi.spyOn(vault.repo, 'getIdentity').mockResolvedValue(null)
      await sync.receive(frame({ me: { name: 'Z', at: { name: Date.now() } } }), Date.now())
      spy.mockRestore()
      sync.stop()
      expect(changed).toEqual([])
    })

    it('tells nothing of a profile with nothing to tell', async () => {
      await known()
      const { sync, sent } = make()
      await sync.start()
      await vault.repo.updateIdentity({ name: '', at: { name: 5, about: 1, avatar: 1 } })
      sync.noteProfile()
      await settle(2 * SECOND)
      sync.stop()
      expect(sent.some((f) => f.me)).toBe(false)
    })

    it('tells nothing with no identity', async () => {
      await known()
      const { sync, sent } = make()
      await sync.start()
      const spy = vi.spyOn(vault.repo, 'getIdentity').mockResolvedValue(null)
      sync.noteProfile()
      await settle(2 * SECOND)
      spy.mockRestore()
      sync.stop()
      expect(sent.some((f) => f.me)).toBe(false)
    })
  })

  describe('the list', () => {
    const entry = (over: Partial<SyncPerson> = {}): SyncPerson => ({ pk: peer, on: true, at: 100, ...over })

    it('merges itself in when another device first appears on the same vault', async () => {
      await known({ ['b'.repeat(16)]: Date.now() })
      await vault.repo.upsertContact(peer, { accepted: true, name: 'Sara' })
      const { sync, sent } = make()
      await sync.start()
      await settle(30 * SECOND)
      sync.stop()
      expect(sent.flatMap((f) => f.people ?? []).map((p) => p.pk)).toEqual([peer])
      expect(sent.some((f) => f.me)).toBe(true)

      const again = make()
      await again.sync.start()
      await settle(30 * SECOND)
      again.sync.stop()
      expect(again.sent).toEqual([])
    })

    it('keeps quiet at first when there is nobody to compare with', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true, name: 'Sara' })
      const { sync, sent } = make()
      await sync.start()
      await settle(30 * SECOND)
      sync.stop()
      expect(sent).toEqual([])
    })

    it('tells a device back after weeks the whole list again', async () => {
      const dev = 'b'.repeat(16)
      await known()
      await vault.repo.upsertContact(peer, { accepted: true, name: 'Sara' })
      const { sync, sent } = make()
      await sync.start()
      await sync.receive(frame({}), Date.now())
      await settle(2 * SECOND)
      expect(sent.flatMap((f) => f.people ?? [])).toHaveLength(1)
      await settle(6 * MINUTE)
      await sync.receive(frame({}), Date.now() + 10 * DAY)
      await settle(2 * SECOND)
      expect(sent.flatMap((f) => f.people ?? [])).toHaveLength(1)
      await sync.receive(frame({ dev }), Date.now() + 40 * DAY)
      await settle(2 * SECOND)
      sync.stop()
      expect(sent.flatMap((f) => f.people ?? [])).toHaveLength(2)
    })

    it('puts off telling a second new device, whatever else goes out first', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true })
      const { sync, sent } = make()
      await sync.start()
      await sync.receive(frame({}), Date.now())
      await settle(2 * SECOND)
      expect(sent.flatMap((f) => f.people ?? [])).toHaveLength(1)
      await sync.receive(frame({ dev: 'c'.repeat(16) }), Date.now())
      await sync.noteContact(peerKey(), { on: false })
      await settle(2 * SECOND)
      expect(sent.flatMap((f) => f.people ?? []).filter((p) => p.pk === peer)).toHaveLength(1)
      await settle(6 * MINUTE)
      sync.stop()
      expect(sent.flatMap((f) => f.people ?? []).filter((p) => p.pk === peer)).toHaveLength(2)
    })

    it('still owes a new device after restarting', async () => {
      await known({}, { owed: true })
      await vault.repo.upsertContact(peer, { accepted: true })
      const { sync, sent } = make()
      await sync.start()
      await settle(30 * SECOND)
      sync.stop()
      expect(sent.flatMap((f) => f.people ?? []).map((p) => p.pk)).toEqual([peer])
    })

    it('tells a blocked contact by when, or by when they were added if nobody knows', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true, blocked: true })
      const dated = peerKey()
      await vault.repo.upsertContact(dated, { accepted: false, blocked: true, blockedAt: 7 })
      const { sync, sent } = make()
      await sync.start()
      await sync.receive(frame({}), Date.now())
      await settle(2 * SECOND)
      sync.stop()
      const blocks = sent.flatMap((f) => f.block ?? [])
      expect(blocks).toContainEqual({ pk: dated, on: true, at: 7 })
      expect(blocks.map((b) => b.pk)).toContain(peer)
    })

    it('says nothing of someone never here, or gone behind its back', async () => {
      await known()
      const { sync, sent } = make()
      await sync.start()
      await sync.noteContact(peer, { name: true })
      await settle(2 * SECOND)
      expect(sent.flatMap((f) => f.people ?? [])).toEqual([])

      await vault.repo.upsertContact(peer, { accepted: true })
      await sync.noteContact(peer, { on: true })
      await vault.repo.deleteContact(peer)
      await sync.noteContact(peer, { name: true })
      await settle(2 * SECOND)
      sync.stop()
      expect(sent.flatMap((f) => f.people ?? [])).toEqual([])
    })

    it('bounds what it tells of someone to what a frame may carry', async () => {
      await known()
      await vault.repo.upsertContact(peer, {
        accepted: true,
        name: 'a'.repeat(300),
        remoteName: 'b'.repeat(300),
        about: 'c'.repeat(900),
        profileAt: 44,
        relays: Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`),
      })
      const { sync, sent } = make()
      await sync.start()
      await sync.noteContact(peer, { on: true, name: true })
      await settle(2 * SECOND)
      sync.stop()
      const told = sent.flatMap((f) => f.people ?? [])[0] as SyncPerson
      expect(told.name).toHaveLength(128)
      expect(told.remote).toHaveLength(128)
      expect(told.about).toHaveLength(512)
      expect(told.profileAt).toBe(44)
      expect(parseSyncFrame(JSON.stringify(sent.at(-1)))).not.toBeNull()
    })

    it('tells their name without an about they do not have', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true, remoteName: 'S' })
      const { sync, sent } = make()
      await sync.start()
      await sync.noteContact(peer, { on: true })
      await settle(2 * SECOND)
      sync.stop()
      const told = sent.flatMap((f) => f.people ?? [])[0] as SyncPerson
      expect(told).toMatchObject({ remote: 'S', profileAt: 1 })
      expect(told.about).toBeUndefined()
    })

    it('is not believed from a clock far ahead', async () => {
      await known()
      const { sync } = make()
      await sync.start()
      const far = Date.now() + 2 * DAY
      await sync.receive(frame({ people: [entry({ at: far })] }), Date.now())
      sync.stop()
      expect(await vault.repo.getContact(peer)).toBeNull()
    })

    it('goes by each stamp, and only takes a profile that is newer', async () => {
      await known()
      await vault.repo.upsertContact(peer, {
        accepted: true,
        name: 'Mine',
        remoteName: 'New',
        about: 'New about',
        profileAt: 50,
      })
      const addedAt = ((await vault.repo.getContact(peer)) as { addedAt: number }).addedAt
      const { sync, changed } = make()
      await sync.start()
      await sync.receive(
        frame({
          people: [
            entry({
              at: addedAt - 1,
              name: 'Old',
              nameAt: addedAt - 1,
              remote: 'Old',
              about: 'Old about',
              profileAt: 49,
            }),
          ],
        }),
        Date.now(),
      )
      expect(changed).toEqual([])
      expect(await vault.repo.getContact(peer)).toMatchObject({
        name: 'Mine',
        remoteName: 'New',
        about: 'New about',
      })
      await sync.receive(
        frame({
          people: [
            entry({ at: addedAt, name: 'Later', nameAt: addedAt + 1, remote: 'Newer', profileAt: 51 }),
          ],
        }),
        Date.now(),
      )
      sync.stop()
      expect(changed).toEqual(['contacts'])
      expect(await vault.repo.getContact(peer)).toMatchObject({
        name: 'Later',
        remoteName: 'Newer',
        about: 'New about',
        profileAt: 51,
      })
    })

    it('does not unpin for an older pin, and treats a removal of someone unknown as nothing', async () => {
      await known()
      const { sync, changed } = make()
      await sync.start()
      await sync.receive(frame({ people: [entry({ on: false })] }), Date.now())
      expect(changed).toEqual([])
      await sync.receive(frame({ people: [entry({ at: 200, pin: true, pinAt: 200 })] }), Date.now())
      await sync.receive(frame({ people: [entry({ at: 200, pin: false, pinAt: 150 })] }), Date.now())
      sync.stop()
      const id = vault.repo.conversationId(self, peer)
      expect((await vault.repo.getConversation(id))?.pinned).toBe(true)
    })

    it('does not delete for a removal older than the person being here', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true })
      const { sync } = make()
      await sync.start()
      await sync.receive(frame({ people: [entry({ on: false, at: 5 })] }), Date.now())
      sync.stop()
      expect(await vault.repo.getContact(peer)).toBeTruthy()
    })

    it('adds nothing up when the relays are already known', async () => {
      await known()
      await vault.repo.upsertContact(peer, { accepted: true, relays: ['wss://a.example/'] })
      const { sync, changed } = make()
      await sync.start()
      await sync.receive(frame({ people: [entry({ relays: ['wss://a.example/'] })] }), Date.now())
      sync.stop()
      expect(changed).toEqual([])
    })

    it('remembers across a restart what it decided', async () => {
      await known()
      const first = make()
      await first.sync.start()
      await first.sync.receive(frame({ people: [entry({ on: false, at: Date.now() })] }), Date.now())
      first.sync.stop()
      const second = make()
      await second.sync.start()
      await second.sync.receive(frame({ dev: 'b'.repeat(16), people: [entry({ at: 5 })] }), Date.now())
      second.sync.stop()
      expect(await vault.repo.getContact(peer)).toBeNull()
    })
  })
})

describe('what a contact says of themselves', () => {
  let network: FakeRelayNetwork
  let mine: Device
  let theirs: Device
  const all: Device[] = []

  const say = (over: Partial<ProfileFrame>) => {
    const rumor = createRumor(
      {
        kind: KIND_CONTROL,
        content: JSON.stringify({ v: PROTOCOL_VERSION, t: 'profile', ...over }),
        tags: recipientTags([mine.pubkey]),
      },
      theirs.secretKey,
    )
    network.publish(giftWrap(rumor, theirs.secretKey, mine.pubkey))
  }
  const held = () => mine.vault.repo.getContact(theirs.pubkey)

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    mine = await makeDevice(network, 'Mine')
    theirs = await makeDevice(network, 'Theirs')
    all.push(mine, theirs)
    await mine.vault.repo.upsertContact(theirs.pubkey, { accepted: true })
  })
  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('takes the newer, whichever order they arrive in', async () => {
    const now = Date.now()
    say({ name: 'New', avatar: PICTURE, at: now })
    await settle()
    expect(await held()).toMatchObject({ remoteName: 'New', avatar: PICTURE, profileAt: now })
    say({ name: 'Old', at: now - 5000 })
    await settle()
    expect(await held()).toMatchObject({ remoteName: 'New', avatar: PICTURE, profileAt: now })
  })

  it('ignores a device of theirs yet to catch up, sending what it has now', async () => {
    await theirs.vault.repo.upsertContact(mine.pubkey, { accepted: true })
    const now = Date.now()
    say({ name: 'Fresh', at: now })
    await settle()
    await theirs.vault.repo.updateIdentity({ name: 'Stale', at: { name: now - 60_000 } })
    await theirs.messenger.sendProfileTo(mine.pubkey)
    await settle()
    expect((await held())?.remoteName).toBe('Fresh')
  })

  it('goes by the time on it, when it comes from a client that says nothing more', async () => {
    say({ name: 'First' })
    await settle(2 * SECOND)
    expect((await held())?.remoteName).toBe('First')
    const later = (await held())?.profileAt as number
    expect(later).toBeGreaterThan(0)
    await settle(2 * SECOND)
    say({ name: 'Second', about: 'Hi' })
    await settle(2 * SECOND)
    expect(await held()).toMatchObject({ remoteName: 'Second', about: 'Hi' })
    say({ avatar: PICTURE })
    await settle(2 * SECOND)
    expect(await held()).toMatchObject({ remoteName: 'Second', about: 'Hi' })
  })

  it('takes away what a stamped profile leaves out', async () => {
    const now = Date.now()
    say({ name: 'N', about: 'Hi', avatar: PICTURE, at: now })
    await settle()
    say({ name: 'N', at: now + 1 })
    await settle()
    const contact = await held()
    expect(contact?.about).toBeFalsy()
    expect(contact?.avatar).toBeFalsy()
  })

  it('still takes where they read, from a profile no newer', async () => {
    const now = Date.now()
    say({ name: 'N', at: now, relays: ['wss://a.example'] })
    await settle()
    say({ name: 'Other', at: now, relays: ['wss://b.example'] })
    await settle()
    expect(await held()).toMatchObject({ remoteName: 'N', relays: ['wss://b.example'] })
  })

  it('is not believed from a clock far ahead', async () => {
    say({ name: 'Future', at: Date.now() + 2 * DAY })
    await settle()
    expect((await held())?.remoteName).toBeUndefined()
  })

  it('sends when the profile changed, not when it was sent, and little for a stand-in', async () => {
    const stamps = async () => {
      const frames = network.events
        .filter((event) => event.kind === 1059 && event.tags.some((t) => t[1] === mine.pubkey))
        .flatMap((event) => {
          const rumor = unwrapGift(event, mine.secretKey)
          const parsed = JSON.parse(rumor.content) as ProfileFrame
          return parsed.t === 'profile' ? [parsed.at] : []
        })
      return frames.at(-1)
    }
    const createdAt = ((await theirs.vault.repo.getIdentity()) as IdentityRecord).createdAt
    await theirs.messenger.sendProfileTo(mine.pubkey)
    await settle()
    expect(await stamps()).toBe(createdAt)
    await theirs.vault.repo.updateIdentity({ at: { name: 12_345, about: 7 } })
    await theirs.messenger.sendProfileTo(mine.pubkey)
    await settle()
    expect(await stamps()).toBe(12_345)
    await theirs.vault.repo.updateIdentity({ at: RESTORED })
    await theirs.messenger.sendProfileTo(mine.pubkey)
    await settle()
    expect(await stamps()).toBe(PROFILE_UNSET)
  })
})
