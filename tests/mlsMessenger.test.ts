import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings, type Conversation, type Message } from '@/core/models/types'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { createRumor, giftWrap } from '@/core/crypto/giftwrap'
import { KIND_MLS_WELCOME, MAX_MLS_MEMBERS } from '@/core/models/protocol'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'
// Loaded up front so the engine's lazy import resolves at once under fake timers.
import { MlsRuntime } from '@/core/mls/runtime'

/**
 * Forward-secret groups through the whole engine: invitations over the
 * inbox, messages over the group's relays, and every change a member can
 * make — with the MLS runtime loaded lazily exactly as the app loads it.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  name: string
  pubkey: string
  vault: TestVault
  messenger: Messenger
}

async function makePeer(
  network: FakeRelayNetwork,
  name: string,
  overrides: Partial<AppSettings> = {},
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
  const messenger = new Messenger(
    vault.vault,
    vault.repo,
    { ...settings, ...overrides },
    new FakeRelayPool(network),
  )
  await messenger.start(secretKeyHex, identity.publicKey)
  return { name, pubkey: identity.publicKey, vault, messenger }
}

const realTimeout = globalThis.setTimeout
/** Advance the fake clock, letting real work — crypto, storage — finish in between. */
async function settle(ms = 2000): Promise<void> {
  for (let spent = 0; spent < ms; spent += 250) {
    await vi.advanceTimersByTimeAsync(Math.min(250, ms - spent))
    await new Promise((resolve) => realTimeout(resolve, 0))
  }
}

/** Stop a peer's engine and start a fresh one on the same vault. */
async function restart(peer: Peer, overrides: Partial<AppSettings> = {}): Promise<void> {
  peer.messenger.stop()
  peer.messenger = new Messenger(
    peer.vault.vault,
    peer.vault.repo,
    { ...settings, ...overrides },
    new FakeRelayPool(currentNetwork),
  )
  const secretKeyHex = (await peer.vault.repo.getIdentity())!.secretKeyHex
  await peer.messenger.start(secretKeyHex, peer.pubkey)
}

let currentNetwork: FakeRelayNetwork

async function secureGroups(peer: Peer): Promise<Conversation[]> {
  return (await peer.vault.repo.listConversations()).filter((c) => c.mls)
}

/**
 * The same group's conversation id on another device. Ids are blinded with
 * each vault's own key, so they differ from device to device.
 */
async function on(peer: Peer, origin: Peer, id: string): Promise<string> {
  const route = (await origin.vault.repo.getConversation(id))?.mls?.group
  if (!route) throw new Error('not a forward-secret group')
  return peer.vault.repo.mlsConversationId(route)
}

async function bodies(peer: Peer, convoId: string): Promise<string[]> {
  return (await peer.vault.repo.listMessages(convoId)).map((m: Message) => m.body)
}

