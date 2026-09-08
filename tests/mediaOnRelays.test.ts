import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { createRumor, giftWrap, unwrapGift } from '@/core/crypto/giftwrap'
import { blobRef, chunkCount, sealBlob } from '@/core/crypto/blobCrypto'
import { chunkEvent, dropAddress } from '@/core/engine/blobDrop'
import '@/core/engine/blobTransfer'
import '@/core/engine/deviceSync'
import { attachmentTag, KIND_CONTROL, recipientTags } from '@/core/models/protocol'
import { MAX_FRAME_RELAY_BYTES, MAX_RELAY_BYTES, type Attachment } from '@/core/models/attachment'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import { bytesToB64, bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Attachments at their own address, between real engines on one fake network
 * that keeps to the 64 KiB the strictest default relays do (ADR-075). Who gets
 * it without whom being online, what travels, and that a client from before all
 * this still gets what it always did.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const settle = (ms = 4000) => vi.advanceTimersByTimeAsync(ms)
const LIMIT = 65_536

interface Peer {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string, secretKeyHex?: string): Promise<Peer> {
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

const file = (length: number): Uint8Array => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) % 251
  return out
}

const send = (from: Peer, to: string, bytes: Uint8Array, kind: Attachment['kind'] = 'file') =>
  from.messenger.sendAttachment(to, { bytes, kind, mime: 'application/octet-stream', caption: 'a file' })

/** Chunks on the network: kind 1059 with an index, addressed to no one in particular. */
const chunkEvents = (network: FakeRelayNetwork): NostrEvent[] =>
  network.events.filter((event) => event.kind === 1059 && event.tags.some((tag) => tag[0] === 'seq'))

