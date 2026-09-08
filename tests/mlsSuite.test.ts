import { describe, expect, it } from 'vitest'
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  acceptAll,
  nobleCryptoProvider,
} from 'ts-mls'
import { SUITE } from '@/core/mls/suite'
import { utf8ToBytes } from '@/core/util/bytes'

/**
 * The ciphersuite is the only cryptography in the MLS layer not imported
 * whole from an audited package, so it is held to other implementations:
 * the HPKE library ts-mls itself depends on, and ts-mls's own provider in a
 * group with a member using this one.
 */

const reference = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
})
const text = new TextDecoder()

describe('HPKE against the reference implementation', () => {
  it('opens what the reference seals, and the reference opens what it seals', async () => {
    const ours = await SUITE.hpke.generateKeyPair()
    const theirs = await reference.kem.generateKeyPair()
    const theirPublic = new Uint8Array(await reference.kem.serializePublicKey(theirs.publicKey))

    const sealed = await SUITE.hpke.seal(
      await SUITE.hpke.importPublicKey(theirPublic),
      utf8ToBytes('to reference'),
      utf8ToBytes('info'),
      utf8ToBytes('aad'),
    )
    const opened = await reference.open(
      { recipientKey: theirs.privateKey, enc: sealed.enc, info: utf8ToBytes('info') },
      sealed.ct,
      utf8ToBytes('aad'),
    )
    expect(text.decode(opened)).toBe('to reference')

    const ourPublic = await reference.kem.deserializePublicKey(
      (await SUITE.hpke.exportPublicKey(ours.publicKey)).buffer as ArrayBuffer,
    )
    const back = await reference.seal(
      { recipientPublicKey: ourPublic, info: utf8ToBytes('i') },
      utf8ToBytes('from reference'),
    )
    expect(
      text.decode(
        await SUITE.hpke.open(
          ours.privateKey,
          new Uint8Array(back.enc),
          new Uint8Array(back.ct),
          utf8ToBytes('i'),
        ),
      ),
    ).toBe('from reference')
  })

  it('derives the same key pair from the same seed', async () => {
    const seed = new Uint8Array(32).fill(7)
    const ours = await SUITE.hpke.deriveKeyPair(seed)
    const theirs = await reference.kem.deriveKeyPair(seed.buffer as ArrayBuffer)
    expect(await SUITE.hpke.exportPublicKey(ours.publicKey)).toEqual(
      new Uint8Array(await reference.kem.serializePublicKey(theirs.publicKey)),
    )
    expect(await SUITE.hpke.exportPrivateKey(ours.privateKey)).toEqual(
      new Uint8Array(await reference.kem.serializePrivateKey(theirs.privateKey)),
    )
  })

  it('exports the same secret on both sides', async () => {
    const theirs = await reference.kem.deriveKeyPair(new Uint8Array(32).fill(9).buffer as ArrayBuffer)
    const ours = await SUITE.hpke.deriveKeyPair(new Uint8Array(32).fill(9))
    const sender = await reference.createSenderContext({
      recipientPublicKey: theirs.publicKey,
      info: utf8ToBytes('x'),
    })
    const expected = new Uint8Array(await sender.export(utf8ToBytes('ctx'), 32))
    expect(
      await SUITE.hpke.importSecret(
        ours.privateKey,
        utf8ToBytes('ctx'),
        new Uint8Array(sender.enc),
        32,
        utf8ToBytes('x'),
      ),
    ).toEqual(expected)

    const exported = await SUITE.hpke.exportSecret(ours.publicKey, utf8ToBytes('ctx'), 32, utf8ToBytes('x'))
    const recipient = await reference.createRecipientContext({
      recipientKey: theirs.privateKey,
      enc: exported.enc,
      info: utf8ToBytes('x'),
    })
    expect(new Uint8Array(await recipient.export(utf8ToBytes('ctx'), 32))).toEqual(exported.secret)
  })

  it('refuses keys of the wrong size and a low-order point', async () => {
    await expect(SUITE.hpke.importPublicKey(new Uint8Array(31))).rejects.toThrow(/32 bytes/)
    await expect(SUITE.hpke.importPrivateKey(new Uint8Array(33))).rejects.toThrow(/32 bytes/)
    const zero = await SUITE.hpke.importPublicKey(new Uint8Array(32))
    await expect(SUITE.hpke.seal(zero, new Uint8Array(1), new Uint8Array(0))).rejects.toThrow()
  })

  it('seals and opens with no associated data at all', async () => {
    const ours = await SUITE.hpke.generateKeyPair()
    const sealed = await SUITE.hpke.seal(ours.publicKey, utf8ToBytes('plain'), utf8ToBytes('info'))
    expect(
      text.decode(await SUITE.hpke.open(ours.privateKey, sealed.enc, sealed.ct, utf8ToBytes('info'))),
    ).toBe('plain')
  })

  it('seals and opens raw AEAD without associated data', async () => {
    const key = new Uint8Array(16).fill(1)
    const nonce = new Uint8Array(12).fill(2)
    const sealed = await SUITE.hpke.encryptAead(key, nonce, undefined, utf8ToBytes('x'))
    expect(text.decode(await SUITE.hpke.decryptAead(key, nonce, undefined, sealed))).toBe('x')
  })
})

