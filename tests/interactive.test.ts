import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnsignedEvent } from 'nostr-tools/core'
import { getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { createRumor, giftWrap, type Rumor } from '@/core/crypto/giftwrap'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import {
  checklistFallback,
  checklistFromTags,
  checklistTags,
  foldChecklist,
  makeChecklist,
  makePoll,
  pollFallback,
  pollFromTags,
  pollTags,
  tallyPoll,
  type InteractiveUpdate,
} from '@/core/models/interactive'
import {
  cleanLine,
  KIND_CONTROL,
  MAX_CHECKLIST_ITEMS,
  MAX_POLL_OPTIONS,
  parseControlFrame,
  type CheckFrame,
  type VoteFrame,
} from '@/core/models/protocol'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Polls and shared checklists are counted by every participant for
 * themselves, so the rules have to be deterministic — two devices holding the
 * same frames must agree whatever order they arrived in — and they have to
 * refuse input from anyone outside the conversation.
 */

const ROOM = 'a'.repeat(32)
const OTHER_ROOM = 'b'.repeat(32)
const hex = (n: number) => n.toString(16).padStart(64, '0')

let seq = 0
function vote(author: string, choices: string[], ts: number, convoId = ROOM, id?: string): InteractiveUpdate {
  const frame: VoteFrame = { v: 1, t: 'vote', poll: hex(1), choices }
  return { id: id ?? hex(1000 + seq++), targetId: hex(1), convoId, authorPubkey: author, ts, frame }
}
function check(
  author: string,
  fields: Omit<CheckFrame, 'v' | 't' | 'list'>,
  ts: number,
  convoId = ROOM,
): InteractiveUpdate {
  const frame: CheckFrame = { v: 1, t: 'check', list: hex(2), ...fields }
  return { id: hex(5000 + seq++), targetId: hex(2), convoId, authorPubkey: author, ts, frame }
}

describe('building polls and checklists', () => {
  it('cleans what was typed and numbers the options', () => {
    const poll = makePoll('  Where\nto eat? ', ['Pizza', '', ' Sushi ', 'Pizza'], false)
    expect(poll).toEqual({
      question: 'Where to eat?',
      options: [
        { id: 'o0', label: 'Pizza' },
        { id: 'o1', label: 'Sushi' },
      ],
      multi: false,
    })
  })

  it('refuses a poll that cannot be a real choice', () => {
    expect(() => makePoll('', ['a', 'b'], false)).toThrow('question')
    expect(() => makePoll('Q', ['only one', '  '], false)).toThrow('two options')
    const many = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `option ${i}`)
    expect(() => makePoll('Q', many, false)).toThrow(`at most ${MAX_POLL_OPTIONS}`)
  })

  it('refuses an empty or oversized checklist', () => {
    expect(() => makeChecklist(' ', ['milk'])).toThrow('title')
    expect(() => makeChecklist('Groceries', ['', ' '])).toThrow('at least one')
    const many = Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, i) => `item ${i}`)
    expect(() => makeChecklist('Big', many)).toThrow(`at most ${MAX_CHECKLIST_ITEMS}`)
  })

  it('round-trips through tags', () => {
    const poll = makePoll('Q?', ['a', 'b', 'c'], true)
    expect(pollFromTags(pollTags(poll))).toEqual(poll)
    const list = makeChecklist('Packing', ['tent', 'stove'])
    expect(checklistFromTags(checklistTags(list))).toEqual(list)
  })

  it('reads a poll as single choice unless it says otherwise', () => {
    const tags = pollTags(makePoll('Q', ['a', 'b'], true)).filter((tag) => tag[0] !== 'polltype')
    expect(pollFromTags(tags)?.multi).toBe(false)
  })

  it('rejects a malformed poll outright rather than showing half of one', () => {
    const good = pollTags(makePoll('Q', ['a', 'b'], false))
    expect(pollFromTags(good.filter((tag) => tag[0] !== 'poll'))).toBeNull()
    expect(pollFromTags([['poll', '  '], ...good.slice(1)])).toBeNull()
    expect(pollFromTags([...good, ['option', 'o0', 'duplicate id']])).toBeNull()
    expect(pollFromTags([...good, ['option', 'BAD ID', 'x']])).toBeNull()
    expect(pollFromTags([...good, ['option', 'o9', '   ']])).toBeNull()
    expect(pollFromTags(good.filter((tag) => tag[1] !== 'o1'))).toBeNull()
    const tooMany = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => ['option', `o${i}`, `${i}`])
    expect(pollFromTags([['poll', 'Q'], ...tooMany])).toBeNull()
  })

  it('rejects a malformed checklist', () => {
    expect(checklistFromTags([['item', 'i0', 'x']])).toBeNull()
    expect(checklistFromTags([['checklist', '']])).toBeNull()
    expect(checklistFromTags([['checklist', 'T']])).toBeNull()
    expect(
      checklistFromTags([
        ['checklist', 'T'],
        ['item', 'i0', 'x'],
        ['item', 'i0', 'y'],
      ]),
    ).toBeNull()
  })

  it('renders a plain-text version for clients that do not know either', () => {
    expect(pollFallback(makePoll('Lunch?', ['Yes', 'No'], false))).toBe('📊 Lunch?\n○ Yes\n○ No')
    expect(checklistFallback(makeChecklist('Trip', ['Tent']))).toBe('☑️ Trip\n☐ Tent')
  })

  it('makes a single safe line of any text', () => {
    expect(cleanLine('a\u0000b c\td', 100)).toBe('a b c d')
    expect(cleanLine('   ', 10)).toBeNull()
    expect(cleanLine(42, 10)).toBeNull()
    // Capped by characters, not UTF-16 units, so an emoji is never split.
    expect(cleanLine('😀😀😀', 2)).toBe('😀😀')
  })
})

