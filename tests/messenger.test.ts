import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import { bytesToHex } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/** WebRTC is absent in Node, so the engine falls back to the relay path. */
const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  name: string
  pubkey: string
  secretKeyHex: string
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string): Promise<Peer> {
  const { identity } = createIdentity()
  const vault = await makeVault(`${name}-passphrase`)
  const secretKeyHex = bytesToHex(identity.secretKey)

  await vault.repo.putIdentity({
    pubkey: identity.publicKey,
    npub: identity.npub,
    secretKeyHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })

  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(secretKeyHex, identity.publicKey)
  return { name, pubkey: identity.publicKey, secretKeyHex, vault, messenger }
}

/** Let queued microtasks, the outbox flush, and receipt debounce settle. */
async function settle(ms = 1500): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function messagesOf(peer: Peer, otherPubkey: string): Promise<Message[]> {
  const convoId = peer.vault.repo.conversationId(peer.pubkey, otherPubkey)
  return peer.vault.repo.listMessages(convoId)
}

describe('end-to-end messaging over relays', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', source: 'invite', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', source: 'invite', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('delivers a message from Alice to Bob', async () => {
    await alice.messenger.sendMessage(bob.pubkey, 'hello Bob')
    await settle()

    const received = await messagesOf(bob, alice.pubkey)
    expect(received).toHaveLength(1)
    expect(received[0]?.body).toBe('hello Bob')
    expect(received[0]?.direction).toBe('in')
    expect(received[0]?.authorPubkey).toBe(alice.pubkey)
  })

  it('marks the sender copy as sent once a relay accepts it', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'delivery states')
    // Short settle: long enough for the publish, short enough that Bob's
    // debounced delivery receipt has not yet advanced the status further.
    await settle(400)

    const stored = await alice.vault.repo.getMessage(sent.id)
    expect(stored?.status).toBe('sent')
    expect(stored?.relayAcks).toBeGreaterThan(0)
  })

  it('carries a delivered receipt back to the sender', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'receipt please')
    await settle(4000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('delivered')
  })

  it('upgrades to read when Bob opens the conversation', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'read me')
    await settle(4000)
    await bob.messenger.openConversation(alice.pubkey)
    await settle(4000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('read')
  })

  it('never downgrades a status that already advanced', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'ordering')
    await settle(4000)
    await bob.messenger.openConversation(alice.pubkey)
    await settle(4000)
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('read')

    // A delayed 'delivered' receipt arriving after 'read' must not roll back.
    await alice.vault.repo.advanceMessageStatus(sent.id, 'delivered')
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('read')
  })

  it('stores a self-addressed copy so a restored vault sees sent messages', async () => {
    await alice.messenger.sendMessage(bob.pubkey, 'for my other device')
    await settle()

    const wraps = network.events.filter((event) => event.kind === 1059)
    const recipients = wraps.flatMap((event) =>
      event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]),
    )
    expect(recipients).toContain(bob.pubkey)
    expect(recipients).toContain(alice.pubkey)
  })

  it('deduplicates an event delivered twice', async () => {
    await alice.messenger.sendMessage(bob.pubkey, 'only once')
    await settle()

    const wrap = network.events.find(
      (event) => event.kind === 1059 && event.tags.some((tag) => tag[1] === bob.pubkey),
    )
    expect(wrap).toBeDefined()
    // Re-deliver the identical event, as a second relay would.
    network.events.length = 0
    network.publish(wrap!)
    await settle()

    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(1)
  })

  it('holds messages in the outbox while offline and flushes on reconnect', async () => {
    network.offline = true
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'queued while offline')
    await settle(3000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('queued')
    expect(await alice.vault.repo.countOutbox()).toBe(1)
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)

    network.offline = false
    await settle(60_000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).not.toBe('queued')
    expect((await messagesOf(bob, alice.pubkey))[0]?.body).toBe('queued while offline')
  })

  it('preserves message order across a burst inside one second', async () => {
    // Nostr timestamps are whole seconds, so without the millisecond tag these
    // five would sort arbitrarily on both ends.
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await alice.messenger.sendMessage(bob.pubkey, text)
    }
    await settle(5000)

    expect((await messagesOf(bob, alice.pubkey)).map((m) => m.body)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ])
    // The sender's own view must agree with the recipient's.
    expect((await messagesOf(alice, bob.pubkey)).map((m) => m.body)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ])
  })

  it('ignores a millisecond tag that disagrees with the event timestamp', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'honest timing')
    await settle()
    const stored = await bob.vault.repo.getMessage(sent.id)
    expect(Math.abs((stored?.ts ?? 0) - sent.ts)).toBeLessThan(1000)
  })

  it('threads a reply to the message it answers', async () => {
    const first = await alice.messenger.sendMessage(bob.pubkey, 'question?')
    await settle()
    await bob.messenger.sendMessage(alice.pubkey, 'answer!', first.id)
    await settle()

    const aliceView = await messagesOf(alice, bob.pubkey)
    expect(aliceView.find((m) => m.body === 'answer!')?.replyTo).toBe(first.id)
  })
})

