import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { blobRef, sealBlob } from '@/core/crypto/blobCrypto'
import { blindId } from '@/core/crypto/vaultCrypto'
import { KIND_CHAT, recipientTags } from '@/core/models/protocol'
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

  /*
   * A payload is named by the hash of its bytes, and sealed under a key of
   * its own each time it is sent. Two copies of the same file therefore share
   * an id and nothing else — and storing them under the id alone kept one set
   * of chunks, so the other message could never be opened (ADR-052).
   */
  it('keeps the same file from two senders readable in both conversations', async () => {
    const carol = await makePeer(network, 'Carol')
    try {
      await carol.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
      await bob.vault.repo.upsertContact(carol.pubkey, { name: 'Carol', accepted: true })
      const bytes = photo(40_000)
      const fromAlice = await alice.messenger.sendAttachment(bob.pubkey, {
        bytes,
        kind: 'image',
        mime: 'image/webp',
        caption: 'from Alice',
      })
      await settle(20_000)
      const fromCarol = await carol.messenger.sendAttachment(bob.pubkey, {
        bytes,
        kind: 'image',
        mime: 'image/webp',
        caption: 'from Carol',
      })
      await settle(20_000)

      expect(fromAlice.attachment!.id).toBe(fromCarol.attachment!.id)
      expect(fromAlice.attachment!.key).not.toBe(fromCarol.attachment!.key)
      const a = (await messagesOf(bob, alice.pubkey))[0]!.attachment!
      const c = (await messagesOf(bob, carol.pubkey))[0]!.attachment!
      expect(await bob.messenger.readAttachment(a)).toEqual(bytes)
      expect(await bob.messenger.readAttachment(c)).toEqual(bytes)
      // …and both senders can still show what they sent.
      expect(await alice.messenger.readAttachment(fromAlice.attachment!)).toEqual(bytes)
      expect(await carol.messenger.readAttachment(fromCarol.attachment!)).toEqual(bytes)
    } finally {
      carol.messenger.stop()
      await carol.vault.destroy()
    }
  })

  it('still reads a payload stored before copies were kept apart, after upgrading', async () => {
    const bytes = photo(40_000)
    const sent = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'image',
      mime: 'image/webp',
      caption: 'from before',
    })
    await settle(20_000)
    // Put Bob's copy back where an earlier build kept it: under the id alone,
    // with no sealed name, and the store not yet marked as moved.
    const legacy = blindId(bob.vault.vault.keys.indexKey, 'blob', sent.attachment!.id)
    const current = bob.vault.repo.blobKey(blobRef(sent.attachment!))
    const chunks = await bob.vault.db.blobChunks.where('blob').equals(current).toArray()
    await bob.vault.db.blobChunks.bulkPut(
      chunks.map((c) => ({ ...c, id: `${legacy}:${c.seq}`, blob: legacy })),
    )
    await bob.vault.db.blobChunks.where('blob').equals(current).delete()
    const { enc: _enc, ...row } = (await bob.vault.db.blobs.get(current))!
    await bob.vault.db.blobs.put({ ...row, id: legacy })
    await bob.vault.db.blobs.delete(current)
    await bob.vault.db.settings.delete('blobstore')
    const received = (await messagesOf(bob, alice.pubkey))[0]!.attachment!
    expect(await bob.messenger.readAttachment(received)).toBeNull()

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      bob.messenger.stop()
      bob.messenger = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
      await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
      expect(info.mock.calls.some((call) => call.join(' ').includes('1 payload(s) moved'))).toBe(true)
    } finally {
      info.mockRestore()
    }
    expect(await bob.messenger.readAttachment(received)).toEqual(bytes)
  })

  it('starts, and keeps messaging, when the attachment store cannot be moved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const migrate = vi.spyOn(bob.vault.repo, 'migrateBlobStore').mockRejectedValueOnce(new Error('disk full'))
    try {
      bob.messenger.stop()
      bob.messenger = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
      await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
      expect(warn.mock.calls.some((call) => String(call[0]).includes('could not be migrated'))).toBe(true)
      await alice.messenger.sendMessage(bob.pubkey, 'still arriving')
      await settle()
      expect((await messagesOf(bob, alice.pubkey)).map((m) => m.body)).toEqual(['still arriving'])
    } finally {
      warn.mockRestore()
      migrate.mockRestore()
    }
  })

  it('refuses to send a copy that does not hold the bytes it is sent with', async () => {
    const { envelope } = sealBlob(photo(100))
    await expect(
      alice.messenger.sendAttachment(bob.pubkey, {
        bytes: photo(200),
        envelope,
        kind: 'file',
        mime: 'application/octet-stream',
        caption: '',
      }),
    ).rejects.toThrow('does not hold these bytes')
  })

  it('frees the payloads of messages retention removes, and nothing still in use', async () => {
    const bytes = (seed: number) => photo(20_000).map((b) => (b + seed) % 251)
    const send = (seed: number, caption: string) =>
      alice.messenger.sendAttachment(bob.pubkey, {
        bytes: bytes(seed),
        kind: 'file',
        mime: 'application/octet-stream',
        caption,
      })
    const old = await send(1, 'old')
    const recent = await send(2, 'recent')
    await settle(20_000)
    const pack = await bob.messenger.importStickerPack('Kept', [{ bytes: bytes(3), mime: 'image/webp' }])
    // The first message is ten days old by the time the janitor looks.
    const stale = (await bob.vault.repo.getMessage(old.id))!
    await bob.vault.repo.putMessage({ ...stale, ts: Date.now() - 10 * 86_400_000 })
    vi.setSystemTime(Date.now() + 2 * 3_600_000)
    // A payload written a moment ago, whose message is not stored yet.
    const pending = sealBlob(bytes(4))
    await bob.vault.repo.putBlobChunk(blobRef(pending.envelope), 0, pending.chunk(0), {
      total: pending.envelope.chunks,
      size: pending.envelope.size,
    })

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await bob.messenger.applySettings({ ...bob.messenger.settings, retention: '7d' })
      expect(
        info.mock.calls.some((call) =>
          call.join(' ').includes('removed 1 messages and 1 attachment payload(s)'),
        ),
      ).toBe(true)
    } finally {
      info.mockRestore()
    }
    expect(await bob.vault.repo.getMessage(old.id)).toBeNull()
    expect(await bob.vault.repo.getBlobManifest(blobRef(old.attachment!))).toBeUndefined()
    expect(await bob.messenger.readAttachment(recent.attachment!)).toEqual(bytes(2))
    expect(await bob.messenger.readSticker(pack.stickers[0]!)).toEqual(bytes(3))
    expect(await bob.vault.repo.getBlobManifest(blobRef(pending.envelope))).toBeDefined()
  })

  it('keeps both copies readable when one person sends the same file twice', async () => {
    const bytes = photo(40_000)
    const first = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'first',
    })
    const second = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes,
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'second',
    })
    await settle(30_000)

    const received = await messagesOf(bob, alice.pubkey)
    expect(received).toHaveLength(2)
    for (const message of received)
      expect(await bob.messenger.readAttachment(message.attachment!)).toEqual(bytes)
    expect(await alice.messenger.readAttachment(first.attachment!)).toEqual(bytes)
    expect(await alice.messenger.readAttachment(second.attachment!)).toEqual(bytes)
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
      expect(await peer.vault.repo.getBlobManifest(blobRef(sent.attachment!))).toBeUndefined()
      expect(await peer.vault.repo.getBlobChunk(blobRef(sent.attachment!), 0)).toBeNull()
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

  /** A chat rumor from Alice to Bob, built by hand so it can be wrapped more than once. */
  const chatRumor = (text: string) =>
    createRumor(
      { kind: KIND_CHAT, content: text, tags: recipientTags([bob.pubkey]) },
      hexToBytes(alice.secretKeyHex),
    )
  const deliver = (rumor: ReturnType<typeof chatRumor>) =>
    network.publish(giftWrap(rumor, hexToBytes(alice.secretKeyHex), bob.pubkey))

  it('keeps a message deleted for me deleted when another copy of it arrives', async () => {
    // A sender's outbox wraps the same rumor afresh on every retry, so the
    // seen marks — which name wraps — do not recognise the second copy.
    const rumor = chatRumor('once is enough')
    deliver(rumor)
    await settle()
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(1)

    await bob.messenger.deleteLocally(rumor.id)
    deliver(rumor)
    await settle()
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)
  })

  it('honours a withdrawal that arrives before the message it withdraws', async () => {
    // Wrap timestamps are fuzzed, so a catch-up read can return the request
    // first. Dropping it for naming nothing would let the message in after.
    const rumor = chatRumor('never mind')
    await alice.messenger.sendRedactForTesting(bob.pubkey, [rumor.id])
    await settle(6000)
    deliver(rumor)
    await settle()
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(0)
  })

  it('does not let one person withdraw, in advance, what another will write', async () => {
    const carol = await makePeer(network, 'Carol')
    try {
      const rumor = chatRumor('from Alice, not Carol')
      await carol.messenger.sendRedactForTesting(bob.pubkey, [rumor.id])
      await settle(6000)
      deliver(rumor)
      await settle()
      expect(await messagesOf(bob, alice.pubkey)).toEqual([expect.objectContaining({ id: rumor.id })])
    } finally {
      carol.messenger.stop()
      await carol.vault.destroy()
    }
  })

  it('refuses a wrap older than the dedup horizon rather than risk processing it twice', async () => {
    // Seen marks older than the floor have been pruned, so a wrap from before
    // it cannot be told apart from one already processed — and perhaps
    // deleted since. It is not even asked for, and refused if it turns up.
    bob.messenger.stop()
    const floorSec = Math.floor(Date.now() / 1000) - 3600
    await bob.vault.repo.setSyncState({ lastSyncSec: 0, floorSec, relays: {} })
    const aliceSk = hexToBytes(alice.secretKeyHex)
    const old = chatRumor('from before the horizon')
    network.publish(giftWrap(old, aliceSk, bob.pubkey, { fuzzedAt: floorSec - 60 }))
    network.publish(giftWrap(chatRumor('after it'), aliceSk, bob.pubkey, { fuzzedAt: floorSec + 60 }))

    bob.messenger = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
    await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
    await settle()
    expect((await messagesOf(bob, alice.pubkey)).map((m) => m.body)).toEqual(['after it'])

    // A live copy of the old one is refused on arrival, and leaves no mark.
    const late = giftWrap(old, aliceSk, bob.pubkey, { fuzzedAt: floorSec - 30 })
    network.publish(late)
    await settle()
    expect(await messagesOf(bob, alice.pubkey)).toHaveLength(1)
    expect(await bob.vault.repo.hasSeen(late.id)).toBe(false)
  })

  it('prunes old seen marks on its schedule, and raises the floor to match', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 86_400 // past the 45-day horizon
    const ids = Array.from({ length: 3 }, (_, i) => String(i).padStart(64, 'a'))
    await bob.vault.repo.markSeen(ids.map((id) => ({ id, createdAt: old })))
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      // Twelve hours on, the next outbox tick runs the janitor.
      vi.setSystemTime(Date.now() + 12 * 3_600_000 + 60_000)
      await settle(6000)
      expect(info.mock.calls.some((call) => call.join(' ').includes('seen table: pruned 3 marks'))).toBe(true)
    } finally {
      info.mockRestore()
    }
    expect(await bob.vault.repo.hasSeen(ids[0]!)).toBe(false)
    expect((await bob.vault.repo.getSyncState()).floorSec).toBeGreaterThan(old)
  })

  it('logs a janitor run that fails, and carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const compact = vi.spyOn(bob.vault.repo, 'compactSeen').mockRejectedValueOnce(new Error('disk full'))
    try {
      bob.messenger.stop()
      bob.messenger = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
      await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
      await settle()
      expect(warn.mock.calls.some((call) => String(call[0]).includes('janitor failed'))).toBe(true)
      await alice.messenger.sendMessage(bob.pubkey, 'still arriving')
      await settle()
      expect((await messagesOf(bob, alice.pubkey)).map((m) => m.body)).toEqual(['still arriving'])
    } finally {
      warn.mockRestore()
      compact.mockRestore()
    }
  })

  it('does nothing to the inbox once stopped, whatever was under way', async () => {
    bob.messenger.stop()
    bob.messenger = new Messenger(
      bob.vault.vault,
      bob.vault.repo,
      { ...settings, retention: '7d' },
      new FakeRelayPool(network),
    )
    const compact = vi.spyOn(bob.vault.repo, 'compactSeen')
    await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
    // Stopped while the janitor was still applying retention.
    bob.messenger.stop()
    await settle()
    expect(compact).not.toHaveBeenCalled()
    // A resync, or a changed relay list, finds nothing to reopen.
    await bob.messenger.resync({ force: true })
    await bob.vault.repo.upsertRelay('wss://another.example', { read: true, write: true })
    await bob.messenger.reloadRelays()
  })
})