describe('vote and check frames', () => {
  const parse = (value: object) => parseControlFrame(JSON.stringify({ v: 1, ...value }))

  it('accepts a ballot, including an empty one that withdraws', () => {
    expect(parse({ t: 'vote', poll: hex(1), choices: ['o0', 'o1'] })).toEqual({
      v: 1,
      t: 'vote',
      poll: hex(1),
      choices: ['o0', 'o1'],
    })
    expect(parse({ t: 'vote', poll: hex(1), choices: [] })).not.toBeNull()
  })

  it('refuses a ballot that is malformed or stuffed', () => {
    expect(parse({ t: 'vote', poll: 'nope', choices: [] })).toBeNull()
    expect(parse({ t: 'vote', poll: hex(1), choices: 'o0' })).toBeNull()
    expect(parse({ t: 'vote', poll: hex(1), choices: ['o0', 'o0'] })).toBeNull()
    expect(parse({ t: 'vote', poll: hex(1), choices: ['Not An Id'] })).toBeNull()
    const stuffed = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `o${i}`)
    expect(parse({ t: 'vote', poll: hex(1), choices: stuffed })).toBeNull()
  })

  it('accepts a tick or an addition, and nothing that is neither', () => {
    expect(parse({ t: 'check', list: hex(2), item: 'i0', done: true })).toMatchObject({ done: true })
    expect(parse({ t: 'check', list: hex(2), item: 'x1', label: ' Eggs\n' })).toMatchObject({ label: 'Eggs' })
    expect(parse({ t: 'check', list: hex(2), item: 'i0' })).toBeNull()
    expect(parse({ t: 'check', list: hex(2), item: 'i0', done: 'yes' })).toBeNull()
    expect(parse({ t: 'check', list: hex(2), item: 'i0', label: '   ' })).toBeNull()
    expect(parse({ t: 'check', list: hex(2), item: '../x', done: true })).toBeNull()
    expect(parse({ t: 'check', list: 'short', item: 'i0', done: true })).toBeNull()
  })
})

