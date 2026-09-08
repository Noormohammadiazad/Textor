import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { MAX_RENEWALS, renewUndelivered, type RenewalHost } from '@/core/engine/deviceSync'
import { createRumor, giftWrap, RENEWAL_SPACING_SEC, unwrapGift, type Rumor } from '@/core/crypto/giftwrap'
import { recipientTags } from '@/core/models/protocol'
import { DEFAULT_SETTINGS, type AppSettings, type Conversation, type Message } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Sending again what nobody has confirmed, before relays drop it (ADR-076). Sent
 * only to someone whose client has confirmed things before, only near the end,
 * only so many times, and never seen twice.
 */

const DAY = 86_400_000
const THIRTY_DAYS_SEC = 30 * 86_400
const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

describe('a wrap sent again', () => {
  const alice = hexToBytes('11'.repeat(32))
  const bob = hexToBytes('22'.repeat(32))
  const bobPk = getPublicKey(bob)
  const rumor = (): Rumor =>
    createRumor({ kind: 14, content: 'are you there', tags: recipientTags([bobPk]) }, alice)

  it('counts from later, is a new event, and from the same signer, so it can be deleted with the rest', () => {
    const message = rumor()
    const first = giftWrap(message, alice, bobPk, { expirationSec: THIRTY_DAYS_SEC })
    const again = giftWrap(message, alice, bobPk, { expirationSec: THIRTY_DAYS_SEC, generation: 1 })
    expect(again.id).not.toBe(first.id)
    expect(again.pubkey).toBe(first.pubkey)
    expect(again.created_at - first.created_at).toBe(RENEWAL_SPACING_SEC)
    expect(Number(again.tags.find((tag) => tag[0] === 'expiration')?.[1])).toBe(
      message.created_at + RENEWAL_SPACING_SEC + THIRTY_DAYS_SEC,
    )
    expect(unwrapGift(again, bob).id).toBe(message.id)
  })

  it('comes out the same from any device', () => {
    const message = rumor()
    const form = { expirationSec: THIRTY_DAYS_SEC, generation: 1 }
    expect(giftWrap(message, alice, bobPk, form).id).toBe(giftWrap(message, alice, bobPk, form).id)
  })
})

