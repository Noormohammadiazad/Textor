import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import { bytesToHex } from '@/core/util/bytes'
import { extractFingerprint } from '@/core/transport/webrtc/directSession'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string, overrides: Partial<AppSettings> = {}) {
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
  const messenger = new Messenger(
    vault.vault,
    vault.repo,
    { ...settings, ...overrides },
    new FakeRelayPool(network),
  )
  await messenger.start(secretKeyHex, identity.publicKey)
  return { pubkey: identity.publicKey, vault, messenger } satisfies Peer
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms)

describe('control frames', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('shares a profile so a contact sees a name rather than a key', async () => {
    await alice.messenger.sendProfileTo(bob.pubkey)
    await settle()

    const contact = await bob.vault.repo.getContact(alice.pubkey)
    expect(contact?.remoteName).toBe('Alice')
  })

  it('lets a locally-set name win over the one the peer sends', async () => {
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Boss' })
    await alice.messenger.sendProfileTo(bob.pubkey)
    await settle()

    const contact = await bob.vault.repo.getContact(alice.pubkey)
    expect(contact?.name).toBe('Boss')
    expect(contact?.remoteName).toBe('Alice')
  })

  it('does not put typing indicators on relays', async () => {
    // Typing is direct-channel only: a keystroke-rate indicator is not worth a
    // permanent row in someone's relay database.
    const before = network.publishCount
    alice.messenger.setTyping(bob.pubkey, true)
    await settle()
    expect(network.publishCount).toBe(before)
  })

  it('honours the read-receipt setting', async () => {
    const quiet = await makePeer(network, 'Quiet', { sendReadReceipts: false })
    await quiet.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
    const sent = await alice.messenger.sendMessage(quiet.pubkey, 'are you reading this?')
    await settle(4000)

    await quiet.messenger.openConversation(alice.pubkey)
    await settle(4000)

    // Delivered still arrives — that is an acknowledgement of receipt, not of
    // attention — but the message must never be marked read.
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('delivered')

    quiet.messenger.stop()
    await quiet.vault.destroy()
  })

  it('batches delivery receipts into a single wrap', async () => {
    for (let i = 0; i < 5; i++) await alice.messenger.sendMessage(bob.pubkey, `message ${i}`)
    await settle(1000)

    const before = network.publishCount
    await settle(4000)
    const receiptPublishes = network.publishCount - before

    // Five acknowledged messages must not cost five wraps.
    expect(receiptPublishes).toBeLessThanOrEqual(2)
    for (const message of await alice.vault.repo.listMessages(
      alice.vault.repo.conversationId(alice.pubkey, bob.pubkey),
    )) {
      expect(message.status).toBe('delivered')
    }
  })
})

describe('outbox behaviour', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('keeps the same message id across retries, so a retry cannot duplicate', async () => {
    network.offline = true
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'retry me')
    await settle(30_000)

    network.offline = false
    await settle(120_000)

    const messages = await alice.vault.repo.listMessages(
      alice.vault.repo.conversationId(alice.pubkey, bob.pubkey),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe(sent.id)

    const received = await bob.vault.repo.listMessages(
      bob.vault.repo.conversationId(bob.pubkey, alice.pubkey),
    )
    expect(received).toHaveLength(1)
  })

  it('gives up on a message after repeated failure and offers a manual retry', async () => {
    network.offline = true
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'doomed')
    // 12 attempts with capped backoff; run well past that.
    await settle(60 * 60 * 1000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('failed')
    expect(await alice.vault.repo.countOutbox()).toBe(0)

    network.offline = false
    await alice.messenger.retryMessage(sent.id)
    await settle(5000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).not.toBe('failed')
  })

  it('drops stale control frames instead of replaying them after a restart', async () => {
    network.offline = true
    // A read receipt that never got out.
    await alice.messenger.openConversation(bob.pubkey)
    await settle(5000)
    const queued = await alice.vault.repo.countOutbox()

    network.offline = false
    // Well past the two-minute ephemeral cutoff.
    await settle(10 * 60 * 1000)

    expect(queued).toBeGreaterThanOrEqual(0)
    expect(await alice.vault.repo.countOutbox()).toBe(0)
  })
})

