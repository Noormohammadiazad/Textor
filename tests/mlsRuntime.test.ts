import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '@/core/util/emitter'
import { bytesToHex } from '@/core/util/bytes'
import {
  DEFAULT_SETTINGS,
  emptyHealth,
  type AppSettings,
  type Conversation,
  type Message,
  type OutboxItem,
} from '@/core/models/types'
import { KIND_GROUP_CHAT, MAX_MESSAGE_CHARS, MAX_MLS_MEMBERS } from '@/core/models/protocol'
import type {
  IRelayPool,
  PublishHandle,
  PublishOutcome,
  RelayPoolEvents,
  RelayProgress,
  SubCloser,
} from '@/core/transport/relayPool'
import type { Rumor } from '@/core/crypto/giftwrap'
import { MlsRuntime, MlsUnavailableError } from '@/core/mls/runtime'
import type { InnerEvent, MlsHost } from '@/core/mls/host'
import { createKeyPackage, keyPackageEvent, KIND_GROUP_EVENT, KIND_KEY_PACKAGE } from '@/core/mls/marmot'
import { matches } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * The group runtime and its messages, driven on a network where the test
 * decides who hears what, and when — the only way to reach the orderings
 * that matter: a commit that arrives after the member it removes has queued
 * more work, a race two members both think they won, an event for a group
 * left a moment ago.
 */

const RELAY = 'wss://group.example'

class Network {
  events: NostrEvent[] = []
  offline = false
}

/** A relay pool that stores what is published and delivers only when told. */
class ManualPool implements IRelayPool {
  readonly events = new Emitter<RelayPoolEvents>()
  readonly readRelays = [RELAY]
  readonly writeRelays = [RELAY]
  readonly onlineCount = 1
  readonly epoch = 0
  subs: {
    filter: (url: string) => Filter
    onEvent: (e: NostrEvent) => void
    onEose?: (url?: string) => void
  }[] = []
  delivered = new Set<string>()
  progress: RelayProgress | null = { reqAt: 1000, eoseAt: 2000, open: true, lastRxAt: 5000 }

  constructor(private readonly net: Network) {}

  setRelays(): void {}
  seedHealth(): void {}
  statuses() {
    return [{ url: RELAY, state: 'online' as const, health: emptyHealth() }]
  }
  healthSnapshot() {
    return []
  }
  subscribe(
    filter: Filter | ((url: string) => Filter),
    handlers: { onEvent: (e: NostrEvent) => void; onEose?: (url?: string) => void },
  ): SubCloser {
    const sub = { filter: typeof filter === 'function' ? filter : () => filter, ...handlers }
    this.subs.push(sub)
    return {
      close: () => {
        this.subs = this.subs.filter((s) => s !== sub)
      },
      progress: (url) => (url === RELAY ? this.progress : null),
    }
  }
  async query(filter: Filter): Promise<NostrEvent[]> {
    return this.net.events.filter((e) => matches(filter, e))
  }
  async reconcile() {
    return { ok: false as const, refused: true, reason: 'unused' }
  }
  #store(event: NostrEvent): PublishOutcome[] {
    if (this.net.offline) return [{ url: RELAY, ok: false, error: 'offline' }]
    if (!this.net.events.some((e) => e.id === event.id)) this.net.events.push(event)
    return [{ url: RELAY, ok: true, ms: 1 }]
  }
  async publish(event: NostrEvent): Promise<PublishOutcome[]> {
    return this.#store(event)
  }
  dispatch(event: NostrEvent): PublishHandle {
    const done = Promise.resolve(this.#store(event))
    return { quorum: done, settled: done }
  }
  rankedWriteRelays() {
    return [RELAY]
  }
  rankedReadRelays() {
    return [RELAY]
  }
  prewarm(): void {}
  wake(): void {}
  destroy(): void {}

  /** Hand this device every stored group event it has not seen, in order. */
  flush(): void {
    for (const event of this.net.events) {
      if (this.delivered.has(event.id)) continue
      for (const sub of this.subs) {
        if (matches(sub.filter(RELAY), event)) {
          this.delivered.add(event.id)
          sub.onEvent(event)
        }
      }
    }
  }

  /** Hand over one event, whatever the filter says. */
  deliver(event: NostrEvent): void {
    for (const sub of this.subs) sub.onEvent(event)
  }

  eose(url?: string): void {
    for (const sub of this.subs) sub.onEose?.(url)
  }
}

interface Device {
  name: string
  pubkey: string
  secretKey: Uint8Array | null
  t: TestVault
  pool: ManualPool
  runtime: MlsRuntime
  host: MlsHost
  rumors: { to: string; rumor: Rumor }[]
  outbox: OutboxItem[]
  failed: { id: string; error: string }[]
  emitted: string[]
  settings: AppSettings
  standing: Map<string, 'accepted' | 'blocked' | 'unknown'>
  viewing: boolean
}

