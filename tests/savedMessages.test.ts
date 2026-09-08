import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { unwrapGift, type Rumor } from '@/core/crypto/giftwrap'
import { blobRef } from '@/core/crypto/blobCrypto'
import { conversationId as legacyConversationId } from '@/core/crypto/vaultCrypto'
import '@/core/engine/blobTransfer'
import '@/core/engine/deviceSync'
import { KIND_CHAT, KIND_CONTROL } from '@/core/models/protocol'
import { MAX_RELAY_BYTES } from '@/core/models/attachment'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Saved Messages (ADR-082): notes an identity writes to itself, one wrap each to
 * its own inbox, which its other devices read as they read everything else.
 * Real engines on one fake relay network, two of them on one key.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const MINUTE = 60_000
const settle = (ms = 4000) => vi.advanceTimersByTimeAsync(ms)

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
}

async function makeDevice(network: FakeRelayNetwork, name: string, secretKeyHex?: string): Promise<Device> {
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
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(skHex, pubkey)
  return { pubkey, secretKey, vault, messenger }
}

/** Every rumor on the network that `device` can open, with the wrap it came in. */
const opened = (network: FakeRelayNetwork, device: Device): { wrap: NostrEvent; rumor: Rumor }[] =>
  network.events
    .filter((event) => event.kind === 1059 && event.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey))
    .flatMap((wrap) => {
      try {
        return [{ wrap, rumor: unwrapGift(wrap, device.secretKey) }]
      } catch {
        return []
      }
    })

const frameKind = (rumor: Rumor): string | null => {
  if (rumor.kind !== KIND_CONTROL) return null
  return (JSON.parse(rumor.content) as { t: string }).t
}

const savedId = (device: Device) => device.vault.repo.conversationId(device.pubkey, device.pubkey)

const file = (length: number): Uint8Array => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 17 + 3) % 251
  return out
}