describe('direct channel as an accelerator', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('still publishes to relays when a message is sent', async () => {
    // The direct path never replaces the relay publish: SCTP accepting a frame
    // says nothing about the peer having stored it, and the self-addressed copy
    // is what makes vault restore work.
    const before = network.events.length
    await alice.messenger.sendMessage(bob.pubkey, 'belt and braces')
    await settle(3000)

    const wraps = network.events.slice(before).filter((event) => event.kind === 1059)
    const recipients = wraps.flatMap((event) =>
      event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]),
    )
    expect(recipients).toContain(bob.pubkey)
    expect(recipients).toContain(alice.pubkey)
  })

  it('leaves a message queued when neither path is available', async () => {
    network.offline = true
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'nowhere to go')
    await settle(3000)

    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('queued')
    expect((await alice.vault.repo.getMessage(sent.id))?.via).toBe('relay')
    await settle(60_000)
  })
})

describe('history retention', () => {
  it('removes messages older than the configured window', async () => {
    const t = await makeVault()
    const self = 'a'.repeat(64)
    const convo = await t.repo.ensureConversation(self, 'b'.repeat(64))

    const day = 24 * 60 * 60 * 1000
    for (const [index, age] of [0, 5, 40, 200].entries()) {
      await t.repo.putMessage({
        id: String(index).repeat(64),
        convoId: convo.id,
        direction: 'in',
        status: 'delivered',
        ts: Date.now() - age * day,
        tsCoarse: 0,
        body: `aged ${age} days`,
        authorPubkey: 'b'.repeat(64),
      })
    }

    expect(await t.repo.countMessages(convo.id)).toBe(4)
    const removed = await t.repo.applyRetention(30)
    expect(removed).toBe(2)
    expect((await t.repo.listMessages(convo.id)).map((m) => m.body)).toEqual(['aged 5 days', 'aged 0 days'])
    await t.destroy()
  })

  it('keeps everything when retention is disabled', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation('a'.repeat(64), 'b'.repeat(64))
    await t.repo.putMessage({
      id: 'c'.repeat(64),
      convoId: convo.id,
      direction: 'in',
      status: 'delivered',
      ts: Date.now() - 5000 * 24 * 60 * 60 * 1000,
      tsCoarse: 0,
      body: 'ancient',
      authorPubkey: 'b'.repeat(64),
    })
    expect(await t.repo.applyRetention(0)).toBe(0)
    expect(await t.repo.countMessages(convo.id)).toBe(1)
    await t.destroy()
  })
})

describe('WebRTC helpers', () => {
  it('extracts a DTLS fingerprint from an SDP blob', () => {
    const sdp = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      'a=group:BUNDLE 0',
      'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89',
      'a=setup:actpass',
    ].join('\r\n')
    expect(extractFingerprint(sdp)).toBe('sha-256 AB:CD:EF:01:23:45:67:89')
  })

  it('returns null when there is no fingerprint line', () => {
    expect(extractFingerprint('v=0\r\no=- 1 2 IN IP4 127.0.0.1')).toBeNull()
  })
})