const devices: Device[] = []

async function device(net: Network, name: string, secret = generateSecretKey()): Promise<Device> {
  const t = await makeVault(`${name}-pw`)
  const pool = new ManualPool(net)
  const d = {
    name,
    pubkey: getPublicKey(secret),
    secretKey: secret,
    t,
    pool,
    rumors: [],
    outbox: [],
    failed: [],
    emitted: [],
    settings: { ...DEFAULT_SETTINGS },
    standing: new Map(),
    viewing: false,
  } as unknown as Device
  const host: MlsHost = {
    pubkey: d.pubkey,
    secretKey: () => d.secretKey,
    pool,
    repo: t.repo,
    settings: () => d.settings,
    relaysOf: async () => [],
    sendRumor: async (to, rumor) => {
      d.rumors.push({ to, rumor })
    },
    enqueue: async (item) => {
      d.outbox.push(item)
    },
    failItem: async (item, error) => {
      d.failed.push({ id: item.id, error })
    },
    emit: (name) => {
      d.emitted.push(name)
    },
    forget: async (message) => {
      await t.repo.withdraw(message.id, message.authorPubkey)
      await t.repo.deleteMessageAndPayload(message.id)
    },
    uncount: async () => undefined,
    isViewing: () => d.viewing,
    threadRoot: async () => null,
    ingestReaction: async (conversation, rumor) => {
      const target = rumor.tags.find((tag) => tag[0] === 'e')?.[1] as string
      await t.repo.putReaction({
        id: rumor.id,
        messageId: target,
        convoId: conversation.id,
        authorPubkey: rumor.pubkey,
        emoji: rumor.content,
        ts: rumor.created_at * 1000,
      })
    },
    standing: async (pubkey) => d.standing.get(pubkey) ?? 'accepted',
  }
  d.host = host
  d.runtime = new MlsRuntime(host)
  await d.runtime.start()
  devices.push(d)
  return d
}

/** Let queued crypto and storage finish. */
async function idle(turns = 40): Promise<void> {
  // setImmediate: storage schedules on it, and the fake clock never touches it.
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Deliver everything to everyone, then everything that caused, until quiet. */
async function sync(...all: Device[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await idle()
    for (const d of all) d.pool.flush()
    await idle()
  }
}

/** Send every outbox item a device has queued, through its own runtime. */
async function drain(d: Device): Promise<void> {
  for (const item of d.outbox.splice(0)) await d.runtime.chat.deliver(item)
}

async function welcome(from: Device, ...to: Device[]): Promise<void> {
  for (const { to: target, rumor } of from.rumors.splice(0)) {
    const d = to.find((candidate) => candidate.pubkey === target)
    if (d) await d.runtime.receiveWelcome(rumor)
  }
}

const groupOf = async (d: Device): Promise<Conversation> =>
  (await d.t.repo.listConversations()).find((c) => c.mls) as Conversation

/** Devices ordered by public key, so the winner of a race between two is known. */
async function ordered(net: Network, ...names: string[]): Promise<Device[]> {
  const made = await Promise.all(names.map((name) => device(net, name)))
  return made.sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))
}