describe('deciding what to send again', () => {
  let vault: TestVault
  const alice = createIdentity().identity
  const person = () => getPublicKey(createIdentity().identity.secretKey)
  const bob = person()
  const carol = person()
  const NOW = 1_790_000_000_000

  const conversationWith = async (people: string[]): Promise<Conversation> =>
    people.length === 1
      ? vault.repo.ensureConversation(alice.publicKey, people[0]!)
      : vault.repo.ensureGroupConversation(alice.publicKey, people, { subject: '', accepted: true })

  const stored = async (
    conversation: Conversation,
    ageDays: number,
    patch: Partial<Message> = {},
    status: Message['status'] = 'sent',
  ): Promise<Message> => {
    const ts = NOW - ageDays * DAY
    const rumor = createRumor(
      {
        kind: 14,
        content: `from ${ageDays} days ago, ${Math.random()}`,
        tags: recipientTags(conversation.members),
        created_at: Math.floor(ts / 1000),
      },
      alice.secretKey,
    )
    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: 'out',
      status,
      ts,
      order: ts,
      tsCoarse: 0,
      body: rumor.content,
      authorPubkey: alice.publicKey,
      via: 'relay',
      ...patch,
    }
    await vault.repo.putMessage(message)
    rumors.set(message.id, rumor)
    return message
  }

  const rumors = new Map<string, Rumor>()
  const host = (over: Partial<RenewalHost> = {}): RenewalHost => ({
    self: alice.publicKey,
    secretKey: alice.secretKey,
    repo: vault.repo,
    caps: { [bob]: 2, [carol]: 1 },
    ttlSec: THIRTY_DAYS_SEC,
    rumorOf: (message) => rumors.get(message.id) ?? null,
    relaysFor: async () => ['wss://theirs.example'],
    queue: { prefix: 'rt-', convoId: 'self' },
    now: () => NOW,
    ...over,
  })
  const queued = async () => {
    const ids = await vault.repo.dueOutboxIds(Number.MAX_SAFE_INTEGER)
    return Promise.all(ids.map((id) => vault.repo.getOutboxItem(id)))
  }

  beforeEach(async () => {
    vault = await makeVault('renewal')
    rumors.clear()
  })
  afterEach(async () => {
    await vault.destroy()
  })

  it('leaves what is young, and sends what is nearing its end to where they read', async () => {
    const conversation = await conversationWith([bob])
    await stored(conversation, 24)
    const due = await stored(conversation, 26)
    expect(await renewUndelivered(host())).toBe(1)
    const [item] = await queued()
    expect(item?.relays).toEqual(['wss://theirs.example'])
    const event = JSON.parse(item!.rumorJson) as { kind: number; tags: string[][] }
    expect(event.kind).toBe(1059)
    expect(event.tags[0]).toEqual(['p', bob])
    expect((await vault.repo.getMessage(due.id))?.renewed).toBe(1)
  })

  it('sends it once per round, twice in all, and then lets it go', async () => {
    const conversation = await conversationWith([bob])
    const message = await stored(conversation, 26)
    expect(await renewUndelivered(host())).toBe(1)
    expect(await renewUndelivered(host())).toBe(0)
    expect(await renewUndelivered(host({ now: () => NOW + 25 * DAY }))).toBe(1)
    expect((await vault.repo.getMessage(message.id))?.renewed).toBe(MAX_RENEWALS)
    expect(await renewUndelivered(host({ now: () => NOW + 50 * DAY }))).toBe(0)
  })

  it('does not send what someone has confirmed', async () => {
    const conversation = await conversationWith([bob])
    await stored(conversation, 26, {}, 'delivered')
    await stored(conversation, 26, {}, 'read')
    expect(await renewUndelivered(host())).toBe(0)
  })

  it('does not send to someone who has never confirmed anything', async () => {
    const conversation = await conversationWith([person()])
    await stored(conversation, 26)
    expect(await renewUndelivered(host())).toBe(0)
  })

  it('in a group, sends only to who has not confirmed and can', async () => {
    const dave = person()
    const conversation = await conversationWith([bob, carol, dave])
    await stored(conversation, 26, { receipts: { [bob]: 'delivered', [carol]: 'sent', [dave]: 'sent' } })
    expect(await renewUndelivered(host())).toBe(1)
    const [item] = await queued()
    expect((JSON.parse(item!.rumorJson) as { tags: string[][] }).tags[0]).toEqual(['p', carol])
  })

  it('does not send a call, or into a conversation gone or forward-secret', async () => {
    const conversation = await conversationWith([bob])
    await stored(conversation, 26, { call: { media: 'audio', outcome: 'missed' } })
    await stored({ ...conversation, id: 'gone' }, 26)
    const secure = await conversationWith([carol])
    await vault.repo.updateConversation(secure.id, { mls: { nostrGroupId: 'x' } as never })
    await stored(secure, 26)
    expect(await renewUndelivered(host())).toBe(0)
  })

  it('does not send what it cannot rebuild exactly', async () => {
    const conversation = await conversationWith([bob])
    await stored(conversation, 26)
    expect(await renewUndelivered(host({ rumorOf: () => null }))).toBe(0)
  })

  it('takes a backlog a little at a time', async () => {
    const conversation = await conversationWith([bob])
    for (let i = 0; i < 23; i++) await stored(conversation, 26)
    expect(await renewUndelivered(host())).toBe(20)
    expect(await renewUndelivered(host())).toBe(3)
  })

  it('goes by this device’s clock if none is given', async () => {
    const conversation = await conversationWith([bob])
    await stored(conversation, 26)
    const { now: _now, ...rest } = host()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    expect(await renewUndelivered(rest)).toBe(1)
    vi.useRealTimers()
  })
})

