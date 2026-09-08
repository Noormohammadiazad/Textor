import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DeviceSync, parseSyncFrame, type DeviceSyncHost } from '@/core/engine/deviceSync'
import { createRumor, giftWrap, unwrapGift } from '@/core/crypto/giftwrap'
import {
  DEFAULT_SETTINGS,
  DEVICE_MARKS,
  MAX_MESSAGE_EXPIRY_DAYS,
  type AppSettings,
  type DeviceMarks,
  type Message,
} from '@/core/models/types'
import { KIND_CONTROL, PROTOCOL_VERSION, recipientTags, type SyncFrame } from '@/core/models/protocol'
import { KIND_DM_RELAY_LIST } from '@/core/transport/nostrTransport'
import { declineRelay } from '@/core/transport/relayScout'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * One identity on two devices (ADR-073, ADR-074): real engines with the same
 * key, on one fake relay network that deletes as the real relays were measured
 * to. What one device does, the other comes to agree with, in any order.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const MINUTE = 60_000
const settle = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  pool: FakeRelayPool
}

async function makeDevice(
  network: FakeRelayNetwork,
  name: string,
  secretKeyHex?: string,
  overrides: Partial<AppSettings> = {},
): Promise<Device> {
  const skHex = secretKeyHex ?? bytesToHex(createIdentity().identity.secretKey)
  const secretKey = hexToBytes(skHex)
  const vault = await makeVault(`${name}-pw`)
  const pubkey = getPublicKey(secretKey)
  await vault.repo.putIdentity({
    pubkey,
    npub: '',
    secretKeyHex: skHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })
  await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
  const pool = new FakeRelayPool(network)
  const messenger = new Messenger(vault.vault, vault.repo, { ...settings, ...overrides }, pool)
  await messenger.start(skHex, pubkey)
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

describe('one identity on two devices', () => {
  let network: FakeRelayNetwork
  let laptop: Device
  let phone: Device
  let bob: Device
  const all: Device[] = []

  const add = (device: Device): Device => {
    all.push(device)
    return device
  }
  /** Long enough for each device to load its chunk, say hello, and hear the other's. */
  const introduce = () => settle(2 * MINUTE)
  const unread = async (device: Device, peer: string) =>
    (await device.vault.repo.getConversation(device.vault.repo.conversationId(device.pubkey, peer)))?.unread

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    laptop = add(await makeDevice(network, 'Laptop'))
    phone = add(await makeDevice(network, 'Phone', bytesToHex(laptop.secretKey)))
    bob = add(await makeDevice(network, 'Bob'))
    await laptop.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await phone.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(laptop.pubkey, { accepted: true })
  })

  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  describe('finding each other', () => {
    it('says hello, once, and is quiet about reading until it has heard from another device', async () => {
      const network2 = new FakeRelayNetwork()
      const alone = add(await makeDevice(network2, 'Alone'))
      const friend = add(await makeDevice(network2, 'Friend'))
      await settle(2 * MINUTE)
      expect(syncFrames(network2, alone)).toHaveLength(1)

      await friend.messenger.sendMessage(alone.pubkey, 'hello')
      await settle()
      await alone.messenger.openConversation(friend.pubkey)
      await settle(10 * MINUTE)
      // Nobody to tell. Friend's frames do not exist either: they are its own.
      expect(syncFrames(network2, alone)).toHaveLength(1)
      expect(syncFrames(network2, alone)[0]).toEqual({ v: 1, t: 'sync', dev: expect.any(String) })
    })

    it('hears the other device, and answers a new one with what has been read', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'from before the phone')
      await settle()
      await laptop.messenger.openConversation(bob.pubkey)
      await introduce()
      expect(await unread(laptop, bob.pubkey)).toBe(0)
      expect(await unread(phone, bob.pubkey)).toBe(0)
      expect(syncFrames(network, laptop).some((frame) => frame.read?.length)).toBe(true)
    })

    it('says when another device was last heard from, for someone to notice one that is not theirs', async () => {
      const network2 = new FakeRelayNetwork()
      const alone = add(await makeDevice(network2, 'Alone'))
      await settle(2 * MINUTE)
      expect(await alone.messenger.otherDevices()).toEqual([])

      await introduce()
      const heard = await laptop.messenger.otherDevices()
      expect(heard).toHaveLength(1)
      expect(heard[0]).toBeGreaterThan(Date.now() - 5 * MINUTE)
    })

    it('ignores its own frames, and a stranger’s', async () => {
      await introduce()
      const stranger = add(await makeDevice(network, 'Stranger'))
      await bob.messenger.sendMessage(laptop.pubkey, 'unread here')
      await settle()
      expect(await unread(phone, bob.pubkey)).toBe(1)
      // A stranger cannot get a frame this far: naming only themselves and us,
      // it is a rumor from them, and nobody's device.
      const frame: SyncFrame = {
        v: PROTOCOL_VERSION,
        t: 'sync',
        dev: 'a'.repeat(16),
        clear: [{ with: [bob.pubkey], key: Date.now() + 1000 }],
      }
      const rumor = createRumor(
        { kind: KIND_CONTROL, content: JSON.stringify(frame), tags: recipientTags([phone.pubkey]) },
        stranger.secretKey,
      )
      network.publish(giftWrap(rumor, stranger.secretKey, phone.pubkey))
      await settle()
      expect(await unread(phone, bob.pubkey)).toBe(1)
    })
  })

  describe('reading', () => {
    beforeEach(introduce)

    it('clears the badge on the other device', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'one')
      await bob.messenger.sendMessage(laptop.pubkey, 'two')
      await settle()
      expect(await unread(phone, bob.pubkey)).toBe(2)
      await laptop.messenger.openConversation(bob.pubkey)
      await settle(MINUTE)
      expect(await unread(laptop, bob.pubkey)).toBe(0)
      expect(await unread(phone, bob.pubkey)).toBe(0)
    })

    it('leaves what arrived after it was read, and what crossed with a reply', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'read')
      await settle()
      await laptop.messenger.openConversation(bob.pubkey)
      laptop.messenger.setActiveConversation(null)
      await bob.messenger.sendMessage(laptop.pubkey, 'not read')
      await settle(MINUTE)
      expect(await unread(laptop, bob.pubkey)).toBe(1)
      expect(await unread(phone, bob.pubkey)).toBe(1)
    })

    it('counts nothing a mark has passed, whichever arrives first', async () => {
      const convoId = phone.vault.repo.conversationId(phone.pubkey, bob.pubkey)
      await phone.vault.repo.putState(DEVICE_MARKS, { read: {}, cleared: {} })
      phone.messenger.stop()
      const marks: DeviceMarks = { read: { [convoId]: Date.now() + 5000 }, cleared: {} }
      await phone.vault.repo.putState(DEVICE_MARKS, marks)
      const reopened = new Messenger(
        phone.vault.vault,
        phone.vault.repo,
        settings,
        new FakeRelayPool(network),
      )
      await reopened.start(bytesToHex(phone.secretKey), phone.pubkey)
      phone.messenger = reopened
      await bob.messenger.sendMessage(laptop.pubkey, 'already read elsewhere')
      await settle()
      expect((await unread(phone, bob.pubkey)) ?? 0).toBe(0)
      const messages = await phone.vault.repo.listMessages(convoId, 10)
      expect(messages.map((message) => message.body)).toContain('already read elsewhere')
    })

    it('tells the other device about what arrived while watching', async () => {
      await laptop.messenger.openConversation(bob.pubkey)
      await bob.messenger.sendMessage(laptop.pubkey, 'seen as it arrived')
      await settle(MINUTE)
      expect(await unread(phone, bob.pubkey)).toBe(0)
    })
  })

  describe('deleting', () => {
    const held = async (device: Device, peer: string): Promise<Message[]> =>
      device.vault.repo.listMessages(device.vault.repo.conversationId(device.pubkey, peer), 50)
    /** Of wraps: a record of the contact list being replaced asks for the same of the one before. */
    const wrapDeletions = () =>
      network.events.filter(
        (event) => event.kind === 5 && event.tags.some((tag) => tag[0] === 'k' && tag[1] === '1059'),
      )

    beforeEach(introduce)

    it('deleting for everyone reaches every device, and the wraps leave the relays', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'take this back')
      await settle()
      expect((await held(phone, bob.pubkey)).map((m) => m.id)).toContain(sent.id)
      const wraps = network.events.filter((event) => event.kind === 1059).length

      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      await settle()
      expect((await held(phone, bob.pubkey)).map((m) => m.id)).not.toContain(sent.id)
      expect((await held(bob, laptop.pubkey)).map((m) => m.id)).not.toContain(sent.id)

      // Its copy to Bob and to ourselves are gone, signed for by what signed
      // them, and all that is left of it is the withdrawal and its self-copy.
      const left = network.events.filter((event) => event.kind === 1059).length
      expect(left).toBe(wraps - 2 + 2)
      expect(wrapDeletions()).toHaveLength(2)
      for (const event of network.events.filter((e) => e.kind === 1059)) {
        for (const reader of [laptop, bob]) {
          try {
            expect(unwrapGift(event, reader.secretKey).id).not.toBe(sent.id)
          } catch (err) {
            expect(String(err)).not.toContain('AssertionError')
          }
        }
      }
    })

    it('a device starting afterwards never sees it', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'gone before the tablet')
      await settle()
      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      await settle()
      const tablet = add(await makeDevice(network, 'Tablet', bytesToHex(laptop.secretKey)))
      await settle()
      expect(await tablet.vault.repo.getMessage(sent.id)).toBeFalsy()
    })

    it('a withdrawal that overtakes its message still stops it, on every device', async () => {
      const rumor = createRumor(
        { kind: 14, content: 'late', tags: recipientTags([laptop.pubkey]) },
        bob.secretKey,
      )
      const copy = giftWrap(rumor, bob.secretKey, laptop.pubkey)
      const withdrawal = createRumor(
        {
          kind: KIND_CONTROL,
          content: JSON.stringify({ v: 1, t: 'redact', refs: [rumor.id] }),
          tags: recipientTags([bob.pubkey]),
        },
        laptop.secretKey,
      )
      network.publish(giftWrap(withdrawal, laptop.secretKey, laptop.pubkey))
      await settle()
      network.publish(copy)
      await settle()
      expect(await phone.vault.repo.getMessage(rumor.id)).toBeFalsy()
    })

    it('stays in its lane: a self-copied withdrawal touches only that conversation', async () => {
      const carol = add(await makeDevice(network, 'Carol'))
      const toCarol = await laptop.messenger.sendMessage(carol.pubkey, 'for carol')
      await settle()
      const withdrawal = createRumor(
        {
          kind: KIND_CONTROL,
          content: JSON.stringify({ v: 1, t: 'redact', refs: [toCarol.id] }),
          tags: recipientTags([bob.pubkey]),
        },
        laptop.secretKey,
      )
      network.publish(giftWrap(withdrawal, laptop.secretKey, laptop.pubkey))
      await settle()
      expect(await phone.vault.repo.getMessage(toCarol.id)).toBeTruthy()
    })

    it('takes back what the other person asks to, from the relays too', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'bob wants this gone')
      await settle()
      await bob.messenger.redactMessage(laptop.pubkey, sent.id)
      await settle()
      expect(wrapDeletions().length).toBeGreaterThan(0)
      expect(await phone.vault.repo.getMessage(sent.id)).toBeFalsy()
    })

    it('deleting for me reaches my other device and leaves everyone else’s alone', async () => {
      const received = await bob.messenger.sendMessage(laptop.pubkey, 'for my eyes')
      const mine = await laptop.messenger.sendMessage(bob.pubkey, 'my own')
      await settle()
      await laptop.messenger.deleteLocally(received.id)
      await laptop.messenger.deleteLocally(mine.id)
      await settle()
      expect(await phone.vault.repo.getMessage(received.id)).toBeFalsy()
      expect(await phone.vault.repo.getMessage(mine.id)).toBeFalsy()
      expect(await bob.vault.repo.getMessage(received.id)).toBeTruthy()
      expect(await bob.vault.repo.getMessage(mine.id)).toBeTruthy()
      // Only what we wrote can be asked of the relays, and only our own copy.
      expect(wrapDeletions()).toHaveLength(1)
    })

    it('holds off a message deleted for me that had not arrived here yet', async () => {
      const rumor = createRumor(
        { kind: 14, content: 'not yet here', tags: recipientTags([laptop.pubkey]) },
        bob.secretKey,
      )
      const frame: SyncFrame = {
        v: PROTOCOL_VERSION,
        t: 'sync',
        dev: 'b'.repeat(16),
        gone: [{ id: rumor.id, by: bob.pubkey }],
      }
      const own = createRumor(
        { kind: KIND_CONTROL, content: JSON.stringify(frame), tags: recipientTags([laptop.pubkey]) },
        laptop.secretKey,
      )
      network.publish(giftWrap(own, laptop.secretKey, laptop.pubkey))
      await settle()
      network.publish(giftWrap(rumor, bob.secretKey, laptop.pubkey))
      await settle()
      expect(await phone.vault.repo.getMessage(rumor.id)).toBeFalsy()
    })

    it('does not ask the relays about what it cannot work out again', async () => {
      const received = await bob.messenger.sendMessage(laptop.pubkey, 'not ours to delete')
      await settle()
      await laptop.vault.repo.updateMessage(received.id, { authorPubkey: laptop.pubkey })
      await laptop.messenger.deleteLocally(received.id)
      await settle()
      expect(wrapDeletions()).toHaveLength(0)
    })

    it('keeps trying a deletion the relays would not take', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'while offline')
      await settle()
      network.offline = true
      await laptop.messenger.deleteLocally(sent.id)
      await settle()
      expect(wrapDeletions()).toHaveLength(0)
      network.offline = false
      await settle(10 * MINUTE)
      expect(wrapDeletions()).toHaveLength(1)
    })

    it('asks a withdrawal to last as long as anything can, whatever the setting says', async () => {
      const brief = add(await makeDevice(network, 'Brief', undefined, { messageExpirationDays: 7 }))
      const sent = await brief.messenger.sendMessage(bob.pubkey, 'short lived')
      await settle()
      const lifetime = (event: (typeof network.events)[number]): number => {
        const at = Number(event.tags.find((t) => t[0] === 'expiration')?.[1])
        return Math.round((at - Date.now() / 1000) / 86_400)
      }
      const toSelf = (event: (typeof network.events)[number]) =>
        event.kind === 1059 && event.tags.some((t) => t[0] === 'p' && t[1] === brief.pubkey)
      expect(network.events.filter(toSelf).map(lifetime)).toContain(7)
      await brief.messenger.redactMessage(bob.pubkey, sent.id)
      await settle()
      expect(network.events.filter(toSelf).map(lifetime)).toContain(MAX_MESSAGE_EXPIRY_DAYS)
    })

    it('takes a reaction back on the other device too', async () => {
      const received = await bob.messenger.sendMessage(laptop.pubkey, 'react to this')
      await settle()
      await laptop.messenger.react(bob.pubkey, received.id, '👍')
      await settle()
      expect(await phone.vault.repo.findReaction(received.id, laptop.pubkey)).toBeTruthy()
      await laptop.messenger.react(bob.pubkey, received.id, '👍')
      await settle()
      expect(await phone.vault.repo.findReaction(received.id, laptop.pubkey)).toBeFalsy()
    })
  })

  describe('deleting a conversation', () => {
    beforeEach(introduce)

    const convoOf = (device: Device, peer: string) => device.vault.repo.conversationId(device.pubkey, peer)
    const removeOn = async (device: Device, peer: string) => {
      const conversation = (await device.vault.repo.getConversation(convoOf(device, peer)))!
      device.messenger.noteConversationDeleted(conversation)
      await device.vault.repo.deleteConversation(conversation.id)
    }

    it('goes from every device, and stays gone', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'old')
      await settle()
      await removeOn(laptop, bob.pubkey)
      await settle()
      expect(await phone.vault.repo.getConversation(convoOf(phone, bob.pubkey))).toBeFalsy()
      expect(await laptop.vault.repo.getConversation(convoOf(laptop, bob.pubkey))).toBeFalsy()
    })

    it('refuses what it covered, arriving late, and takes what is newer', async () => {
      const late = createRumor(
        {
          kind: 14,
          content: 'from before',
          tags: recipientTags([laptop.pubkey]),
          created_at: Math.floor(Date.now() / 1000) - 5,
        },
        bob.secretKey,
      )
      await bob.messenger.sendMessage(laptop.pubkey, 'old')
      await settle()
      await removeOn(laptop, bob.pubkey)
      await settle()
      network.publish(giftWrap(late, bob.secretKey, laptop.pubkey))
      await settle()
      expect(await phone.vault.repo.getMessage(late.id)).toBeFalsy()
      expect(await laptop.vault.repo.getMessage(late.id)).toBeFalsy()

      const newer = await bob.messenger.sendMessage(laptop.pubkey, 'a new start')
      await settle()
      expect(await phone.vault.repo.getMessage(newer.id)).toBeTruthy()
    })

    it('keeps what is newer than the deletion on a device that had it already', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'old')
      await settle()
      const conversation = (await laptop.vault.repo.getConversation(convoOf(laptop, bob.pubkey)))!
      const stale = { ...conversation, clock: (conversation.clock ?? 0) - 1 }
      const newer = await bob.messenger.sendMessage(laptop.pubkey, 'crossed with it')
      await settle()
      laptop.messenger.noteConversationDeleted({
        ...stale,
        clock: (await phone.vault.repo.getMessage(newer.id))!.order! - 1,
      })
      await settle()
      const left = await phone.vault.repo.listMessages(convoOf(phone, bob.pubkey), 10)
      expect(left.map((message) => message.id)).toEqual([newer.id])
    })

    it('leaves a forward-secret group where it is', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'old')
      await settle()
      const conversation = (await laptop.vault.repo.getConversation(convoOf(laptop, bob.pubkey)))!
      const before = syncFrames(network, laptop).length
      laptop.messenger.noteConversationDeleted({ ...conversation, mls: { nostrGroupId: 'x' } as never })
      await settle()
      expect(syncFrames(network, laptop)).toHaveLength(before)
    })
  })

  describe('blocking', () => {
    beforeEach(introduce)

    it('blocks on the other device, and the latest choice wins', async () => {
      await laptop.vault.repo.upsertContact(bob.pubkey, { blocked: true })
      laptop.messenger.noteBlocked(bob.pubkey, true)
      await settle()
      expect((await phone.vault.repo.getContact(bob.pubkey))?.blocked).toBe(true)

      await settle(1000)
      await phone.vault.repo.upsertContact(bob.pubkey, { blocked: false })
      phone.messenger.noteBlocked(bob.pubkey, false)
      await settle()
      expect((await laptop.vault.repo.getContact(bob.pubkey))?.blocked).toBe(false)
    })

    it('does not go back to an older choice replayed later', async () => {
      laptop.messenger.noteBlocked(bob.pubkey, true)
      await settle()
      const frame: SyncFrame = {
        v: PROTOCOL_VERSION,
        t: 'sync',
        dev: 'c'.repeat(16),
        block: [{ pk: bob.pubkey, on: false, at: 1000 }],
      }
      const own = createRumor(
        { kind: KIND_CONTROL, content: JSON.stringify(frame), tags: recipientTags([laptop.pubkey]) },
        laptop.secretKey,
      )
      network.publish(giftWrap(own, laptop.secretKey, laptop.pubkey))
      await settle()
      expect((await phone.vault.repo.getContact(bob.pubkey))?.blocked).toBe(true)
    })
  })

  describe('calls', () => {
    beforeEach(introduce)

    it('stops the other device ringing, and leaves no missed call there', async () => {
      const elsewhere: string[] = []
      phone.messenger.events.on('callElsewhere', ({ callId }) => elsewhere.push(callId))
      const callId = 'd'.repeat(64)
      await phone.messenger.recordCall(
        bob.pubkey,
        callId,
        'in',
        { media: 'audio', outcome: 'missed' },
        Date.now(),
      )
      expect(await unread(phone, bob.pubkey)).toBe(1)

      laptop.messenger.noteCallHandled(callId, bob.pubkey)
      await settle()
      expect(elsewhere).toEqual([callId])
      expect(await phone.vault.repo.getMessage(callId)).toBeFalsy()
      expect(await unread(phone, bob.pubkey)).toBe(0)
    })

    it('says nothing about a call to a device that is alone', async () => {
      const network2 = new FakeRelayNetwork()
      const alone = add(await makeDevice(network2, 'Alone'))
      await settle(2 * MINUTE)
      const before = syncFrames(network2, alone).length
      alone.messenger.noteCallHandled('e'.repeat(64), bob.pubkey)
      await settle()
      expect(syncFrames(network2, alone)).toHaveLength(before)
    })

    it('does not ring for a call answered elsewhere, whichever arrived first', async () => {
      const offer = createRumor(
        {
          kind: KIND_CONTROL,
          content: JSON.stringify({ v: 1, t: 'rtc', kind: 'offer', media: 'audio', sdp: 'v=0' }),
          tags: recipientTags([laptop.pubkey]),
        },
        bob.secretKey,
      )
      laptop.messenger.noteCallHandled(offer.id, bob.pubkey)
      await settle()
      const rang: unknown[] = []
      phone.messenger.events.on('callSignal', (signal) => rang.push(signal))
      network.publish(giftWrap(offer, bob.secretKey, laptop.pubkey))
      await settle()
      expect(rang).toEqual([])
    })
  })

  describe('where the inbox is announced', () => {
    const announcements = (net: FakeRelayNetwork, pubkey: string) =>
      net
        .query({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey] })
        .sort((a, b) => b.created_at - a.created_at)
        .map((event) => event.tags.map((tag) => tag[1]))

    it('reads the list first: a new device adds what it lacks, and overwrites nothing', async () => {
      const net = new FakeRelayNetwork()
      const first = add(await makeDevice(net, 'First'))
      await settle()
      expect(announcements(net, first.pubkey)).toEqual([['wss://fake.relay']])

      // The list other devices read now names one this new device has never heard of.
      await first.vault.repo.upsertRelay('wss://custom.relay', { read: true, write: true })
      vi.spyOn(first.pool, 'rankedReadRelays').mockReturnValue(['wss://custom.relay'])
      await first.messenger.reloadRelays()
      await settle(11 * MINUTE)
      expect(announcements(net, first.pubkey)[0]).toContain('wss://custom.relay')
      const count = announcements(net, first.pubkey).length

      const second = add(await makeDevice(net, 'Second', bytesToHex(first.secretKey)))
      const preferred = vi.spyOn(second.pool, 'preferRead')
      await settle()
      const relays = await second.vault.repo.listRelays()
      expect(relays.map((entry) => entry.url)).toContain('wss://custom.relay')
      expect(preferred).toHaveBeenCalled()
      // It reads a subset of the list as it stands, so it has nothing to change.
      expect(announcements(net, first.pubkey).length).toBe(count)
    })

    it('does not take up a relay this person removed', async () => {
      const net = new FakeRelayNetwork()
      const first = add(await makeDevice(net, 'First'))
      await first.vault.repo.upsertRelay('wss://custom.relay', { read: true, write: true })
      vi.spyOn(first.pool, 'rankedReadRelays').mockReturnValue(['wss://custom.relay'])
      await first.messenger.reloadRelays()
      await settle(11 * MINUTE)

      const vault = await makeVault('second-pw')
      await declineRelay(vault.repo, 'wss://custom.relay')
      await vault.repo.putIdentity({
        pubkey: first.pubkey,
        npub: '',
        secretKeyHex: bytesToHex(first.secretKey),
        name: 'Second',
        about: '',
        createdAt: Date.now(),
        mnemonicBackedUp: true,
      })
      await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
      const pool = new FakeRelayPool(net)
      const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
      await messenger.start(bytesToHex(first.secretKey), first.pubkey)
      await settle()
      expect((await vault.repo.listRelays()).map((entry) => entry.url)).not.toContain('wss://custom.relay')
      messenger.stop()
      await vault.destroy()
    })

    it('says so when reading the list fails, and tries again another time', async () => {
      const net = new FakeRelayNetwork()
      const first = add(await makeDevice(net, 'First'))
      await settle()
      vi.spyOn(first.messenger.transport, 'fetchInboxRelays').mockRejectedValueOnce(new Error('offline'))
      vi.spyOn(first.pool, 'rankedReadRelays').mockReturnValue(['wss://next.relay'])
      await settle(11 * MINUTE)
      await settle(11 * MINUTE)
      expect(announcements(net, first.pubkey)[0]).toContain('wss://next.relay')
    })

    it('stops if the engine stopped while it was asking', async () => {
      const net = new FakeRelayNetwork()
      const first = add(await makeDevice(net, 'First'))
      await settle()
      const count = announcements(net, first.pubkey).length
      vi.spyOn(first.pool, 'rankedReadRelays').mockReturnValue(['wss://next.relay'])
      vi.spyOn(first.messenger.transport, 'fetchInboxRelays').mockImplementationOnce(async () => {
        first.messenger.stop()
        return []
      })
      await settle(11 * MINUTE)
      expect(announcements(net, first.pubkey).length).toBe(count)
    })
  })

  describe('a device restored from nothing', () => {
    it('holds the interface until its first catch-up is done', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'in the inbox')
      await settle()
      const tablet = add(await makeDevice(network, 'Tablet', bytesToHex(laptop.secretKey)))
      expect(tablet.messenger.restoring).toBe(true)
      let told = 0
      tablet.messenger.events.on('conversationsChanged', () => (told += 1))
      await settle(10_000)
      expect(tablet.messenger.restoring).toBe(false)
      expect(told).toBeGreaterThan(0)
      expect(await unread(tablet, bob.pubkey)).toBe(1)
    })

    it('does not hold an install that already has history', async () => {
      await settle(10_000)
      laptop.messenger.stop()
      const again = new Messenger(laptop.vault.vault, laptop.vault.repo, settings, new FakeRelayPool(network))
      await again.start(bytesToHex(laptop.secretKey), laptop.pubkey)
      laptop.messenger = again
      expect(again.restoring).toBe(false)
    })
  })
})