describe('forward-secret groups through the engine', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer
  const everyone = () => [alice, bob, carol]

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    currentNetwork = network
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    for (const a of everyone()) {
      for (const b of everyone()) {
        if (a !== b) await a.vault.repo.upsertContact(b.pubkey, { name: b.name, accepted: true })
      }
    }
    // Each device publishes its KeyPackage shortly after start, off the start-up path.
    await settle(25_000)
  })

  afterEach(async () => {
    for (const peer of everyone()) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('publishes a KeyPackage for each device, and finds who can be invited', async () => {
    expect(
      network.events
        .filter((e) => e.kind === 30443)
        .map((e) => e.pubkey)
        .sort(),
    ).toEqual(
      everyone()
        .map((p) => p.pubkey)
        .sort(),
    )
    const stranger = createIdentity().identity.publicKey
    expect(await alice.messenger.mlsReadiness([bob.pubkey, stranger])).toEqual({
      ready: [bob.pubkey],
      missing: [stranger],
    })
  })

  it('invites, then carries messages, replies, reactions and deletions to everyone', async () => {
    const { id, missing } = await alice.messenger.createSecureGroup([bob.pubkey, carol.pubkey], 'Plans')
    expect(missing).toEqual([])
    await settle()

    for (const peer of [bob, carol]) {
      const [group] = await secureGroups(peer)
      expect(group).toMatchObject({
        id: await on(peer, alice, id),
        subject: 'Plans',
        accepted: true,
        kind: 'group',
      })
      expect(group!.members.sort()).toEqual(
        everyone()
          .map((p) => p.pubkey)
          .filter((p) => p !== peer.pubkey)
          .sort(),
      )
      expect(group!.mls).toMatchObject({ admins: [alice.pubkey], epoch: 1 })
      expect(group!.mls!.code).toBe((await secureGroups(alice))[0]!.mls!.code)
    }
    // The KeyPackage a Welcome consumed is replaced.
    expect(network.events.filter((e) => e.kind === 30443 && e.pubkey === bob.pubkey).length).toBeGreaterThan(
      1,
    )

    const bobId = await on(bob, alice, id)
    const carolId = await on(carol, alice, id)
    const first = await alice.messenger.sendMessage(id, 'hello, group')
    await settle()
    expect((await alice.vault.repo.getMessage(first.id))?.status).toBe('sent')
    expect(await bodies(bob, bobId)).toEqual(['hello, group'])
    expect(await bodies(carol, carolId)).toEqual(['hello, group'])
    expect((await bob.vault.repo.getConversation(bobId))?.unread).toBe(1)

    const reply = await bob.messenger.sendMessage(bobId, 'hi Alice', first.id)
    await settle()
    const seen = await carol.vault.repo.getMessage(reply.id)
    expect(seen).toMatchObject({ body: 'hi Alice', replyTo: first.id, authorPubkey: bob.pubkey })

    await carol.messenger.react(carolId, first.id, '👍')
    await settle()
    expect((await alice.vault.repo.listReactionsFor([first.id])).map((r) => r.emoji)).toEqual(['👍'])
    await carol.messenger.react(carolId, first.id, '👍') // the same again takes it back
    await settle()
    expect(await alice.vault.repo.listReactionsFor([first.id])).toEqual([])

    await bob.messenger.redactMessage(bobId, reply.id)
    await settle()
    expect(await carol.vault.repo.getMessage(reply.id)).toBeNull()
    await expect(carol.messenger.redactMessage(carolId, first.id)).rejects.toThrow(/did not write/)

    // Nothing on the relays names a member or carries anything readable.
    for (const event of network.events.filter((e) => e.kind === 445)) {
      expect(event.tags.map((t) => t[0])).toEqual(['h'])
      for (const peer of everyone()) expect(event.pubkey).not.toBe(peer.pubkey)
      expect(event.content).not.toContain('hello')
    }
    // Small-group features are refused rather than sent the wrong way.
    await expect(
      alice.messenger.sendPoll(id, {
        question: 'q?',
        options: [
          { id: 'a', label: 'a' },
          { id: 'b', label: 'b' },
        ],
        multi: false,
      } as never),
    ).rejects.toThrow()
  })

  it('adds and removes people, and the removed person can no longer read the group', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    const bobId = await on(bob, alice, id)
    await expect(bob.messenger.addGroupMembers(bobId, [carol.pubkey])).rejects.toThrow(/only an admin/)

    expect(await alice.messenger.addGroupMembers(id, [carol.pubkey])).toEqual({
      added: [carol.pubkey],
      missing: [],
    })
    await settle()
    const carolId = await on(carol, alice, id)
    expect((await secureGroups(carol))[0]?.id).toBe(carolId)
    await alice.messenger.sendMessage(id, 'welcome, Carol')
    await settle()
    expect(await bodies(carol, carolId)).toEqual(['welcome, Carol'])

    await alice.messenger.removeGroupMember(id, bob.pubkey)
    await settle()
    expect((await bob.vault.repo.getConversation(bobId))?.mls?.left).toBe(true)
    expect(await bob.vault.repo.getMlsGroup(bobId)).toBeNull()
    await alice.messenger.sendMessage(id, 'after Bob')
    await settle()
    expect(await bodies(carol, carolId)).toContain('after Bob')
    expect(await bodies(bob, bobId)).not.toContain('after Bob')
    await expect(bob.messenger.sendMessage(bobId, 'still here?')).rejects.toThrow(/no longer in this group/)
  })

  it('lets a member leave, and hands on the admin role when the admin does', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey, carol.pubkey], 'Three')
    await settle()
    const carolId = await on(carol, alice, id)
    await carol.messenger.leaveGroup(carolId)
    await settle(10_000)
    expect((await carol.vault.repo.getConversation(carolId))?.mls?.left).toBe(true)
    // Alice, the admin, committed Carol's request.
    expect((await alice.vault.repo.getConversation(id))?.members).toEqual([bob.pubkey])

    await alice.messenger.leaveGroup(id)
    await settle(10_000)
    const bobs = await bob.vault.repo.getConversation(await on(bob, alice, id))
    expect(bobs?.mls?.admins).toEqual([bob.pubkey])
    expect(bobs?.members).toEqual([])
  })

  it('refreshes keys on request and moves everyone to the new epoch', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    const bobId = await on(bob, alice, id)
    const before = (await bob.vault.repo.getConversation(bobId))!.mls!
    await bob.messenger.rotateGroupKeys(bobId)
    await settle()
    const after = (await alice.vault.repo.getConversation(id))!.mls!
    expect(after.epoch).toBeGreaterThan(before.epoch)
    expect(after.code).not.toBe(before.code)
    expect((await bob.vault.repo.getConversation(bobId))!.mls!.refreshedAt).toBeGreaterThan(
      before.refreshedAt - 1,
    )
    await alice.messenger.sendMessage(id, 'new keys')
    await settle()
    expect(await bodies(bob, bobId)).toEqual(['new keys'])
  })

  it('shows an invitation from a stranger as a request, and ignores one from someone blocked', async () => {
    await bob.vault.repo.upsertContact(alice.pubkey, { accepted: false })
    await carol.vault.repo.upsertContact(alice.pubkey, { blocked: true })
    await alice.messenger.createSecureGroup([bob.pubkey, carol.pubkey], 'Hmm')
    await settle()
    expect((await secureGroups(bob))[0]?.accepted).toBe(false)
    expect(await secureGroups(carol)).toEqual([])
  })

  it('reports who cannot be added, and refuses when nobody can', async () => {
    const stranger = createIdentity().identity.publicKey
    const { missing } = await alice.messenger.createSecureGroup([bob.pubkey, stranger], '')
    expect(missing).toEqual([stranger])
    await expect(alice.messenger.createSecureGroup([stranger], '')).rejects.toThrow(/can be added/)
  })

  it('withdraws the KeyPackage when invitations are turned off', async () => {
    await bob.messenger.applySettings({ ...bob.messenger.settings, mlsInvites: false })
    await settle()
    expect(network.events.some((e) => e.kind === 5 && e.pubkey === bob.pubkey)).toBe(true)
    expect(await bob.vault.repo.listMlsKeys()).toEqual([])
  })

  it('keeps listening after a restart', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    bob.messenger.stop()
    bob.messenger = new Messenger(bob.vault.vault, bob.vault.repo, settings, new FakeRelayPool(network))
    const secretKeyHex = (await bob.vault.repo.getIdentity())!.secretKeyHex
    await bob.messenger.start(secretKeyHex, bob.pubkey)
    await settle()
    await alice.messenger.sendMessage(id, 'after your restart')
    await settle()
    expect(await bodies(bob, await on(bob, alice, id))).toEqual(['after your restart'])
  })

  it('refuses what cannot be a group, and leaving what it is not in', async () => {
    await expect(alice.messenger.createSecureGroup(['not a key'])).rejects.toThrow(/not a public key/)
    const crowd = Array.from({ length: MAX_MLS_MEMBERS }, (_, i) => i.toString(16).padStart(64, '0'))
    await expect(alice.messenger.createSecureGroup(crowd)).rejects.toThrow(/at most/)
    await alice.messenger.leaveGroup('f'.repeat(64)) // no such group: nothing to do
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    // Opening it sends no read receipts: nobody tracks who read what in a group this size.
    const wraps = network.events.filter((e) => e.kind === 1059).length
    await alice.messenger.openConversation(id)
    await settle()
    expect(network.events.filter((e) => e.kind === 1059).length).toBe(wraps)
    alice.messenger.stop()
    await expect(alice.messenger.createSecureGroup([bob.pubkey])).rejects.toThrow(/not running/)
  })

  it('sends a message again through the group, under its id', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    const sent = await alice.messenger.sendMessage(id, 'once, and again')
    await settle()
    await alice.messenger.retryMessage(sent.id)
    await settle()
    expect((await alice.vault.repo.getMessage(sent.id))?.status).toBe('sent')
    expect(await bodies(bob, await on(bob, alice, id))).toEqual(['once, and again'])
  })

  it('ignores an invitation from itself, and logs one it could not take', async () => {
    const welcome = vi.spyOn(MlsRuntime.prototype, 'receiveWelcome')
    const aliceSk = hexToBytes((await alice.vault.repo.getIdentity())!.secretKeyHex)
    const bobSk = hexToBytes((await bob.vault.repo.getIdentity())!.secretKeyHex)
    const rumor = (sk: Uint8Array) => createRumor({ kind: KIND_MLS_WELCOME, content: 'AAAA', tags: [] }, sk)
    network.publish(giftWrap(rumor(aliceSk), aliceSk, alice.pubkey))
    await settle()
    expect(welcome).not.toHaveBeenCalled()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    welcome.mockRejectedValueOnce(new Error('not for us'))
    network.publish(giftWrap(rumor(bobSk), bobSk, alice.pubkey))
    await settle()
    expect(welcome).toHaveBeenCalledTimes(1)
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('could not process a group invitation')),
    ).toBe(true)
  })

  it('logs a KeyPackage it could not update when invitations are switched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(MlsRuntime.prototype, 'ensureKeyPackage').mockRejectedValue(new Error('relays down'))
    await bob.messenger.applySettings({ ...bob.messenger.settings, mlsInvites: false })
    await settle()
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('could not update the published KeyPackage')),
    ).toBe(true)
  })

  it('holds a group message while the runtime cannot load, and sends it once it can', async () => {
    const { id } = await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    network.offline = true
    const sent = await alice.messenger.sendMessage(id, 'waited for the chunk')
    await settle(500)
    network.offline = false

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const start = vi.spyOn(MlsRuntime.prototype, 'start').mockRejectedValue(new Error('chunk failed to load'))
    await restart(alice)
    await settle(1000)
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('forward-secret groups did not start')),
    ).toBe(true)
    // The outbox tried it, could not load the runtime, and kept it for later.
    await settle(6000)
    expect((await alice.vault.repo.getOutboxItem(sent.id))?.lastError).toMatch(/chunk failed/)

    start.mockRestore()
    await settle(120_000)
    expect(await bodies(bob, await on(bob, alice, id))).toEqual(['waited for the chunk'])
  })

  it('stops a runtime that finishes loading after the engine stopped', async () => {
    await alice.messenger.createSecureGroup([bob.pubkey], '')
    await settle()
    const original = MlsRuntime.prototype.start
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const stop = vi.spyOn(MlsRuntime.prototype, 'stop')
    vi.spyOn(MlsRuntime.prototype, 'start').mockImplementation(async function (this: MlsRuntime) {
      await gate
      return original.call(this)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await restart(alice)
    await settle(500) // loading, held at the gate
    alice.messenger.stop()
    stop.mockClear()
    release()
    await settle(500)
    expect(stop).toHaveBeenCalled()
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('forward-secret groups did not start')),
    ).toBe(true)
  })
})