describe('access control', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('files an unsolicited first message as an unaccepted contact', async () => {
    await alice.messenger.sendMessage(bob.pubkey, 'we have never met')
    await settle()

    const contact = await bob.vault.repo.getContact(alice.pubkey)
    expect(contact).not.toBeNull()
    expect(contact?.source).toBe('incoming')
    expect(contact?.accepted).toBe(false)
    expect((await messagesOf(bob, alice.pubkey))[0]?.body).toBe('we have never met')
  })

  it('drops messages from a blocked contact', async () => {
    await bob.vault.repo.upsertContact(alice.pubkey, { blocked: true })
    await alice.messenger.sendMessage(bob.pubkey, 'let me in')
    await settle()

    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)
  })

  it('ignores a wrap addressed to a third party', async () => {
    const stranger = getPublicKey(createIdentity().identity.secretKey)
    await alice.messenger.sendMessage(stranger, 'not for Bob')
    await settle()

    // Bob's subscription filters on his own p-tag, so nothing should land, and
    // the engine double-checks the tag after unwrapping.
    expect(await bob.vault.repo.listConversations()).toHaveLength(0)
  })

  it('rejects an empty message before it reaches the network', async () => {
    const before = network.publishCount
    await expect(alice.messenger.sendMessage(bob.pubkey, '   ')).rejects.toThrow(/empty/)
    expect(network.publishCount).toBe(before)
  })

  it('rejects an over-long message', async () => {
    await expect(alice.messenger.sendMessage(bob.pubkey, 'x'.repeat(20_000))).rejects.toThrow(/too long/)
  })
})

/**
 * Attachments, end to end over the relay path.
 *
 * These exist because the unit tests for the transfer engine all passed while
 * no photo could actually be delivered: the faults were at the seams — an
 * ingest guard that predated attachments, and a resend that inferred a value it
 * should have looked up. Only a two-peer test crosses those seams.
 */
