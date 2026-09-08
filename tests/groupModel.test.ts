import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { conversationId, conversationIdOf, blindId } from '@/core/crypto/vaultCrypto'
import {
  MAX_GROUP_MEMBERS,
  reactionTags,
  recipientsFromTags,
  recipientTags,
  roomOf,
  subjectFromTags,
  MAX_SUBJECT_CHARS,
} from '@/core/models/protocol'
import { isGroupAddress, type IdentityRecord, type Message } from '@/core/models/types'
import { aggregateStatus } from '@/core/vault/repo'
import { decryptExport, exportVault, importVault } from '@/core/vault/exportImport'
import { bytesToHex } from '@/core/util/bytes'
import { makeVault, type TestVault } from './helpers'

/**
 * The model underneath groups: how a rumor is placed in a room, how a room
 * is keyed, how a stored conversation from before groups reads back, and how
 * a group message's per-member states combine.
 */

const pk = (n: number) => n.toString(16).padStart(64, '0')
const SELF = pk(1)

describe('placing a rumor in a room', () => {
  it('reads one other person as a direct conversation', () => {
    expect(roomOf({ pubkey: pk(2), tags: [['p', SELF]] }, SELF)).toEqual([pk(2)])
    // The earliest NIP-17 clients sent no `p` tag at all.
    expect(roomOf({ pubkey: pk(2), tags: [] }, SELF)).toEqual([pk(2)])
  })

  it('reads the author plus every other named person as a group, sorted', () => {
    const tags = [
      ['p', pk(9)],
      ['p', SELF],
      ['p', pk(4)],
    ]
    expect(roomOf({ pubkey: pk(7), tags }, SELF)).toEqual([pk(4), pk(7), pk(9)])
  })

  it('places our own copy by whom it names', () => {
    expect(roomOf({ pubkey: SELF, tags: [['p', pk(3)]] }, SELF)).toEqual([pk(3)])
    expect(
      roomOf(
        {
          pubkey: SELF,
          tags: [
            ['p', pk(5)],
            ['p', pk(3)],
          ],
        },
        SELF,
      ),
    ).toEqual([pk(3), pk(5)])
    // A copy of our own that names nobody else has nowhere to go.
    expect(roomOf({ pubkey: SELF, tags: [['p', SELF]] }, SELF)).toBeNull()
  })

  it('refuses a rumor that names people but not us', () => {
    expect(roomOf({ pubkey: pk(2), tags: [['p', pk(3)]] }, SELF)).toBeNull()
  })

  it('ignores repeated and malformed `p` tags', () => {
    const tags = [['p', SELF], ['p', pk(3)], ['p', pk(3)], ['p', 'nope'], ['e', pk(8)], ['p']]
    expect(recipientsFromTags(tags)).toEqual([SELF, pk(3)])
    expect(roomOf({ pubkey: pk(2), tags }, SELF)).toEqual([pk(2), pk(3)])
  })

  it(`holds at most ${MAX_GROUP_MEMBERS} people, counting the author and us`, () => {
    const named = (n: number) => [['p', SELF], ...Array.from({ length: n }, (_, i) => ['p', pk(100 + i)])]
    expect(roomOf({ pubkey: pk(2), tags: named(MAX_GROUP_MEMBERS - 2) }, SELF)).toHaveLength(
      MAX_GROUP_MEMBERS - 1,
    )
    expect(roomOf({ pubkey: pk(2), tags: named(MAX_GROUP_MEMBERS - 1) }, SELF)).toBeNull()
  })

  it('names recipients in a stable order, so a rebuilt rumor hashes the same', () => {
    expect(recipientTags([pk(5), pk(3)])).toEqual([
      ['p', pk(3)],
      ['p', pk(5)],
    ])
    expect(reactionTags(pk(3), pk(8))).toEqual([
      ['p', pk(3)],
      ['e', pk(8)],
      ['k', '14'],
    ])
    expect(reactionTags([pk(5), pk(3)], pk(8)).slice(0, 2)).toEqual(recipientTags([pk(3), pk(5)]))
  })

  it('reads a group name as one clean, capped line', () => {
    expect(subjectFromTags([['subject', '  Trip\nplanning ']])).toBe('Trip planning')
    expect(subjectFromTags([['subject', 'x'.repeat(200)]])).toHaveLength(MAX_SUBJECT_CHARS)
    expect(subjectFromTags([['subject', '   ']])).toBeNull()
    expect(subjectFromTags([['p', pk(2)]])).toBeNull()
  })
})