function chatEvent(d: Device, content: string, tags: string[][] = []): InnerEvent {
  return finalizeEvent(
    { kind: KIND_GROUP_CHAT, created_at: Math.floor(Date.now() / 1000), tags, content },
    d.secretKey!,
  ) as unknown as InnerEvent
}

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.runtime.stop()
    await d.t.destroy()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('KeyPackages', () => {
  it('publishes one, republishes one a relay never took, and replaces one when asked', async () => {
    const net = new Network()
    net.offline = true
    const alice = await device(net, 'alice')
    await idle()
    const [stored] = await alice.t.repo.listMlsKeys<{ ref: string; publishedAt: number }>()
    expect(stored?.publishedAt).toBe(0)
    expect(net.events).toHaveLength(0)

    // Back online: the same package goes out, not a new one.
    net.offline = false
    await alice.runtime.ensureKeyPackage()
    const again = await alice.t.repo.listMlsKeys<{ ref: string; publishedAt: number }>()
    expect(again.map((k) => k.ref)).toEqual([stored!.ref])
    expect(again[0]!.publishedAt).toBeGreaterThan(0)
    expect(net.events.filter((e) => e.kind === KIND_KEY_PACKAGE)).toHaveLength(1)

    // Fresh and published: nothing to do. Forced: a new one takes the slot.
    await alice.runtime.ensureKeyPackage()
    expect(await alice.t.repo.listMlsKeys()).toHaveLength(1)
    await alice.runtime.ensureKeyPackage(true)
    const both = await alice.t.repo.listMlsKeys<{ replacedAt?: number; slot: string }>()
    expect(both).toHaveLength(2)
    expect(both.filter((k) => k.replacedAt !== undefined)).toHaveLength(1)
    expect(new Set(both.map((k) => k.slot)).size).toBe(1)
  })

  it('deletes replaced and expired private keys once forward secrecy says so', async () => {
    const net = new Network()
    const alice = await device(net, 'alice')
    await idle()
    await alice.runtime.ensureKeyPackage(true)
    vi.useFakeTimers({ now: Date.now() + 8 * 86_400_000, toFake: ['Date'] })
    await alice.runtime.ensureKeyPackage()
    expect(await alice.t.repo.listMlsKeys()).toHaveLength(1)
    vi.setSystemTime(Date.now() + 90 * 86_400_000)
    await alice.runtime.ensureKeyPackage()
    // The expired one is gone, and a fresh one published in its place.
    const keys = await alice.t.repo.listMlsKeys<{ notAfter: number }>()
    expect(keys).toHaveLength(1)
    expect(keys[0]!.notAfter).toBeGreaterThan(Date.now() / 1000)
  })

  it('withdraws, and does nothing without a key', async () => {
    const net = new Network()
    const alice = await device(net, 'alice')
    await idle()
    alice.settings.mlsInvites = false
    await alice.runtime.ensureKeyPackage()
    expect(net.events.some((e) => e.kind === 5)).toBe(true)
    expect(await alice.t.repo.listMlsKeys()).toEqual([])
    await alice.runtime.ensureKeyPackage() // nothing left to withdraw
    alice.secretKey = null
    await alice.runtime.ensureKeyPackage()
    await alice.runtime.withdrawKeyPackages()
    await expect(alice.runtime.createGroup({ members: ['a'.repeat(64)], name: '' })).rejects.toThrow(
      /not running/,
    )
  })

  it('picks the freshest valid package, and between equals the lower reference', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    // Bob publishes two more in other slots at the same second, and some junk.
    const now = Math.floor(Date.now() / 1000) + 5
    const extra = await Promise.all(
      ['aa', 'bb'].map(async (slot) =>
        keyPackageEvent(
          bob!.secretKey!,
          (await createKeyPackage(bob!.secretKey!, bob!.pubkey)).publicPackage,
          slot.repeat(32),
          now,
        ),
      ),
    )
    net.events.push(
      ...extra,
      finalizeEvent(
        { kind: KIND_KEY_PACKAGE, created_at: now + 1, tags: [], content: 'junk' },
        bob!.secretKey!,
      ),
    )
    const lower = extra.map((e) => e.tags.find((t) => t[0] === 'i')![1]!).sort()[0]
    const expectedEvent = extra.find((e) => e.tags.some((t) => t[0] === 'i' && t[1] === lower))!
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const rumor = alice!.rumors[0]!.rumor
    expect(rumor.tags.find((t) => t[0] === 'e')?.[1]).toBe(expectedEvent.id)
  })
})

