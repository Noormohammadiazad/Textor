import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as nip19 from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  contactLabel,
  createIdentity,
  formatId,
  identityFromMnemonic,
  identityFromNsec,
  identityFromSecretKey,
  isValidMnemonic,
  normalizeMnemonic,
  parseProfilePointer,
  parsePubkey,
  randomSecretKey,
  secretKeyToHex,
  shortNpub,
  toNpub,
  toNsec,
} from '@/core/identity/keys'
import {
  createInvite,
  decodeInvite,
  extractInvitePayload,
  InviteError,
  inviteLink,
  isValidPubkeyHex,
} from '@/core/identity/invite'
import type { Contact } from '@/core/models/types'
import { bytesToB64url, bytesToHex, concatBytes, utf8ToBytes } from '@/core/util/bytes'

/**
 * Everything an identity is made from and everything a pasted key or invite can be.
 * What arrives here comes from strangers, so every way of being wrong is held to.
 */

vi.mock('nostr-tools/nip19', async (original) => {
  const actual = await original<typeof nip19>()
  return {
    ...actual,
    // An nprofile as another client may write one, with no relays at all.
    decode: (code: string) =>
      code === 'nprofile-without-relays'
        ? { type: 'nprofile', data: { pubkey: 'a'.repeat(64) } }
        : actual.decode(code as never),
  }
})

const NIP06_WORDS = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const NIP06_SECRET = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
const NIP06_PUBLIC = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917'

describe('an identity', () => {
  it('comes from the twelve words the way NIP-06 says, so other clients agree', () => {
    const identity = identityFromMnemonic(NIP06_WORDS)
    expect(bytesToHex(identity.secretKey)).toBe(NIP06_SECRET)
    expect(identity.publicKey).toBe(NIP06_PUBLIC)
    expect(identity.npub).toBe(toNpub(NIP06_PUBLIC))
  })

  it('takes the words however they were pasted', () => {
    const pasted = `  ${NIP06_WORDS.toUpperCase().split(' ').join('  \n ')}  `
    expect(normalizeMnemonic(pasted)).toBe(NIP06_WORDS)
    expect(isValidMnemonic(pasted)).toBe(true)
    expect(identityFromMnemonic(pasted).publicKey).toBe(NIP06_PUBLIC)
  })

  it('is another identity with a BIP-39 passphrase', () => {
    expect(identityFromMnemonic(NIP06_WORDS, 'extra').publicKey).not.toBe(NIP06_PUBLIC)
  })

  it('refuses words that are not a recovery phrase', () => {
    expect(isValidMnemonic('not a phrase')).toBe(false)
    expect(() => identityFromMnemonic('not a phrase')).toThrow('invalid recovery phrase')
    // Real words, wrong checksum.
    expect(() => identityFromMnemonic(NIP06_WORDS.replace('bean', 'ball'))).toThrow()
  })

  it('is made new with the words that bring it back', () => {
    const { identity, mnemonic } = createIdentity()
    expect(identityFromMnemonic(mnemonic).publicKey).toBe(identity.publicKey)
    expect(createIdentity().mnemonic).not.toBe(mnemonic)
  })

  it('takes 32 bytes as a secret key, and nothing else', () => {
    const secret = randomSecretKey()
    expect(identityFromSecretKey(secret).publicKey).toBe(getPublicKey(secret))
    expect(() => identityFromSecretKey(new Uint8Array(31))).toThrow('must be 32 bytes')
  })

  it('is imported from an nsec or a bare hex key, and nothing else', () => {
    const secret = generateSecretKey()
    const publicKey = getPublicKey(secret)
    expect(identityFromNsec(`  ${toNsec(secret)} `).publicKey).toBe(publicKey)
    expect(identityFromNsec(secretKeyToHex(secret)).publicKey).toBe(publicKey)
    expect(() => identityFromNsec(toNpub(publicKey))).toThrow('not an nsec')
    expect(() => identityFromNsec('garbage')).toThrow('not an nsec')
  })
})

describe('a pasted key', () => {
  const pubkey = getPublicKey(generateSecretKey())
  const relays = ['wss://a.example']

  it('is read as a public key from anything that can say one', () => {
    expect(parsePubkey(pubkey)).toBe(pubkey)
    expect(parsePubkey(`  ${toNpub(pubkey)} `)).toBe(pubkey)
    expect(parsePubkey(`nostr:${toNpub(pubkey)}`)).toBe(pubkey)
    expect(parsePubkey(`NOSTR:${nip19.nprofileEncode({ pubkey, relays })}`)).toBe(pubkey)
  })

  it('is not, from anything else', () => {
    expect(parsePubkey('garbage')).toBeNull()
    expect(parsePubkey(toNsec(generateSecretKey()))).toBeNull()
    expect(parsePubkey(pubkey.slice(1))).toBeNull()
  })

  it('brings its relay hints if it has any', () => {
    expect(parseProfilePointer(pubkey)).toEqual({ pubkey, relays: [] })
    expect(parseProfilePointer(toNpub(pubkey))).toEqual({ pubkey, relays: [] })
    expect(parseProfilePointer(`nostr:${nip19.nprofileEncode({ pubkey, relays })}`)).toEqual({
      pubkey,
      relays,
    })
    expect(parseProfilePointer('nprofile-without-relays')).toEqual({ pubkey: 'a'.repeat(64), relays: [] })
  })

  it('is no pointer if it is anything else', () => {
    expect(parseProfilePointer('garbage')).toBeNull()
    expect(parseProfilePointer(toNsec(generateSecretKey()))).toBeNull()
  })

  it('has a short label, from either spelling', () => {
    const label = shortNpub(pubkey)
    expect(label).toBe(shortNpub(toNpub(pubkey)))
    expect(label).toMatch(/^npub1.{5}\.\.\..{6}$/)
  })

  it('counts as a key only in lower-case hex of the right length', () => {
    expect(isValidPubkeyHex(pubkey)).toBe(true)
    expect(isValidPubkeyHex('nope')).toBe(false)
  })
})