describe('between real engines', () => {
  let network: FakeRelayNetwork
  const peers: { vault: TestVault; messenger: Messenger }[] = []

  const makePeer = async (name: string, over: Partial<AppSettings> = {}) => {
    const skHex = bytesToHex(createIdentity().identity.secretKey)
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
    const messenger = new Messenger(
      vault.vault,
      vault.repo,
      { ...settings, ...over },
      new FakeRelayPool(network),
    )
    await messenger.start(skHex, pubkey)
    const peer = { name, pubkey, secretKey, skHex, vault, messenger }
    peers.push(peer)
    return peer
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
  })
  afterEach(async () => {
    for (const peer of peers.splice(0)) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('reaches someone back after five weeks, once, past the point it would have expired', async () => {
    const alice = await makePeer('Alice')
    const bob = await makePeer('Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
    await alice.messenger.sendMessage(bob.pubkey, 'first')
    await vi.advanceTimersByTimeAsync(4000)

    // Bob goes away with what he has.
    bob.messenger.stop()
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'are you there')
    await vi.advanceTimersByTimeAsync(4000)
    const wrapsToBob = () =>
      network.events.filter((event) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === bob.pubkey))
    const before = wrapsToBob().length

    vi.setSystemTime(Date.now() + 26 * DAY)
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000)
    expect(wrapsToBob().length).toBe(before + 1)
    const renewed = wrapsToBob().at(-1)!
    expect(Number(renewed.tags.find((tag) => tag[0] === 'expiration')?.[1])).toBeGreaterThan(
      sent.ts / 1000 + 50 * 86_400,
    )

    // What relays would have dropped by the time he is back.
    const first = wrapsToBob().filter((event) => {
      try {
        return (
          unwrapGift(event, bob.secretKey).id === sent.id &&
          Number(event.tags.find((tag) => tag[0] === 'expiration')?.[1]) < sent.ts / 1000 + 31 * 86_400
        )
      } catch {
        return false
      }
    })
    expect(first).toHaveLength(1)
    network.events.splice(network.events.indexOf(first[0]!), 1)

    vi.setSystemTime(Date.now() + 9 * DAY)
    const again = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
    bob.messenger = again
    await again.start(bob.skHex, bob.pubkey)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await bob.vault.repo.getMessage(sent.id)).toBeTruthy()
  })

  it('leaves alone someone who chose a short life for their messages', async () => {
    const alice = await makePeer('Alice', { messageExpirationDays: 7 })
    const bob = await makePeer('Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
    await alice.messenger.sendMessage(bob.pubkey, 'first')
    await vi.advanceTimersByTimeAsync(4000)
    bob.messenger.stop()
    await alice.messenger.sendMessage(bob.pubkey, 'short lived')
    await vi.advanceTimersByTimeAsync(4000)
    const count = network.events.length
    vi.setSystemTime(Date.now() + 26 * DAY)
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000)
    // (Its own weekly hello goes on: that is to itself.)
    const toBob = (event: (typeof network.events)[number]) => event.tags.some((tag) => tag[1] === bob.pubkey)
    expect(network.events.slice(count).filter(toBob)).toEqual([])
  })

  it('does not try while it has no relay to reach', async () => {
    const alice = await makePeer('Alice')
    const bob = await makePeer('Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { accepted: true })
    await alice.messenger.sendMessage(bob.pubkey, 'first')
    await vi.advanceTimersByTimeAsync(4000)
    bob.messenger.stop()
    const sent = await alice.messenger.sendMessage(bob.pubkey, 'while offline')
    await vi.advanceTimersByTimeAsync(4000)
    network.offline = true
    vi.setSystemTime(Date.now() + 26 * DAY)
    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000)
    expect((await alice.vault.repo.getMessage(sent.id))?.renewed).toBeUndefined()
  })
})
