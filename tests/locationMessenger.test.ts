import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsignedEvent } from 'nostr-tools/core'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { createRumor, giftWrap, unwrapGift } from '@/core/crypto/giftwrap'
import { DEFAULT_SETTINGS, type AppSettings, type Message } from '@/core/models/types'
import {
  KIND_CHAT,
  KIND_CONTROL,
  PROTOCOL_VERSION,
  parseControlFrame,
  recipientTags,
  timestampTag,
  type LiveFrame,
} from '@/core/models/protocol'
import { locationTags } from '@/core/models/location'
import { liveStatus } from '@/core/location/status'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Location sharing across real engines on one fake relay network (ADR-064):
 * a place and a live share sent, moved, and ended, as every member sees them —
 * and the ways a peer or a relay can get it wrong.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const HOME = { lat: 35.6892, lon: 51.389 }
const MINUTE = 60_000

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
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(skHex, pubkey)
  return { pubkey, secretKey, vault, messenger }
}

const settle = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

/** Hand-deliver a rumor, playing a client that does something ours never would. */
function inject(network: FakeRelayNetwork, from: Peer, to: Peer, template: Partial<UnsignedEvent>): string {
  const rumor = createRumor(template, from.secretKey)
  network.publish(giftWrap(rumor, from.secretKey, to.pubkey))
  return rumor.id
}

const loc = (ref: string, seq: number, extra: Partial<LiveFrame> = {}): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, t: 'loc', ref, seq, ...extra })