describe('what to call someone', () => {
  const pubkey = getPublicKey(generateSecretKey())
  const contact = (over: Partial<Contact>) => ({ name: '', ...over }) as Contact

  it('writes an ID in two groups of five', () => {
    expect(formatId('7X9K2M4QHD')).toBe('7X9K2-M4QHD')
  })

  it('goes by the name given here, then the one they gave, then their ID', () => {
    const all = { name: 'Given', remoteName: 'Theirs', textorId: '7X9K2M4QHD' }
    expect(contactLabel(contact(all), pubkey)).toBe('Given')
    expect(contactLabel(contact({ ...all, name: '' }), pubkey)).toBe('Theirs')
    expect(contactLabel(contact({ textorId: '7X9K2M4QHD' }), pubkey)).toBe('7X9K2-M4QHD')
  })

  it('falls back to a piece of the key only with nothing else to go by', () => {
    expect(contactLabel(contact({}), pubkey)).toBe(shortNpub(pubkey))
    expect(contactLabel(undefined, pubkey)).toBe(shortNpub(pubkey))
  })
})

describe('an invite built by hand, as an attacker would', () => {
  const secret = generateSecretKey()
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    return bytes
  }
  const header = () =>
    concatBytes(
      new Uint8Array([1]),
      Uint8Array.from(Buffer.from(getPublicKey(secret), 'hex')),
      u32(1_800_000_000),
    )
  /** Signed properly, so it is the shape that gets it refused. */
  const signed = (...parts: Uint8Array[]) => {
    const body = concatBytes(header(), ...parts)
    return bytesToB64url(concatBytes(body, schnorr.sign(sha256(body), secret)))
  }
  const bytes = (...values: number[]) => new Uint8Array(values)
  const text = (value: string) => {
    const encoded = utf8ToBytes(value)
    return concatBytes(bytes(encoded.length), encoded)
  }

  it('reads relays in each form one can be written', () => {
    const invite = decodeInvite(
      signed(
        text('Sara'),
        bytes(3),
        bytes(0),
        text('a.example'),
        bytes(1),
        text('localhost:7777'),
        bytes(2),
        text('wss://c.example'),
      ),
    )
    expect(invite.relays).toEqual(['wss://a.example', 'ws://localhost:7777', 'wss://c.example'])
  })

  it('drops a relay that is no relay', () => {
    const invite = decodeInvite(signed(text('Sara'), bytes(1), bytes(2), text('https://nope.example')))
    expect(invite.relays).toEqual([])
  })

  it.each([
    ['a relay scheme it does not know', () => signed(text(''), bytes(1), bytes(9), text('x'))],
    ['more relays than allowed', () => signed(text(''), bytes(7))],
    ['a relay named but not there', () => signed(text(''), bytes(1))],
    ['a relay shorter than it says', () => signed(text(''), bytes(1), bytes(0), bytes(50), bytes(97))],
    [
      'a relay longer than allowed',
      () => signed(text(''), bytes(1), bytes(0), bytes(200), new Uint8Array(200)),
    ],
    ['a name longer than allowed', () => signed(bytes(200), new Uint8Array(200), bytes(0))],
    ['a name that is not UTF-8', () => signed(bytes(2), bytes(0xff, 0xfe), bytes(0))],
    ['a name shorter than it says', () => signed(bytes(90), bytes(97), bytes(0))],
  ])('refuses %s', (_label, make) => {
    expect(() => decodeInvite(make())).toThrow()
  })

  it('says what was wrong with a name it cannot read', () => {
    expect(() => decodeInvite(signed(bytes(2), bytes(0xff, 0xfe), bytes(0)))).toThrow(InviteError)
  })

  it('makes an invite at the time it is told, and refuses a relay too long to carry', () => {
    const encoded = createInvite(secret, { name: 'Sara', relays: [], createdAt: 1234 })
    expect(decodeInvite(encoded).createdAt).toBe(1234)
    const long = `wss://${'a'.repeat(200)}.example`
    expect(() => createInvite(secret, { name: '', relays: [long] })).toThrow('invite field too long')
  })

  it('carries a local relay', () => {
    const encoded = createInvite(secret, { name: '', relays: ['ws://localhost:7777'] })
    expect(decodeInvite(encoded).relays).toEqual(['ws://localhost:7777'])
  })

  it('finds no payload in what has none', () => {
    expect(extractInvitePayload('short')).toBeNull()
    expect(extractInvitePayload('#/i/')).toBeNull()
  })

  it('links from where the app is, if it has to', () => {
    expect(inviteLink('abc')).toBe('/#/i/abc')
    vi.stubGlobal('location', { origin: 'https://example.org', pathname: '/Textor/' })
    expect(inviteLink('abc')).toBe('https://example.org/Textor/#/i/abc')
    vi.unstubAllGlobals()
  })
})
