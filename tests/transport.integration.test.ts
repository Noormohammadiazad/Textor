import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { InboxSync } from '@/core/engine/inboxSync'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import { RelayPool } from '@/core/transport/relayPool'
import { bytesToHex } from '@/core/util/bytes'
import { FakeSocketNetwork, type FakeWebSocket } from './fakeWebSocket'
import { makeVault, type TestVault } from './helpers'

/**
 * The engine over the real relay pool and real sockets, against relays that
 * misbehave the way measured public relays do. Where the other suites prove
 * the pieces, this proves the latency a person actually experiences.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  vault: TestVault
  messenger: Messenger
  /** Every socket this peer opened, for inspecting what it actually sent. */
  sockets: FakeWebSocket[]
}

async function makePeer(
  network: FakeSocketNetwork,
  name: string,
  relays: { read: string[]; write: string[] },
): Promise<Peer> {
  const { identity } = createIdentity()
  const vault = await makeVault(`${name}-pw`)
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
  for (const url of new Set([...relays.read, ...relays.write])) {
    await vault.repo.upsertRelay(url, { read: relays.read.includes(url), write: relays.write.includes(url) })
  }
  const sockets: FakeWebSocket[] = []
  const pool = new RelayPool({
    socket: {
      createSocket: (url) => {
        const socket = network.factory(url) as FakeWebSocket
        sockets.push(socket)
        return socket
      },
      isOffline: () => false,
    },
  })
  const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
  await messenger.start(secretKeyHex, identity.publicKey)
  return { pubkey: identity.publicKey, vault, messenger, sockets }
}

const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** Resolves with the fake-clock time at which a message first reaches `status`. */
function whenStatus(peer: Peer, id: string, status: Message['status']): () => number | null {
  let at: number | null = null
  peer.messenger.events.on('messageUpdated', (message) => {
    if (message.id === id && message.status === status && at === null) at = Date.now()
  })
  return () => at
}

async function received(peer: Peer, from: string): Promise<Message[]> {
  return peer.vault.repo.listMessages(peer.vault.repo.conversationId(peer.pubkey, from))
}

/** Gift wraps a peer put on the wire, with the relay each went to. */
function wrapsSentBy(peer: Peer): { url: string; event: NostrEvent }[] {
  const out: { url: string; event: NostrEvent }[] = []
  for (const socket of peer.sockets) {
    for (const frame of socket.sent) {
      if (!frame.startsWith('["EVENT"')) continue
      const event = (JSON.parse(frame) as [string, NostrEvent])[1]
      if (event.kind === 1059) out.push({ url: socket.url, event })
    }
  }
  return out
}

const recipient = (event: NostrEvent) => event.tags.find((tag) => tag[0] === 'p')?.[1]

