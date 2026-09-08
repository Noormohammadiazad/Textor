import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import {
  createApplicationMessage,
  createCommit,
  createGroupInfoWithExternalPub,
  createProposal,
  decodeGroupState,
  decodeMlsMessage,
  encodeMlsMessage,
  joinGroupExternal,
  type ClientState,
  type MLSMessage,
} from 'ts-mls'
import {
  createKeyPackage,
  groupContextExtensions,
  groupEventKey,
  keyPackageEvent,
  openGroupEvent,
  parseKeyPackageEvent,
  sealGroupEvent,
  type AppEvent,
  type KeyPackageCandidate,
} from '@/core/mls/marmot'
import {
  clientConfig,
  compareCommitKeys,
  MarmotGroup,
  RETAINED_EPOCHS,
  ROLLBACK_WINDOW_MS,
  type Identity,
  type KeyPackageBundle,
  type OpenOutcome,
} from '@/core/mls/group'
import { SUITE } from '@/core/mls/suite'
import { b64ToBytes } from '@/core/util/bytes'

/**
 * A Marmot group as its members see it: who may change it, what happens when
 * two of them commit at once, and the two properties the whole thing exists
 * for — forward secrecy and post-compromise security — shown directly.
 */

interface Member {
  name: string
  identity: Identity
  bundle: KeyPackageBundle
  candidate: KeyPackageCandidate
}

const nowSec = () => Math.floor(Date.now() / 1000)
const ROUTING = { nostrGroupId: 'cd'.repeat(32), relays: ['wss://group.example'] }

async function member(name: string): Promise<Member> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const bundle = await createKeyPackage(secretKey, pubkey)
  const event = await keyPackageEvent(secretKey, bundle.publicPackage, 'ab'.repeat(32), nowSec())
  return { name, identity: { pubkey, secretKey }, bundle, candidate: await parseKeyPackageEvent(event) }
}

/** A group founded by `admin`, with everyone else joined through the Welcome. */
async function found(admin: Member, ...others: Member[]): Promise<MarmotGroup[]> {
  const group = await MarmotGroup.create(admin.bundle, {
    routing: ROUTING,
    profile: { name: 'Team', description: '' },
    admins: [admin.identity.pubkey],
  })
  if (others.length === 0) return [group]
  const pending = await group.commit(admin.identity, { add: others.map((o) => o.candidate) })
  expect(await group.confirm(pending)).toBe(true)
  const joined = await Promise.all(
    others.map((o) =>
      MarmotGroup.join(pending.welcome!, o.bundle, {
        inviter: admin.identity.pubkey,
        self: o.identity.pubkey,
        at: nowSec(),
      }),
    ),
  )
  return [group, ...joined]
}

function chat(from: Member, content: string): AppEvent {
  const base = { pubkey: from.identity.pubkey, created_at: nowSec(), kind: 9, tags: [], content }
  return { ...base, id: getEventHash(base) }
}

const body = (outcome: OpenOutcome) => (outcome.kind === 'application' ? outcome.event.content : outcome.kind)