describe('starting and stopping', () => {
  it('skips a stored group it cannot read, and loads the rest', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: 'kept' })
    await alice!.t.repo.putMlsGroup('broken', { record: { v: 1, state: 'AAAA' }, hwm: {} })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const again = new MlsRuntime(alice!.host)
    await again.start()
    expect(warn).toHaveBeenCalled()
    again.stop()
    again.tick() // stopped: nothing
  })

  it('does not subscribe or run late work once stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle(80)
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    await welcome(alice!, bob!)
    bob!.runtime.stop()
    // The post-join key refresh was scheduled; stopped, it never runs.
    await vi.advanceTimersByTimeAsync(700_000)
    const convo = await groupOf(bob!)
    await bob!.runtime.leave(convo.id)
    expect(bob!.pool.subs).toHaveLength(0)
  })

  it('keeps each relay’s high-water mark, and writes it down now and then', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    alice!.pool.eose() // no URL: a relay this subscription never asked
    alice!.pool.eose('wss://other.example')
    alice!.pool.eose(RELAY)
    alice!.runtime.tick()
    const stored = await alice!.t.repo.getMlsGroup<{ hwm: Record<string, number> }>(convoId)
    expect(stored?.hwm[RELAY]).toBe(5)
    // A connection that has not finished replaying proves nothing new.
    alice!.pool.progress = { reqAt: 9000, eoseAt: 0, open: true, lastRxAt: 9000 }
    alice!.runtime.tick()
    alice!.pool.progress = null
    alice!.runtime.tick()
    alice!.pool.progress = { reqAt: 1000, eoseAt: 2000, open: true, lastRxAt: 7000 }
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] })
    alice!.runtime.tick()
    await idle()
    expect((await alice!.t.repo.getMlsGroup<{ hwm: Record<string, number> }>(convoId))?.hwm[RELAY]).toBe(7)
    alice!.pool.progress = { reqAt: 1000, eoseAt: 2000, open: true, lastRxAt: 8000 }
    alice!.runtime.tick()
    alice!.runtime.stop() // writes the mark it has not written yet
    await idle()
    expect((await alice!.t.repo.getMlsGroup<{ hwm: Record<string, number> }>(convoId))?.hwm[RELAY]).toBe(8)
  })

  it('refreshes keys once they are a week old, and checks its KeyPackage every few hours', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const before = (await alice!.t.repo.getConversation(convoId))!.mls!.epoch
    vi.useFakeTimers({ now: Date.now() + 8 * 86_400_000, toFake: ['Date'] })
    alice!.runtime.tick()
    alice!.runtime.tick() // already rotating: not twice
    await idle(80)
    expect((await alice!.t.repo.getConversation(convoId))!.mls!.epoch).toBe(before + 1)

    // A failing KeyPackage check is logged, not thrown.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.setSystemTime(Date.now() + 7 * 3600_000)
    alice!.t.vault.lock()
    alice!.runtime.tick()
    await idle()
    expect(warn).toHaveBeenCalled()
  })

  it('logs a key refresh that could not be published', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    net.offline = true
    // Info is logged to console.log, in development and tests.
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.useFakeTimers({ now: Date.now() + 8 * 86_400_000, toFake: ['Date'] })
    alice!.runtime.tick()
    await idle(80)
    expect(info.mock.calls.some((call) => String(call.join(' ')).includes('could not refresh keys'))).toBe(
      true,
    )
  })
})

describe('making and changing groups', () => {
  it('refuses what cannot be a group', async () => {
    const net = new Network()
    const alice = await device(net, 'alice')
    await idle()
    await expect(alice.runtime.createGroup({ members: [alice.pubkey], name: '' })).rejects.toThrow(
      /someone else/,
    )
    const crowd = Array.from({ length: MAX_MLS_MEMBERS }, () =>
      bytesToHex(new Uint8Array(32).map(() => Math.random() * 256)),
    )
    await expect(alice.runtime.createGroup({ members: crowd, name: '' })).rejects.toThrow(/at most/)
    const stranger = getPublicKey(generateSecretKey())
    const refused = alice.runtime.createGroup({ members: [stranger], name: '' })
    await expect(refused).rejects.toBeInstanceOf(MlsUnavailableError)
    await expect(refused).rejects.toMatchObject({ missing: [stranger] })
  })

  it('does not keep a group whose first commit never reached a relay', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    net.offline = true
    await expect(alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })).rejects.toThrow(
      /could not be reached/,
    )
    expect(await alice!.t.repo.listMlsGroups()).toEqual([])
    await expect(alice!.runtime.publish('nope', chatEvent(alice!, 'x'))).rejects.toThrow(/not in that group/)
  })

  it('adds only who can be added, and refuses a group past its size', async () => {
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: 'n' })
    const stranger = getPublicKey(generateSecretKey())
    expect(await alice!.runtime.addMembers(convoId, [stranger])).toEqual({ added: [], missing: [stranger] })
    const crowd = Array.from({ length: MAX_MLS_MEMBERS }, () =>
      bytesToHex(new Uint8Array(32).map(() => Math.random() * 256)),
    )
    await expect(alice!.runtime.addMembers(convoId, crowd)).rejects.toThrow(/at most/)
    expect(await alice!.runtime.addMembers(convoId, [carol!.pubkey, bob!.pubkey])).toEqual({
      added: [carol!.pubkey],
      missing: [],
    })
    expect(await alice!.runtime.readiness([carol!.pubkey, stranger])).toEqual({
      ready: [carol!.pubkey],
      missing: [stranger],
    })
  })

  it('removes an admin by first taking them off the admin list', async () => {
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    // Make Bob an admin through a leave: Alice hands the role on when she goes.
    const bobConvo = (await groupOf(bob!)).id
    await alice!.runtime.leave(convoId)
    await sync(bob!, carol!)
    expect((await groupOf(bob!)).mls!.admins.sort()).toEqual([bob!.pubkey, carol!.pubkey].sort())
    await bob!.runtime.removeMember(bobConvo, carol!.pubkey)
    await sync(bob!, carol!)
    expect((await groupOf(carol!)).mls!.left).toBe(true)
    expect((await groupOf(bob!)).mls!.admins).toEqual([bob!.pubkey])
    await bob!.runtime.leave('not-a-group') // nothing to leave
  })

  it('leaves alone, with requests pending, and after the conversation is gone', async () => {
    // Admins commit a request to leave a few seconds after it arrives.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    // Carol asks to leave; Alice has not committed it when she leaves herself.
    await carol!.runtime.leave((await groupOf(carol!)).id)
    alice!.pool.flush()
    await idle()
    await alice!.runtime.leave(convoId)
    await sync(bob!)
    await vi.advanceTimersByTimeAsync(6000)
    await sync(bob!)
    expect((await groupOf(bob!)).members).toEqual([])

    // The last one left leaves without anyone to tell, and a deleted
    // conversation is not brought back to mark it left.
    const bobConvo = (await groupOf(bob!)).id
    await bob!.t.repo.deleteConversation(bobConvo)
    await bob!.runtime.leave(bobConvo)
    expect(await bob!.t.repo.getConversation(bobConvo)).toBeNull()
  })
})