describe('Saved Messages', () => {
  let network: FakeRelayNetwork
  let laptop: Device
  let phone: Device
  let bob: Device
  const all: Device[] = []
  const add = (device: Device): Device => {
    all.push(device)
    return device
  }
  const save = (device: Device, text: string): Promise<Message> =>
    device.messenger.sendMessage(device.pubkey, text)

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    laptop = add(await makeDevice(network, 'Laptop'))
    phone = add(await makeDevice(network, 'Phone', bytesToHex(laptop.secretKey)))
    bob = add(await makeDevice(network, 'Bob'))
    await laptop.vault.repo.upsertContact(bob.pubkey, { accepted: true })
  })

  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  describe('a note', () => {
    it('is kept here at once, and is sent once: a wrap to ourselves, naming only us', async () => {
      network.offline = true
      const note = await save(laptop, 'buy milk')
      // Written before any relay has it, as everything sent is.
      expect(await laptop.vault.repo.getMessage(note.id)).toMatchObject({
        convoId: savedId(laptop),
        direction: 'out',
        status: 'queued',
        body: 'buy milk',
      })
      expect(note.receipts).toBeUndefined()

      network.offline = false
      await laptop.messenger.retryMessage(note.id)
      await settle()
      expect((await laptop.vault.repo.getMessage(note.id))?.status).toBe('sent')

      const copies = opened(network, laptop).filter(({ rumor }) => rumor.id === note.id)
      expect(copies).toHaveLength(1)
      expect(copies[0]?.rumor.kind).toBe(KIND_CHAT)
      expect(copies[0]?.rumor.tags.filter((tag) => tag[0] === 'p')).toEqual([['p', laptop.pubkey]])
      // Nobody else is sent anything, nor told anything.
      expect(opened(network, bob)).toEqual([])

      const conversation = await laptop.vault.repo.getConversation(savedId(laptop))
      expect(conversation).toMatchObject({
        kind: 'self',
        peerPubkey: laptop.pubkey,
        members: [laptop.pubkey],
        accepted: true,
        unread: 0,
      })
      expect(await laptop.vault.repo.getContact(laptop.pubkey)).toBeNull()
    })

    it('is wrapped once, never again as a copy of itself', async () => {
      const { pool } = laptop.messenger
      // Each wrap handed to the relays, however the engine hands it over.
      const published: NostrEvent[] = []
      let dispatching = false
      const publish = pool.publish.bind(pool)
      const dispatch = pool.dispatch.bind(pool)
      vi.spyOn(pool, 'publish').mockImplementation((event, relays) => {
        if (!dispatching) published.push(event)
        return publish(event, relays)
      })
      vi.spyOn(pool, 'dispatch').mockImplementation((event, relays) => {
        published.push(event)
        dispatching = true
        try {
          return dispatch(event, relays)
        } finally {
          dispatching = false
        }
      })
      const note = await save(laptop, 'once')
      await settle()
      const wraps = published.filter((event) => {
        try {
          return unwrapGift(event, laptop.secretKey).id === note.id
        } catch {
          return false
        }
      })
      expect(wraps).toHaveLength(1)
    })

    it('reaches our other device, as ours, and counts as nothing unread', async () => {
      const note = await save(laptop, 'the door code is 4096')
      await settle()
      const there = await phone.vault.repo.getMessage(note.id)
      expect(there).toMatchObject({
        convoId: savedId(phone),
        direction: 'out',
        status: 'sent',
        body: 'the door code is 4096',
        authorPubkey: laptop.pubkey,
      })
      expect(there?.receipts).toBeUndefined()
      const conversation = await phone.vault.repo.getConversation(savedId(phone))
      expect(conversation).toMatchObject({ kind: 'self', members: [phone.pubkey], unread: 0 })
      expect(await phone.vault.repo.getContact(phone.pubkey)).toBeNull()
    })

    it('comes back to a device restored from nothing', async () => {
      const first = await save(laptop, 'first')
      const second = await save(laptop, 'second')
      await settle()
      const tablet = add(await makeDevice(network, 'Tablet', bytesToHex(laptop.secretKey)))
      await settle(MINUTE)
      const held = await tablet.vault.repo.listMessages(savedId(tablet), 10)
      expect(held.map((message) => message.id)).toEqual([first.id, second.id])
      // Listed at when the newest note was written, not at when it was restored.
      expect(await tablet.vault.repo.getConversation(savedId(tablet))).toMatchObject({
        unread: 0,
        lastActivity: second.ts,
      })
    })

    it('can be a reply to another note, and is sent again as itself', async () => {
      const first = await save(laptop, 'groceries')
      const reply = await laptop.messenger.sendMessage(laptop.pubkey, 'and eggs', first.id)
      await laptop.messenger.retryMessage(reply.id)
      await settle()
      expect((await phone.vault.repo.getMessage(reply.id))?.replyTo).toBe(first.id)
      expect(opened(network, laptop).filter(({ rumor }) => rumor.id === reply.id).length).toBeGreaterThan(0)
    })
  })

  describe('kept apart', () => {
    it('has an id of its own, apart from where the outbox keeps what is no conversation’s', async () => {
      const { repo } = laptop.vault
      const id = savedId(laptop)
      expect(repo.conversationIdOf(laptop.pubkey, [laptop.pubkey])).toBe(id)
      expect(repo.conversationIdOf(laptop.pubkey, [])).toBe(id)
      // The queue keeps the id the room of one always had, so nothing queued moves.
      expect(repo.queueId(laptop.pubkey)).toBe(
        legacyConversationId(laptop.vault.vault.keys.indexKey, laptop.pubkey, laptop.pubkey),
      )
      expect(repo.queueId(laptop.pubkey)).not.toBe(id)
      expect(repo.conversationId(laptop.pubkey, bob.pubkey)).not.toBe(id)
    })

    it('leaves a withdrawal queued when Saved Messages is deleted', async () => {
      const note = await save(laptop, 'gone soon')
      await settle()
      network.offline = true
      await laptop.messenger.redactMessage(laptop.pubkey, note.id)
      await settle()
      const queued = await laptop.vault.repo.outboxForConversation(laptop.vault.repo.queueId(laptop.pubkey))
      expect(queued.length).toBeGreaterThan(0)
      await laptop.vault.repo.deleteConversation(savedId(laptop))
      expect(
        await laptop.vault.repo.outboxForConversation(laptop.vault.repo.queueId(laptop.pubkey)),
      ).toHaveLength(queued.length)
    })

    it('queues what our devices tell each other apart from it, so deleting it stops none of that', async () => {
      await settle(2 * MINUTE)
      const note = await save(laptop, 'gone soon')
      await settle()
      network.offline = true
      await laptop.messenger.deleteLocally(note.id)
      await settle(MINUTE)
      const { repo } = laptop.vault
      const frames = (await repo.outboxForConversation(repo.queueId(laptop.pubkey))).filter((item) => {
        const rumor = JSON.parse(item.rumorJson) as Rumor
        return rumor.kind === KIND_CONTROL && frameKind(rumor) === 'sync'
      })
      expect(frames.length).toBeGreaterThan(0)
      expect(await repo.outboxForConversation(savedId(laptop))).toEqual([])
      await repo.deleteConversation(savedId(laptop))
      expect(await repo.getOutboxItem(frames[0]!.id)).not.toBeNull()
    })

    it('still hands what our devices tell each other to the device sync', async () => {
      await settle(2 * MINUTE)
      // Each says hello to the other, and neither files it as a note.
      expect(opened(network, laptop).some(({ rumor }) => frameKind(rumor) === 'sync')).toBe(true)
      expect(await laptop.vault.repo.listMessages(savedId(laptop), 10)).toEqual([])
      expect(await phone.vault.repo.getConversation(savedId(phone))).toBeNull()
    })
  })

  describe('what it holds', () => {
    it('keeps a file on the relays, where our other device reads it', async () => {
      const bytes = file(100_000)
      const note = await laptop.messenger.sendAttachment(laptop.pubkey, {
        bytes,
        kind: 'file',
        mime: 'application/octet-stream',
        caption: 'a file',
      })
      expect(note.attachment?.relays?.length).toBeGreaterThan(0)
      await settle(20_000)
      const there = await phone.vault.repo.getMessage(note.id)
      expect(there?.attachment).toBeDefined()
      expect(await phone.messenger.readAttachment(there!.attachment!)).toEqual(bytes)
      // Never pushed in frames, nor asked for: there is nobody to push it or ask.
      const frames = opened(network, laptop).map(({ rumor }) => frameKind(rumor))
      expect(frames).not.toContain('blob')
      expect(frames).not.toContain('blobreq')
    })

    it('asks nobody for a payload the relays have lost', async () => {
      const note = await laptop.messenger.sendAttachment(laptop.pubkey, {
        bytes: file(40_000),
        kind: 'file',
        mime: 'application/octet-stream',
        caption: 'a file',
      })
      await settle(20_000)
      // Gone from the relays before the phone, away until now, asks for it.
      network.events.splice(
        0,
        network.events.length,
        ...network.events.filter((event) => !event.tags.some((tag) => tag[0] === 'seq')),
      )
      const there = await phone.vault.repo.getMessage(note.id)
      await phone.vault.repo.deleteBlob(blobRef(there!.attachment!))
      await phone.messenger.openConversation(phone.pubkey)
      await settle(10 * MINUTE)
      expect(opened(network, laptop).map(({ rumor }) => frameKind(rumor))).not.toContain('blobreq')
    })

    it('refuses a file too large for the relays, having no direct channel', async () => {
      await expect(
        laptop.messenger.sendAttachment(laptop.pubkey, {
          bytes: file(MAX_RELAY_BYTES + 1),
          kind: 'file',
          mime: 'application/octet-stream',
          caption: 'a file',
        }),
      ).rejects.toThrow('too large to save')
    })

    it('refuses a file with no relay to keep it on', async () => {
      vi.spyOn(laptop.messenger.pool, 'rankedReadRelays').mockReturnValue([])
      vi.spyOn(laptop.messenger.pool, 'rankedWriteRelays').mockReturnValue([])
      await expect(
        laptop.messenger.sendAttachment(laptop.pubkey, {
          bytes: file(1000),
          kind: 'file',
          mime: 'application/octet-stream',
          caption: 'a file',
        }),
      ).rejects.toThrow('no relay to keep it on')
    })

    it('ticks a checklist on every device, with one wrap a tick', async () => {
      const list = await laptop.messenger.sendChecklist(laptop.pubkey, {
        title: 'Packing',
        items: [{ id: 'a', label: 'passport' }],
      })
      await settle()
      await laptop.messenger.checkItem(laptop.pubkey, list.id, 'a', true)
      await settle()
      const updates = await phone.vault.repo.listUpdatesFor([list.id])
      expect(updates.map((update) => update.frame)).toEqual([
        expect.objectContaining({ t: 'check', done: true }),
      ])
      const ticks = opened(network, laptop).filter(({ rumor }) => frameKind(rumor) === 'check')
      expect(ticks).toHaveLength(1)
    })

    it('holds a place, but not a live location, nor a reaction', async () => {
      const place = await laptop.messenger.sendLocation(laptop.pubkey, { lat: 35.7, lon: 51.4 })
      expect(place.location).toMatchObject({ lat: 35.7, lon: 51.4 })
      await expect(
        laptop.messenger.sendLocation(laptop.pubkey, { lat: 35.7, lon: 51.4, live: 900 }),
      ).rejects.toThrow('needs someone to share it with')
      await expect(laptop.messenger.react(laptop.pubkey, place.id, '👍')).rejects.toThrow('no reactions')
      await settle()
      expect((await phone.vault.repo.getMessage(place.id))?.location).toMatchObject({ lat: 35.7, lon: 51.4 })
    })

    it('says nothing about typing, and opens without dialling anyone', async () => {
      const before = network.events.length
      laptop.messenger.setTyping(laptop.pubkey, true)
      await laptop.messenger.openConversation(laptop.pubkey)
      await settle()
      expect(network.events.length).toBe(before)
    })
  })

  describe('deleting', () => {
    it('takes a note off every device and off the relays, telling nobody else', async () => {
      await settle(2 * MINUTE)
      const told = opened(network, bob).length
      const note = await save(laptop, 'temporary')
      await settle()
      expect(await phone.vault.repo.getMessage(note.id)).not.toBeNull()

      await laptop.messenger.redactMessage(laptop.pubkey, note.id)
      await settle(10 * MINUTE)
      expect(await laptop.vault.repo.getMessage(note.id)).toBeNull()
      expect(await phone.vault.repo.getMessage(note.id)).toBeNull()
      // Its wrap is gone, and no withdrawal frame was sent to ourselves for it.
      expect(opened(network, laptop).some(({ rumor }) => rumor.id === note.id)).toBe(false)
      expect(opened(network, laptop).map(({ rumor }) => frameKind(rumor))).not.toContain('redact')
      expect(opened(network, bob)).toHaveLength(told)
    })

    it('clears it on our other device when it is deleted whole', async () => {
      await settle(2 * MINUTE)
      await save(laptop, 'one')
      await save(laptop, 'two')
      await settle()
      expect(await phone.vault.repo.listMessages(savedId(phone), 10)).toHaveLength(2)

      const conversation = (await laptop.vault.repo.getConversation(savedId(laptop)))!
      laptop.messenger.noteConversationDeleted(conversation)
      await laptop.vault.repo.deleteConversation(conversation.id)
      await settle(10 * MINUTE)
      expect(await phone.vault.repo.getConversation(savedId(phone))).toBeNull()
    })
  })

  describe('from anyone else', () => {
    it('is a direct message from them, never a note, listed at when they sent it', async () => {
      network.offline = true
      const hi = await bob.messenger.sendMessage(laptop.pubkey, 'hi')
      await settle(MINUTE)
      network.offline = false
      await bob.messenger.retryMessage(hi.id)
      await settle()
      expect(await laptop.vault.repo.getConversation(savedId(laptop))).toBeNull()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      expect(await laptop.vault.repo.listMessages(id, 10)).toHaveLength(1)
      // Arriving a minute late, it is still listed at the time it was written.
      expect((await laptop.vault.repo.getConversation(id))?.lastActivity).toBe(hi.ts)
    })
  })
})
