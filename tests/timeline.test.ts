import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { byTimeline, carriedOrder, HLC_TAG, nextOrder, orderOf, orderTag } from '@/core/models/timeline'
import { KIND_CHAT, recipientTags, timestampTag } from '@/core/models/protocol'
import { PROTOCOL_VERSION, type CallFrame } from '@/core/models/protocol'
import { DEFAULT_SETTINGS, type Message } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { coarsenMs, DAY, HOUR, MAX_CLOCK_AHEAD_MS } from '@/core/util/time'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * A conversation's order is causal (ADR-063): anything sent after seeing an
 * entry sorts after it, on every device, however far apart the clocks — while
 * each bubble still shows the time its author's clock gave it, in the reader's
 * time zone. The key is a hybrid logical clock, one per conversation, carried
 * in the rumor so every device sorts by the same one.
 */

const MINUTE = 60_000
const LOS_ANGELES = 'America/Los_Angeles' // UTC−7 in September
const TEHRAN = 'Asia/Tehran' // UTC+3:30, a half-hour zone

const originalTz = process.env.TZ
/** Act as a device in `zone`: Node re-reads `TZ` when it is assigned. */
const inZone = (zone: string) => {
  process.env.TZ = zone
}
afterEach(() => {
  process.env.TZ = originalTz
})

describe('the clock', () => {
  it('sorts by key, a legacy entry by its time, and a tie by id either way round', () => {
    expect(byTimeline({ ts: 9, order: 1, id: 'a' }, { ts: 1, order: 2, id: 'b' })).toBeLessThan(0)
    expect(byTimeline({ ts: 5, id: 'a' }, { ts: 1, order: 6, id: 'b' })).toBeLessThan(0)
    expect(byTimeline({ ts: 1, order: 3, id: 'a' }, { ts: 2, order: 3, id: 'b' })).toBeLessThan(0)
    expect(byTimeline({ ts: 1, order: 3, id: 'b' }, { ts: 2, order: 3, id: 'a' })).toBeGreaterThan(0)
    expect(byTimeline({ ts: 1, id: 'a' }, { ts: 1, id: 'a' })).toBe(0)
    expect(orderOf({ ts: 7 })).toBe(7)
    expect(orderOf({ ts: 7, order: 9 })).toBe(9)
  })

  it('keys what is sent by this clock, or just past everything seen', () => {
    expect(nextOrder(1000, 400)).toBe(1000)
    expect(nextOrder(1000, 1000)).toBe(1001)
    expect(nextOrder(1000, 5000)).toBe(5001)
    expect(orderTag(5001)).toEqual([HLC_TAG, '5001'])
  })

  it('takes a carried key between its author’s time and a day ahead of this clock, and nothing else', () => {
    const now = 1_000_000
    const ts = 900_000
    const tagged = (value?: string) => [['p', 'x'], value === undefined ? [HLC_TAG] : [HLC_TAG, value]]
    expect(carriedOrder(tagged('950000'), ts, now)).toBe(950_000)
    expect(carriedOrder(tagged(String(ts)), ts, now)).toBe(ts)
    expect(carriedOrder(tagged(String(now + MAX_CLOCK_AHEAD_MS)), ts, now)).toBe(now + MAX_CLOCK_AHEAD_MS)
    // Earlier than the clock it came from was, or further ahead than any rumor may be.
    expect(carriedOrder(tagged('899999'), ts, now)).toBe(ts)
    expect(carriedOrder(tagged(String(now + MAX_CLOCK_AHEAD_MS + 1)), ts, now)).toBe(ts)
    // Not a number, or no number at all.
    for (const bad of ['', '9.5e5', '-950000', '0x10', 'soon'])
      expect(carriedOrder(tagged(bad), ts, now)).toBe(ts)
    expect(carriedOrder(tagged(), ts, now)).toBe(ts)
    // Another client's rumor carries none.
    expect(carriedOrder([['p', 'x']], ts, now)).toBe(ts)
    // A bad key does not hide a good one after it.
    expect(
      carriedOrder(
        [
          [HLC_TAG, 'x'],
          [HLC_TAG, '950000'],
        ],
        ts,
        now,
      ),
    ).toBe(950_000)
  })

  it('buckets the index by UTC hour, not by the hour on the local clock', () => {
    // 12:40 UTC is 05:40 in Los Angeles and 16:10 in Tehran, whose local hour
    // began at 12:30 UTC. The bucket is 12:00 UTC wherever the device is.
    const at = Date.UTC(2026, 8, 20, 12, 40)
    const localClock: Record<string, string> = { [LOS_ANGELES]: '5:40', [TEHRAN]: '16:10', UTC: '12:40' }
    for (const zone of [LOS_ANGELES, TEHRAN, 'UTC']) {
      inZone(zone)
      // The switch is real: the local clock reads differently in each zone.
      const local = new Date(at)
      expect(`${local.getHours()}:${local.getMinutes()}`).toBe(localClock[zone])
      expect(coarsenMs(at)).toBe(Date.UTC(2026, 8, 20, 12))
    }
  })
})