describe('joining', () => {
  it('turns down every Welcome it should, and takes one only once', async () => {
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const rumor = alice!.rumors[0]!.rumor
    bob!.standing.set(alice!.pubkey, 'blocked')
    expect(await bob!.runtime.receiveWelcome(rumor)).toBeNull()
    bob!.standing.set(alice!.pubkey, 'unknown')
    expect(await bob!.runtime.receiveWelcome({ ...rumor, content: 'junk' })).toBeNull()
    expect(await carol!.runtime.receiveWelcome(rumor)).toBeNull() // not a KeyPackage Carol holds
    expect(await bob!.runtime.receiveWelcome({ ...rumor, pubkey: carol!.pubkey })).toBeNull() // not an admin
    const id = await bob!.runtime.receiveWelcome(rumor)
    expect(id).not.toBeNull()
    expect((await groupOf(bob!)).accepted).toBe(false)
    // The consumed KeyPackage is gone, so a second copy finds nothing to open with…
    expect(await bob!.runtime.receiveWelcome(rumor)).toBeNull()
  })

  it('opens a duplicate Welcome as the group it already holds', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const rumor = alice!.rumors[0]!.rumor
    // A second device state holding the same KeyPackage: join, then the copy.
    const keys = await bob!.t.repo.listMlsKeys<{ ref: string }>()
    const first = await bob!.runtime.receiveWelcome(rumor)
    for (const key of keys) await bob!.t.repo.putMlsKey(key.ref, key)
    expect(await bob!.runtime.receiveWelcome(rumor)).toBe(first)
  })

  it('cannot join with a stored KeyPackage it cannot read', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const [key] = await bob!.t.repo.listMlsKeys<{ ref: string }>()
    await bob!.t.repo.putMlsKey(key!.ref, { ...key, publicPackage: 'AAAA' })
    expect(await bob!.runtime.receiveWelcome(alice!.rumors[0]!.rumor)).toBeNull()
  })

  it('refreshes a joiner’s keys soon after joining, unless a commit already has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // The earliest the refresh can be scheduled: a minute after joining.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle(80)
    await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    // Carol refreshes by hand first, a moment later; Bob's scheduled refresh
    // then runs, and hers finds nothing left to do.
    await vi.advanceTimersByTimeAsync(2000)
    await carol!.runtime.rotate((await groupOf(carol!)).id)
    // Everyone has it before any scheduled refresh can race it for the epoch.
    for (const d of [alice!, bob!]) d.pool.flush()
    await idle()
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(70_000)
      await idle()
      for (const d of [alice!, bob!, carol!]) d.pool.flush()
      await idle()
    }
    const epochs = await Promise.all([alice!, bob!, carol!].map(async (d) => (await groupOf(d)).mls!.epoch))
    expect(new Set(epochs).size).toBe(1)
    expect(epochs[0]).toBeGreaterThanOrEqual(3)
  })
})