describe('the sync frame itself', () => {
  const pk = 'a'.repeat(64)
  const dev = 'b'.repeat(16)
  const frame = (extra: object) => JSON.stringify({ v: 1, t: 'sync', dev, ...extra })

  it('takes every part it knows, within bounds', () => {
    const parsed = parseSyncFrame(
      frame({
        read: [{ with: [pk], key: 5 }],
        clear: [{ with: [pk, 'c'.repeat(64)], key: 6 }],
        gone: [{ id: pk, by: pk }],
        block: [{ pk, on: true, at: 7 }],
        call: [{ id: pk, with: pk }],
      }),
    )
    expect(parsed).toMatchObject({ dev, read: [{ key: 5 }], clear: [{ key: 6 }], block: [{ at: 7 }] })
    expect(parseSyncFrame(frame({}))).toMatchObject({ read: [], clear: [], gone: [], block: [], call: [] })
  })

  it.each([
    ['not JSON', 'nope'],
    ['null', 'null'],
    ['another version', JSON.stringify({ v: 2, t: 'sync', dev })],
    ['another type', JSON.stringify({ v: 1, t: 'redact', dev })],
    ['no device', JSON.stringify({ v: 1, t: 'sync' })],
    ['a malformed device', JSON.stringify({ v: 1, t: 'sync', dev: 'xyz' })],
    ['marks not a list', frame({ read: 'x' })],
    ['too many marks', frame({ read: Array.from({ length: 65 }, () => ({ with: [pk], key: 1 })) })],
    ['a mark naming nobody', frame({ read: [{ with: [], key: 1 }] })],
    ['a mark naming a crowd', frame({ clear: [{ with: Array.from({ length: 8 }, () => pk), key: 1 }] })],
    ['a mark naming something else', frame({ read: [{ with: ['nope'], key: 1 }] })],
    ['a mark with no key', frame({ read: [{ with: [pk] }] })],
    ['a mark that is nothing', frame({ read: [null] })],
    ['an entry that is nothing', frame({ gone: [null] })],
    ['a deletion naming nothing', frame({ gone: [{ id: 'x', by: pk }] })],
    ['too many deletions', frame({ gone: Array.from({ length: 65 }, () => ({ id: pk, by: pk })) })],
    ['a block without a time', frame({ block: [{ pk, on: true }] })],
    ['a block without a choice', frame({ block: [{ pk, on: 1, at: 2 }] })],
    ['a call naming nothing', frame({ call: [{ id: pk }] })],
    ['a list that is not one', frame({ call: {} })],
  ])('refuses %s', (_label, json) => {
    expect(parseSyncFrame(json)).toBeNull()
  })
})