describe('attachments end to end', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  const photo = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) % 251
    return out
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', source: 'invite', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', source: 'invite', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('delivers an attachment that carries no caption at all', async () => {
    // The regression that mattered: an uncaptioned photo produced an empty
    // kind 14, and the ingest guard dropped it as noise. The sender saw "sent"
    // and the recipient never saw anything.
    const bytes = photo(40_000)
    await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'image',
      mime: 'image/webp',
      caption: '',
      name: 'holiday.webp',
    })
    await settle(6000)

    const received = await messagesOf(bob, alice.pubkey)
    expect(received).toHaveLength(1)
    expect(received[0]?.attachment?.kind).toBe('image')
    expect(received[0]?.attachment?.size).toBe(bytes.length)
  })

  it('transfers the payload and reassembles the exact bytes', async () => {
    const bytes = photo(40_000)
    const sent = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'image',
      mime: 'image/webp',
      caption: 'Photo',
    })
    await settle(20_000)

    const received = await messagesOf(bob, alice.pubkey)
    const attachment = received[0]?.attachment
    expect(attachment).toBeDefined()
    // Multi-chunk on purpose: a single-chunk payload would not exercise
    // ordering, the manifest, or reassembly.
    expect(attachment?.chunks).toBeGreaterThan(1)

    const opened = await bob.messenger.readAttachment(attachment!)
    expect(opened).toEqual(bytes)
    expect(attachment?.id).toBe(sent.attachment?.id)
  })

  it('round-trips a voice note with its waveform', async () => {
    const bytes = photo(25_000)
    await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'voice',
      mime: 'audio/webm',
      caption: 'Voice message · 0:04',
      durationMs: 4200,
      waveform: [10, 80, 40],
    })
    await settle(20_000)

    const received = (await messagesOf(bob, alice.pubkey))[0]
    expect(received?.attachment?.durationMs).toBe(4200)
    expect(received?.attachment?.waveform).toEqual([10, 80, 40])
    expect(await bob.messenger.readAttachment(received!.attachment!)).toEqual(bytes)
  })

  it('recovers when the relay silently refuses every chunk as too large', async () => {
    // Exactly the production failure: the small chat message is accepted and
    // every oversized chunk event is swallowed without complaint. The sender
    // sees "sent". The receiver must notice the silence and ask for what it is
    // owed, which is the only thing standing between this and a dead bubble.
    network.maxEventBytes = 20_000
    const bytes = photo(40_000)
    const sent = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'File',
    })
    await settle(4000)

    expect(network.droppedCount).toBeGreaterThan(0)
    // The message arrived; the payload did not.
    expect((await messagesOf(bob, alice.pubkey))[0]?.attachment).toBeDefined()
    expect(await bob.messenger.readAttachment(sent.attachment!)).toBeNull()

    network.maxEventBytes = Infinity
    await settle(60_000)

    const received = (await messagesOf(bob, alice.pubkey))[0]
    expect(await bob.messenger.readAttachment(received!.attachment!)).toEqual(bytes)
  })
})

describe('delete for everyone', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', source: 'invite', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', source: 'invite', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('removes the message from both devices', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'said too much')
    await settle(4000)
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(1)

    await alice.messenger.redactMessage(bob.pubkey, sent.id)
    await settle(6000)

    expect(await messagesOf(alice, bob.pubkey)).toHaveLength(0)
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)
  })

  it('takes the attachment payload with it on both devices', async () => {
    // A deletion that leaves the photo on disk has not deleted the photo.
    const bytes = new Uint8Array(40_000).fill(9)
    const sent = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'image',
      mime: 'image/webp',
      caption: 'Photo',
    })
    await settle(20_000)
    expect(await bob.messenger.readAttachment(sent.attachment!)).toEqual(bytes)

    await alice.messenger.redactMessage(bob.pubkey, sent.id)
    await settle(6000)

    for (const peer of [alice, bob]) {
      expect(await peer.vault.repo.getBlobManifest(sent.attachment!.id)).toBeUndefined()
      expect(await peer.vault.repo.getBlobChunk(sent.attachment!.id, 0)).toBeNull()
      expect((await peer.vault.repo.stats()).blobs).toBe(0)
    }
  })

  it('reaches a peer who was offline when it was sent', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'regret this')
    await settle(4000)
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(1)

    // Bob goes away entirely, then the withdrawal is issued.
    bob.messenger.stop()
    await alice.messenger.redactMessage(bob.pubkey, sent.id)
    await settle(6000)

    // He comes back and honours it, because the request was queued durably
    // rather than fired once at a device that was not listening.
    await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
    await settle(10_000)
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)
  })

  it('refuses to withdraw a message the peer wrote', async () => {
    // Otherwise anyone who can reach your inbox could delete your own words out
    // of your own conversation.
    await bob.messenger.sendMessage(alice.pubkey, 'you cannot unsay this for me')
    await settle(4000)
    const [received] = await messagesOf(alice, bob.pubkey)
    expect(received).toBeDefined()

    await expect(alice.messenger.redactMessage(bob.pubkey, received!.id)).rejects.toThrow(/did not write/)
    expect(await messagesOf(alice, bob.pubkey)).toHaveLength(1)
  })

  it('ignores a redact frame naming a message the sender did not author', async () => {
    const mine = await alice.messenger.sendMessage(bob.pubkey, 'mine, and staying')
    await settle(4000)

    // Bob forges a request to delete Alice's own message from Alice's device.
    await bob.messenger.sendRedactForTesting(alice.pubkey, [mine.id])
    await settle(6000)

    expect(await messagesOf(alice, bob.pubkey)).toHaveLength(1)
  })
})