describe('what arrives', () => {
  it('ignores what is not for a group it holds', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const junk = finalizeEvent(
      { kind: KIND_GROUP_EVENT, created_at: 1, tags: [['h', 'ef'.repeat(32)]], content: 'x' },
      generateSecretKey(),
    )
    const notAGroupEvent = finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content: '' },
      generateSecretKey(),
    )
    alice!.pool.deliver(junk)
    alice!.pool.deliver(notAGroupEvent)
    const route = (await groupOf(alice!)).mls!.group
    const garbled = finalizeEvent(
      { kind: KIND_GROUP_EVENT, created_at: 1, tags: [['h', route]], content: '%%%' },
      generateSecretKey(),
    )
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    alice!.pool.deliver(garbled)
    await idle()
    expect(await alice!.t.repo.hasSeen(garbled.id)).toBe(true)
    void debug
  })

  it('carries messages, recreates a conversation deleted under it, and rolls back a lost race', async () => {
    const net = new Network()
    const [low, high] = await ordered(net, 'low', 'high')
    await idle()
    const { convoId } = await low!.runtime.createGroup({ members: [high!.pubkey], name: '' })
    await welcome(low!, high!)
    const highConvo = (await groupOf(high!)).id

    // A message, and one after the conversation row was deleted underneath.
    await high!.runtime.chat.send(await groupOf(high!), 'first')
    await drain(high!)
    await low!.t.repo.deleteConversation(convoId)
    await high!.runtime.chat.send(await groupOf(high!), 'second')
    await drain(high!)
    await sync(low!)
    expect((await low!.t.repo.listMessages(convoId)).map((m) => m.body)).toEqual(['first', 'second'])

    // Both refresh at once; "low" sorts first and wins. "high" had already
    // said something in the epoch that loses, and sends it again.
    await low!.runtime.rotate(convoId)
    await high!.runtime.rotate(highConvo)
    const lost = await high!.runtime.chat.send(await groupOf(high!), 'from the lost branch')
    await drain(high!)
    high!.pool.flush()
    await idle(80)
    expect(high!.outbox.map((item) => item.id)).toContain(lost.id)
    await drain(high!)
    await sync(low!, high!)
    expect((await low!.t.repo.listMessages(convoId)).map((m) => m.body)).toContain('from the lost branch')
    expect((await groupOf(low!)).mls!.code).toBe((await groupOf(high!)).mls!.code)
  })

  it('stops at once when a commit removes it, whatever is queued behind', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    await welcome(alice!, bob!)
    await alice!.runtime.chat.send((await alice!.t.repo.getConversation(convoId))!, 'before')
    await drain(alice!)
    const message = net.events.at(-1)!
    await alice!.runtime.removeMember(convoId, bob!.pubkey)
    const removal = net.events.at(-1)!
    // The removal first, then the message behind it, delivered in one go.
    bob!.pool.deliver(removal)
    bob!.pool.deliver(message)
    await idle(80)
    expect((await groupOf(bob!)).mls!.left).toBe(true)
  })
})

