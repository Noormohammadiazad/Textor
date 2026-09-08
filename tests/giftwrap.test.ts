import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip59 from 'nostr-tools/nip59'
import {
  createRumor,
  createSeal,
  giftWrap,
  GiftWrapError,
  isExpired,
  KIND_GIFT_WRAP,
  KIND_SEAL,
  unwrapGift,
  validateRumor,
} from '@/core/crypto/giftwrap'
import { verifyEventSignature } from '@/core/crypto/eventSignature'
import { retraction } from '@/core/engine/deviceSync'
import * as nip44 from 'nostr-tools/nip44'
import { nowSec } from '@/core/util/time'

const alice = generateSecretKey()
const bob = generateSecretKey()
const mallory = generateSecretKey()
const alicePk = getPublicKey(alice)
const bobPk = getPublicKey(bob)

describe('gift wrapping', () => {
  it('round-trips a message from Alice to Bob', () => {
    const rumor = createRumor({ kind: 14, content: 'meet at six', tags: [['p', bobPk]] }, alice)
    const wrap = giftWrap(rumor, alice, bobPk)
    const out = unwrapGift(wrap, bob)

    expect(out.content).toBe('meet at six')
    expect(out.pubkey).toBe(alicePk)
    expect(out.id).toBe(rumor.id)
  })

  it('hides the sender: the wrap is signed by a key of its own', () => {
    const rumor = createRumor({ kind: 14, content: 'hi', tags: [['p', bobPk]] }, alice)
    const toBob = giftWrap(rumor, alice, bobPk)
    const toSelf = giftWrap(rumor, alice, alicePk)

    expect(toBob.pubkey).not.toBe(alicePk)
    expect(toSelf.pubkey).not.toBe(alicePk)
    // Two people's copies of one rumor must not be linkable to each other.
    expect(toBob.pubkey).not.toBe(toSelf.pubkey)
    expect(toBob.content).not.toBe(toSelf.content)
    expect(toBob.created_at).not.toBe(toSelf.created_at)
    expect(toBob.kind).toBe(KIND_GIFT_WRAP)
  })

  it('leaks only the recipient in plaintext tags', () => {
    const rumor = createRumor({ kind: 14, content: 'secret text', tags: [['p', bobPk]] }, alice)
    const wrap = giftWrap(rumor, alice, bobPk)
    const serialized = JSON.stringify(wrap)

    expect(serialized).not.toContain('secret text')
    expect(serialized).not.toContain(alicePk)
    expect(wrap.tags.filter((t) => t[0] === 'p')).toEqual([['p', bobPk]])
  })

  it('fuzzes the wrap timestamp backwards, never into the future', () => {
    const now = nowSec()
    for (let i = 0; i < 50; i++) {
      const rumor = createRumor({ kind: 14, content: 'x', tags: [['p', bobPk]] }, alice)
      const wrap = giftWrap(rumor, alice, bobPk)
      expect(wrap.created_at).toBeLessThanOrEqual(now + 1)
      expect(wrap.created_at).toBeGreaterThanOrEqual(now - 2 * 24 * 60 * 60)
    }
  })

  it('preserves the real timestamp inside the rumor', () => {
    const rumor = createRumor({ kind: 14, content: 'x', tags: [['p', bobPk]] }, alice)
    const out = unwrapGift(giftWrap(rumor, alice, bobPk), bob)
    expect(Math.abs(out.created_at - nowSec())).toBeLessThan(5)
  })

  it('adds a NIP-40 expiration tag when asked', () => {
    const rumor = createRumor({ kind: 14, content: 'x', tags: [['p', bobPk]] }, alice)
    const wrap = giftWrap(rumor, alice, bobPk, { expirationSec: 30 * 24 * 60 * 60 })
    const expiration = wrap.tags.find((tag) => tag[0] === 'expiration')

    expect(expiration).toBeDefined()
    expect(Number(expiration?.[1])).toBeGreaterThan(nowSec())
  })

  it('cannot be opened by anyone other than the recipient', () => {
    const rumor = createRumor({ kind: 14, content: 'x', tags: [['p', bobPk]] }, alice)
    const wrap = giftWrap(rumor, alice, bobPk)
    expect(() => unwrapGift(wrap, mallory)).toThrow()
    expect(() => unwrapGift(wrap, alice)).toThrow()
  })

  it('interoperates with nostr-tools NIP-59 in both directions', () => {
    // Textor must be able to talk to other Nostr DM clients, so both ends of
    // the interop have to hold: theirs -> ours and ours -> theirs.
    const theirs = nip59.wrapEvent(
      { kind: 14, content: 'from another client', tags: [['p', bobPk]] },
      alice,
      bobPk,
    )
    expect(unwrapGift(theirs, bob).content).toBe('from another client')

    const ours = giftWrap(
      createRumor({ kind: 14, content: 'from textor', tags: [['p', bobPk]] }, alice),
      alice,
      bobPk,
    )
    expect(nip59.unwrapEvent(ours, bob).content).toBe('from textor')
  })
})