describe('dispatch latency over real sockets', () => {
  let network: FakeSocketNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeSocketNetwork()
  })

  afterEach(async () => {
    alice?.messenger.stop()
    bob?.messenger.stop()
    await alice?.vault.destroy()
    await bob?.vault.destroy()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('marks a message sent at quorum while one relay is black-holed and another is slow', async () => {
    network.relay('wss://fast1.example', { okDelayMs: 150 })
    network.relay('wss://fast2.example', { okDelayMs: 220 })
    network.relay('wss://slow.example', { okDelayMs: 7000 })
    network.relay('wss://hole.example', { blackhole: true })
    const relays = ['wss://fast1.example', 'wss://fast2.example', 'wss://slow.example', 'wss://hole.example']
    alice = await makePeer(network, 'Alice', { read: relays, write: relays })
    bob = await makePeer(network, 'Bob', { read: relays, write: relays })
    await settle(300)

    const message = await alice.messenger.sendMessage(bob.pubkey, 'not waiting on the slowest relay')
    const sentAt = whenStatus(alice, message.id, 'sent')
    const started = Date.now()
    await settle(1500)

    // Before: every relay had to answer, so this took the black hole's full
    // timeout. Now it is the second-fastest acknowledgement.
    expect(sentAt()).not.toBeNull()
    expect(sentAt()! - started).toBeLessThan(1500)
    expect((await received(bob, alice.pubkey)).map((m) => m.body)).toEqual([
      'not waiting on the slowest relay',
    ])

    // The slow relay still gets it, and the final count lands afterwards.
    await settle(11_000)
    expect((await alice.vault.repo.getMessage(message.id))?.relayAcks).toBe(3)
  })

  it('delivers live through a relay whose first handshake took five seconds', async () => {
    // Under nostr-tools this subscription was abandoned at three seconds and
    // never retried: the message below would only have appeared on refocus.
    network.relay('wss://slow-open.example', { connectDelayMs: 5000 })
    const relays = ['wss://slow-open.example']
    alice = await makePeer(network, 'Alice', { read: relays, write: relays })
    bob = await makePeer(network, 'Bob', { read: relays, write: relays })
    await settle(12_000)

    const catchUps = vi.spyOn(InboxSync.prototype, 'catchUp')
    await alice.messenger.sendMessage(bob.pubkey, 'arrives live')
    await settle(1000)

    expect((await received(bob, alice.pubkey)).map((m) => m.body)).toEqual(['arrives live'])
    expect(catchUps).not.toHaveBeenCalled()
  })

  it('does not hold a text message behind the chunks of a photo sent just before it', async () => {
    network.relay('wss://r1.example', { okDelayMs: 400 })
    network.relay('wss://r2.example', { okDelayMs: 400 })
    const relays = ['wss://r1.example', 'wss://r2.example']
    alice = await makePeer(network, 'Alice', { read: relays, write: relays })
    bob = await makePeer(network, 'Bob', { read: relays, write: relays })
    await settle(300)

    await alice.messenger.sendAttachment(bob.pubkey, {
      bytes: new Uint8Array(160_000).map((_, i) => i % 251),
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'big file',
    })
    const text = await alice.messenger.sendMessage(bob.pubkey, 'meanwhile')
    const sentAt = whenStatus(alice, text.id, 'sent')
    const started = Date.now()
    await settle(1200)

    expect(sentAt()).not.toBeNull()
    expect(sentAt()! - started).toBeLessThan(1200)
    // …while the photo's chunks are still going out behind it.
    expect(await alice.vault.repo.countOutbox((id) => id.startsWith('blob-'))).toBeGreaterThan(0)
  })

  it('sends the self-addressed copy to our own inbox only, and never copies control frames', async () => {
    network.relay('wss://alice-inbox.example')
    network.relay('wss://alice-out.example')
    network.relay('wss://bob-inbox.example')
    alice = await makePeer(network, 'Alice', {
      read: ['wss://alice-inbox.example'],
      write: ['wss://alice-inbox.example', 'wss://alice-out.example'],
    })
    bob = await makePeer(network, 'Bob', {
      read: ['wss://bob-inbox.example'],
      write: ['wss://bob-inbox.example'],
    })
    await alice.vault.repo.upsertContact(bob.pubkey, {
      name: 'Bob',
      accepted: true,
      relays: ['wss://bob-inbox.example'],
    })
    await settle(300)

    await alice.messenger.sendAttachment(bob.pubkey, {
      bytes: new Uint8Array(40_000).map((_, i) => i % 199),
      kind: 'image',
      mime: 'image/webp',
      caption: 'photo',
    })
    await settle(5000)

    const wraps = wrapsSentBy(alice)
    const selfCopies = wraps.filter((w) => recipient(w.event) === alice.pubkey)
    // One chat message, one copy — not one per attachment chunk as well.
    expect(new Set(selfCopies.map((w) => w.event.id)).size).toBe(1)
    expect(new Set(selfCopies.map((w) => w.url))).toEqual(new Set(['wss://alice-inbox.example']))

    const toBob = wraps.filter((w) => recipient(w.event) === bob.pubkey)
    expect(toBob.some((w) => w.url === 'wss://bob-inbox.example')).toBe(true)
    // The message plus three chunks.
    expect(new Set(toBob.map((w) => w.event.id)).size).toBeGreaterThanOrEqual(4)
  })

  it('delivers at once when the network returns, instead of waiting out the retry backoff', async () => {
    const servers = ['wss://r1.example', 'wss://r2.example'].map((url) =>
      network.relay(url, { refuse: true }),
    )
    const relays = servers.map((server) => server.url)
    alice = await makePeer(network, 'Alice', { read: relays, write: relays })
    network.relay('wss://bob.example')
    bob = await makePeer(network, 'Bob', { read: ['wss://bob.example'], write: ['wss://bob.example'] })

    // Pin retry jitter high so the backoff is long and the comparison is honest.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const message = await alice.messenger.sendMessage(bob.pubkey, 'held while offline')
    // Run until the message is sitting out a long retry backoff, not mid-attempt.
    let waiting = 0
    for (let i = 0; i < 180 && waiting <= 5000; i++) {
      await settle(1000)
      const queued = await alice.vault.repo.getOutboxItem(message.id)
      waiting = queued ? queued.nextAttemptAt - Date.now() : 0
    }
    expect(waiting).toBeGreaterThan(5000)

    for (const server of servers) server.set({ refuse: false })
    const sentAt = whenStatus(alice, message.id, 'sent')
    const started = Date.now()
    alice.messenger.wake('online')
    await settle(2000)

    expect(sentAt()).not.toBeNull()
    expect(sentAt()! - started).toBeLessThan(2000)
  })
})
