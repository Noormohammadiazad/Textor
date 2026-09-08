import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsignedEvent } from 'nostr-tools/core'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { getPublicKey } from 'nostr-tools/pure'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { DEFAULT_SETTINGS, type AppSettings, type Conversation } from '@/core/models/types'
import { KIND_CHAT, KIND_CONTROL, MAX_GROUP_MEMBERS } from '@/core/models/protocol'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import type { PublishHandle } from '@/core/transport/relayPool'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Small groups, as NIP-17 defines them: a conversation is the set of people a
 * rumor names, and a group message is one rumor sealed and wrapped once per
 * member. These run several real engines against one shared fake relay
 * network, so everything below crosses the actual wire format.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  pool: FakeRelayPool
}

async function makePeer(network: FakeRelayNetwork, name: string, secretKeyHex?: string): Promise<Peer> {
  const identity = secretKeyHex ? null : createIdentity().identity
  const skHex = secretKeyHex ?? bytesToHex((identity as NonNullable<typeof identity>).secretKey)
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
  const pool = new FakeRelayPool(network)
  const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
  await messenger.start(skHex, pubkey)
  return { pubkey, secretKey, vault, messenger, pool }
}

const settle = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

/** Where a peer files the room holding these other people. */
const roomOn = (peer: Peer, others: string[]): string => peer.vault.repo.conversationIdOf(peer.pubkey, others)

/** Hand-deliver a rumor, for playing a client that does something ours never would. */
function inject(network: FakeRelayNetwork, from: Peer, to: Peer, template: Partial<UnsignedEvent>): string {
  const rumor = createRumor(template, from.secretKey)
  network.publish(giftWrap(rumor, from.secretKey, to.pubkey))
  return rumor.id
}

const randomPubkey = (): string => createIdentity().identity.publicKey