describe('the rest of the suite', () => {
  it('signs and verifies with Ed25519, and says no rather than throwing', async () => {
    const { signKey, publicKey } = await SUITE.signature.keygen()
    const signature = await SUITE.signature.sign(signKey, utf8ToBytes('m'))
    expect(await SUITE.signature.verify(publicKey, utf8ToBytes('m'), signature)).toBe(true)
    expect(await SUITE.signature.verify(publicKey, utf8ToBytes('n'), signature)).toBe(false)
    expect(await SUITE.signature.verify(new Uint8Array(3), utf8ToBytes('m'), signature)).toBe(false)
  })

  it('hashes, MACs and derives keys as SHA-256 and HKDF', async () => {
    expect((await SUITE.hash.digest(utf8ToBytes('abc'))).length).toBe(32)
    const mac = await SUITE.hash.mac(new Uint8Array(32), utf8ToBytes('abc'))
    expect(await SUITE.hash.verifyMac(new Uint8Array(32), mac, utf8ToBytes('abc'))).toBe(true)
    expect(await SUITE.hash.verifyMac(new Uint8Array(32), mac, utf8ToBytes('abd'))).toBe(false)
    const prk = await SUITE.kdf.extract(new Uint8Array(0), utf8ToBytes('ikm'))
    expect((await SUITE.kdf.expand(prk, utf8ToBytes('info'), 42)).length).toBe(42)
    expect(SUITE.rng.randomBytes(5)).toHaveLength(5)
  })
})

describe('in a group with ts-mls’s own provider', () => {
  it('interoperates in both directions', async () => {
    const theirs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE.name), nobleCryptoProvider)
    const alice = await generateKeyPackage(
      { credentialType: 'basic', identity: utf8ToBytes('alice') },
      defaultCapabilities(),
      defaultLifetime,
      [],
      SUITE,
    )
    const bob = await generateKeyPackage(
      { credentialType: 'basic', identity: utf8ToBytes('bob') },
      defaultCapabilities(),
      defaultLifetime,
      [],
      theirs,
    )

    let a = await createGroup(utf8ToBytes('interop'), alice.publicPackage, alice.privatePackage, [], SUITE)
    const commit = await createCommit(
      { state: a, cipherSuite: SUITE },
      {
        extraProposals: [{ proposalType: 'add', add: { keyPackage: bob.publicPackage } }],
        ratchetTreeExtension: true,
      },
    )
    a = commit.newState
    let b = await joinGroup(commit.welcome!, bob.publicPackage, bob.privatePackage, emptyPskIndex, theirs)

    const toBob = await createApplicationMessage(a, utf8ToBytes('from our suite'), SUITE)
    a = toBob.newState
    const wire = decodeMlsMessage(
      encodeMlsMessage({
        privateMessage: toBob.privateMessage,
        wireformat: 'mls_private_message',
        version: 'mls10',
      }),
      0,
    )![0]
    const read = await processMessage(wire as never, b, emptyPskIndex, acceptAll, theirs)
    expect(read.kind === 'applicationMessage' && text.decode(read.message)).toBe('from our suite')
    b = read.newState

    // Bob commits with his provider; Alice follows with ours.
    const update = await createCommit({ state: b, cipherSuite: theirs }, { wireAsPublicMessage: true })
    const followed = await processMessage(
      decodeMlsMessage(encodeMlsMessage(update.commit), 0)![0] as never,
      a,
      emptyPskIndex,
      acceptAll,
      SUITE,
    )
    expect(followed.newState.keySchedule.epochAuthenticator).toEqual(
      update.newState.keySchedule.epochAuthenticator,
    )
  })
})