describe('a Marmot group', () => {
  it('founds a group, adds people, and carries messages between every member', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    expect(a!.view()).toMatchObject({
      members: [alice.identity.pubkey, bob.identity.pubkey, carol.identity.pubkey],
      admins: [alice.identity.pubkey],
      profile: { name: 'Team' },
      relays: ROUTING.relays,
      active: true,
      epoch: 1,
    })
    expect(b!.epochAuthenticator).toBe(a!.epochAuthenticator)

    const hello = await a!.encrypt(chat(alice, 'hello both'))
    expect(body(await b!.open(hello))).toBe('hello both')
    expect(body(await c!.open(hello))).toBe('hello both')
    // Our own message coming back, and a second copy of someone else's.
    expect(await a!.open(hello)).toMatchObject({ kind: 'ignored' })
    expect(await b!.open(hello)).toMatchObject({ kind: 'ignored' })

    const reply = await b!.encrypt(chat(bob, 'hi'))
    expect(body(await a!.open(reply))).toBe('hi')
    expect(body(await c!.open(reply))).toBe('hi')
  })

  it('lets only an admin change who is in it, on every device', async () => {
    const [alice, bob, dave] = await Promise.all([member('alice'), member('bob'), member('dave')])
    const [a, b] = await found(alice, bob)
    await expect(b!.commit(bob.identity, { add: [dave.candidate] })).rejects.toThrow(/only an admin/)

    // A client that skips the rule: Bob's own state, driven by ts-mls directly.
    const record = b!.toRecord()
    const state = { ...decodeGroupState(b64ToBytes(record.state), 0)![0], clientConfig: clientConfig() }
    const rogue = await createCommit(
      { state, cipherSuite: SUITE },
      {
        extraProposals: [{ proposalType: 'add', add: { keyPackage: dave.candidate.keyPackage } }],
        wireAsPublicMessage: true,
      },
    )
    const event = sealGroupEvent(
      await groupEventKey(state),
      ROUTING.nostrGroupId,
      encodeMlsMessage(rogue.commit),
    )
    expect(await a!.open(event)).toEqual({ kind: 'ignored', reason: 'commit not allowed' })
    expect(a!.view().members).toHaveLength(2)
  })

  it('refuses a Welcome sent by someone who is not an admin', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a] = await found(alice)
    const pending = await a!.commit(alice.identity, { add: [bob.candidate] })
    await a!.confirm(pending)
    await expect(
      MarmotGroup.join(pending.welcome!, bob.bundle, {
        inviter: carol.identity.pubkey,
        self: bob.identity.pubkey,
        at: nowSec(),
      }),
    ).rejects.toThrow(/not an admin/)
    await expect(
      MarmotGroup.join(pending.welcome!, bob.bundle, {
        inviter: alice.identity.pubkey,
        self: carol.identity.pubkey,
        at: nowSec(),
      }),
    ).rejects.toThrow(/does not add this account/)
  })

  it('publishes before it applies, and a commit that lost is not applied', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    const mine = await b!.commit(bob.identity)
    expect(b!.epoch).toBe(1n)
    // Alice's changes the group's settings, which only an admin may do: it
    // sorts before Bob's whatever the digests say.
    const theirs = await a!.commit(alice.identity, { profile: { name: 'Team', description: 'ours' } })
    await a!.confirm(theirs)
    expect(await b!.open(theirs.event)).toMatchObject({ kind: 'commit', epoch: 2 })
    // Bob's commit was for epoch 1, which Alice's has since closed, and it lost.
    expect(compareCommitKeys(mine.key, theirs.key)).toBeGreaterThan(0)
    expect(await b!.confirm(mine)).toBe(false)
    expect(b!.epochAuthenticator).toBe(a!.epochAuthenticator)
    // Abandoning an unpublished commit leaves nothing behind.
    const unused = await b!.commit(bob.identity)
    b!.abandon(unused)
    expect(b!.epoch).toBe(2n)
  })

  it('converges when two members commit at once, whatever order others see them in', async () => {
    const people = await Promise.all(['alice', 'bob', 'carol', 'dave'].map(member))
    const [alice, bob] = people as [Member, Member]
    const [a, b, c, d] = await found(alice, bob, people[2]!, people[3]!)

    const fromA = await a!.commit(alice.identity)
    const fromB = await b!.commit(bob.identity)
    // Each publishes, sees its own acknowledged, and applies it.
    expect(await a!.confirm(fromA)).toBe(true)
    expect(await b!.confirm(fromB)).toBe(true)
    // Bob says something in his branch before he hears of Alice's commit.
    const early = chat(bob, 'said in the branch that may lose')
    const earlyEvent = await b!.encrypt(early)

    const outcomes = {
      a: await a!.open(fromB.event),
      b: await b!.open(fromA.event),
      c: [await c!.open(fromA.event), await c!.open(fromB.event)],
      d: [await d!.open(fromB.event), await d!.open(fromA.event)],
    }
    void outcomes
    const auth = new Set([a, b, c, d].map((g) => g!.epochAuthenticator))
    expect(auth.size).toBe(1)

    const winner = compareCommitKeys(fromA.key, fromB.key) < 0 ? 'alice' : 'bob'
    if (winner === 'alice') {
      // Bob rolled back: his message from the lost branch is handed back to be resent.
      expect(outcomes.b).toMatchObject({ kind: 'commit', rolledBack: [early.id] })
      expect(await c!.open(earlyEvent)).toMatchObject({ kind: expect.stringMatching(/deferred|ignored/) })
    } else {
      expect(outcomes.a).toMatchObject({ kind: 'commit', rolledBack: [] })
    }

    // Whoever won, everyone can talk again.
    const after = await c!.encrypt(chat(people[2]!, 'converged'))
    for (const g of [a, b, d]) expect(body(await g!.open(after))).toBe('converged')
  })

  it('gives up waiting for a race to settle once the window has passed', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    const fromA = await a!.commit(alice.identity)
    const fromB = await b!.commit(bob.identity)
    await c!.open(fromA.event)
    vi.useFakeTimers({ now: Date.now() + ROLLBACK_WINDOW_MS + 1000 })
    try {
      c!.expire()
      expect(await c!.open(fromB.event)).toEqual({ kind: 'ignored', reason: 'stale commit' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps forward secrecy: once past epochs are gone, old messages are unreadable', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    const early = await a!.encrypt(chat(alice, 'from epoch one'))
    expect(body(await b!.open(early))).toBe('from epoch one')
    // Its key was used up by reading it: a replay reads nothing.
    expect(await b!.open(early)).toMatchObject({ kind: 'ignored' })

    // A second copy that Bob never read, so only the epoch's keys protect it.
    const unread = await a!.encrypt(chat(alice, 'also from epoch one'))
    for (let i = 0; i <= RETAINED_EPOCHS; i++) {
      const update = await a!.commit(alice.identity)
      await a!.confirm(update)
      expect(await b!.open(update.event)).toMatchObject({ kind: 'commit' })
    }
    // Everything Bob holds now — the state an attacker would take from his
    // device today — cannot open what was said three epochs ago.
    const seized = MarmotGroup.load(b!.toRecord())
    expect(await seized.open(unread)).not.toMatchObject({ kind: 'application' })
  })

  it('heals after a compromise, but only once the compromised member refreshes', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    // An attacker copies Carol's whole state.
    const stolen = c!.toRecord()

    // Without Carol refreshing, the attacker can follow along: Alice's commit
    // encrypts to Carol's leaf key, which the attacker holds.
    const follow = MarmotGroup.load(stolen)
    const byAlice = await a!.commit(alice.identity)
    await a!.confirm(byAlice)
    await b!.open(byAlice.event)
    await c!.open(byAlice.event)
    expect(await follow.open(byAlice.event)).toMatchObject({ kind: 'commit' })
    const leaked = await b!.encrypt(chat(bob, 'still exposed'))
    expect(body(await follow.open(leaked))).toBe('still exposed')

    // Carol refreshes her own leaf. From here the copy is useless.
    const locked = MarmotGroup.load(stolen)
    await locked.open(byAlice.event)
    const refresh = await c!.commit(carol.identity)
    expect(refresh.refreshes).toBe(true)
    await c!.confirm(refresh)
    expect(c!.selfUpdatedAt).toBeGreaterThan(0)
    for (const g of [a, b]) expect(await g!.open(refresh.event)).toMatchObject({ kind: 'commit' })
    expect(await locked.open(refresh.event)).toMatchObject({ kind: 'ignored' })
    const safe = await b!.encrypt(chat(bob, 'healed'))
    expect(body(await c!.open(safe))).toBe('healed')
    expect(await locked.open(safe)).not.toMatchObject({ kind: 'application' })
  })

  it('lets a member leave: they ask, and someone else commits it', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    const request = await c!.proposeLeave(carol.identity.pubkey)
    expect(await a!.open(request)).toEqual({ kind: 'proposal', leaving: carol.identity.pubkey })
    expect(await b!.open(request)).toEqual({ kind: 'proposal', leaving: carol.identity.pubkey })
    expect(a!.hasPendingProposals).toBe(true)

    // Bob is not an admin, but anyone may commit someone else's request to leave.
    const commit = await b!.commit(bob.identity)
    expect(commit.key.priority).toBe(1)
    await b!.confirm(commit)
    expect(await a!.open(commit.event)).toMatchObject({
      kind: 'commit',
      removed: [carol.identity.pubkey],
      removedSelf: false,
    })
    expect(await c!.open(commit.event)).toMatchObject({ kind: 'commit', removedSelf: true })
    expect(c!.active).toBe(false)
    expect(a!.view().members).toEqual([alice.identity.pubkey, bob.identity.pubkey])
  })

  it('does not let an admin walk out and leave the group without one', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    await expect(a!.proposeLeave(alice.identity.pubkey)).rejects.toThrow(/admin role/)
    await expect(a!.commit(alice.identity, { admins: [] })).rejects.toThrow(/needs an admin/)

    // A client that asks anyway is refused by everyone else.
    const state = {
      ...decodeGroupState(b64ToBytes(a!.toRecord().state), 0)![0],
      clientConfig: clientConfig(),
    }
    const request = await createProposal(
      state,
      true,
      { proposalType: 'remove', remove: { removed: state.privatePath.leafIndex } },
      SUITE,
    )
    const event = sealGroupEvent(
      await groupEventKey(state),
      ROUTING.nostrGroupId,
      encodeMlsMessage(request.message),
    )
    expect(await b!.open(event)).toEqual({ kind: 'ignored', reason: 'proposal not allowed' })
  })

  it('removes an admin in two steps: off the admin list, then out of the group', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    const promote = await a!.commit(alice.identity, {
      admins: [alice.identity.pubkey, bob.identity.pubkey],
      profile: { name: 'Renamed', description: 'x' },
    })
    await a!.confirm(promote)
    for (const g of [b, c]) await g!.open(promote.event)
    expect(c!.view()).toMatchObject({
      admins: [alice.identity.pubkey, bob.identity.pubkey].sort(),
      profile: { name: 'Renamed' },
    })

    await expect(a!.commit(alice.identity, { remove: [alice.identity.pubkey] })).rejects.toThrow(
      /before removing/,
    )
    await expect(a!.commit(alice.identity, { remove: [bob.identity.pubkey] })).rejects.toThrow(
      /before removing/,
    )
    await expect(
      a!.commit(alice.identity, { remove: [carol.identity.pubkey], admins: [alice.identity.pubkey] }),
    ).rejects.toThrow(/of their own/)

    const demote = await a!.commit(alice.identity, { admins: [alice.identity.pubkey] })
    await a!.confirm(demote)
    for (const g of [b, c]) expect(await g!.open(demote.event)).toMatchObject({ kind: 'commit' })
    const out = await a!.commit(alice.identity, { remove: [bob.identity.pubkey] })
    await a!.confirm(out)
    expect(await b!.open(out.event)).toMatchObject({ kind: 'commit', removedSelf: true })
    expect(await c!.open(out.event)).toMatchObject({ kind: 'commit', removed: [bob.identity.pubkey] })
    expect(c!.view().admins).toEqual([alice.identity.pubkey])
    expect(c!.epochAuthenticator).toBe(a!.epochAuthenticator)
  })

  it('holds a message from an epoch it has not reached, and reads it after', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    const update = await a!.commit(alice.identity)
    await a!.confirm(update)
    await b!.open(update.event)
    const ahead = await b!.encrypt(chat(bob, 'from epoch two'))
    // Carol hears the message before the commit that makes it readable.
    expect(await c!.open(ahead)).toEqual({ kind: 'deferred' })
    expect(await c!.open(ahead)).toEqual({ kind: 'deferred' })
    await c!.open(update.event)
    const held = c!.takeDeferred()
    expect(held).toHaveLength(1)
    expect(body(await c!.open(held[0]!))).toBe('from epoch two')
    expect(c!.takeDeferred()).toEqual([])
  })

  it('refuses an app message whose author is not the member who sent it', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b] = await found(alice, bob, carol)
    const forged = await b!.encrypt(chat(carol, 'I am Carol'))
    expect(await a!.open(forged)).toEqual({ kind: 'ignored', reason: 'author mismatch' })
  })

  it('carries on exactly after being stored and loaded', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    const reloaded = MarmotGroup.load(JSON.parse(JSON.stringify(b!.toRecord())))
    expect(reloaded.view()).toEqual(b!.view())
    const message = await a!.encrypt(chat(alice, 'after reload'))
    expect(body(await reloaded.open(message))).toBe('after reload')
    const back = await reloaded.encrypt(chat(bob, 'and back'))
    expect(body(await a!.open(back))).toBe('and back')
  })

  it('ignores what is not a message for it', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a] = await found(alice, bob)
    const junk: NostrEvent = {
      ...sealGroupEvent(new Uint8Array(32), ROUTING.nostrGroupId, new Uint8Array(1)),
      content: '%%%',
    }
    expect(await a!.open(junk)).toMatchObject({ kind: 'ignored', reason: 'content is not base64' })
    // Sealed under the group's real key, but not an MLS message inside.
    const state = {
      ...decodeGroupState(b64ToBytes(a!.toRecord().state), 0)![0],
      clientConfig: clientConfig(),
    }
    const garbage = sealGroupEvent(
      await groupEventKey(state),
      ROUTING.nostrGroupId,
      new Uint8Array([1, 2, 3]),
    )
    expect(await a!.open(garbage)).toEqual({ kind: 'ignored', reason: 'unexpected wire format' })
  })
})