describe('gift wrap validation', () => {
  const rumor = createRumor({ kind: 14, content: 'legit', tags: [['p', bobPk]] }, alice)

  it('rejects a wrap of the wrong kind', () => {
    const wrap = { ...giftWrap(rumor, alice, bobPk), kind: 1 }
    expect(() => unwrapGift(wrap, bob)).toThrow(GiftWrapError)
  })

  it('rejects a wrap whose signature does not verify', () => {
    const wrap = giftWrap(rumor, alice, bobPk)
    // Spreading copies nostr-tools' memoised "verified" symbol along with the
    // fields, so this also pins the behaviour that we never trust that cache.
    expect(() => unwrapGift({ ...wrap, sig: 'ab'.repeat(32) }, bob)).toThrow(/signature/)
  })

  it('rejects a wrap whose content was swapped under a valid signature', () => {
    const wrap = giftWrap(rumor, alice, bobPk)
    const other = giftWrap(
      createRumor({ kind: 14, content: 'other', tags: [['p', bobPk]] }, alice),
      alice,
      bobPk,
    )
    expect(() => unwrapGift({ ...wrap, content: other.content }, bob)).toThrow(/signature/)
  })

  it('ignores a forged verified-cache marker on an unsigned object', () => {
    const wrap = giftWrap(rumor, alice, bobPk)
    const forged = { ...wrap, sig: '00'.repeat(64) }
    expect(() => unwrapGift(forged, bob)).toThrow(/signature/)
  })

  it("rejects a seal that Mallory signed around Alice's rumor", () => {
    // Mallory takes a rumor authored by Alice and seals it with her own key.
    // The author-match check is what stops this from showing up as Alice.
    const seal = createSeal(rumor, mallory, bobPk)
    const wrap = wrapSeal(seal, bobPk)
    expect(() => unwrapGift(wrap, bob)).toThrow(/author does not match/)
  })

  it('rejects a rumor whose id does not hash its contents', () => {
    const tampered = { ...rumor, id: 'f'.repeat(64) }
    expect(() => validateRumor(tampered, alicePk)).toThrow(/id does not match/)
  })

  it('rejects a rumor whose content was edited after the id was computed', () => {
    const tampered = { ...rumor, content: 'edited' }
    expect(() => validateRumor(tampered, alicePk)).toThrow(/id does not match/)
  })

  it('rejects a signed rumor, which would break deniability', () => {
    const signed = finalizeEvent(
      { kind: 14, content: 'legit', tags: [['p', bobPk]], created_at: rumor.created_at },
      alice,
    )
    expect(() => validateRumor(signed, alicePk)).toThrow(/unsigned/)
  })

  it('rejects a rumor dated far in the future', () => {
    const future = createRumor(
      { kind: 14, content: 'x', tags: [['p', bobPk]], created_at: nowSec() + 90 * 24 * 60 * 60 },
      alice,
    )
    expect(() => validateRumor(future, alicePk)).toThrow(/future/)
  })

  it('rejects malformed tags', () => {
    const bad = { ...rumor, tags: [['p', 123]] }
    expect(() => validateRumor(bad, alicePk)).toThrow(/tags/)
  })

  it('rejects non-object payloads', () => {
    expect(() => validateRumor('a string', alicePk)).toThrow(GiftWrapError)
    expect(() => validateRumor(null, alicePk)).toThrow(GiftWrapError)
    expect(() => validateRumor([1, 2, 3], alicePk)).toThrow(GiftWrapError)
  })

  it('rejects an oversized wrap without attempting decryption', () => {
    const wrap = giftWrap(rumor, alice, bobPk)
    expect(() => unwrapGift({ ...wrap, content: 'A'.repeat(600_000) }, bob)).toThrow(/too large/)
  })
})

/** Wrap an externally-built seal the way createWrap does, for attack tests. */
function wrapSeal(seal: ReturnType<typeof createSeal>, recipientPk: string) {
  const ephemeral = generateSecretKey()
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(ephemeral, recipientPk)),
      created_at: nowSec(),
      tags: [['p', recipientPk]],
    },
    ephemeral,
  )
}