describe('counting a poll', () => {
  const single = makePoll('Q', ['a', 'b', 'c'], false)
  const multi = makePoll('Q', ['a', 'b', 'c'], true)

  it("counts each voter's newest ballot once", () => {
    const result = tallyPoll(
      single,
      ROOM,
      [vote('ann', ['o0'], 1), vote('ben', ['o1'], 2), vote('ann', ['o1'], 3)],
      'ann',
    )
    expect(result.options.map((option) => option.count)).toEqual([0, 2, 0])
    expect(result.voters).toBe(2)
    expect(result.mine).toEqual(['o1'])
    expect(result.options[1]?.voters.sort()).toEqual(['ann', 'ben'])
  })

  it('gives the same answer whatever order the frames arrived in', () => {
    const frames = [
      vote('ann', ['o0'], 5, ROOM, hex(90)),
      vote('ann', ['o2'], 5, ROOM, hex(91)),
      vote('ben', ['o1'], 1),
      vote('ben', [], 9),
      vote('cy', ['o2'], 4),
    ]
    const forward = tallyPoll(single, ROOM, frames, 'x')
    const backward = tallyPoll(single, ROOM, [...frames].reverse(), 'x')
    expect(backward).toEqual(forward)
    // Same timestamp: the higher id is the later one, on every device.
    expect(forward.options.map((option) => option.count)).toEqual([0, 0, 2])
  })

  it('treats an empty ballot as a withdrawn vote', () => {
    const result = tallyPoll(single, ROOM, [vote('ann', ['o0'], 1), vote('ann', [], 2)], 'ann')
    expect(result.voters).toBe(0)
    expect(result.mine).toEqual([])
  })

  it('ignores votes addressed to a different conversation', () => {
    const result = tallyPoll(single, ROOM, [vote('ann', ['o0'], 1), vote('eve', ['o0'], 2, OTHER_ROOM)], 'x')
    expect(result.options[0]?.voters).toEqual(['ann'])
  })

  it('drops options the poll does not have, and extra choices on a single-choice poll', () => {
    const result = tallyPoll(single, ROOM, [vote('ann', ['o9', 'o2', 'o0'], 1), vote('ben', ['o9'], 2)], 'x')
    expect(result.options.map((option) => option.count)).toEqual([0, 0, 1])
    expect(result.voters).toBe(1)
  })

  it('counts every choice on a multiple-choice poll', () => {
    const result = tallyPoll(multi, ROOM, [vote('ann', ['o0', 'o2'], 1), vote('ben', ['o2'], 2)], 'ann')
    expect(result.options.map((option) => option.count)).toEqual([1, 0, 2])
    expect(result.mine).toEqual(['o0', 'o2'])
  })

  it('ignores checklist frames', () => {
    expect(tallyPoll(single, ROOM, [check('ann', { item: 'o0', done: true }, 1)], 'ann').voters).toBe(0)
  })
})