describe('small groups', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer
  let dave: Peer
  const extra: Peer[] = []

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    dave = await makePeer(network, 'Dave')
    // Bob knows Alice; Carol does not, so for her the group is a request.
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    await alice.vault.repo.upsertContact(carol.pubkey, { name: 'Carol', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol, dave, ...extra.splice(0)]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  async function startGroup(subject = 'Weekend'): Promise<Conversation> {
    return alice.messenger.createGroup([bob.pubkey, carol.pubkey], subject)
  }

  describe('creating one', () => {
    it('needs at least two other people', async () => {
      await expect(alice.messenger.createGroup([bob.pubkey])).rejects.toThrow('at least two')
      // Naming yourself does not count towards the two.
      await expect(alice.messenger.createGroup([bob.pubkey, alice.pubkey])).rejects.toThrow('at least two')
    })

    it(`holds at most ${MAX_GROUP_MEMBERS} people, including you`, async () => {
      const seven = Array.from({ length: MAX_GROUP_MEMBERS - 1 }, randomPubkey)
      await expect(alice.messenger.createGroup(seven)).resolves.toMatchObject({ kind: 'group' })
      await expect(alice.messenger.createGroup([...seven, randomPubkey()])).rejects.toThrow(
        `at most ${MAX_GROUP_MEMBERS}`,
      )
    })

    it('refuses something that is not a public key', async () => {
      await expect(alice.messenger.createGroup([bob.pubkey, 'npub1nope'])).rejects.toThrow('not a public key')
    })

    it('is addressed by the id of its member set, whatever order they were given in', async () => {
      const one = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'A')
      const two = await alice.messenger.createGroup([carol.pubkey, bob.pubkey], 'B')
      expect(two.id).toBe(one.id)
      expect(one.id).toBe(roomOn(alice, [bob.pubkey, carol.pubkey]))
      expect(one.members).toEqual([bob.pubkey, carol.pubkey].sort())
      expect(one.accepted).toBe(true)
    })
  })

  it('delivers one message to every member, in the same room, under one id', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'who is in for Saturday?')
    await settle()

    const onBob = await bob.vault.repo.getMessage(sent.id)
    const onCarol = await carol.vault.repo.getMessage(sent.id)
    expect(onBob?.body).toBe('who is in for Saturday?')
    expect(onCarol?.body).toBe('who is in for Saturday?')
    expect(onBob?.authorPubkey).toBe(alice.pubkey)

    // Each member files it under the set of *other* people, which differs per
    // member but names the same room.
    const bobRoom = await bob.vault.repo.getConversation(roomOn(bob, [alice.pubkey, carol.pubkey]))
    expect(bobRoom).toMatchObject({ kind: 'group', subject: 'Weekend', peerPubkey: '' })
    expect(bobRoom?.members).toEqual([alice.pubkey, carol.pubkey].sort())
    expect(onBob?.convoId).toBe(bobRoom?.id)
  })

  it('treats a group from someone you know as taken, and one from a stranger as a request', async () => {
    const group = await startGroup()
    await alice.messenger.sendMessage(group.id, 'hello both')
    await settle()

    const bobRoom = await bob.vault.repo.getConversation(roomOn(bob, [alice.pubkey, carol.pubkey]))
    const carolRoom = await carol.vault.repo.getConversation(roomOn(carol, [alice.pubkey, bob.pubkey]))
    expect(bobRoom?.accepted).toBe(true)
    expect(carolRoom?.accepted).toBe(false)
    // Strangers in a group are not added to the address book.
    expect(await carol.vault.repo.getContact(alice.pubkey)).toBeNull()
  })

  it('tracks delivery and reading per member, and shows the least advanced', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'read me')
    expect(sent.receipts).toEqual({ [bob.pubkey]: 'queued', [carol.pubkey]: 'queued' })
    await settle()

    let mine = await alice.vault.repo.getMessage(sent.id)
    expect(mine?.receipts).toEqual({ [bob.pubkey]: 'delivered', [carol.pubkey]: 'delivered' })
    expect(mine?.status).toBe('delivered')

    await bob.messenger.openConversation(roomOn(bob, [alice.pubkey, carol.pubkey]))
    await settle()
    mine = await alice.vault.repo.getMessage(sent.id)
    expect(mine?.receipts?.[bob.pubkey]).toBe('read')
    expect(mine?.status).toBe('delivered')

    await carol.messenger.openConversation(roomOn(carol, [alice.pubkey, bob.pubkey]))
    await settle()
    mine = await alice.vault.repo.getMessage(sent.id)
    expect(mine?.status).toBe('read')
  })

  it('sends a read receipt to each author when a group is opened', async () => {
    const group = await startGroup()
    const fromAlice = await alice.messenger.sendMessage(group.id, 'from alice')
    await settle()
    const fromCarol = await carol.messenger.sendMessage(
      roomOn(carol, [alice.pubkey, bob.pubkey]),
      'from carol',
    )
    await settle()

    await bob.messenger.openConversation(roomOn(bob, [alice.pubkey, carol.pubkey]))
    await settle()

    expect((await alice.vault.repo.getMessage(fromAlice.id))?.receipts?.[bob.pubkey]).toBe('read')
    expect((await carol.vault.repo.getMessage(fromCarol.id))?.receipts?.[bob.pubkey]).toBe('read')
  })

  it('marks every earlier message read for a member from one receipt', async () => {
    const group = await startGroup()
    const older = await alice.messenger.sendMessage(group.id, 'older')
    const newer = await alice.messenger.sendMessage(group.id, 'newer')
    await settle()

    // One read receipt, naming only the newest message.
    inject(network, bob, alice, {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'receipt', refs: [newer.id], state: 'read' }),
      tags: [['p', alice.pubkey]],
    })
    await settle()

    for (const id of [older.id, newer.id]) {
      const mine = await alice.vault.repo.getMessage(id)
      expect(mine?.receipts?.[bob.pubkey]).toBe('read')
      expect(mine?.receipts?.[carol.pubkey]).toBe('delivered')
    }
  })

  it('counts a group message as unread only when the group is not on screen', async () => {
    const group = await startGroup()
    const bobRoom = roomOn(bob, [alice.pubkey, carol.pubkey])
    await alice.messenger.sendMessage(group.id, 'while you were away')
    await settle()
    expect((await bob.vault.repo.getConversation(bobRoom))?.unread).toBe(1)

    await bob.messenger.openConversation(bobRoom)
    expect((await bob.vault.repo.getConversation(bobRoom))?.unread).toBe(0)
    await alice.messenger.sendMessage(group.id, 'while you are reading')
    await settle()
    expect((await bob.vault.repo.getConversation(bobRoom))?.unread).toBe(0)

    bob.messenger.setActiveConversation(null)
    await alice.messenger.sendMessage(group.id, 'after you left')
    await settle()
    expect((await bob.vault.repo.getConversation(bobRoom))?.unread).toBe(1)
  })

  it('carries replies from any member to everyone else', async () => {
    const group = await startGroup()
    const first = await alice.messenger.sendMessage(group.id, 'first')
    await settle()

    const bobRoom = roomOn(bob, [alice.pubkey, carol.pubkey])
    const reply = await bob.messenger.sendMessage(bobRoom, 'count me in', first.id)
    await settle()

    const onAlice = await alice.vault.repo.getMessage(reply.id)
    const onCarol = await carol.vault.repo.getMessage(reply.id)
    expect(onAlice?.convoId).toBe(group.id)
    expect(onAlice?.replyTo).toBe(first.id)
    expect(onCarol?.convoId).toBe(roomOn(carol, [alice.pubkey, bob.pubkey]))
  })

  it('retries only the members whose copy never reached a relay', async () => {
    const group = await startGroup()
    const original = alice.pool.dispatch.bind(alice.pool)
    let refuseCarol = true
    const toBob: string[] = []
    alice.pool.dispatch = (event, relays): PublishHandle => {
      const to = event.tags.find((tag) => tag[0] === 'p')?.[1]
      if (to === bob.pubkey) toBob.push(event.id)
      if (refuseCarol && to === carol.pubkey) {
        const refused = Promise.resolve(relays.map((url) => ({ url, ok: false as const, error: 'refused' })))
        return { quorum: refused, settled: refused }
      }
      return original(event, relays)
    }

    const sent = await alice.messenger.sendMessage(group.id, 'some of you will get this')
    await settle()

    expect(await bob.vault.repo.getMessage(sent.id)).not.toBeNull()
    expect(await carol.vault.repo.getMessage(sent.id)).toBeNull()
    let mine = await alice.vault.repo.getMessage(sent.id)
    expect(mine?.receipts?.[bob.pubkey]).toBe('delivered')
    expect(mine?.receipts?.[carol.pubkey]).toBe('queued')
    expect(mine?.status).toBe('queued')
    const queued = await alice.vault.repo.getOutboxItem(sent.id)
    expect(queued?.recipients).toEqual([carol.pubkey])

    refuseCarol = false
    const bobWrapsBefore = toBob.length
    alice.messenger.wake('online')
    await settle()

    expect(await carol.vault.repo.getMessage(sent.id)).not.toBeNull()
    // Bob's copy is not sent again because Carol's needed retrying.
    expect(toBob.length).toBe(bobWrapsBefore)
    mine = await alice.vault.repo.getMessage(sent.id)
    expect(mine?.status).toBe('delivered')
    expect(await alice.vault.repo.getOutboxItem(sent.id)).toBeNull()
  })

  it(`refuses a room larger than ${MAX_GROUP_MEMBERS} people on arrival`, async () => {
    const strangers = (n: number) => Array.from({ length: n }, randomPubkey)
    const tooMany = inject(network, dave, bob, {
      kind: KIND_CHAT,
      content: 'a crowd',
      tags: [['p', bob.pubkey], ...strangers(MAX_GROUP_MEMBERS - 1).map((pk) => ['p', pk])],
    })
    const justRight = inject(network, dave, bob, {
      kind: KIND_CHAT,
      content: 'a small crowd',
      tags: [['p', bob.pubkey], ...strangers(MAX_GROUP_MEMBERS - 2).map((pk) => ['p', pk])],
    })
    await settle()

    expect(await bob.vault.repo.getMessage(tooMany)).toBeNull()
    expect(await bob.vault.repo.getMessage(justRight)).not.toBeNull()
  })

  it('ignores a rumor that names other people but not us', async () => {
    const id = inject(network, dave, bob, {
      kind: KIND_CHAT,
      content: 'not for you',
      tags: [
        ['p', alice.pubkey],
        ['p', carol.pubkey],
      ],
    })
    await settle()
    expect(await bob.vault.repo.getMessage(id)).toBeNull()
  })

  it('keeps an outsider who names the same people out of the group', async () => {
    const group = await startGroup()
    await alice.messenger.sendMessage(group.id, 'just us three')
    await settle()

    // Dave addresses Bob, Alice and Carol: that is a room of four, not theirs.
    const id = inject(network, dave, bob, {
      kind: KIND_CHAT,
      content: 'let me in',
      tags: [
        ['p', bob.pubkey],
        ['p', alice.pubkey],
        ['p', carol.pubkey],
      ],
    })
    await settle()

    const landed = await bob.vault.repo.getMessage(id)
    expect(landed?.convoId).toBe(roomOn(bob, [alice.pubkey, carol.pubkey, dave.pubkey]))
    expect(landed?.convoId).not.toBe(roomOn(bob, [alice.pubkey, carol.pubkey]))
  })

  it('ignores receipts from anyone the message was not sent to', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'receipts only from members')
    await settle()
    const before = await alice.vault.repo.getMessage(sent.id)

    inject(network, dave, alice, {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'receipt', refs: [sent.id], state: 'read' }),
      tags: [['p', alice.pubkey]],
    })
    await settle()

    const after = await alice.vault.repo.getMessage(sent.id)
    expect(after?.receipts).toEqual(before?.receipts)
    expect(after?.receipts?.[dave.pubkey]).toBeUndefined()
    expect(after?.status).toBe(before?.status)
  })

  it('ignores a spoofed receipt on a direct message too', async () => {
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'just for bob')
    await settle()
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('delivered')

    inject(network, dave, alice, {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'receipt', refs: [sent.id], state: 'read' }),
      tags: [['p', alice.pubkey]],
    })
    await settle()
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('delivered')
  })

  it('acts on nothing but withdrawal when plumbing is addressed to a whole group', async () => {
    const group = await startGroup()
    await alice.messenger.sendMessage(group.id, 'hello')
    await settle()

    // A profile is only ever exchanged person to person. Sent to the room, it
    // would add everyone in a stranger's group to the address book.
    inject(network, carol, bob, {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'profile', name: 'Carol' }),
      tags: [
        ['p', alice.pubkey],
        ['p', bob.pubkey],
      ],
    })
    await settle()
    expect(await bob.vault.repo.getContact(carol.pubkey)).toBeNull()
  })

  it('drops messages from a member you blocked, and keeps the group', async () => {
    const group = await startGroup()
    await alice.messenger.sendMessage(group.id, 'hello')
    await settle()
    await bob.vault.repo.upsertContact(carol.pubkey, { blocked: true })

    const carolRoom = roomOn(carol, [alice.pubkey, bob.pubkey])
    const fromCarol = await carol.messenger.sendMessage(carolRoom, 'from carol')
    const fromAlice = await alice.messenger.sendMessage(group.id, 'from alice')
    await settle()

    expect(await bob.vault.repo.getMessage(fromCarol.id)).toBeNull()
    expect(await bob.vault.repo.getMessage(fromAlice.id)).not.toBeNull()
    expect(await alice.vault.repo.getMessage(fromCarol.id)).not.toBeNull()
  })

  it('carries a reaction to every member', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'react to this')
    await settle()

    await bob.messenger.react(roomOn(bob, [alice.pubkey, carol.pubkey]), sent.id, '🎉')
    await settle()

    for (const peer of [alice, carol]) {
      const reactions = await peer.vault.repo.listReactionsFor([sent.id])
      expect(reactions.map((reaction) => [reaction.emoji, reaction.authorPubkey])).toEqual([
        ['🎉', bob.pubkey],
      ])
    }
    const onCarol = await carol.vault.repo.listReactionsFor([sent.id])
    expect(onCarol[0]?.convoId).toBe(roomOn(carol, [alice.pubkey, bob.pubkey]))
  })

  it('withdraws a message from every member', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'oops')
    await settle()
    expect(await carol.vault.repo.getMessage(sent.id)).not.toBeNull()

    await alice.messenger.redactMessage(group.id, sent.id)
    await settle()
    expect(await bob.vault.repo.getMessage(sent.id)).toBeNull()
    expect(await carol.vault.repo.getMessage(sent.id)).toBeNull()
  })

  it('does not let a member withdraw what someone else wrote', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'mine, not yours')
    await settle()

    inject(network, carol, bob, {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'redact', refs: [sent.id] }),
      tags: [
        ['p', alice.pubkey],
        ['p', bob.pubkey],
      ],
    })
    await settle()
    expect(await bob.vault.repo.getMessage(sent.id)).not.toBeNull()
  })

  it('adopts a newer group name and ignores an older one', async () => {
    const group = await startGroup('First name')
    await alice.messenger.sendMessage(group.id, 'hi')
    await settle()
    const bobRoom = roomOn(bob, [alice.pubkey, carol.pubkey])
    expect((await bob.vault.repo.getConversation(bobRoom))?.subject).toBe('First name')

    const now = Math.floor(Date.now() / 1000)
    const members = [
      ['p', bob.pubkey],
      ['p', alice.pubkey],
    ] as string[][]
    inject(network, carol, bob, {
      kind: KIND_CHAT,
      content: 'renaming',
      created_at: now + 5,
      tags: [...members, ['subject', 'Newer name'], ['ms', String((now + 5) * 1000)]],
    })
    await settle()
    expect((await bob.vault.repo.getConversation(bobRoom))?.subject).toBe('Newer name')

    inject(network, carol, bob, {
      kind: KIND_CHAT,
      content: 'late arrival',
      created_at: now - 3600,
      tags: [...members, ['subject', 'Stale name'], ['ms', String((now - 3600) * 1000)]],
    })
    await settle()
    expect((await bob.vault.repo.getConversation(bobRoom))?.subject).toBe('Newer name')
  })

  it("shows a group message sent from one device on the sender's other device", async () => {
    const secondDevice = await makePeer(network, 'Alice-2', bytesToHex(alice.secretKey))
    extra.push(secondDevice)
    const group = await startGroup('Trip')
    const sent = await alice.messenger.sendMessage(group.id, 'from my phone')
    await settle()

    const copy = await secondDevice.vault.repo.getMessage(sent.id)
    expect(copy?.direction).toBe('out')
    expect(copy?.convoId).toBe(roomOn(secondDevice, [bob.pubkey, carol.pubkey]))
    expect(copy?.subject).toBe('Trip')
    // Receipts are addressed to the key, so the second device tracks them too.
    expect(copy?.receipts).toEqual({ [bob.pubkey]: 'delivered', [carol.pubkey]: 'delivered' })
    const room = await secondDevice.vault.repo.getConversation(copy?.convoId ?? '')
    expect(room).toMatchObject({ kind: 'group', accepted: true, subject: 'Trip' })
  })

  it('refuses an attachment too large for the relays, since a group has no direct channel', async () => {
    const group = await startGroup()
    await expect(
      alice.messenger.sendAttachment(group.id, {
        bytes: new Uint8Array(600 * 1024),
        kind: 'file',
        mime: 'application/octet-stream',
        caption: 'big',
      }),
    ).rejects.toThrow('too large to send to a group')
  })

  it('delivers an attachment to every member', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendAttachment(group.id, {
      bytes: new Uint8Array([9, 8, 7, 6, 5]),
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'File · a.bin',
      name: 'a.bin',
    })
    await settle(6000)
    for (const peer of [bob, carol]) {
      const arrived = await peer.vault.repo.getMessage(sent.id)
      expect(arrived?.attachment?.name).toBe('a.bin')
      expect(Array.from((await peer.messenger.readAttachment(arrived!.attachment!)) ?? [])).toEqual([
        9, 8, 7, 6, 5,
      ])
    }
  })

  it('does nothing when asked to retry a group message everyone already has', async () => {
    const group = await startGroup()
    const sent = await alice.messenger.sendMessage(group.id, 'already there')
    await settle()
    await alice.messenger.retryMessage(sent.id)
    expect(await alice.vault.repo.getOutboxItem(sent.id)).toBeNull()
  })

  it('cannot start a group while stopped', async () => {
    alice.messenger.stop()
    await expect(alice.messenger.createGroup([bob.pubkey, carol.pubkey])).rejects.toThrow('not running')
  })

  it('sends a typing indicator to nobody in a group', async () => {
    const group = await startGroup()
    const before = network.publishCount
    alice.messenger.setTyping(group.id, true)
    await settle()
    expect(network.publishCount).toBe(before)
  })

  it('refuses to send to a group that does not exist', async () => {
    await expect(alice.messenger.sendMessage('0'.repeat(32), 'hello?')).rejects.toThrow('no such group')
  })
})