describe('seal shape', () => {
  it('uses kind 13 and is signed by the real sender key', () => {
    const seal = createSeal(rumorOf('x'), alice, bobPk)
    expect(seal.kind).toBe(KIND_SEAL)
    expect(seal.pubkey).toBe(alicePk)
  })
})

const rumorOf = (content: string) => createRumor({ kind: 14, content, tags: [['p', bobPk]] }, alice)

describe('a wrap worked out from the sender’s key (ADR-074)', () => {
  const DAY = 24 * 60 * 60
  const lifetime = { expirationSec: 30 * DAY }

  it('comes out the same every time, so a retry is the same event and any device can find it', () => {
    const rumor = rumorOf('same on every device')
    const a = giftWrap(rumor, alice, bobPk, lifetime)
    const b = giftWrap(rumor, alice, bobPk, lifetime)
    expect(b.id).toBe(a.id)
    expect(b.pubkey).toBe(a.pubkey)
    expect(b.content).toBe(a.content)
    expect(b.created_at).toBe(a.created_at)
    expect(b.tags).toEqual(a.tags)
  })

  it('does not depend on the order a rumor’s fields happen to be in', () => {
    const rumor = rumorOf('parsed back from storage')
    const shuffled = {
      content: rumor.content,
      tags: rumor.tags,
      kind: rumor.kind,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
      id: rumor.id,
    }
    expect(giftWrap(shuffled, alice, bobPk, lifetime).id).toBe(giftWrap(rumor, alice, bobPk, lifetime).id)
  })

  it('differs for every rumor, recipient and sender, and looks unrelated to all of them', () => {
    const rumor = rumorOf('x')
    const base = giftWrap(rumor, alice, bobPk)
    const other = giftWrap(rumorOf('y'), alice, bobPk)
    const toSelf = giftWrap(rumor, alice, alicePk)
    const mallorys = giftWrap(createRumor({ ...rumor, pubkey: undefined } as never, mallory), mallory, bobPk)
    const signers = new Set([base, other, toSelf, mallorys].map((wrap) => wrap.pubkey))
    expect(signers.size).toBe(4)
    expect(signers.has(alicePk)).toBe(false)
    expect(signers.has(bobPk)).toBe(false)
  })

  it('still opens, with an unforgeable seal, and with other clients’ code', () => {
    const rumor = rumorOf('still a gift wrap')
    const wrap = giftWrap(rumor, alice, bobPk, lifetime)
    expect(unwrapGift(wrap, bob).id).toBe(rumor.id)
    expect(nip59.unwrapEvent(wrap, bob).content).toBe('still a gift wrap')
    const seal = createSeal(rumor, alice, bobPk)
    expect(createSeal(rumor, alice, bobPk).sig).toBe(seal.sig)
    expect(seal.created_at).toBeLessThanOrEqual(rumor.created_at)
    expect(seal.created_at).toBeGreaterThanOrEqual(rumor.created_at - 2 * DAY)
  })

  it('never encrypts two different things under one nonce', () => {
    const first = rumorOf('one thing')
    const second = { ...first, content: 'another thing' }
    const nonce = (wrap: { content: string }) =>
      Buffer.from(wrap.content, 'base64').subarray(1, 33).toString('hex')
    expect(nonce(giftWrap(second, alice, bobPk))).not.toBe(nonce(giftWrap(first, alice, bobPk)))
  })

  it('counts its timestamps and expiry from the rumor, not from when it was sent', () => {
    const rumor = createRumor(
      { kind: 14, content: 'sent late', tags: [['p', bobPk]], created_at: nowSec() - 3 * DAY },
      alice,
    )
    const wrap = giftWrap(rumor, alice, bobPk, lifetime)
    expect(wrap.created_at).toBeLessThanOrEqual(rumor.created_at)
    expect(wrap.created_at).toBeGreaterThanOrEqual(rumor.created_at - 2 * DAY)
    expect(wrap.tags.find((tag) => tag[0] === 'expiration')?.[1]).toBe(String(rumor.created_at + 30 * DAY))
  })

  it('counts from now when sent so late that a relay would refuse it', () => {
    const rumor = createRumor(
      { kind: 14, content: 'retried after a month', tags: [['p', bobPk]], created_at: nowSec() - 40 * DAY },
      alice,
    )
    const wrap = giftWrap(rumor, alice, bobPk, lifetime)
    expect(Number(wrap.tags.find((tag) => tag[0] === 'expiration')?.[1])).toBeGreaterThan(nowSec() + 29 * DAY)
    expect(wrap.created_at).toBeGreaterThanOrEqual(nowSec() - 2 * DAY - 1)
    expect(unwrapGift(wrap, bob).id).toBe(rumor.id)
  })

  it('asks for no expiry unless told to', () => {
    expect(giftWrap(rumorOf('x'), alice, bobPk).tags).toEqual([['p', bobPk]])
    expect(giftWrap(rumorOf('x'), alice, bobPk, { expirationSec: 0 }).tags).toEqual([['p', bobPk]])
  })

  describe('a retraction', () => {
    const lifetimes = [{ expirationSec: 7 * DAY }, { expirationSec: 30 * DAY }]

    it('is signed by what signed the wrap, and names it under every lifetime it may have had', () => {
      const rumor = rumorOf('take this back')
      const week = giftWrap(rumor, alice, bobPk, { expirationSec: 7 * DAY })
      const month = giftWrap(rumor, alice, bobPk, { expirationSec: 30 * DAY })
      const event = retraction(rumor, alice, bobPk, lifetimes)
      expect(event.kind).toBe(5)
      expect(event.pubkey).toBe(month.pubkey)
      expect(event.pubkey).toBe(week.pubkey)
      expect(verifyEventSignature(event)).toBe(true)
      expect(event.tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1])).toEqual([week.id, month.id])
      expect(event.tags).toContainEqual(['k', '1059'])
      expect(Number(event.tags.find((tag) => tag[0] === 'expiration')?.[1])).toBeGreaterThan(
        nowSec() + 30 * DAY,
      )
    })

    it('says nothing about who sent it', () => {
      const event = retraction(rumorOf('x'), alice, bobPk, lifetimes)
      expect(event.pubkey).not.toBe(alicePk)
      expect(JSON.stringify(event)).not.toContain(alicePk)
    })
  })

  it('knows a wrap past its own expiry', () => {
    expect(isExpired({ tags: [['expiration', '100']] }, 100)).toBe(true)
    expect(isExpired({ tags: [['expiration', '100']] }, 99)).toBe(false)
    expect(isExpired({ tags: [['p', 'x']] }, 100)).toBe(false)
  })

  it('refuses a recipient that is not a key', () => {
    expect(() => giftWrap(rumorOf('x'), alice, 'nope')).toThrow(/recipient/)
  })
})