describe('messages in a group', () => {
  async function pair() {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    await welcome(alice!, bob!)
    return { net, alice: alice!, bob: bob!, convoId, bobConvo: (await groupOf(bob!)).id }
  }

  it('sends, reacts, withdraws and retries, and says when it cannot', async () => {
    const { net, alice, bob, convoId } = await pair()
    const convo = (await alice.t.repo.getConversation(convoId))!
    const sent = await alice.runtime.chat.send(convo, 'hello')
    await drain(alice)
    expect((await alice.t.repo.getMessage(sent.id))?.status).toBe('sent')

    await alice.runtime.chat.react(convo, sent, '👍')
    await alice.runtime.chat.react(convo, sent, '🎉') // changes it
    await alice.runtime.chat.react(convo, sent, '🎉') // takes it back
    expect(await alice.t.repo.listReactionsFor([sent.id])).toEqual([])
    const elsewhere = { ...sent, convoId: 'elsewhere' }
    await expect(alice.runtime.chat.react(convo, elsewhere, '👍')).rejects.toThrow(/not in this conversation/)
    await expect(alice.runtime.chat.withdraw(convo, elsewhere)).rejects.toThrow(/not in this conversation/)
    await expect(alice.runtime.chat.withdraw(convo, { ...sent, call: {} as never })).rejects.toThrow(
      /not in this conversation/,
    )

    // A retry rebuilds exactly the same message; anything else is left alone.
    await alice.runtime.chat.retry(convo, sent)
    expect(alice.outbox.at(-1)?.id).toBe(sent.id)
    const before = alice.outbox.length
    await alice.runtime.chat.retry(convo, { ...sent, body: 'edited' })
    await alice.runtime.chat.retry(convo, { ...sent, direction: 'in' })
    await alice.runtime.chat.retry({ ...convo, mls: { ...convo.mls!, left: true } }, sent)
    await alice.runtime.chat.resend(convoId, ['0'.repeat(64)])
    await alice.runtime.chat.resend('no-such-conversation', [sent.id])
    expect(alice.outbox).toHaveLength(before)

    await alice.runtime.chat.withdraw(convo, sent)
    await drain(alice)
    await expect(
      alice.runtime.chat.send({ ...convo, mls: { ...convo.mls!, left: true } }, 'x'),
    ).rejects.toThrow(/no longer/)

    // Nowhere to send: the outbox is told why, whether relays said so or not.
    net.offline = true
    await alice.runtime.chat.send(convo, 'queued')
    await drain(alice)
    expect(alice.failed.at(-1)?.error).toBe('offline')
    vi.spyOn(alice.pool, 'dispatch').mockReturnValue({
      quorum: Promise.resolve([]),
      settled: Promise.resolve([]),
    })
    net.offline = false
    await alice.runtime.chat.send(convo, 'no relays')
    await drain(alice)
    expect(alice.failed.at(-1)?.error).toBe('no relay accepted the message')
    const orphan = { ...alice.outbox[0], id: 'x' } as OutboxItem
    await alice.runtime.chat.deliver({
      ...orphan,
      convoId: 'gone',
      rumorJson: JSON.stringify(chatEvent(alice, 'x')),
    })
    expect(alice.failed.at(-1)?.error).toMatch(/not in that group/)
    void bob
  })

  it('delivers a message whose stored copy is gone without complaint', async () => {
    const { alice, convoId } = await pair()
    const convo = (await alice.t.repo.getConversation(convoId))!
    const sent = await alice.runtime.chat.send(convo, 'short-lived')
    await alice.t.repo.deleteMessageAndPayload(sent.id)
    await drain(alice)
    expect(alice.emitted).not.toContain('messageUpdated')
  })

  it('reads what arrives by the rules of the group', async () => {
    const { alice, bob, convoId, bobConvo } = await pair()
    const convo = (await bob.t.repo.getConversation(bobConvo))!
    const ingest = (event: InnerEvent) => bob.runtime.chat.ingest(convo, event)
    const hello = chatEvent(alice, 'hello')
    await ingest(hello)
    await ingest(hello) // twice: once
    await ingest(chatEvent(alice, '')) // empty
    await ingest(chatEvent(alice, 'x'.repeat(MAX_MESSAGE_CHARS + 1))) // too long
    await ingest({ ...chatEvent(alice, 'odd'), kind: 1 }) // not a kind this group carries
    bob.viewing = true
    await ingest(chatEvent(alice, 'seen at once'))
    // Both within one second, so compared as a set.
    expect((await bob.t.repo.listMessages(bobConvo)).map((m) => m.body).sort()).toEqual([
      'hello',
      'seen at once',
    ])

    // Another device of this account: its messages are ours.
    const fromOtherDevice = chatEvent(bob, 'from my other device')
    await ingest(fromOtherDevice)
    expect(await bob.t.repo.getMessage(fromOtherDevice.id)).toMatchObject({
      direction: 'out',
      status: 'sent',
    })

    // Blocked authors are not heard.
    await bob.t.repo.upsertContact(alice.pubkey, { blocked: true })
    await ingest(chatEvent(alice, 'blocked'))
    await bob.t.repo.upsertContact(alice.pubkey, { blocked: false })

    // Deletions: only of what the author wrote, here.
    const reaction = { ...chatEvent(alice, '👍', [['e', hello.id]]), kind: 7 }
    await ingest(reaction as InnerEvent)
    const mine = (await bob.t.repo.getMessage(fromOtherDevice.id))!
    const del = (tags: string[][], from = alice) => ({ ...chatEvent(from, '', tags), kind: 5 }) as InnerEvent
    await ingest(del([['e', mine.id]])) // Bob's, not Alice's
    await ingest(del([['e', reaction.id]], bob)) // Alice's reaction, not Bob's
    await ingest(
      del([
        ['p', alice.pubkey],
        ['e', 'not-hex'],
        ['e', reaction.id],
        ['e', hello.id],
      ]),
    )
    expect(await bob.t.repo.getMessage(hello.id)).toBeNull()
    expect(await bob.t.repo.listReactionsFor([hello.id])).toEqual([])
    const ahead = chatEvent(alice, 'deleted before it arrives')
    await ingest(del([['e', ahead.id]]))
    await ingest(ahead)
    expect(await bob.t.repo.getMessage(ahead.id)).toBeNull()
    await bob.t.repo.putMessage({
      ...mine,
      id: 'c'.repeat(64),
      authorPubkey: alice.pubkey,
      call: { media: 'audio', outcome: 'missed' } as never,
    })
    await ingest(del([['e', 'c'.repeat(64)]]))
    expect(await bob.t.repo.getMessage('c'.repeat(64))).not.toBeNull()
    void convoId
  })

  it('refuses to send without a key', async () => {
    const { alice, convoId } = await pair()
    alice.secretKey = null
    await expect(
      alice.runtime.chat.send((await alice.t.repo.getConversation(convoId))!, 'x'),
    ).rejects.toThrow(/not running/)
    expect((await alice.t.repo.getConversation(convoId))?.mls).toBeDefined()
    void ({} as Message)
  })
})