describe('settling a checklist', () => {
  const list = makeChecklist('Trip', ['tent', 'stove'])

  it('takes the newest tick on each item', () => {
    const entries = foldChecklist(list, ROOM, [
      check('ann', { item: 'i0', done: true }, 1),
      check('ben', { item: 'i0', done: false }, 3),
      check('ann', { item: 'i1', done: true }, 2),
    ])
    expect(entries.map((entry) => [entry.id, entry.done, entry.by])).toEqual([
      ['i0', false, 'ben'],
      ['i1', true, 'ann'],
    ])
  })

  it('applies additions before ticks, so transit order does not matter', () => {
    const add = check('ann', { item: 'x1', label: 'matches' }, 5)
    const tick = check('ben', { item: 'x1', done: true }, 4)
    const forward = foldChecklist(list, ROOM, [add, tick])
    expect(foldChecklist(list, ROOM, [tick, add])).toEqual(forward)
    expect(forward[2]).toMatchObject({ id: 'x1', label: 'matches', added: true, done: true })
  })

  it('keeps the first label for an item and ignores ticks on items that do not exist', () => {
    const entries = foldChecklist(list, ROOM, [
      check('ann', { item: 'x1', label: 'first' }, 1),
      check('ben', { item: 'x1', label: 'second' }, 2),
      check('ben', { item: 'i0', label: 'relabel' }, 3),
      check('ben', { item: 'ghost', done: true }, 4),
    ])
    expect(entries.map((entry) => entry.label)).toEqual(['tent', 'stove', 'first'])
  })

  it(`stops adding at ${MAX_CHECKLIST_ITEMS} items`, () => {
    const adds = Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, i) =>
      check('ann', { item: `x${i}`, label: `thing ${i}` }, i + 1),
    )
    const entries = foldChecklist(list, ROOM, adds)
    expect(entries).toHaveLength(MAX_CHECKLIST_ITEMS)
    expect(entries.at(-1)?.id).toBe(`x${MAX_CHECKLIST_ITEMS - 3}`)
  })

  it('ignores changes from a different conversation, and votes', () => {
    const entries = foldChecklist(list, ROOM, [
      check('eve', { item: 'i0', done: true }, 1, OTHER_ROOM),
      vote('ann', ['i0'], 2),
    ])
    expect(entries.every((entry) => !entry.done && entry.by === undefined)).toBe(true)
  })
})

