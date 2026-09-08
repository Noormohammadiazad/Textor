import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsignedEvent } from 'nostr-tools/core'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger, type CallSignal } from '@/core/engine/messenger'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import {
  encodeControlFrame,
  KIND_CONTROL,
  PROTOCOL_VERSION,
  recipientTags,
  type CallFrame,
} from '@/core/models/protocol'
import { CALL_RING_WINDOW_MS } from '@/core/models/call'
import { DEFAULT_ICE_SERVERS } from '@/core/transport/defaultRelays'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * The engine's side of calling: which signals reach the call subsystem, which
 * are refused without a word, and what a call leaves in the conversation.
 * Real engines on a shared fake relay network, so every signal crosses the
 * sealed wire format.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  signals: CallSignal[]
}

async function makePeer(network: FakeRelayNetwork, name: string): Promise<Peer> {
  const skHex = bytesToHex(createIdentity().identity.secretKey)
  const secretKey = hexToBytes(skHex)
  const pubkey = getPublicKey(secretKey)
  const vault = await makeVault(`${name}-pw`)
  await vault.repo.putIdentity({
    pubkey,
    npub: '',
    secretKeyHex: skHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(skHex, pubkey)
  const signals: CallSignal[] = []
  messenger.events.on('callSignal', (signal) => signals.push(signal))
  return { pubkey, secretKey, vault, messenger, signals }
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms)

const offer = (media: 'audio' | 'video' = 'audio'): CallFrame => ({
  v: PROTOCOL_VERSION,
  t: 'rtc',
  kind: 'offer',
  media,
  sdp: 'v=0\r\n',
})

/** Hand-deliver a call signal, for playing a client that does something ours never would. */
function inject(
  network: FakeRelayNetwork,
  from: Peer,
  to: Peer,
  frame: CallFrame,
  template: Partial<UnsignedEvent> = {},
): string {
  const rumor = createRumor(
    { kind: KIND_CONTROL, content: encodeControlFrame(frame), tags: recipientTags([to.pubkey]), ...template },
    from.secretKey,
  )
  network.publish(giftWrap(rumor, from.secretKey, to.pubkey))
  return rumor.id
}

describe('call signals in the engine', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('rings for a contact, naming the call by the rumor that opened it', async () => {
    const id = await alice.messenger.sendCallSignal(bob.pubkey, offer('video'))
    await settle()
    expect(bob.signals).toEqual([
      expect.objectContaining({
        peerPubkey: alice.pubkey,
        callId: id,
        frame: expect.objectContaining({ kind: 'offer', media: 'video' }),
      }),
    ])
    expect(Math.abs((bob.signals[0]?.at ?? 0) - Date.now())).toBeLessThan(5000)

    // Everything after the opening offer names the call explicitly.
    await bob.messenger.sendCallSignal(alice.pubkey, { v: 1, t: 'rtc', kind: 'ringing', call: id })
    await settle()
    expect(alice.signals).toEqual([expect.objectContaining({ peerPubkey: bob.pubkey, callId: id })])
  })

  it('keeps call signals off our own inbox, unlike messages', async () => {
    await alice.messenger.sendCallSignal(bob.pubkey, offer())
    await settle()
    const toSelf = network.query({ kinds: [1059], '#p': [alice.pubkey] })
    expect(toSelf).toEqual([])
    expect(network.query({ kinds: [1059], '#p': [bob.pubkey] })).toHaveLength(1)
  })

  it('stays silent for someone not in the address book, and tells them nothing', async () => {
    await carol.messenger.sendCallSignal(bob.pubkey, offer())
    await settle()
    expect(bob.signals).toEqual([])
    expect(await bob.vault.repo.getContact(carol.pubkey)).toBeNull()
    // No busy, no decline: nothing goes back to say the device is online.
    expect(network.query({ kinds: [1059], '#p': [carol.pubkey] })).toEqual([])
  })

  it('stays silent for a message request, and for someone blocked', async () => {
    await bob.vault.repo.upsertContact(carol.pubkey, { name: 'Carol', accepted: false })
    await carol.messenger.sendCallSignal(bob.pubkey, offer())
    await settle()
    expect(bob.signals).toEqual([])

    await bob.vault.repo.upsertContact(alice.pubkey, { blocked: true })
    await alice.messenger.sendCallSignal(bob.pubkey, offer())
    await settle()
    expect(bob.signals).toEqual([])
  })

  it('refuses a call addressed to a group: calls are one to one', async () => {
    const rumor = createRumor(
      {
        kind: KIND_CONTROL,
        content: encodeControlFrame(offer()),
        tags: recipientTags([bob.pubkey, carol.pubkey]),
      },
      alice.secretKey,
    )
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    expect(bob.signals).toEqual([])
  })

  it('writes an offer too old to ring into the conversation as a missed call, once', async () => {
    const past = Math.floor((Date.now() - CALL_RING_WINDOW_MS - 60_000) / 1000)
    const rumor = createRumor(
      {
        kind: KIND_CONTROL,
        content: encodeControlFrame(offer('video')),
        tags: recipientTags([bob.pubkey]),
        created_at: past,
      },
      alice.secretKey,
    )
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    // A second wrap of the same rumor, as a relay replaying history would deliver.
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()

    expect(bob.signals).toEqual([])
    const convoId = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    const messages = await bob.vault.repo.listMessages(convoId)
    expect(messages).toEqual([
      expect.objectContaining({
        id: rumor.id,
        direction: 'in',
        authorPubkey: alice.pubkey,
        body: '',
        ts: past * 1000,
        call: { media: 'video', outcome: 'missed' },
      }),
    ])
    expect((await bob.vault.repo.getConversation(convoId))?.unread).toBe(1)
  })

  it('does not ring an offer it has already recorded', async () => {
    const rumor = createRumor(
      { kind: KIND_CONTROL, content: encodeControlFrame(offer()), tags: recipientTags([bob.pubkey]) },
      alice.secretKey,
    )
    await bob.messenger.recordCall(alice.pubkey, rumor.id, 'in', { media: 'audio', outcome: 'declined' })
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    expect(bob.signals).toEqual([])
  })

  it('passes on signals for a call already under way, whatever their age', async () => {
    const past = Math.floor((Date.now() - 10 * 60_000) / 1000)
    inject(network, alice, bob, { v: 1, t: 'rtc', kind: 'bye', call: 'a'.repeat(64) }, { created_at: past })
    await settle()
    expect(bob.signals).toEqual([expect.objectContaining({ callId: 'a'.repeat(64) })])
  })

  it('refuses to send a signal the other side would drop', async () => {
    await expect(
      alice.messenger.sendCallSignal(bob.pubkey, { v: 1, t: 'rtc', kind: 'answer' } as CallFrame),
    ).rejects.toThrow('malformed call signal')
    alice.messenger.stop()
    await expect(alice.messenger.sendCallSignal(bob.pubkey, offer())).rejects.toThrow('not running')
  })

  it('records a call as a local entry, unread only when it was missed', async () => {
    const convoId = alice.vault.repo.conversationId(alice.pubkey, bob.pubkey)
    const seen: string[] = []
    alice.messenger.events.on('message', ({ message }) => seen.push(message.id))

    await alice.messenger.recordCall(bob.pubkey, '1'.repeat(64), 'out', {
      media: 'audio',
      outcome: 'completed',
      durationMs: 90_000,
    })
    expect(await alice.vault.repo.getMessage('1'.repeat(64))).toMatchObject({
      direction: 'out',
      authorPubkey: alice.pubkey,
      status: 'sent',
      call: { media: 'audio', outcome: 'completed', durationMs: 90_000 },
    })
    expect((await alice.vault.repo.getConversation(convoId))?.unread).toBe(0)

    await alice.messenger.recordCall(bob.pubkey, '2'.repeat(64), 'in', { media: 'video', outcome: 'missed' })
    expect((await alice.vault.repo.getConversation(convoId))?.unread).toBe(1)
    // The same call is recorded once, however many times it is reported.
    await alice.messenger.recordCall(bob.pubkey, '2'.repeat(64), 'in', { media: 'video', outcome: 'missed' })
    expect(seen).toEqual(['1'.repeat(64), '2'.repeat(64)])
  })

  it('does not count a missed call as unread in the conversation on screen', async () => {
    alice.messenger.setActiveConversation(bob.pubkey, { focused: true })
    await alice.messenger.recordCall(bob.pubkey, '3'.repeat(64), 'in', { media: 'audio', outcome: 'missed' })
    const convoId = alice.vault.repo.conversationId(alice.pubkey, bob.pubkey)
    expect((await alice.vault.repo.getConversation(convoId))?.unread).toBe(0)
  })

  it('records nothing once the vault has locked', async () => {
    alice.messenger.stop()
    await alice.messenger.recordCall(bob.pubkey, '4'.repeat(64), 'in', { media: 'audio', outcome: 'missed' })
    expect(await alice.vault.repo.hasMessage('4'.repeat(64))).toBe(false)
  })

  it('never sends a receipt for a call record, and never takes one', async () => {
    await bob.messenger.sendMessage(alice.pubkey, 'call me?')
    await settle()
    const callId = 'e'.repeat(64)
    await alice.messenger.recordCall(
      bob.pubkey,
      callId,
      'in',
      { media: 'audio', outcome: 'missed' },
      Date.now() + 1000,
    )
    await bob.messenger.recordCall(
      alice.pubkey,
      callId,
      'out',
      { media: 'audio', outcome: 'unanswered' },
      Date.now() + 1000,
    )

    // Opening the conversation reads everything — and the receipt names the
    // message, not the call, whose id Bob would recognise as his own offer.
    await alice.messenger.openConversation(bob.pubkey)
    await settle()
    const bobConvo = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    const [message, record] = await bob.vault.repo.listMessages(bobConvo)
    expect(message).toMatchObject({ body: 'call me?', status: 'read' })
    expect(record).toMatchObject({ id: callId, status: 'sent' })

    // And one naming it outright is ignored.
    inject(network, alice, bob, { v: 1, t: 'receipt', refs: [callId], state: 'read' } as never)
    await settle()
    expect((await bob.vault.repo.getMessage(callId))?.status).toBe('sent')
  })

  it('builds calls from the public STUN defaults, the user’s servers and their relay choice', async () => {
    expect(alice.messenger.callConfig()).toEqual({ iceServers: [...DEFAULT_ICE_SERVERS], relayOnly: false })
    const turn = { urls: 'turn:t.example.org', username: 'u', credential: 'p' }
    await alice.messenger.applySettings({ ...settings, iceServers: [turn], callRelayOnly: true })
    expect(alice.messenger.callConfig()).toEqual({
      iceServers: [...DEFAULT_ICE_SERVERS, turn],
      relayOnly: true,
    })
  })
})

describe('deleting a call from the conversation', () => {
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
    for (const peer of [alice, bob]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  const conversationOf = (peer: Peer, other: Peer) =>
    peer.vault.repo.conversationId(peer.pubkey, other.pubkey)
  const entriesOf = (peer: Peer, other: Peer) => peer.vault.repo.listMessages(conversationOf(peer, other))

  /** Both sides' records of one call, as a call that ran its course leaves them. */
  async function callBetween(
    caller: Peer,
    callee: Peer,
    id: string,
    outcome: 'completed' | 'unanswered' = 'completed',
  ) {
    const done = outcome === 'completed' ? { durationMs: 61_000 } : {}
    await caller.messenger.recordCall(callee.pubkey, id, 'out', { media: 'audio', outcome, ...done })
    await callee.messenger.recordCall(caller.pubkey, id, 'in', {
      media: 'audio',
      outcome: outcome === 'completed' ? 'completed' : 'missed',
      ...done,
    })
  }

  /** An offer from long enough ago that it is recorded rather than rung. */
  function staleOffer(from: Peer, to: Peer) {
    return createRumor(
      {
        kind: KIND_CONTROL,
        content: encodeControlFrame(offer()),
        tags: recipientTags([to.pubkey]),
        created_at: Math.floor((Date.now() - CALL_RING_WINDOW_MS - 60_000) / 1000),
      },
      from.secretKey,
    )
  }

  it('lets the person who was called delete it for both of them', async () => {
    // A call has no author. On the caller's side the record names the caller,
    // and the rule for messages — only what you wrote — would refuse this.
    const id = 'c'.repeat(64)
    await callBetween(alice, bob, id)
    await bob.messenger.redactMessage(alice.pubkey, id)
    await settle(6000)
    expect(await entriesOf(bob, alice)).toEqual([])
    expect(await entriesOf(alice, bob)).toEqual([])
  })

  it('lets the caller delete it for both of them', async () => {
    const id = 'd'.repeat(64)
    await callBetween(alice, bob, id)
    await alice.messenger.redactMessage(bob.pubkey, id)
    await settle(6000)
    expect(await entriesOf(alice, bob)).toEqual([])
    expect(await entriesOf(bob, alice)).toEqual([])
  })

  it('keeps a call deleted for me from coming back when its offer is replayed', async () => {
    const rumor = staleOffer(alice, bob)
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    expect(await entriesOf(bob, alice)).toEqual([expect.objectContaining({ id: rumor.id })])

    await bob.messenger.deleteLocally(rumor.id)
    // A fresh wrap of the same offer — a retry, or another relay's copy.
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    await bob.messenger.recordCall(alice.pubkey, rumor.id, 'in', { media: 'audio', outcome: 'missed' })
    expect(await entriesOf(bob, alice)).toEqual([])
    expect(bob.signals).toEqual([])
  })

  it('never records a call whose withdrawal arrived before its offer', async () => {
    // Bob was offline for the call and for its deletion, and his catch-up read
    // returned the withdrawal first.
    const rumor = staleOffer(alice, bob)
    await alice.messenger.sendRedactForTesting(bob.pubkey, [rumor.id])
    await settle(6000)
    network.publish(giftWrap(rumor, alice.secretKey, bob.pubkey))
    await settle()
    expect(await entriesOf(bob, alice)).toEqual([])
    expect((await bob.vault.repo.getConversation(conversationOf(bob, alice)))?.unread ?? 0).toBe(0)
  })

  it('never records a call the person called deleted before this side wrote it down', async () => {
    const id = 'f'.repeat(64)
    await bob.messenger.recordCall(alice.pubkey, id, 'in', { media: 'audio', outcome: 'declined' })
    await bob.messenger.redactMessage(alice.pubkey, id)
    await settle(6000)
    await alice.messenger.recordCall(bob.pubkey, id, 'out', { media: 'audio', outcome: 'declined' })
    expect(await entriesOf(alice, bob)).toEqual([])
  })

  it('refuses to let someone who was not in the call delete it', async () => {
    const carol = await makePeer(network, 'Carol')
    try {
      const id = 'a'.repeat(64)
      await callBetween(alice, bob, id)
      await carol.messenger.sendRedactForTesting(alice.pubkey, [id])
      await settle(6000)
      expect(await entriesOf(alice, bob)).toEqual([expect.objectContaining({ id })])

      // Nor, by asking first, stop one from being recorded.
      const later = 'b'.repeat(64)
      await carol.messenger.sendRedactForTesting(alice.pubkey, [later])
      await settle(6000)
      await alice.messenger.recordCall(bob.pubkey, later, 'out', { media: 'audio', outcome: 'unanswered' })
      expect(await alice.vault.repo.hasMessage(later)).toBe(true)
    } finally {
      carol.messenger.stop()
      await carol.vault.destroy()
    }
  })

  it('takes a withdrawn missed call off the unread count, and nothing else', async () => {
    const convo = conversationOf(bob, alice)
    const first = '1'.repeat(64)
    const second = '2'.repeat(64)
    await callBetween(alice, bob, first, 'unanswered')
    await callBetween(alice, bob, second, 'unanswered')
    expect((await bob.vault.repo.getConversation(convo))?.unread).toBe(2)

    await alice.messenger.redactMessage(bob.pubkey, second)
    await settle(6000)
    expect((await bob.vault.repo.getConversation(convo))?.unread).toBe(1)

    // Once read, withdrawing the other takes nothing off a count of zero.
    await bob.messenger.openConversation(alice.pubkey)
    await alice.messenger.redactMessage(bob.pubkey, first)
    await settle(6000)
    expect((await bob.vault.repo.getConversation(convo))?.unread).toBe(0)
    expect(await entriesOf(bob, alice)).toEqual([])
  })

  it('does not count a read missed call as unread when a newer one is withdrawn', async () => {
    const convo = conversationOf(bob, alice)
    await callBetween(alice, bob, '3'.repeat(64), 'unanswered')
    await bob.messenger.openConversation(alice.pubkey)
    bob.messenger.setActiveConversation(null)
    await alice.messenger.sendMessage(bob.pubkey, 'call me back')
    await settle()
    expect((await bob.vault.repo.getConversation(convo))?.unread).toBe(1)

    // The call was read before the message arrived; withdrawing it must not
    // take the message's badge with it.
    await alice.messenger.redactMessage(bob.pubkey, '3'.repeat(64))
    await settle(6000)
    expect((await bob.vault.repo.getConversation(convo))?.unread).toBe(1)
  })
})