describe('attachments on the relays', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  const all: Peer[] = []
  const add = (peer: Peer): Peer => {
    all.push(peer)
    return peer
  }

  /** Each has had a receipt from the other, so each knows what the other can do. */
  const acquaint = async () => {
    await alice.messenger.sendMessage(bob.pubkey, 'hello')
    await bob.messenger.sendMessage(alice.pubkey, 'hello to you')
    await settle()
  }
  const payloadOf = async (peer: Peer, message: Message) => {
    const held = await peer.vault.repo.getMessage(message.id)
    return held?.attachment ? peer.messenger.readAttachment(held.attachment) : null
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    network.maxEventBytes = LIMIT
    alice = add(await makePeer(network, 'Alice'))
    bob = add(await makePeer(network, 'Bob'))
    await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
  })

  afterEach(async () => {
    for (const peer of all.splice(0)) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  describe('between two people who both can', () => {
    beforeEach(acquaint)

    it('carries a file at its own address, out of everyone’s inbox, within the event limit', async () => {
      const bytes = file(200_000)
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
      expect(network.droppedCount).toBe(0)

      const chunks = chunkEvents(network)
      expect(chunks).toHaveLength(5)
      const address = dropAddress(message.attachment!)
      expect(chunks.every((event) => event.tags[0]?.[1] === address)).toBe(true)
      expect(address).not.toBe(bob.pubkey)
    })

    it('carries a megabyte, which is a five-minute voice note and then some', async () => {
      const bytes = file(MAX_RELAY_BYTES)
      const message = await send(alice, bob.pubkey, bytes, 'voice')
      expect(message.attachment?.chunks).toBe(22)
      await settle(30_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
      expect(network.droppedCount).toBe(0)
    })

    it('needs a direct channel past that', async () => {
      await expect(send(alice, bob.pubkey, file(MAX_RELAY_BYTES + 1))).rejects.toThrow('direct connection')
    })

    it('says where it is, and the chunk size it was cut to', async () => {
      const message = await send(alice, bob.pubkey, file(1000))
      expect(message.attachment?.chunkBytes).toBe(48_640)
      expect(message.attachment?.relays).toEqual(['wss://fake.relay'])
      await settle()
      const received = await bob.vault.repo.getMessage(message.id)
      expect(received?.attachment).toEqual(message.attachment)
    })

    it('reaches the sender’s other device without asking anybody', async () => {
      const phone = add(await makePeer(network, 'Alice-phone', bytesToHex(alice.secretKey)))
      await settle()
      const bytes = file(100_000)
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      expect(await payloadOf(phone, message)).toEqual(bytes)
      const asked = network.events.filter((event) => {
        try {
          const rumor = unwrapGift(event, bob.secretKey)
          return rumor.kind === KIND_CONTROL && JSON.parse(rumor.content).t === 'blobreq'
        } catch {
          return false
        }
      })
      expect(asked).toEqual([])
    })

    it('reaches someone while the sender is gone, once it has been put there', async () => {
      const bytes = file(100_000)
      bob.messenger.stop()
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      alice.messenger.stop()

      const again = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
      bob.messenger = again
      await again.start(bytesToHex(bob.secretKey), bob.pubkey)
      await settle(20_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
    })

    it('reads from nobody while a device is catching up from nothing, and reads when opened', async () => {
      const bytes = file(100_000)
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      const served = network.served
      const tablet = add(await makePeer(network, 'Bob-tablet', bytesToHex(bob.secretKey)))
      await settle(20_000)
      expect(await tablet.vault.repo.getMessage(message.id)).toBeTruthy()
      expect(await payloadOf(tablet, message)).toBeNull()
      expect(served).toBeLessThanOrEqual(network.served)

      await tablet.messenger.openConversation(alice.pubkey)
      await settle(20_000)
      expect(await payloadOf(tablet, message)).toEqual(bytes)
    })

    it('fetches what the sender sent from another device when its conversation opens', async () => {
      const bytes = file(100_000)
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      const phone = add(await makePeer(network, 'Alice-phone', bytesToHex(alice.secretKey)))
      await settle(20_000)
      expect(await payloadOf(phone, message)).toBeNull()
      await phone.messenger.openConversation(bob.pubkey)
      await settle(20_000)
      expect(await payloadOf(phone, message)).toEqual(bytes)
    })

    it('leaves a device’s old attachments until they are wanted, but takes a new one at once', async () => {
      const old = file(50_000)
      const sealed = sealBlob(old, 48_640)
      const envelope = sealed.envelope
      const attachment: Attachment = {
        kind: 'file',
        ...envelope,
        mime: 'application/octet-stream',
        relays: ['wss://fake.relay'],
      }
      const rumor = createRumor(
        {
          kind: 14,
          content: 'from last week',
          tags: [...recipientTags([bob.pubkey]), attachmentTag(attachment)],
          created_at: Math.floor(Date.now() / 1000) - 7 * 86_400,
        },
        alice.secretKey,
      )
      network.publish(
        giftWrap(rumor, alice.secretKey, bob.pubkey, { fuzzedAt: Math.floor(Date.now() / 1000) }),
      )
      await settle(20_000)
      expect(await bob.vault.repo.getMessage(rumor.id)).toBeTruthy()
      expect(await bob.vault.repo.missingChunks(blobRef(envelope), envelope.chunks)).toHaveLength(2)
    })

    it('fetches an old one at once if its conversation is the one on screen', async () => {
      await bob.messenger.openConversation(alice.pubkey)
      const sealed = sealBlob(file(50_000), 48_640)
      const attachment: Attachment = {
        kind: 'file',
        ...sealed.envelope,
        mime: 'application/octet-stream',
        relays: ['wss://fake.relay'],
      }
      const rumor = createRumor(
        {
          kind: 14,
          content: 'from last week',
          tags: [...recipientTags([bob.pubkey]), attachmentTag(attachment)],
          created_at: Math.floor(Date.now() / 1000) - 7 * 86_400,
        },
        alice.secretKey,
      )
      network.publish(
        giftWrap(rumor, alice.secretKey, bob.pubkey, { fuzzedAt: Math.floor(Date.now() / 1000) }),
      )
      const place = {
        address: dropAddress(sealed.envelope),
        copy: blobRef(sealed.envelope).copy,
        senderSk: alice.secretKey,
        at: Math.floor(Date.now() / 1000),
        ttlSec: 86_400,
      }
      for (let seq = 0; seq < sealed.envelope.chunks; seq++) {
        network.publish(chunkEvent(place, seq, sealed.chunk(seq)))
      }
      await settle(20_000)
      expect(await bob.messenger.readAttachment(attachment)).toEqual(file(50_000))
    })

    it('sends a sticker’s own copy to the relays, cut as it was', async () => {
      const bytes = file(30_000)
      const pack = await alice.messenger.importStickerPack('Pack', [{ bytes, mime: 'image/webp' }])
      const sticker = pack.stickers[0]!
      const message = await alice.messenger.sendAttachment(bob.pubkey, {
        bytes,
        kind: 'image',
        mime: 'image/webp',
        caption: '',
        envelope: sticker,
      })
      expect(message.attachment?.chunkBytes).toBeUndefined()
      expect(message.attachment?.relays).toEqual(['wss://fake.relay'])
      await settle(20_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
    })

    it('asks the sender when a relay has lost it, who puts it back', async () => {
      const bytes = file(100_000)
      const message = await send(alice, bob.pubkey, bytes)
      // Bob's copy of the message arrives, and every chunk goes before he reads it.
      bob.messenger.stop()
      await settle(20_000)
      for (const event of chunkEvents(network)) network.events.splice(network.events.indexOf(event), 1)
      const again = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
      bob.messenger = again
      await again.start(bytesToHex(bob.secretKey), bob.pubkey)
      await settle()
      expect(await bob.vault.repo.getMessage(message.id)).toBeTruthy()
      await again.openConversation(alice.pubkey)
      await settle(60_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
    })

    it('does not press a relay that turned a chunk down, once another has taken it', async () => {
      const pool = (alice.messenger as unknown as { pool: FakeRelayPool }).pool
      const publish = vi.spyOn(pool, 'publish').mockImplementation(async (event, relays) => {
        network.publish(event)
        return (relays ?? []).flatMap((url) => [
          { url, ok: true as const, ms: 1 },
          { url: 'wss://refusing.example', ok: false as const, error: 'blocked: spam not permitted' },
        ])
      })
      const message = await send(alice, bob.pubkey, file(100_000))
      await settle(60_000)
      const chunkCalls = publish.mock.calls.filter(([event]) => event.tags.some((tag) => tag[0] === 'seq'))
      expect(chunkCalls).toHaveLength(message.attachment!.chunks)
      publish.mockRestore()
    })

    it('tries a chunk again if nobody took it', async () => {
      const pool = (alice.messenger as unknown as { pool: FakeRelayPool }).pool
      let refused = 0
      const real = pool.publish.bind(pool)
      const publish = vi.spyOn(pool, 'publish').mockImplementation(async (event, relays) => {
        if (event.tags.some((tag) => tag[0] === 'seq') && refused < 2) {
          refused += 1
          return [{ url: 'wss://fake.relay', ok: false as const, error: 'no answer' }]
        }
        return real(event, relays)
      })
      const bytes = file(10_000)
      const message = await send(alice, bob.pubkey, bytes)
      await settle(60_000)
      expect(await payloadOf(bob, message)).toEqual(bytes)
      publish.mockRestore()
    })

    it('takes the chunks off the relays with the message, when everyone is losing it', async () => {
      const message = await send(alice, bob.pubkey, file(100_000))
      await settle(20_000)
      expect(chunkEvents(network)).toHaveLength(3)
      await alice.messenger.redactMessage(bob.pubkey, message.id)
      await settle(20_000)
      expect(chunkEvents(network)).toHaveLength(0)
    })

    it('leaves them where they are when only this person is', async () => {
      const message = await send(alice, bob.pubkey, file(100_000))
      await settle(20_000)
      await alice.messenger.deleteLocally(message.id)
      await settle(20_000)
      expect(chunkEvents(network)).toHaveLength(3)
    })

    it('lets another device of the sender take it all off the relays too', async () => {
      const bytes = file(100_000)
      const phone = add(await makePeer(network, 'Alice-phone', bytesToHex(alice.secretKey)))
      await settle()
      const message = await send(alice, bob.pubkey, bytes)
      await settle(20_000)
      expect(await payloadOf(phone, message)).toEqual(bytes)
      await phone.messenger.redactMessage(bob.pubkey, message.id)
      await settle(20_000)
      expect(chunkEvents(network)).toHaveLength(0)
    })
  })

  describe('in a group', () => {
    it('uploads once, and every member reads the same chunks', async () => {
      const carol = add(await makePeer(network, 'Carol'))
      await acquaint()
      await carol.messenger.sendMessage(alice.pubkey, 'hi')
      await alice.messenger.sendMessage(carol.pubkey, 'hi')
      await settle()
      await carol.vault.repo.upsertContact(alice.pubkey, { accepted: true })
      await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })

      const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'Friends')
      const bytes = file(100_000)
      const message = await alice.messenger.sendAttachment(group.id, {
        bytes,
        kind: 'file',
        mime: 'application/octet-stream',
        caption: 'for you both',
      })
      await settle(30_000)
      expect(chunkEvents(network)).toHaveLength(3)
      expect(await payloadOf(bob, message)).toEqual(bytes)
      expect(await payloadOf(carol, message)).toEqual(bytes)
    })
  })

  describe('with a client from before all this', () => {
    it('pushes in frames, as it always did, to someone who has shown nothing', async () => {
      // No receipt has come back yet: this could be anyone's build.
      const bytes = file(40_000)
      const message = await send(alice, bob.pubkey, bytes)
      expect(message.attachment?.relays).toBeUndefined()
      expect(message.attachment?.chunks).toBe(chunkCount(40_000))
      await settle(20_000)
      expect(chunkEvents(network)).toEqual([])
      expect(await payloadOf(bob, message)).toEqual(bytes)
    })

    it('goes on pushing frames to someone whose receipts say nothing of it', async () => {
      // A receipt in the old shape: Textor, but from before this.
      const rumor = createRumor(
        {
          kind: KIND_CONTROL,
          content: JSON.stringify({ v: 1, t: 'receipt', refs: ['a'.repeat(64)], state: 'delivered' }),
          tags: recipientTags([alice.pubkey]),
        },
        bob.secretKey,
      )
      network.publish(giftWrap(rumor, bob.secretKey, alice.pubkey))
      await settle()
      const message = await send(alice, bob.pubkey, file(40_000))
      expect(message.attachment?.relays).toBeUndefined()
      await settle(20_000)
    })

    it('still takes chunks pushed in frames by one, in flight or new', async () => {
      await acquaint()
      const bytes = file(40_000)
      const sealed = sealBlob(bytes)
      const attachment: Attachment = { kind: 'file', ...sealed.envelope, mime: 'application/octet-stream' }
      const message = createRumor(
        { kind: 14, content: 'old', tags: [...recipientTags([bob.pubkey]), attachmentTag(attachment)] },
        alice.secretKey,
      )
      network.publish(giftWrap(message, alice.secretKey, bob.pubkey))
      for (let seq = 0; seq < sealed.envelope.chunks; seq++) {
        const frame = createRumor(
          {
            kind: KIND_CONTROL,
            content: JSON.stringify({
              v: 1,
              t: 'blob',
              id: sealed.envelope.id,
              copy: blobRef(sealed.envelope).copy,
              seq,
              total: sealed.envelope.chunks,
              data: bytesToB64(sealed.chunk(seq)),
            }),
            tags: recipientTags([bob.pubkey]),
          },
          alice.secretKey,
        )
        network.publish(giftWrap(frame, alice.secretKey, bob.pubkey))
      }
      await settle(20_000)
      expect(await bob.messenger.readAttachment(attachment)).toEqual(bytes)
    })

    it('sends what frames could never carry at its own address, whoever it is to', async () => {
      const message = await send(alice, bob.pubkey, file(MAX_FRAME_RELAY_BYTES + 1))
      expect(message.attachment?.relays).toEqual(['wss://fake.relay'])
      await settle(30_000)
    })

    it('tells each receipt what it can do, so the other side learns', async () => {
      await acquaint()
      const receipts = network.events.flatMap((event) => {
        try {
          const rumor = unwrapGift(event, alice.secretKey)
          const frame = JSON.parse(rumor.content) as { t?: string; caps?: number }
          return rumor.kind === KIND_CONTROL && frame.t === 'receipt' ? [frame] : []
        } catch {
          return []
        }
      })
      expect(receipts.length).toBeGreaterThan(0)
      expect(receipts.every((frame) => frame.caps === 2)).toBe(true)
    })

    it('remembers what someone can do across a restart', async () => {
      await acquaint()
      alice.messenger.stop()
      const again = new Messenger(alice.vault.vault, alice.vault.repo, settings, new FakeRelayPool(network))
      alice.messenger = again
      await again.start(bytesToHex(alice.secretKey), alice.pubkey)
      const message = await send(alice, bob.pubkey, file(1000))
      expect(message.attachment?.relays).toEqual(['wss://fake.relay'])
      await settle()
    })
  })
})

describe('the outbox as the vault locks', () => {
  it('stops reading it, rather than failing where nobody is listening', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const network = new FakeRelayNetwork()
    const alice = await makePeer(network, 'Alice')
    await settle()
    const due = vi.spyOn(alice.vault.repo, 'dueOutboxIds').mockImplementation(async () => {
      alice.vault.vault.lock()
      return ['nothing']
    })
    await expect(alice.messenger.flushOutbox()).resolves.toBeUndefined()
    due.mockRestore()
    alice.messenger.stop()
    await alice.vault.destroy()
    vi.useRealTimers()
  })
})