// --- across real engines ------------------------------------------------------

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string, skHex?: string): Promise<Peer> {
  const secretKeyHex = skHex ?? bytesToHex(createIdentity().identity.secretKey)
  const secretKey = hexToBytes(secretKeyHex)
  const pubkey = getPublicKey(secretKey)
  const vault = await makeVault(`${name}-pw`)
  await vault.repo.putIdentity({
    pubkey,
    npub: '',
    secretKeyHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(secretKeyHex, pubkey)
  return { pubkey, secretKey, vault, messenger }
}

const settle = (ms = 3000) => vi.advanceTimersByTimeAsync(ms)

describe('polls and checklists between people', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer
  let carol: Peer
  const extra: Peer[] = []
  const room = (peer: Peer, others: Peer[]) =>
    peer.vault.repo.conversationIdOf(
      peer.pubkey,
      others.map((other) => other.pubkey),
    )

  async function counted(peer: Peer, pollId: string) {
    const message = await peer.vault.repo.getMessage(pollId)
    if (!message?.poll) throw new Error('no poll here')
    return tallyPoll(
      message.poll,
      message.convoId,
      await peer.vault.repo.listUpdatesFor([pollId]),
      peer.pubkey,
    )
  }

  async function settled(peer: Peer, listId: string) {
    const message = await peer.vault.repo.getMessage(listId)
    if (!message?.checklist) throw new Error('no checklist here')
    return foldChecklist(message.checklist, message.convoId, await peer.vault.repo.listUpdatesFor([listId]))
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    carol = await makePeer(network, 'Carol')
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol, ...extra.splice(0)]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('tallies a group poll identically on every device', async () => {
    const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'Dinner')
    const poll = await alice.messenger.sendPoll(group.id, makePoll('Where?', ['Pizza', 'Sushi'], false))
    await settle()

    const onBob = await bob.vault.repo.getMessage(poll.id)
    expect(onBob?.poll?.question).toBe('Where?')
    expect(onBob?.body).toBe('📊 Where?\n○ Pizza\n○ Sushi')

    await alice.messenger.vote(group.id, poll.id, ['o0'])
    await bob.messenger.vote(room(bob, [alice, carol]), poll.id, ['o1'])
    await carol.messenger.vote(room(carol, [alice, bob]), poll.id, ['o1'])
    await settle()

    for (const peer of [alice, bob, carol]) {
      const result = await counted(peer, poll.id)
      expect(result.options.map((option) => option.count)).toEqual([1, 2])
      expect(result.voters).toBe(3)
    }
    expect((await counted(bob, poll.id)).mine).toEqual(['o1'])

    // A change of mind replaces the vote everywhere; an empty ballot withdraws it.
    await bob.messenger.vote(room(bob, [alice, carol]), poll.id, ['o0'])
    await carol.messenger.vote(room(carol, [alice, bob]), poll.id, [])
    await settle()
    for (const peer of [alice, bob, carol]) {
      const result = await counted(peer, poll.id)
      expect(result.options.map((option) => option.count)).toEqual([2, 0])
      expect(result.voters).toBe(2)
    }
  })

  it('refuses a ballot the poll cannot take before sending anything', async () => {
    const poll = await alice.messenger.sendPoll(bob.pubkey, makePoll('One?', ['a', 'b'], false))
    await settle()
    const before = network.publishCount
    await expect(bob.messenger.vote(alice.pubkey, poll.id, ['o0', 'o1'])).rejects.toThrow('one choice')
    await expect(bob.messenger.vote(alice.pubkey, poll.id, ['o7'])).rejects.toThrow('not an option')
    await expect(bob.messenger.vote(alice.pubkey, 'f'.repeat(64), ['o0'])).rejects.toThrow('no such poll')
    // A poll from one conversation cannot be voted on from another.
    await expect(bob.messenger.vote(carol.pubkey, poll.id, ['o0'])).rejects.toThrow('no such poll')
    expect(network.publishCount).toBe(before)
  })

  it('does not count a vote from outside the conversation', async () => {
    const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey])
    const poll = await alice.messenger.sendPoll(group.id, makePoll('Q', ['a', 'b'], false))
    await settle()

    // An outsider who learned the poll's id addresses a vote to Alice, naming
    // the members as well. That is a room of four, not this one.
    const outsider = await makePeer(network, 'Eve')
    extra.push(outsider)
    const template: Partial<UnsignedEvent> = {
      kind: KIND_CONTROL,
      content: JSON.stringify({ v: 1, t: 'vote', poll: poll.id, choices: ['o1'] }),
      tags: [alice, bob, carol].map((peer) => ['p', peer.pubkey]),
    }
    const rumor: Rumor = createRumor(template, outsider.secretKey)
    network.publish(giftWrap(rumor, outsider.secretKey, alice.pubkey))
    await settle()

    expect((await alice.vault.repo.listUpdatesFor([poll.id])).map((u) => u.id)).toContain(rumor.id)
    expect((await counted(alice, poll.id)).voters).toBe(0)
  })

  it('shares a checklist that anyone in the conversation can tick and add to', async () => {
    const list = await alice.messenger.sendChecklist(bob.pubkey, makeChecklist('Groceries', ['milk', 'eggs']))
    await settle()
    expect((await bob.vault.repo.getMessage(list.id))?.checklist?.items).toHaveLength(2)

    await bob.messenger.checkItem(alice.pubkey, list.id, 'i0', true)
    const added = await bob.messenger.addChecklistItem(alice.pubkey, list.id, '  bread ')
    await settle()
    await alice.messenger.checkItem(bob.pubkey, list.id, added, true)
    await settle()

    for (const peer of [alice, bob]) {
      const entries = await settled(peer, list.id)
      expect(entries.map((entry) => [entry.label, entry.done])).toEqual([
        ['milk', true],
        ['eggs', false],
        ['bread', true],
      ])
    }
    await expect(alice.messenger.checkItem(bob.pubkey, list.id, 'nope', true)).rejects.toThrow('no such item')
    await expect(alice.messenger.addChecklistItem(bob.pubkey, list.id, '   ')).rejects.toThrow('some text')
  })

  it('refuses to send an invalid poll or checklist, and to change a message that is not one', async () => {
    await expect(
      alice.messenger.sendPoll(bob.pubkey, {
        question: 'Q',
        options: [{ id: 'o0', label: 'only' }],
        multi: false,
      }),
    ).rejects.toThrow('not a valid poll')
    await expect(alice.messenger.sendChecklist(bob.pubkey, { title: ' ', items: [] })).rejects.toThrow(
      'not a valid checklist',
    )
    const plain = await alice.messenger.sendMessage(bob.pubkey, 'just text')
    await expect(alice.messenger.checkItem(bob.pubkey, plain.id, 'i0', true)).rejects.toThrow(
      'no such checklist',
    )
    await expect(alice.messenger.addChecklistItem(bob.pubkey, plain.id, 'x')).rejects.toThrow(
      'no such checklist',
    )
  })

  it('stops a checklist from growing past its limit', async () => {
    const labels = Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, i) => `item ${i}`)
    const list = await alice.messenger.sendChecklist(bob.pubkey, makeChecklist('Full', labels))
    await expect(alice.messenger.addChecklistItem(bob.pubkey, list.id, 'one more')).rejects.toThrow('full')
  })

  it("shows a vote cast on one device on the voter's other device", async () => {
    const secondDevice = await makePeer(network, 'Bob-2', bytesToHex(bob.secretKey))
    extra.push(secondDevice)
    const poll = await alice.messenger.sendPoll(bob.pubkey, makePoll('Q', ['a', 'b'], false))
    await settle()
    await bob.messenger.vote(alice.pubkey, poll.id, ['o1'])
    await settle()
    expect((await counted(secondDevice, poll.id)).mine).toEqual(['o1'])
  })

  it('drops the votes on a poll when the poll is withdrawn', async () => {
    const poll = await alice.messenger.sendPoll(bob.pubkey, makePoll('Q', ['a', 'b'], false))
    await settle()
    await bob.messenger.vote(alice.pubkey, poll.id, ['o0'])
    await settle()
    expect(await bob.vault.repo.listUpdatesFor([poll.id])).toHaveLength(1)

    await alice.messenger.redactMessage(bob.pubkey, poll.id)
    await settle()
    expect(await bob.vault.repo.getMessage(poll.id)).toBeNull()
    expect(await bob.vault.repo.listUpdatesFor([poll.id])).toHaveLength(0)
    expect(await alice.vault.repo.listUpdatesFor([poll.id])).toHaveLength(0)
  })
})