describe('keying a room', () => {
  const key = new Uint8Array(32).fill(7)

  it('gives two people the id a direct conversation has always had', () => {
    // The formula before groups existed, spelled out, so a change to the new
    // one cannot silently move every existing conversation.
    const legacy = blindId(key, 'convo', [SELF, pk(2)].sort().join(':'))
    expect(conversationIdOf(key, [pk(2), SELF])).toBe(legacy)
    expect(conversationId(key, SELF, pk(2))).toBe(legacy)
  })

  it('ignores order and repetition, and changes with membership', () => {
    const one = conversationIdOf(key, [SELF, pk(2), pk(3)])
    expect(conversationIdOf(key, [pk(3), SELF, pk(2), pk(3)])).toBe(one)
    expect(conversationIdOf(key, [SELF, pk(2), pk(3), pk(4)])).not.toBe(one)
  })

  it('tells a group address from a person by its shape', () => {
    expect(isGroupAddress(conversationIdOf(key, [SELF, pk(2), pk(3)]))).toBe(true)
    expect(isGroupAddress(pk(2))).toBe(false)
    expect(isGroupAddress('not-hex-at-all-not-hex-at-all-xx')).toBe(false)
  })
})

describe('combining per-member states', () => {
  it('is the least advanced member, and failed if anyone failed', () => {
    expect(aggregateStatus({ a: 'read', b: 'delivered' })).toBe('delivered')
    expect(aggregateStatus({ a: 'read', b: 'read' })).toBe('read')
    expect(aggregateStatus({ a: 'sent', b: 'queued', c: 'read' })).toBe('queued')
    expect(aggregateStatus({ a: 'read', b: 'failed' })).toBe('failed')
  })
})

describe('group conversations in the vault', () => {
  let t: TestVault

  beforeEach(async () => {
    t = await makeVault()
  })
  afterEach(async () => {
    await t.destroy()
  })

  it('reads a conversation stored before groups existed as a direct one', async () => {
    const id = t.repo.conversationId(SELF, pk(2))
    await t.db.conversations.put({
      id,
      enc: t.vault.sealRecord({ peerPubkey: pk(2), draft: 'half-typed' }, `textor/conversations/${id}`),
      lastActivity: 5,
      unread: 2,
      pinned: 0,
    })
    expect(await t.repo.getConversation(id)).toEqual({
      id,
      kind: 'direct',
      peerPubkey: pk(2),
      members: [pk(2)],
      accepted: true,
      draft: 'half-typed',
      lastActivity: 5,
      unread: 2,
      pinned: false,
    })
  })

  it('creates a group once, names it, and only ever turns acceptance on', async () => {
    const created = await t.repo.ensureGroupConversation(SELF, [pk(3), SELF, pk(2)], {
      subject: 'First',
      at: 100,
    })
    expect(created).toMatchObject({
      kind: 'group',
      members: [pk(2), pk(3)],
      subject: 'First',
      subjectAt: 100,
      accepted: false,
      peerPubkey: '',
    })

    const accepted = await t.repo.ensureGroupConversation(SELF, [pk(2), pk(3)], { accepted: true })
    expect(accepted.id).toBe(created.id)
    expect(accepted.accepted).toBe(true)
    const again = await t.repo.ensureGroupConversation(SELF, [pk(2), pk(3)], { accepted: false })
    expect(again.accepted).toBe(true)

    const renamed = await t.repo.ensureGroupConversation(SELF, [pk(2), pk(3)], { subject: 'Second', at: 200 })
    expect(renamed.subject).toBe('Second')
    const stale = await t.repo.ensureGroupConversation(SELF, [pk(2), pk(3)], { subject: 'Zeroth', at: 50 })
    expect(stale.subject).toBe('Second')
    expect((await t.repo.listConversations()).filter((c) => c.kind === 'group')).toHaveLength(1)
  })

  it('refuses a group of fewer than two other people', async () => {
    await expect(t.repo.ensureGroupConversation(SELF, [pk(2), SELF])).rejects.toThrow('at least two')
  })

  async function groupMessage(receipts: Message['receipts']): Promise<Message> {
    const group = await t.repo.ensureGroupConversation(SELF, [pk(2), pk(3)])
    const message: Message = {
      id: pk(50),
      convoId: group.id,
      direction: 'out',
      status: aggregateStatus(receipts ?? {}),
      ts: Date.now(),
      tsCoarse: 0,
      body: 'hi',
      authorPubkey: SELF,
      receipts,
    }
    await t.repo.putMessage(message)
    return message
  }

  it('moves members freely before sending, and only forward after', async () => {
    await groupMessage({ [pk(2)]: 'queued', [pk(3)]: 'queued' })
    let m = await t.repo.markRecipients(pk(50), [pk(2), pk(3)], 'sending')
    expect(m?.status).toBe('sending')
    m = await t.repo.markRecipients(pk(50), [pk(3)], 'queued')
    expect(m?.receipts?.[pk(3)]).toBe('queued')
    m = await t.repo.markRecipients(pk(50), [pk(2)], 'read')
    expect(m?.receipts?.[pk(2)]).toBe('read')
    expect(m?.status).toBe('queued')

    // A late "delivered", or a failed retry, cannot undo what has happened.
    m = await t.repo.markRecipients(pk(50), [pk(2)], 'delivered')
    expect(m?.receipts?.[pk(2)]).toBe('read')
    m = await t.repo.markRecipients(pk(50), [pk(2)], 'failed')
    expect(m?.receipts?.[pk(2)]).toBe('read')
    m = await t.repo.markRecipients(pk(50), [pk(3)], 'failed')
    expect(m?.status).toBe('failed')
    m = await t.repo.markRecipients(pk(50), [pk(3)], 'queued')
    expect(m?.status).toBe('queued')
  })

  it('ignores people the message was not sent to', async () => {
    await groupMessage({ [pk(2)]: 'sent', [pk(3)]: 'sent' })
    const m = await t.repo.markRecipients(pk(50), [pk(9)], 'read')
    expect(m?.receipts).toEqual({ [pk(2)]: 'sent', [pk(3)]: 'sent' })
    expect(await t.repo.markRecipients(pk(51), [pk(2)], 'read')).toBeNull()
  })

  it("drops a group's votes and ticks with the group", async () => {
    const message = await groupMessage({ [pk(2)]: 'sent', [pk(3)]: 'sent' })
    await t.repo.putUpdate({
      id: pk(60),
      targetId: message.id,
      convoId: message.convoId,
      authorPubkey: pk(2),
      ts: 1,
      frame: { v: 1, t: 'vote', poll: message.id, choices: ['o0'] },
    })
    expect(
      await t.repo.putUpdate({
        id: pk(60),
        targetId: message.id,
        convoId: message.convoId,
        authorPubkey: pk(2),
        ts: 1,
        frame: { v: 1, t: 'vote', poll: message.id, choices: ['o0'] },
      }),
    ).toBe(false)
    expect(await t.repo.listUpdatesFor([message.id])).toHaveLength(1)
    expect(await t.repo.listUpdatesFor([])).toEqual([])

    await t.repo.deleteConversation(message.convoId)
    expect(await t.repo.listUpdatesFor([message.id])).toHaveLength(0)
  })

  it('drops votes on messages that retention removes', async () => {
    const message = await groupMessage({ [pk(2)]: 'sent', [pk(3)]: 'sent' })
    await t.repo.putMessage({ ...message, ts: Date.now() - 40 * 24 * 60 * 60 * 1000 })
    await t.repo.putUpdate({
      id: pk(61),
      targetId: message.id,
      convoId: message.convoId,
      authorPubkey: pk(2),
      ts: 1,
      frame: { v: 1, t: 'check', list: message.id, item: 'i0', done: true },
    })
    expect(await t.repo.applyRetention(30)).toBe(1)
    expect(await t.repo.listUpdatesFor([message.id])).toHaveLength(0)
  })
})