describe('the queue behind a group', () => {
  it('does nothing more for a group once a commit in its queue removes it', async () => {
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    // Alice refreshes (c1), then removes Bob (c2); Carol speaks after.
    await alice!.runtime.rotate(convoId)
    const c1 = net.events.at(-1)!
    await alice!.runtime.removeMember(convoId, bob!.pubkey)
    const c2 = net.events.at(-1)!
    carol!.pool.flush()
    await idle(80)
    await carol!.runtime.chat.send(await groupOf(carol!), 'after Bob')
    await drain(carol!)
    const late = net.events.at(-1)!
    // Bob hears the removal and the message before the commit they follow:
    // both wait, and draining them stops at the removal.
    bob!.pool.deliver(c2)
    bob!.pool.deliver(late)
    await idle(80)
    bob!.pool.deliver(c1)
    // …and a leave he asks for meanwhile waits behind it, then finds nothing to do.
    const leaving = bob!.runtime.leave((await groupOf(bob!)).id)
    await idle(120)
    await leaving
    expect((await groupOf(bob!)).mls!.left).toBe(true)
    expect(await bob!.t.repo.listMessages((await groupOf(bob!)).id)).toEqual([])
  })

  it('lets an admin who is the last one left simply go', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    await welcome(alice!, bob!)
    await bob!.runtime.leave((await groupOf(bob!)).id)
    alice!.pool.flush()
    await idle(80)
    const before = net.events.length
    await alice!.runtime.leave(convoId)
    // Bob's request committed; nobody to hand the role to, nobody to ask.
    expect(net.events.length).toBe(before + 1)
    expect((await groupOf(alice!)).mls!.left).toBe(true)
  })

  it('finds nothing to commit when a request to leave was already committed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    await carol!.runtime.leave((await groupOf(carol!)).id)
    alice!.pool.flush()
    await idle(80)
    // Alice refreshes at once, which commits the request with it.
    await alice!.runtime.rotate(convoId)
    const events = net.events.length
    await vi.advanceTimersByTimeAsync(6000)
    await idle(80)
    expect(net.events.length).toBe(events)
    expect((await groupOf(alice!)).members).toEqual([bob!.pubkey])
  })

  it('logs a replacement KeyPackage that could not be published after joining', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(bob!.pool, 'publish').mockRejectedValue(new Error('socket gone'))
    await welcome(alice!, bob!)
    await idle(80)
    expect(warn.mock.calls.some((call) => String(call[0]).includes('KeyPackage replacement failed'))).toBe(
      true,
    )
  })

  it('retries a message whose stored copy has gone without announcing it', async () => {
    const net = new Network()
    const [alice, bob] = await ordered(net, 'alice', 'bob')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey], name: '' })
    const convo = (await alice!.t.repo.getConversation(convoId))!
    const sent = await alice!.runtime.chat.send(convo, 'gone soon')
    await alice!.t.repo.deleteMessageAndPayload(sent.id)
    alice!.emitted.length = 0
    await alice!.runtime.chat.retry(convo, sent)
    expect(alice!.emitted).not.toContain('messageUpdated')
    expect(alice!.outbox.at(-1)?.id).toBe(sent.id)
  })

  it('hands the admin role to the admins who stay, when there are any', async () => {
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    await alice!.runtime.leave(convoId)
    await sync(bob!, carol!)
    // Bob and Carol are both admins now: Carol going leaves it to Bob alone.
    await carol!.runtime.leave((await groupOf(carol!)).id)
    await sync(bob!)
    expect((await groupOf(bob!)).mls!.admins).toEqual([bob!.pubkey])
  })

  it('keeps a request to leave for later when its commit cannot go out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const net = new Network()
    const [alice, bob, carol] = await ordered(net, 'alice', 'bob', 'carol')
    await idle()
    const { convoId } = await alice!.runtime.createGroup({ members: [bob!.pubkey, carol!.pubkey], name: '' })
    await welcome(alice!, bob!, carol!)
    await carol!.runtime.leave((await groupOf(carol!)).id)
    alice!.pool.flush()
    await idle(80)
    net.offline = true
    const events = net.events.length
    await vi.advanceTimersByTimeAsync(6000)
    await idle(80)
    expect(net.events.length).toBe(events)
    net.offline = false
    // Still waiting: the next change commits it.
    await alice!.runtime.rotate(convoId)
    expect((await groupOf(alice!)).members).toEqual([bob!.pubkey])
  })

  it('logs KeyPackage upkeep that fails as it starts', async () => {
    const net = new Network()
    const [alice] = await ordered(net, 'alice')
    await idle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(alice!.t.repo, 'listMlsKeys').mockRejectedValue(new Error('storage gone'))
    const again = new MlsRuntime(alice!.host)
    await again.start()
    await idle()
    expect(warn.mock.calls.some((call) => String(call[0]).includes('KeyPackage upkeep failed'))).toBe(true)
    again.stop()
  })
})