describe('waking and catching up', () => {
  let network: FakeRelayNetwork
  let pool: FakeRelayPool
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    bob = await makePeer(network, 'Bob')
    // Alice gets a pool the test can inspect.
    const { identity } = createIdentity()
    const vault = await makeVault('Alice-pw')
    const secretKeyHex = bytesToHex(identity.secretKey)
    await vault.repo.putIdentity({
      pubkey: identity.publicKey,
      npub: identity.npub,
      secretKeyHex,
      name: 'Alice',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
    })
    pool = new FakeRelayPool(network)
    const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
    await messenger.start(secretKeyHex, identity.publicKey)
    alice = { pubkey: identity.publicKey, vault, messenger }
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    await settle(1000)
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('passes a wake-up through to the relay sockets', () => {
    alice.messenger.wake('online')
    alice.messenger.wake('focus')
    expect(pool.wakes).toEqual(['online', 'focus'])
  })

  it('skips a catch-up read when no relay has dropped since the last one', async () => {
    // The live subscription has been receiving throughout, so replaying three
    // days of gift wraps from every relay would find nothing.
    const catchUps = vi.spyOn(alice.messenger.transport, 'fetchInbox')
    await settle(10_000)
    alice.messenger.wake('visible')
    await settle(100)
    expect(catchUps).not.toHaveBeenCalled()

    // A read relay dropped: something may have been missed.
    pool.epoch += 1
    alice.messenger.wake('visible')
    await settle(100)
    expect(catchUps).toHaveBeenCalledTimes(1)

    // And a long enough gap earns one regardless.
    await settle(3 * 60_000)
    alice.messenger.wake('focus')
    await settle(100)
    expect(catchUps).toHaveBeenCalledTimes(2)
  })

  it('treats a heartbeat that arrives far too late as a resume from sleep', async () => {
    // Timers stop while a device sleeps; the first tick afterwards is late.
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await settle(5000)
    expect(pool.wakes).toContain('resume')
  })

  it('does not mistake ordinary ticks for sleep', async () => {
    await settle(60_000)
    expect(pool.wakes).not.toContain('resume')
  })

  it('pre-warms a contact’s inbox relays when their conversation opens', async () => {
    await alice.vault.repo.upsertContact(bob.pubkey, { relays: ['wss://bob-inbox.example'] })
    await alice.messenger.openConversation(bob.pubkey)
    await settle(50)
    expect(pool.prewarmed).toContainEqual(['wss://bob-inbox.example'])

    // Not again on every re-open within the minute.
    await alice.messenger.openConversation(bob.pubkey)
    await settle(50)
    expect(pool.prewarmed).toHaveLength(1)
  })

  it('counts only messages in the sending indicator, not queue traffic', async () => {
    network.offline = true
    const states: number[] = []
    alice.messenger.events.on('syncState', (state) => states.push(state.pendingOutbox))
    // A profile frame and a message both queue up.
    await alice.messenger.sendProfileTo(bob.pubkey)
    await alice.messenger.sendMessage(bob.pubkey, 'one real message')
    await settle(3000)

    expect(await alice.vault.repo.countOutbox()).toBe(2)
    expect(Math.max(...states)).toBe(1)
  })

  it('never demotes a message the peer has already acknowledged', async () => {
    // Over a direct channel the receipt can land while the relays are still
    // failing. The retry path must not drag the message back to queued or
    // failed.
    network.offline = true
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'already there')
    await settle(3000)
    await alice.vault.repo.advanceMessageStatus(sent.id, 'delivered')

    await settle(60 * 60 * 1000)
    const stored = await alice.vault.repo.getMessage(sent.id)
    expect(stored?.status).toBe('delivered')
    expect(await alice.vault.repo.countOutbox()).toBe(0)
  })
})

describe('relay configuration reloads', () => {
  let network: FakeRelayNetwork
  let alice: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
  })

  afterEach(async () => {
    alice.messenger.stop()
    await alice.vault.destroy()
    vi.useRealTimers()
  })

  it('keeps the inbox subscription when nothing about the read relays changed', async () => {
    // The UI reloads relays right after unlock; that must not tear down and
    // replay the subscription the engine has only just opened.
    const subscribe = vi.spyOn(alice.messenger.transport, 'subscribeInbox')
    await alice.messenger.reloadRelays()
    expect(subscribe).not.toHaveBeenCalled()

    await alice.vault.repo.upsertRelay('wss://another.example', { read: true, write: true })
    await alice.messenger.reloadRelays()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })
})