/** A member's state as ts-mls holds it, for a client that does not follow the rules. */
const stateOf = (group: MarmotGroup): ClientState => ({
  ...decodeGroupState(b64ToBytes(group.toRecord().state), 0)![0],
  clientConfig: clientConfig(),
})

const seal = async (state: ClientState, message: MLSMessage): Promise<NostrEvent> =>
  sealGroupEvent(await groupEventKey(state), ROUTING.nostrGroupId, encodeMlsMessage(message))

const routeOf = (group: MarmotGroup) => ({ ...ROUTING, nostrGroupId: group.view().nostrGroupId })

describe('a Marmot group, against a client that breaks the rules', () => {
  it('refuses commits it may not accept, whoever makes them', async () => {
    const [alice, bob, dave] = await Promise.all([member('alice'), member('bob'), member('dave')])
    const [a, b] = await found(alice, bob)
    // An admin's commit that leaves an admin who is not in the group.
    const outsider = getPublicKey(generateSecretKey())
    const view = a!.view()
    const settings = await createCommit(
      { state: stateOf(a!), cipherSuite: SUITE },
      {
        extraProposals: [
          {
            proposalType: 'group_context_extensions',
            groupContextExtensions: {
              extensions: groupContextExtensions({
                routing: routeOf(a!),
                admins: [alice.identity.pubkey, outsider],
                profile: view.profile,
              }),
            },
          },
        ],
        wireAsPublicMessage: true,
      },
    )
    expect(await b!.open(await seal(stateOf(a!), settings.commit))).toEqual({
      kind: 'ignored',
      reason: 'invalid result: an admin is not a member',
    })
    // Nor may the admin make one through this client.
    await expect(a!.commit(alice.identity, { admins: [outsider] })).rejects.toThrow(/admin is not a member/)

    // A proposal type this client never accepts in a commit.
    const reinit = await createCommit(
      { state: stateOf(a!), cipherSuite: SUITE },
      {
        extraProposals: [
          {
            proposalType: 'reinit',
            reinit: {
              groupId: new Uint8Array(32),
              version: 'mls10',
              cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
              extensions: [],
            },
          },
        ],
        wireAsPublicMessage: true,
      },
    )
    expect(await b!.open(await seal(stateOf(a!), reinit.commit))).toEqual({
      kind: 'ignored',
      reason: 'commit not allowed',
    })

    // Someone joining on their own, by an external commit.
    const info = await createGroupInfoWithExternalPub(stateOf(a!), [], SUITE)
    const external = await joinGroupExternal(
      info,
      dave.bundle.publicPackage,
      dave.bundle.privatePackage,
      false,
      SUITE,
      stateOf(a!).ratchetTree,
      clientConfig(),
    )
    const joining = await seal(stateOf(a!), {
      publicMessage: external.publicMessage,
      wireformat: 'mls_public_message',
      version: 'mls10',
    })
    expect(await b!.open(joining)).toEqual({ kind: 'ignored', reason: 'commit not allowed' })
    expect(b!.view().members).toHaveLength(2)
  })

  it('refuses a request other than to leave, a stale one, and a forged one', async () => {
    const [alice, bob, carol] = await Promise.all([member('alice'), member('bob'), member('carol')])
    const [a, b, c] = await found(alice, bob, carol)
    // Bob asks, on his own, for Carol to be removed.
    const other = await createProposal(
      stateOf(b!),
      true,
      { proposalType: 'remove', remove: { removed: 2 } },
      SUITE,
    )
    expect(await a!.open(await seal(stateOf(b!), other.message))).toEqual({
      kind: 'ignored',
      reason: 'proposal not allowed',
    })

    // A request that fails verification: its membership tag is not the group's.
    const request = await c!.proposeLeave(carol.identity.pubkey)
    const key = await groupEventKey(stateOf(a!))
    const bytes = openGroupEvent(request.content, [key])!
    bytes[bytes.length - 1]! ^= 1
    const forged = sealGroupEvent(key, ROUTING.nostrGroupId, bytes)
    expect(await a!.open(forged)).toMatchObject({ kind: 'ignored' })
    expect(a!.hasPendingProposals).toBe(false)

    // The real one, after the epoch it was made in has closed.
    const update = await a!.commit(alice.identity)
    await a!.confirm(update)
    expect(await a!.open(request)).toEqual({ kind: 'ignored', reason: 'proposal for another epoch' })
  })

  it('reads only application messages, sent privately, that decode', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    // A commit sent as a PrivateMessage: Marmot puts handshakes in the clear.
    const hidden = await createCommit(
      { state: stateOf(b!), cipherSuite: SUITE },
      { wireAsPublicMessage: false },
    )
    expect(await a!.open(await seal(stateOf(b!), hidden.commit))).toEqual({
      kind: 'ignored',
      reason: 'not an application message',
    })
    // An application message whose payload is not an event.
    const junk = await createApplicationMessage(stateOf(b!), new Uint8Array([0xff, 0x00]), SUITE)
    const junkEvent = await seal(stateOf(b!), {
      privateMessage: junk.privateMessage,
      wireformat: 'mls_private_message',
      version: 'mls10',
    })
    expect(await a!.open(junkEvent)).toMatchObject({ kind: 'ignored' })
    // Application data in a PublicMessage: readable by anyone who sees it, so refused.
    const request = await b!.proposeLeave(bob.identity.pubkey)
    const key = await groupEventKey(stateOf(a!))
    const decoded = decodeMlsMessage(openGroupEvent(request.content, [key])!, 0)![0]
    if (decoded.wireformat !== 'mls_public_message') throw new Error('expected a PublicMessage')
    const { content, auth } = decoded.publicMessage
    const clear = {
      ...decoded,
      publicMessage: {
        ...decoded.publicMessage,
        content: { ...content, contentType: 'application', applicationData: new Uint8Array([1]) },
        auth: { signature: auth.signature, contentType: 'application' },
      },
    } as MLSMessage
    expect(await a!.open(sealGroupEvent(key, ROUTING.nostrGroupId, encodeMlsMessage(clear)))).toEqual({
      kind: 'ignored',
      reason: 'application data in the clear',
    })
  })

  it('reads a message from the epoch before, and not one from an epoch it let go', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    const late = await a!.encrypt(chat(alice, 'sent just before the commit'))
    const update = await a!.commit(alice.identity)
    await a!.confirm(update)
    await b!.open(update.event)
    // One epoch back: still held, and read.
    expect(body(await b!.open(late))).toBe('sent just before the commit')

    const old = await a!.encrypt(chat(alice, 'will be too old'))
    const raw = openGroupEvent(old.content, [await groupEventKey(stateOf(a!))])!
    for (let i = 0; i <= RETAINED_EPOCHS; i++) {
      const next = await a!.commit(alice.identity)
      await a!.confirm(next)
      await b!.open(next.event)
    }
    // Re-sealed under today's outer key, so only the MLS epoch is out of reach.
    const resealed = sealGroupEvent(await groupEventKey(stateOf(b!)), ROUTING.nostrGroupId, raw)
    expect(await b!.open(resealed)).toEqual({ kind: 'ignored', reason: 'epoch no longer held' })
  })

  it('knows its own commits when they come back', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    const pending = await a!.commit(alice.identity)
    expect(await a!.open(pending.event)).toEqual({ kind: 'ignored', reason: 'own or already applied' })
    await a!.confirm(pending)
    expect(await a!.open(pending.event)).toEqual({ kind: 'ignored', reason: 'own or already applied' })
    // Leaving is a request someone else commits, never a commit of one's own.
    await expect(b!.commit(bob.identity, { remove: [bob.identity.pubkey] })).rejects.toThrow(
      /cannot remove itself/,
    )
  })

  it('takes back a commit it applied when its own, published for the same epoch, sorts first', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    // Alice's is privileged, so it sorts before Bob's whatever the digests.
    const mine = await a!.commit(alice.identity, { profile: { name: 'Renamed', description: 'new' } })
    const theirs = await b!.commit(bob.identity)
    await b!.confirm(theirs)
    expect(await a!.open(theirs.event)).toMatchObject({ kind: 'commit' })
    expect(await a!.confirm(mine)).toBe(true)
    expect(a!.view().profile).toEqual({ name: 'Renamed', description: 'new' })
    expect(await b!.open(mine.event)).toMatchObject({ kind: 'commit', rolledBack: [] })
    expect(b!.epochAuthenticator).toBe(a!.epochAuthenticator)
  })

  it('keeps bounded lists of what waits and what it sent', async () => {
    const [alice, bob] = await Promise.all([member('alice'), member('bob')])
    const [a, b] = await found(alice, bob)
    for (let i = 0; i < 70; i++) {
      const stray = sealGroupEvent(
        crypto.getRandomValues(new Uint8Array(32)),
        ROUTING.nostrGroupId,
        new Uint8Array([i]),
      )
      expect(await b!.open(stray)).toEqual({ kind: 'deferred' })
    }
    expect(b!.takeDeferred()).toHaveLength(64)
    for (let i = 0; i < 70; i++) await a!.encrypt(chat(alice, `n${i}`))
    const record = a!.toRecord()
    expect(record.sent).toHaveLength(64)
    // …and what it sent survives a reload, for a lost race to resend.
    expect(MarmotGroup.load(JSON.parse(JSON.stringify(record))).toRecord().sent).toEqual(record.sent)
  })

  it('orders commit keys by priority, then committer, then digest', () => {
    const key = (priority: 0 | 1, committer: string, digest: string) => ({ priority, committer, digest })
    expect(compareCommitKeys(key(0, 'b', 'b'), key(1, 'a', 'a'))).toBeLessThan(0)
    expect(compareCommitKeys(key(1, 'b', 'a'), key(1, 'a', 'b'))).toBeGreaterThan(0)
    expect(compareCommitKeys(key(1, 'a', 'b'), key(1, 'a', 'a'))).toBeGreaterThan(0)
    expect(compareCommitKeys(key(1, 'a', 'a'), key(1, 'a', 'b'))).toBeLessThan(0)
    expect(compareCommitKeys(key(1, 'a', 'a'), key(1, 'a', 'a'))).toBe(0)
  })

  it('accepts only credentials that name a Nostr account', async () => {
    const { validateCredential } = clientConfig().authService
    const key = new Uint8Array(32)
    expect(await validateCredential({ credentialType: 'basic', identity: new Uint8Array(3) }, key)).toBe(
      false,
    )
  })
})
