import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip59 from 'nostr-tools/nip59'
import {
  createRumor,
  createSeal,
  giftWrap,
  GiftWrapError,
  KIND_GIFT_WRAP,
  KIND_SEAL,
  unwrapGift,
  validateRumor,
} from '@/core/crypto/giftwrap'
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

  it('hides the sender: the wrap is authored by a single-use ephemeral key', () => {
    const rumor = createRumor({ kind: 14, content: 'hi', tags: [['p', bobPk]] }, alice)
    const a = giftWrap(rumor, alice, bobPk)
    const b = giftWrap(rumor, alice, bobPk)

    expect(a.pubkey).not.toBe(alicePk)
    expect(b.pubkey).not.toBe(alicePk)
    // Two wraps of the same rumor must not be linkable to each other.
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(a.content).not.toBe(b.content)
    expect(a.kind).toBe(KIND_GIFT_WRAP)
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