describe('a wrap nobody can open', () => {
  it('is marked as seen, and costs no more than that', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const network = new FakeRelayNetwork()
    const bob = await makePeer(network, 'Bob')
    await settle()
    const signer = createIdentity().identity.secretKey
    const junk = finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', bob.pubkey]], content: 'AAAA' },
      signer,
    )
    network.publish(junk)
    await settle()
    expect(await bob.vault.repo.hasSeen(junk.id)).toBe(true)
    bob.messenger.stop()
    await bob.vault.destroy()
    vi.useRealTimers()
  })
})

describe('a wrap arriving just as the engine stops', () => {
  it('is not marked as seen, so the next start still reads it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const network = new FakeRelayNetwork()
    const alice = await makePeer(network, 'Alice')
    const bob = await makePeer(network, 'Bob')
    await settle()
    const hasSeen = bob.vault.repo.hasSeen.bind(bob.vault.repo)
    // Stopped between asking whether it has been seen and opening it.
    bob.vault.repo.hasSeen = async (id) => {
      const seen = await hasSeen(id)
      bob.messenger.stop()
      return seen
    }
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'caught mid-stop')
    await settle()
    bob.vault.repo.hasSeen = hasSeen
    const again = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
    await again.start(bytesToHex(bob.secretKey), bob.pubkey)
    await settle()
    expect(await bob.vault.repo.getMessage(sent.id)).toBeTruthy()
    again.stop()
    alice.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })
})