describe('backing up a group', () => {
  it('restores group conversations and their history under the new vault key', async () => {
    const source = await makeVault('source')
    const target = await makeVault('target')
    try {
      const { identity: keys } = createIdentity()
      const identity: IdentityRecord = {
        pubkey: keys.publicKey,
        npub: keys.npub,
        secretKeyHex: bytesToHex(keys.secretKey),
        name: 'Sara',
        about: '',
        createdAt: Date.now(),
        mnemonicBackedUp: true,
      }
      await source.repo.putIdentity(identity)
      const group = await source.repo.ensureGroupConversation(identity.pubkey, [pk(2), pk(3)], {
        subject: 'Book club',
        at: 10,
        accepted: true,
      })
      await source.repo.putMessage({
        id: pk(70),
        convoId: group.id,
        direction: 'in',
        status: 'delivered',
        ts: Date.now(),
        tsCoarse: 0,
        body: 'chapter three?',
        authorPubkey: pk(2),
      })

      const payload = await decryptExport(await exportVault(source.repo, 'backup pass'), 'backup pass')
      await importVault(target.repo, payload, { adoptIdentity: true })

      const restoredId = target.repo.conversationIdOf(identity.pubkey, [pk(2), pk(3)])
      // Blinded under a different key, so the id itself changes.
      expect(restoredId).not.toBe(group.id)
      expect(await target.repo.getConversation(restoredId)).toMatchObject({
        kind: 'group',
        subject: 'Book club',
        accepted: true,
        members: [pk(2), pk(3)],
      })
      expect((await target.repo.getMessage(pk(70)))?.convoId).toBe(restoredId)
    } finally {
      await source.destroy()
      await target.destroy()
    }
  })
})
