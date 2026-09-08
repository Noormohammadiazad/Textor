import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import { KIND_GIFT_WRAP } from '@/core/crypto/giftwrap'
import { KIND_DM_RELAY_LIST } from '@/core/transport/nostrTransport'
import { bytesToHex } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Reactions travel as NIP-25 kind 7 rumors sealed inside the gift wrap. The
 * tests that matter are the ones that would let a reaction escape unsealed, or
 * leave the two sides disagreeing about what is on a message.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string): Promise<Peer> {
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
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(secretKeyHex, identity.publicKey)
  return { pubkey: identity.publicKey, vault, messenger }
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms)

describe('reactions between two people', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  const reactionsOn = (peer: Peer, messageId: string) => peer.vault.repo.listReactionsFor([messageId])

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

  it('carries a reaction to the other side', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'worth reacting to')
    await settle(3000)

    await bob.messenger.react(alice.pubkey, sent.id, '🎉')
    await settle(3000)

    expect((await reactionsOn(bob, sent.id)).map((r) => r.emoji)).toEqual(['🎉'])
    const onAlice = await reactionsOn(alice, sent.id)
    expect(onAlice).toHaveLength(1)
    expect(onAlice[0]?.emoji).toBe('🎉')
    expect(onAlice[0]?.authorPubkey).toBe(bob.pubkey)
  })

  it('never puts an unsealed reaction on a relay', async () => {
    // The whole reason for sealing: a public kind 7 would tell every relay who
    // reacted to what, which is the graph the gift wrap exists to hide.
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'sealed or nothing')
    await settle(3000)
    await bob.messenger.react(alice.pubkey, sent.id, '👍')
    await settle(3000)

    expect(network.events.length).toBeGreaterThan(0)
    // Chat traffic is gift-wrapped; the only other thing published is the
    // public kind 10050 relay list, which is an address, not a message.
    for (const event of network.events) {
      expect([KIND_GIFT_WRAP, KIND_DM_RELAY_LIST]).toContain(event.kind)
    }
    const wire = JSON.stringify(network.events)
    expect(wire).not.toContain('👍')
    expect(wire).not.toContain(sent.id)
  })

  it('takes the reaction back when the same emoji is sent again', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'undo me')
    await settle(3000)

    await bob.messenger.react(alice.pubkey, sent.id, '😀')
    await settle(3000)
    expect(await reactionsOn(alice, sent.id)).toHaveLength(1)

    await bob.messenger.react(alice.pubkey, sent.id, '😀')
    await settle(3000)

    expect(await reactionsOn(bob, sent.id)).toEqual([])
    // And it is gone from the other side too, rather than stuck there.
    expect(await reactionsOn(alice, sent.id)).toEqual([])
  })

  it('replaces rather than stacks when someone changes their mind', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'one each')
    await settle(3000)

    await bob.messenger.react(alice.pubkey, sent.id, '😀')
    await settle(3000)
    await bob.messenger.react(alice.pubkey, sent.id, '🎉')
    await settle(3000)

    expect((await reactionsOn(bob, sent.id)).map((r) => r.emoji)).toEqual(['🎉'])
    expect((await reactionsOn(alice, sent.id)).map((r) => r.emoji)).toEqual(['🎉'])
  })

  it('keeps both sides’ reactions on the same message', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'two reactions')
    await settle(3000)

    await bob.messenger.react(alice.pubkey, sent.id, '👍')
    await alice.messenger.react(bob.pubkey, sent.id, '🎉')
    await settle(3000)

    const onAlice = await reactionsOn(alice, sent.id)
    expect(onAlice).toHaveLength(2)
    expect(new Set(onAlice.map((r) => r.emoji))).toEqual(new Set(['👍', '🎉']))
  })

  it('refuses a body that is not an emoji', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'not a notepad')
    await settle(3000)
    await expect(bob.messenger.react(alice.pubkey, sent.id, 'nice work')).rejects.toThrow('not a reaction')
    expect(await reactionsOn(bob, sent.id)).toEqual([])
  })

  it('keeps a reaction whose message has not arrived yet', async () => {
    // Relays deliver wraps in whatever order they like, and a restored history
    // arrives as a batch. Dropping a reaction because its message is not here
    // yet would lose it for good, so the row is written regardless and becomes
    // visible when the message lands.
    const notHereYet = 'f'.repeat(64)
    const convoId = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    await bob.vault.repo.putReaction({
      id: 'a'.repeat(64),
      messageId: notHereYet,
      convoId,
      authorPubkey: alice.pubkey,
      emoji: '🎉',
      ts: Date.now(),
    })
    expect((await reactionsOn(bob, notHereYet)).map((r) => r.emoji)).toEqual(['🎉'])
  })

  it('drops a message’s reactions when the message goes', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'ordering')
    await settle(3000)
    await bob.messenger.react(alice.pubkey, sent.id, '🎉')
    await settle(3000)
    expect(await reactionsOn(bob, sent.id)).toHaveLength(1)

    await bob.vault.repo.deleteMessage(sent.id)
    expect(await reactionsOn(bob, sent.id)).toEqual([])
  })

  it('drops a conversation’s reactions along with the conversation', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'clean up')
    await settle(3000)
    await bob.messenger.react(alice.pubkey, sent.id, '👍')
    await settle(3000)

    const convoId = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    await bob.vault.repo.deleteConversation(convoId)
    expect(await reactionsOn(bob, sent.id)).toEqual([])
  })
})