describe('sharing a location', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer
  const extra: Peer[] = []

  const seen = (peer: Peer, id: string): Promise<Message | null> => peer.vault.repo.getMessage(id)

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    for (const [a, b] of [
      [alice, bob],
      [bob, alice],
      [alice, carol],
      [carol, alice],
      [bob, carol],
      [carol, bob],
    ] as const) {
      await a.vault.repo.upsertContact(b.pubkey, { name: 'x', source: 'invite', accepted: true })
    }
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol, ...extra.splice(0)]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('sends a place as a message, named, with a geo: URI for other clients', async () => {
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, acc: 12, place: 'Café Naderi' })
    await settle()

    const received = await seen(bob, sent.id)
    expect(received).toMatchObject({
      direction: 'in',
      body: '📍 Café Naderi\ngeo:35.6892,51.389;u=12',
      location: { ...HOME, acc: 12, place: 'Café Naderi' },
    })
    expect(received?.live).toBeUndefined()
    await expect(alice.messenger.sendLocation(bob.pubkey, { lat: 91, lon: 0 })).rejects.toThrow(
      'not a valid location',
    )
  })

  it('never lets a single coordinate, heading or accuracy reach a relay unsealed', async () => {
    const before = network.events.length
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, acc: 7, live: 900 })
    await alice.messenger.moveLiveLocation(sent.id, {
      lat: 35.70123,
      lon: 51.40456,
      acc: 9,
      hdg: 123,
      spd: 4.2,
    })
    await alice.messenger.moveLiveLocation(sent.id, null)
    await settle()
    const published = network.events.slice(before)
    // The share, its self-copy, the update, the end and its self-copy — and
    // Bob's delivery receipt: every one a gift wrap.
    expect(published.length).toBeGreaterThanOrEqual(5)
    expect(published.every((event) => event.kind === 1059)).toBe(true)
    const onTheWire = JSON.stringify(network.events)
    for (const needle of [
      '35.6892',
      '51.389',
      '35.70123',
      '51.40456',
      '"hdg"',
      '"acc"',
      'location',
      'geo:',
    ]) {
      expect(onTheWire).not.toContain(needle)
    }
  })

  it('moves a live location on for the person it was shared with, and ends it', async () => {
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, acc: 20, live: 15 * 60 })
    expect(sent.live).toMatchObject({ ...HOME, acc: 20, seq: 0, lag: 0 })
    expect(sent.body).toBe('📡 geo:35.6892,51.389;u=20')
    await settle()
    expect((await seen(bob, sent.id))?.live).toMatchObject({ ...HOME, seq: 0 })

    const moved = await alice.messenger.moveLiveLocation(sent.id, {
      lat: 35.7,
      lon: 51.4,
      hdg: 90.4,
      spd: 1.44,
    })
    expect(moved?.live).toMatchObject({ lat: 35.7, lon: 51.4, hdg: 90, spd: 1.4, seq: 1 })
    await settle()
    const there = await seen(bob, sent.id)
    expect(there?.live).toMatchObject({
      lat: 35.7,
      lon: 51.4,
      hdg: 90,
      spd: 1.4,
      seq: 1,
      trail: [[HOME.lat, HOME.lon]],
    })
    expect(there?.live?.acc).toBeUndefined()
    expect(liveStatus(there as Message, Date.now())?.active).toBe(true)

    const ended = await alice.messenger.moveLiveLocation(sent.id, null)
    expect(ended?.live?.end).toBeDefined()
    await settle()
    const over = await seen(bob, sent.id)
    expect(over?.live?.end).toBeDefined()
    expect(liveStatus(over as Message, Date.now())?.active).toBe(false)

    // Over is over, and nobody moves what is not theirs.
    expect(await alice.messenger.moveLiveLocation(sent.id, HOME)).toBeNull()
    expect(await bob.messenger.moveLiveLocation(sent.id, HOME)).toBeNull()
    expect(await alice.messenger.moveLiveLocation('f'.repeat(64), HOME)).toBeNull()
    await expect(alice.messenger.moveLiveLocation(sent.id, { lat: 0, lon: 500 })).rejects.toThrow(
      'not a valid position',
    )
  })

  it('shares live with everyone in a group, and moves it for all of them', async () => {
    const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'Trip')
    const sent = await alice.messenger.sendLocation(group.id, { ...HOME, live: 0 })
    await settle()
    await alice.messenger.moveLiveLocation(sent.id, { lat: 36, lon: 52 })
    await settle()
    for (const peer of [bob, carol]) {
      expect((await seen(peer, sent.id))?.live).toMatchObject({ lat: 36, lon: 52, seq: 1 })
    }
    // A member cannot move someone else's share, even from inside the group.
    const convo = carol.vault.repo.conversationIdOf(carol.pubkey, [alice.pubkey, bob.pubkey])
    expect((await carol.vault.repo.getMessage(sent.id))?.convoId).toBe(convo)
    inject(network, bob, carol, {
      kind: KIND_CONTROL,
      content: loc(sent.id, 9, { lat: 0, lon: 0 }),
      tags: recipientTags([alice.pubkey, carol.pubkey]),
    })
    await settle()
    expect((await seen(carol, sent.id))?.live).toMatchObject({ lat: 36, lon: 52, seq: 1 })
  })

  it('refuses an update sealed to another room, even from the person sharing', async () => {
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, live: 900 })
    await settle()
    // Alice, but addressed to Bob and Carol together: a different conversation.
    inject(network, alice, bob, {
      kind: KIND_CONTROL,
      content: loc(sent.id, 5, { lat: 1, lon: 1 }),
      tags: recipientTags([bob.pubkey, carol.pubkey]),
    })
    await settle()
    expect((await seen(bob, sent.id))?.live?.seq).toBe(0)
  })

  it('shows an update that overtook its share, and an end that did, when the share arrives', async () => {
    const start = (live: number) =>
      createRumor(
        {
          kind: KIND_CHAT,
          content: 'live',
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ...recipientTags([bob.pubkey]),
            timestampTag(Date.now()),
            ...locationTags({ ...HOME, live }),
          ],
        },
        alice.secretKey,
      )
    const frameFor = (ref: string, seq: number, extra: Partial<LiveFrame>) =>
      createRumor(
        { kind: KIND_CONTROL, content: loc(ref, seq, extra), tags: recipientTags([bob.pubkey]) },
        alice.secretKey,
      )

    // An update, then an older one, then the share itself.
    const moving = start(900)
    network.publish(giftWrap(frameFor(moving.id, 2, { lat: 2, lon: 2 }), alice.secretKey, bob.pubkey))
    network.publish(giftWrap(frameFor(moving.id, 1, { lat: 1, lon: 1 }), alice.secretKey, bob.pubkey))
    await settle()
    network.publish(giftWrap(moving, alice.secretKey, bob.pubkey))
    await settle()
    expect((await seen(bob, moving.id))?.live).toMatchObject({ lat: 2, lon: 2, seq: 2 })

    // A share "until turned off" whose end came first is over when it lands.
    const open = start(0)
    network.publish(giftWrap(frameFor(open.id, 7, { end: true }), alice.secretKey, bob.pubkey))
    await settle()
    network.publish(giftWrap(open, alice.secretKey, bob.pubkey))
    await settle()
    const over = await seen(bob, open.id)
    expect(over?.live?.end).toBeDefined()
    expect(liveStatus(over as Message, Date.now())?.active).toBe(false)

    // An early update from someone else is not held against the share.
    const third = start(900)
    inject(network, carol, bob, {
      kind: KIND_CONTROL,
      content: loc(third.id, 3, { end: true }),
      tags: recipientTags([bob.pubkey]),
    })
    await settle()
    network.publish(giftWrap(third, alice.secretKey, bob.pubkey))
    await settle()
    expect((await seen(bob, third.id))?.live).toMatchObject({ seq: 0 })
    expect((await seen(bob, third.id))?.live?.end).toBeUndefined()
  })

  it('holds early updates for so many shares only, dropping the oldest', async () => {
    const shares = Array.from({ length: 65 }, (_, i) =>
      createRumor(
        {
          kind: KIND_CHAT,
          content: `live ${i}`,
          tags: [...recipientTags([bob.pubkey]), ...locationTags({ ...HOME, live: 900 })],
        },
        alice.secretKey,
      ),
    )
    for (const share of shares) {
      inject(network, alice, bob, {
        kind: KIND_CONTROL,
        content: loc(share.id, 1, { lat: 1, lon: 1 }),
        tags: recipientTags([bob.pubkey]),
      })
      await settle(50)
    }
    await settle()
    const [first, second, last] = [shares[0]!, shares[1]!, shares[64]!]
    for (const share of [first, second, last]) network.publish(giftWrap(share, alice.secretKey, bob.pubkey))
    await settle()
    // Sixty-four are held; the first to come went to make room for the last.
    expect((await seen(bob, first.id))?.live?.seq).toBe(0)
    expect((await seen(bob, second.id))?.live?.seq).toBe(1)
    expect((await seen(bob, last.id))?.live?.seq).toBe(1)
  })

  it('keeps a share live on a reader whose clock is an hour ahead of the sharer’s', async () => {
    // Alice's phone says it is an hour earlier than it is.
    const behind = Date.now() - 60 * MINUTE
    const share = createRumor(
      {
        kind: KIND_CHAT,
        content: 'live',
        created_at: Math.floor(behind / 1000),
        tags: [...recipientTags([bob.pubkey]), timestampTag(behind), ...locationTags({ ...HOME, live: 900 })],
      },
      alice.secretKey,
    )
    network.publish(giftWrap(share, alice.secretKey, bob.pubkey))
    await settle()
    const update = createRumor(
      {
        kind: KIND_CONTROL,
        content: loc(share.id, 1, { lat: 1, lon: 1 }),
        created_at: Math.floor((behind + 2 * MINUTE) / 1000),
        tags: [...recipientTags([bob.pubkey]), timestampTag(behind + 2 * MINUTE)],
      },
      alice.secretKey,
    )
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    network.publish(giftWrap(update, alice.secretKey, bob.pubkey))
    await settle()

    const now = Date.now()
    const status = liveStatus((await seen(bob, share.id)) as Message, now)
    expect(status?.active).toBe(true)
    // Shown as moved moments ago, with most of its quarter hour to go.
    expect(now - (status?.updatedAt ?? 0)).toBeLessThan(10_000)
    expect((status?.endsAt ?? 0) - now).toBeGreaterThan(12 * MINUTE)
  })

  it('queues only the newest update while offline, asks relays to drop each within the hour', async () => {
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, live: 3600 })
    await settle()
    network.offline = true
    for (let i = 1; i <= 4; i++)
      await alice.messenger.moveLiveLocation(sent.id, { lat: 35 + i / 100, lon: 51 })
    const queued = (await alice.vault.repo.outboxIdsFrom('ctl-live-')).filter((id) => id.includes(sent.id))
    expect(queued).toEqual([`ctl-live-${sent.id}-4`])

    network.offline = false
    const before = network.events.length
    await alice.messenger.flushOutbox()
    await settle(1000)
    expect((await seen(bob, sent.id))?.live).toMatchObject({ lat: 35.04, seq: 4 })

    const wraps = network.events.slice(before).filter((event) => event.tags.some((t) => t[1] === bob.pubkey))
    expect(wraps).toHaveLength(1)
    const expiration = Number(wraps[0]?.tags.find((tag) => tag[0] === 'expiration')?.[1])
    expect(expiration - Date.now() / 1000).toBeGreaterThan(55 * 60)
    expect(expiration - Date.now() / 1000).toBeLessThanOrEqual(60 * 60)
    // An update is not copied to Alice's own inbox; only content and the end are.
    expect(network.events.slice(before).some((event) => event.tags.some((t) => t[1] === alice.pubkey))).toBe(
      false,
    )
  })

  it('retries the share itself until it lands, under the same id', async () => {
    network.offline = true
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, live: 900 })
    await settle(5000)
    expect((await seen(alice, sent.id))?.status).toBe('queued')
    network.offline = false
    await settle(60_000)
    expect((await seen(bob, sent.id))?.location).toEqual({ ...HOME, live: 900 })

    // A manual retry rebuilds the very same rumor from what was stored.
    await alice.vault.repo.updateMessage(sent.id, { status: 'failed' })
    await alice.messenger.retryMessage(sent.id)
    const again = network.events.at(-1)
    expect(again).toBeDefined()
    expect(unwrapGift(again!, alice.secretKey).id).toBe(sent.id)
  })

  it('ends on every device of the sharer, whichever one pressed stop', async () => {
    const phone = await makePeer(network, 'Alice-phone', bytesToHex(alice.secretKey))
    extra.push(phone)
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, live: 0 })
    await settle()
    const copy = await seen(phone, sent.id)
    expect(copy).toMatchObject({ direction: 'out', live: { seq: 0 } })

    const updated = vi.fn()
    alice.messenger.events.on('messageUpdated', updated)
    await phone.messenger.moveLiveLocation(sent.id, null)
    await settle()
    expect((await seen(alice, sent.id))?.live?.end).toBeDefined()
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: sent.id }))
    expect((await seen(bob, sent.id))?.live?.end).toBeDefined()
    // The end is a durable frame to Bob, copied to Alice's own inbox.
    const ends = network.events.filter((event) => {
      try {
        const frame = parseControlFrame(unwrapGift(event, bob.secretKey).content)
        return frame?.t === 'loc' && frame.end === true
      } catch {
        return false
      }
    })
    expect(ends).toHaveLength(1)
  })

  it('ends a share before deleting it, so nobody is left watching it', async () => {
    const sent = await alice.messenger.sendLocation(bob.pubkey, { ...HOME, live: 900 })
    await settle()
    await alice.messenger.deleteLocally(sent.id)
    await settle()
    expect(await seen(alice, sent.id)).toBeNull()
    expect((await seen(bob, sent.id))?.live?.end).toBeDefined()

    // Deleting a share of Bob's that Alice holds sends nothing for it.
    const theirs = await bob.messenger.sendLocation(alice.pubkey, { ...HOME, live: 900 })
    await settle()
    await alice.messenger.deleteLocally(theirs.id)
    await settle()
    expect((await seen(bob, theirs.id))?.live?.end).toBeUndefined()
  })

  it('reads a location only where nothing else claims the message', async () => {
    inject(network, alice, bob, {
      kind: KIND_CHAT,
      content: 'poll, really',
      tags: [
        ...recipientTags([bob.pubkey]),
        ['poll', 'Where?'],
        ['option', 'o0', 'Here'],
        ['option', 'o1', 'There'],
        ...locationTags(HOME),
      ],
    })
    await settle()
    const [message] = await bob.vault.repo.listMessages(
      bob.vault.repo.conversationId(bob.pubkey, alice.pubkey),
    )
    expect(message?.poll).toBeDefined()
    expect(message?.location).toBeUndefined()
  })
})