describe('the engine in pieces', () => {
  let vault: TestVault
  const self = 'f'.repeat(64)
  const peer = 'e'.repeat(64)

  const make = (over: Partial<DeviceSyncHost> = {}) => {
    const sent: SyncFrame[] = []
    const marks: DeviceMarks = { read: {}, cleared: {} }
    const sync = new DeviceSync({
      self,
      repo: vault.repo,
      marks,
      send: async (frame) => sent.push(frame),
      tell: async () => undefined,
      forget: async (message) => {
        await vault.repo.deleteMessageAndPayload(message.id)
      },
      changed: () => undefined,
      callElsewhere: () => undefined,
      restoring: () => false,
      record: {
        secretKey: () => null,
        relays: () => [],
        query: async () => [],
        write: async () => undefined,
      },
      ...over,
    })
    return { sync, sent, marks }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vault = await makeVault('pieces')
  })
  afterEach(async () => {
    await vault.destroy()
    vi.useRealTimers()
  })

  it('forgets devices and marks too old to matter', async () => {
    const old = Date.now() - 100 * 86_400_000
    await vault.repo.putState('device-sync', {
      dev: 'a'.repeat(16),
      seen: { ['b'.repeat(16)]: old, ['c'.repeat(16)]: Date.now() },
      helloAt: Date.now(),
    })
    const marks: DeviceMarks = { read: { x: old, y: Date.now() }, cleared: { z: old } }
    const { sync } = make({ marks })
    await sync.start()
    expect(sync.others).toHaveLength(1)
    expect(marks).toEqual({ read: { y: expect.any(Number) }, cleared: {} })
    sync.stop()
  })

  it('says hello only when it has been long enough', async () => {
    await vault.repo.putState('device-sync', { dev: 'a'.repeat(16), seen: {}, helloAt: Date.now() })
    const { sync, sent } = make()
    await sync.start()
    await settle(MINUTE)
    expect(sent).toHaveLength(0)
    sync.stop()
  })

  it('sends nothing after stopping', async () => {
    const { sync, sent } = make()
    await sync.start()
    sync.stop()
    sync.noteGone('a'.repeat(64), peer)
    await settle(MINUTE)
    expect(sent).toHaveLength(0)
  })

  it('splits what does not fit in one frame', async () => {
    const { sync, sent } = make()
    await sync.start()
    for (let i = 0; i < 70; i++) sync.noteGone(i.toString(16).padStart(64, '0'), peer)
    await settle(MINUTE)
    expect(sent.map((frame) => frame.gone?.length)).toEqual([64, 6])
    sync.stop()
  })

  it('brings a sooner send forward, and leaves a later one alone', async () => {
    await vault.repo.putState('device-sync', {
      dev: 'a'.repeat(16),
      seen: { ['b'.repeat(16)]: Date.now() },
      helloAt: Date.now(),
    })
    const conversation = await vault.repo.ensureConversation(self, peer)
    const { sync, sent } = make()
    await sync.start()
    sync.noteRead(conversation.id)
    sync.noteGone('a'.repeat(64), peer)
    sync.noteRead(conversation.id)
    await settle(2000)
    expect(sent).toHaveLength(1)
    sync.stop()
  })

  it('names nothing about a conversation with nothing read, or no longer there', async () => {
    await vault.repo.putState('device-sync', {
      dev: 'a'.repeat(16),
      seen: { ['b'.repeat(16)]: Date.now() },
      helloAt: Date.now(),
    })
    const conversation = await vault.repo.ensureConversation(self, peer)
    const { sync, sent } = make()
    await sync.start()
    sync.noteRead(conversation.id)
    sync.noteRead('nowhere')
    await settle(MINUTE)
    expect(sent).toHaveLength(0)
    sync.stop()
  })

  it('tells nothing of a forward-secret group, and goes by its last activity where no clock was kept', async () => {
    const seen = { ['b'.repeat(16)]: Date.now() }
    await vault.repo.putState('device-sync', { dev: 'a'.repeat(16), seen, helloAt: Date.now() })
    const conversation = await vault.repo.ensureConversation(self, peer)
    await vault.repo.updateConversation(conversation.id, { mls: { nostrGroupId: 'x' } as never })
    const { sync, sent, marks } = make()
    await sync.start()
    sync.noteRead(conversation.id)
    await settle(MINUTE)
    expect(sent).toHaveLength(0)

    const plain = await vault.repo.ensureConversation(self, 'd'.repeat(64))
    await sync.noteCleared({ ...plain, clock: undefined, lastActivity: 1234 })
    expect(marks.cleared[plain.id]).toBe(1234)
    sync.stop()
  })

  it('survives a send that fails, and keeps working', async () => {
    let fail = true
    const sent: SyncFrame[] = []
    const { sync } = make({
      tell: async () => undefined,
      send: async (frame) => {
        if (fail) throw new Error('locked')
        sent.push(frame)
      },
    })
    await sync.start()
    sync.noteGone('a'.repeat(64), peer)
    await settle(2000)
    fail = false
    sync.noteGone('b'.repeat(64), peer)
    await settle(2000)
    expect(sent).toHaveLength(1)
    sync.stop()
  })

  it('reads each mark once, and answers a new device at most once an hour', async () => {
    const { sync, sent } = make()
    await sync.start()
    const read = JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16), read: [{ with: [peer], key: 5 }] })
    await sync.receive(read, Date.now())
    await sync.receive(read, Date.now())
    await sync.receive(JSON.stringify({ v: 1, t: 'sync', dev: 'c'.repeat(16) }), Date.now())
    await settle(MINUTE)
    expect(sent.length).toBeLessThanOrEqual(2)
    sync.stop()
  })

  it('takes a group’s marks by who is in it, and skips a forward-secret group', async () => {
    const group = await vault.repo.ensureGroupConversation(self, [peer, 'd'.repeat(64)], {
      subject: '',
      accepted: true,
    })
    const { sync, marks } = make()
    await sync.start()
    await sync.receive(
      JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16), read: [{ with: group.members, key: 9 }] }),
      Date.now(),
    )
    expect(marks.read[group.id]).toBe(9)
    await vault.repo.updateConversation(group.id, { mls: { nostrGroupId: 'x' } as never })
    await sync.noteCleared((await vault.repo.getConversation(group.id))!)
    await sync.receive(
      JSON.stringify({ v: 1, t: 'sync', dev: 'b'.repeat(16), clear: [{ with: group.members, key: 9 }] }),
      Date.now(),
    )
    expect(await vault.repo.getConversation(group.id)).toBeTruthy()
    sync.stop()
  })
})