describe('retrying a message rebuilds it exactly', () => {
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
  })

  afterEach(async () => {
    for (const peer of [alice, bob, carol]) {
      peer.messenger.stop()
      await peer.vault.destroy()
    }
    vi.useRealTimers()
  })

  const queuedRumor = async (peer: Peer, id: string) => {
    const item = await peer.vault.repo.getOutboxItem(id)
    return item ? (JSON.parse(item.rumorJson) as Rumor) : null
  }

  it('keeps an attachment, and so its id, when an attachment message is retried', async () => {
    network.offline = true
    const sent = await alice.messenger.sendAttachment(bob.pubkey, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'File · notes.bin',
      name: 'notes.bin',
    })
    await alice.messenger.retryMessage(sent.id)
    const rebuilt = await queuedRumor(alice, sent.id)
    expect(rebuilt?.id).toBe(sent.id)
    expect(rebuilt?.tags.some((tag) => tag[0] === 'textor-attachment')).toBe(true)

    network.offline = false
    alice.messenger.wake('online')
    await settle()
    const arrived = await bob.vault.repo.getMessage(sent.id)
    expect(arrived?.attachment?.name).toBe('notes.bin')
  })

  it('keeps the group name, poll and reply of a group message when it is retried', async () => {
    const group = await alice.messenger.createGroup([bob.pubkey, carol.pubkey], 'Old name')
    const first = await alice.messenger.sendMessage(group.id, 'first')
    await settle()
    network.offline = true
    const poll = await alice.messenger.sendPoll(group.id, makePoll('Q', ['a', 'b'], true), first.id)
    // Renamed since: the retry must still carry the name the poll was sent with.
    await alice.vault.repo.updateConversation(group.id, { subject: 'New name' })

    await alice.messenger.retryMessage(poll.id)
    const rebuilt = await queuedRumor(alice, poll.id)
    expect(rebuilt?.id).toBe(poll.id)
    expect(rebuilt?.tags).toContainEqual(['subject', 'Old name'])
  })
})