describe('when the group runtime loads', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const day = 86_400
  let peer: Peer | null = null

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentNetwork = new FakeRelayNetwork()
  })

  afterEach(async () => {
    peer?.messenger.stop()
    await peer?.vault.destroy()
    peer = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const key = (patch: { notAfter?: number; publishedAt?: number; replacedAt?: number }) => ({
    notAfter: now() + 60 * day,
    publishedAt: now() - day,
    ...patch,
  })

  it.each([
    ['a fresh published KeyPackage, invitations on', true, [key({})], false],
    ['one never acknowledged by a relay', true, [key({ publishedAt: 0 })], true],
    ['one close to expiring', true, [key({ notAfter: now() + 3 * day })], true],
    ['only expired ones', true, [key({ notAfter: now() - day })], true],
    ['one replaced within the grace period', true, [key({}), key({ replacedAt: now() - day })], false],
    ['one replaced long ago', true, [key({}), key({ replacedAt: now() - 30 * day })], true],
    ['invitations off, and a KeyPackage to withdraw', false, [key({})], true],
    ['invitations off, and nothing published', false, [], false],
  ])('with %s: loads it = %s', async (_label, invites, keys, loads) => {
    await startLoader(invites, keys)
    expect(start.mock.calls.length > 0).toBe(loads)
  })

  it('tries again later when the runtime cannot load in the background', async () => {
    start.mockRejectedValue(new Error('chunk failed to load'))
    await startLoader(true, [])
    expect(start).toHaveBeenCalled()
    start.mockResolvedValue(undefined)
    // The next group operation loads it afresh.
    expect(await peer!.messenger.mlsReadiness([])).toEqual({ ready: [], missing: [] })
  })

  let start: MockInstance<MlsRuntime['start']>
  beforeEach(() => {
    start = vi.spyOn(MlsRuntime.prototype, 'start').mockResolvedValue(undefined)
  })

  async function startLoader(invites: boolean, keys: object[]): Promise<void> {
    const { identity } = createIdentity()
    const vault = await makeVault('loader-pw')
    await vault.repo.putIdentity({
      pubkey: identity.publicKey,
      npub: identity.npub,
      secretKeyHex: bytesToHex(identity.secretKey),
      name: 'Loader',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
    })
    for (const [i, k] of keys.entries()) await vault.repo.putMlsKey(`ref-${i}`, k)
    const messenger = new Messenger(
      vault.vault,
      vault.repo,
      { ...settings, mlsInvites: invites },
      new FakeRelayPool(currentNetwork),
    )
    peer = { name: 'Loader', pubkey: identity.publicKey, vault, messenger }
    await messenger.start(bytesToHex(identity.secretKey), identity.publicKey)
    await settle(25_000)
  }
})