interface Peer {
  name: string
  pubkey: string
  secretKeyHex: string
  vault: TestVault
  messenger: Messenger
  /** Offers that rang here, with the time the offer gave. */
  rang: { callId: string; at: number }[]
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
  const messenger = new Messenger(
    vault.vault,
    vault.repo,
    { ...DEFAULT_SETTINGS, enableDirectConnection: false },
    new FakeRelayPool(network),
  )
  await messenger.start(secretKeyHex, identity.publicKey)
  const rang: Peer['rang'] = []
  messenger.events.on('callSignal', ({ callId, at }) => rang.push({ callId, at }))
  return { name, pubkey: identity.publicKey, secretKeyHex, vault, messenger, rang }
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms)

describe('causal order across skewed clocks', () => {
  // A true "now", and each device's clock relative to it.
  const T = Date.UTC(2026, 8, 20, 20, 10)
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer

  /** Act as `peer`, whose clock is `skew` off the true time `at`. */
  const clockOf = (at: number, skew: number) => vi.setSystemTime(at + skew)

  const conversation = (peer: Peer, others: Peer[]) =>
    others.length === 1
      ? peer.vault.repo.conversationId(peer.pubkey, others[0]!.pubkey)
      : peer.vault.repo.conversationIdOf(
          peer.pubkey,
          others.map((o) => o.pubkey),
        )
  const timeline = async (peer: Peer, others: Peer[]) =>
    (await peer.vault.repo.listMessages(conversation(peer, others))).map((m: Message) => ({
      id: m.id,
      body: m.body,
      ts: m.ts,
      order: orderOf(m),
    }))
  const bodies = async (peer: Peer, others: Peer[]) => (await timeline(peer, others)).map((m) => m.body)

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(T)
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    for (const a of [alice, bob, carol]) {
      for (const b of [alice, bob, carol]) {
        if (a !== b) await a.vault.repo.upsertContact(b.pubkey, { name: b.name, accepted: true })
      }
    }
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('puts a reply from a clock an hour behind after its question, on both sides, at the time it says', async () => {
    clockOf(T, 0)
    const question = await alice.messenger.sendMessage(bob.pubkey, 'question')
    await settle()
    clockOf(T + MINUTE, -HOUR)
    const answer = await bob.messenger.sendMessage(alice.pubkey, 'answer')
    await settle()

    for (const [peer, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const [q, a] = await timeline(peer, [other])
      expect([q?.body, a?.body]).toEqual(['question', 'answer'])
      expect(a!.order).toBeGreaterThan(q!.order)
    }
    // Shown as Bob's clock gave it, an hour early: the key is not the time.
    expect(answer.ts).toBe(T + MINUTE - HOUR)
    expect(question.ts).toBe(T)
    // Both sides hold the same keys.
    expect(await timeline(alice, [bob])).toEqual(await timeline(bob, [alice]))
  })

  it('answers a question from a clock an hour ahead below it, on both sides', async () => {
    clockOf(T, HOUR)
    await alice.messenger.sendMessage(bob.pubkey, 'question from the future')
    await settle()
    clockOf(T + MINUTE, 0)
    const answer = await bob.messenger.sendMessage(alice.pubkey, 'answer on time')
    await settle()

    expect(await bodies(alice, [bob])).toEqual(['question from the future', 'answer on time'])
    expect(await timeline(alice, [bob])).toEqual(await timeline(bob, [alice]))
    expect(answer.ts).toBe(T + MINUTE)
  })

  it('keeps a chain in order through a group whose clocks are an hour apart each way', async () => {
    const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'Plans')
    const others = (peer: Peer) => [alice, bob, carol].filter((p) => p !== peer)
    const turns: [Peer, number, string][] = [
      [alice, HOUR, 'Alice, an hour ahead'],
      [bob, -HOUR, 'Bob, an hour behind'],
      [carol, 0, 'Carol, on time'],
      [alice, HOUR, 'Alice again'],
      [bob, -HOUR, 'Bob again'],
    ]
    for (const [i, [peer, skew, body]] of turns.entries()) {
      clockOf(T + i * MINUTE, skew)
      const address = peer === alice ? group.id : conversation(peer, others(peer))
      await peer.messenger.sendMessage(address, body)
      await settle()
    }
    const expected = turns.map(([, , body]) => body)
    for (const peer of [alice, bob, carol]) expect(await bodies(peer, others(peer))).toEqual(expected)
    const keys = async (peer: Peer) => (await timeline(peer, others(peer))).map((m) => m.order)
    expect(await keys(bob)).toEqual(await keys(alice))
    expect(await keys(carol)).toEqual(await keys(alice))
  })

  it('agrees on the order of two messages neither had seen, on both sides', async () => {
    clockOf(T, 0)
    await alice.messenger.sendMessage(bob.pubkey, 'from Alice')
    clockOf(T + 1000, -HOUR)
    await bob.messenger.sendMessage(alice.pubkey, 'from Bob')
    await settle()
    // Neither saw the other's: they sort by their keys — here Bob's clock put
    // his an hour earlier — and both devices agree.
    expect(await bodies(alice, [bob])).toEqual(['from Bob', 'from Alice'])
    expect(await timeline(alice, [bob])).toEqual(await timeline(bob, [alice]))
  })

  it('keeps the order when one side catches up later, in the relay’s order', async () => {
    bob.messenger.stop()
    for (const [i, body] of ['one', 'two', 'three', 'four', 'five'].entries()) {
      clockOf(T + i * 1000, HOUR)
      await alice.messenger.sendMessage(bob.pubkey, body)
    }
    await settle()
    clockOf(T + MINUTE, -HOUR)
    await bob.messenger.start(bob.secretKeyHex, bob.pubkey)
    await settle(5000)
    await bob.messenger.sendMessage(alice.pubkey, 'six, from an hour behind')
    await settle()

    const expected = ['one', 'two', 'three', 'four', 'five', 'six, from an hour behind']
    expect(await bodies(bob, [alice])).toEqual(expected)
    expect(await timeline(alice, [bob])).toEqual(await timeline(bob, [alice]))
  })

  it('orders after a rumor that carries no key, and ignores a key from further ahead than any rumor may be', async () => {
    // Another client's message, with no key, then one with a forged one.
    const aliceKey = hexToBytes(alice.secretKeyHex)
    const plain = createRumor(
      {
        kind: KIND_CHAT,
        content: 'from another client',
        created_at: Math.floor(T / 1000),
        tags: recipientTags([bob.pubkey]),
      },
      aliceKey,
    )
    network.publish(giftWrap(plain, aliceKey, bob.pubkey))
    const forgedAt = T + 1000
    const forged = createRumor(
      {
        kind: KIND_CHAT,
        content: 'a key from next week',
        created_at: Math.floor(forgedAt / 1000),
        tags: [...recipientTags([bob.pubkey]), timestampTag(forgedAt), orderTag(T + 7 * DAY)],
      },
      aliceKey,
    )
    network.publish(giftWrap(forged, aliceKey, bob.pubkey))
    await settle()
    clockOf(T + MINUTE, -HOUR)
    await bob.messenger.sendMessage(alice.pubkey, 'reply from an hour behind')
    await settle()

    const seen = await timeline(bob, [alice])
    expect(seen.map((m) => m.body)).toEqual([
      'from another client',
      'a key from next week',
      'reply from an hour behind',
    ])
    expect(seen[0]!.order).toBe(seen[0]!.ts)
    expect(seen[1]!.order).toBe(forgedAt)
  })

  it('enters a call at the key its offer carried, on both sides, between what came before and after', async () => {
    // Bob's clock is an hour ahead. He asks for a call; Alice, on time, calls
    // after reading it — so the call belongs after his question, though her
    // clock says it happened an hour before it.
    clockOf(T - MINUTE, HOUR)
    await bob.messenger.sendMessage(alice.pubkey, 'call me?')
    await settle()
    clockOf(T, 0)
    const offer: CallFrame = { v: PROTOCOL_VERSION, t: 'rtc', kind: 'offer', media: 'audio', sdp: 'v=0\r\n' }
    const callId = await alice.messenger.sendCallSignal(bob.pubkey, offer)
    await settle()
    const rang = bob.rang.find((r) => r.callId === callId)
    expect(rang).toBeDefined()

    // Bob says something before either side writes the call down.
    clockOf(T + MINUTE, HOUR)
    await bob.messenger.sendMessage(alice.pubkey, 'thanks for calling')
    await settle()
    const record = { media: 'audio', outcome: 'completed', durationMs: 60_000 } as const
    await bob.messenger.recordCall(alice.pubkey, callId, 'in', record, rang!.at)
    clockOf(T + 2 * MINUTE, 0)
    await alice.messenger.recordCall(bob.pubkey, callId, 'out', record, T)

    for (const [peer, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const entries = await timeline(peer, [other])
      expect(entries.map((m) => (m.id === callId ? 'the call' : m.body))).toEqual([
        'call me?',
        'the call',
        'thanks for calling',
      ])
    }
    // Both sides enter it at the same key, and show it at Alice's time.
    const call = async (peer: Peer, other: Peer) =>
      (await timeline(peer, [other])).find((m) => m.id === callId)
    expect((await call(bob, alice))?.order).toBe((await call(alice, bob))?.order)
    expect((await call(alice, bob))?.ts).toBe(T)
  })
})

describe('one timeline across time zones', () => {
  // 20:10 on 20 September in UTC: 13:10 that day in Los Angeles, and 23:40 in
  // Tehran — close to midnight there, so the two devices disagree on the date.
  const T = Date.UTC(2026, 8, 20, 20, 10)
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  const timeline = async (peer: Peer, other: Peer) =>
    (await peer.vault.repo.listMessages(peer.vault.repo.conversationId(peer.pubkey, other.pubkey))).map(
      (message: Message) => ({ body: message.body, ts: message.ts, order: orderOf(message) }),
    )

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(T)
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

  it('weaves Los Angeles and Tehran into one order, the same on both sides, at UTC times', async () => {
    // Alice in Los Angeles and Bob in Tehran take turns, across 20:30 UTC — the
    // top of Tehran's hour — and past midnight in Tehran.
    const turns: [Peer, Peer, string, string][] = [
      [alice, bob, LOS_ANGELES, 'one'],
      [bob, alice, TEHRAN, 'two'],
      [alice, bob, LOS_ANGELES, 'three'],
      [bob, alice, TEHRAN, 'four'],
      [bob, alice, TEHRAN, 'five'],
      [alice, bob, LOS_ANGELES, 'six'],
    ]
    const sentAt: number[] = []
    for (const [i, [from, to, zone, body]] of turns.entries()) {
      inZone(zone)
      vi.setSystemTime(T + i * 9 * MINUTE)
      sentAt.push(Date.now())
      await from.messenger.sendMessage(to.pubkey, body)
      await settle()
    }

    inZone(LOS_ANGELES)
    const seen = await timeline(alice, bob)
    expect(seen.map((m) => m.body)).toEqual(turns.map(([, , , body]) => body))
    expect(seen.map((m) => m.ts)).toEqual(sentAt)
    inZone(TEHRAN)
    expect(await timeline(bob, alice)).toEqual(seen)
  })
})

describe('a device that changes time zone', () => {
  it('pages its history exactly across the change', async () => {
    // Written first in Los Angeles, then in Tehran, around the half hour at
    // which a Tehran-local hour would begin. A page must be the newest ones,
    // in order, whichever zone each was written in.
    const t = await makeVault()
    const self = 'a'.repeat(64)
    const peer = 'b'.repeat(64)
    const convo = await t.repo.ensureConversation(self, peer)
    const base = Date.UTC(2026, 8, 20, 12, 0)
    for (let i = 0; i < 120; i++) {
      inZone(i < 60 ? LOS_ANGELES : TEHRAN)
      await t.repo.putMessage({
        id: bytesToHex(new Uint8Array(32).map((_, j) => (i * 7 + j * 13) % 256)),
        convoId: convo.id,
        direction: i % 2 === 0 ? 'out' : 'in',
        status: 'read',
        ts: base + i * 30_000,
        order: base + i * 30_000,
        tsCoarse: 0,
        body: `m${i}`,
        authorPubkey: i % 2 === 0 ? self : peer,
      })
    }
    expect((await t.repo.listMessages(convo.id, 50)).map((m) => m.body)).toEqual(
      Array.from({ length: 50 }, (_, i) => `m${70 + i}`),
    )
    await t.destroy()
  }, 60_000)
})

describe('the conversation’s clock', () => {
  it('moves past every entry, issues keys no two sends share, and starts a legacy conversation at its newest', async () => {
    const t = await makeVault()
    const convo = await t.repo.ensureConversation('a'.repeat(64), 'b'.repeat(64))
    // A conversation from before keys existed starts at its newest entry.
    await t.repo.updateConversation(convo.id, { lastActivity: 5000 })
    expect(await t.repo.tickClock(convo.id, 1000)).toBe(5001)
    // An entry that arrives with a later key moves the clock past it.
    await t.repo.bumpConversation(convo.id, { ts: 6000, order: 9000 }, false)
    const [a, b] = await Promise.all([t.repo.tickClock(convo.id, 1000), t.repo.tickClock(convo.id, 1000)])
    expect(new Set([a, b])).toEqual(new Set([9001, 9002]))
    // What the list shows stays the author's time.
    expect((await t.repo.getConversation(convo.id))?.lastActivity).toBe(6000)
    await expect(t.repo.tickClock('0'.repeat(64), 1000)).rejects.toThrow('no such conversation')
    await t.destroy()
  })
})