describe('what validation turns away', () => {
  it('a signature that cannot be checked', () => {
    expect(
      verifyEventSignature({
        pubkey: alicePk,
        sig: '0'.repeat(128),
        kind: 1,
        content: '',
        created_at: 1,
        tags: [[1]],
      }),
    ).toBe(false)
  })

  it('an event missing what a signature covers', () => {
    expect(
      verifyEventSignature({
        pubkey: alicePk,
        sig: '0'.repeat(128),
        kind: '1',
        content: '',
        created_at: 1,
        tags: [],
      }),
    ).toBe(false)
    expect(
      verifyEventSignature({
        pubkey: alicePk,
        sig: '0'.repeat(128),
        kind: 1,
        content: '',
        created_at: '1',
        tags: [],
      }),
    ).toBe(false)
    expect(verifyEventSignature({ pubkey: 'x', sig: 'y' })).toBe(false)
  })

  it('an event whose id is not its hash', () => {
    const wrap = giftWrap(rumorOf('x'), alice, bobPk)
    expect(verifyEventSignature({ ...wrap, id: '0'.repeat(64) })).toBe(false)
  })

  it('a seal that is not one, or not signed by who it says', () => {
    const rumor = rumorOf('x')
    const seal = createSeal(rumor, alice, bobPk)
    expect(() => unwrapGift(wrapSeal({ ...seal, kind: 1 }, bobPk), bob)).toThrow(/seal kind/)
    expect(() => unwrapGift(wrapSeal({ ...seal, content: 7 as never }, bobPk), bob)).toThrow(/malformed/)
    expect(() => unwrapGift(wrapSeal({ ...seal, sig: '0'.repeat(128) }, bobPk), bob)).toThrow(/signature/)
  })

  it('a rumor with a malformed time', () => {
    const rumor = rumorOf('x')
    expect(() => validateRumor({ ...rumor, created_at: 'soon' }, alicePk)).toThrow(/timestamp/)
    expect(() => validateRumor({ ...rumor, created_at: Infinity }, alicePk)).toThrow(/timestamp/)
    expect(() => validateRumor({ ...rumor, kind: 'x' }, alicePk)).toThrow(/malformed/)
    expect(() => validateRumor({ ...rumor, tags: ['x'] }, alicePk)).toThrow(/tags/)
  })
})
