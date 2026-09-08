import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { encodeMlsMessage, generateKeyPackageWithKey, type KeyPackage } from 'ts-mls'
import { SUITE } from '@/core/mls/suite'
import {
  CAPABILITIES,
  canonicalRelays,
  COMPONENT_ADMIN_POLICY,
  COMPONENT_APP_COMPONENTS,
  COMPONENT_IDENTITY_PROOF,
  COMPONENT_PROFILE,
  COMPONENT_ROUTING,
  createIdentityProof,
  createKeyPackage,
  decodeAdmins,
  decodeAppEvent,
  decodeComponentList,
  decodeDictionary,
  decodeProfile,
  decodeRouting,
  dictionaryExtension,
  dictionaryOf,
  encodeAdmins,
  encodeAppEvent,
  encodeComponentList,
  encodeDictionary,
  encodeProfile,
  encodeRouting,
  groupContextExtensions,
  groupEventRoute,
  identityProofEventId,
  isRelayUrl,
  keyPackageEvent,
  leafExtensions,
  leafIdentity,
  MAX_LIFETIME_SEC,
  openGroupEvent,
  parseKeyPackageEvent,
  parseWelcomeRumor,
  readGroupState,
  sealGroupEvent,
  validateLeaf,
  verifyIdentityProof,
  welcomeRumor,
  type AppEvent,
} from '@/core/mls/marmot'
import { bytesToB64, bytesToHex, hexToBytes, utf8ToBytes } from '@/core/util/bytes'
import { getEventHash } from 'nostr-tools/pure'

/**
 * Marmot's byte formats, checked against the spec where it gives a vector and
 * against every way a peer or relay could hand over something malformed.
 */

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const nowSec = () => Math.floor(Date.now() / 1000)
const GROUP_ID = 'ab'.repeat(32)

describe('the account identity proof', () => {
  it('matches the spec’s signing test vector', () => {
    // app-components/account-identity-proof-v2.md, "Signing test vector".
    const signer = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
    const key = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    expect(identityProofEventId(signer, 1_700_000_000, key)).toBe(
      'b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b',
    )
    const component = hexToBytes(
      'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000006553f100c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d',
    )
    expect(verifyIdentityProof(component, signer, key)).toBe(true)
    // Secret key 3 signs the same event: our encoding of the envelope matches.
    const ours = createIdentityProof(hexToBytes('0'.repeat(63) + '3'), key, 1_700_000_000)
    expect(bytesToHex(ours.subarray(0, 40))).toBe(bytesToHex(component.subarray(0, 40)))
    expect(verifyIdentityProof(ours, signer, key)).toBe(true)
  })

  it('binds exactly one account to exactly one leaf key', () => {
    const key = new Uint8Array(32).fill(5)
    const proof = createIdentityProof(sk, key, nowSec())
    expect(verifyIdentityProof(proof, pk, key)).toBe(true)
    expect(verifyIdentityProof(proof, pk, new Uint8Array(32).fill(6))).toBe(false)
    expect(verifyIdentityProof(proof, getPublicKey(generateSecretKey()), key)).toBe(false)
    expect(verifyIdentityProof(proof.subarray(0, 103), pk, key)).toBe(false)
    const zeroTime = createIdentityProof(sk, key, 0)
    expect(verifyIdentityProof(zeroTime, pk, key)).toBe(false)
    const garbled = new Uint8Array(proof)
    garbled[50] = (garbled[50] as number) ^ 1
    expect(verifyIdentityProof(garbled, pk, key)).toBe(false)
  })
})

describe('the binary profile', () => {
  it('round-trips a dictionary, sorted, and refuses one that is not', () => {
    const dict = new Map([
      [0x8004, new Uint8Array([1])],
      [0x0001, new Uint8Array(70).fill(2)],
    ])
    const bytes = encodeDictionary(dict)
    expect([...decodeDictionary(bytes).keys()]).toEqual([0x0001, 0x8004])
    // Two entries, out of order.
    const unsorted = new Uint8Array([7, 0x80, 0x04, 1, 9, 0x00, 0x01, 0])
    expect(() => decodeDictionary(unsorted)).toThrow(/sorted/)
    expect(() => decodeDictionary(new Uint8Array([...bytes, 0]))).toThrow(/trailing/)
    expect(() => decodeDictionary(new Uint8Array([0x40, 0x01, 0]))).toThrow(/minimal/)
    expect(() => decodeDictionary(new Uint8Array([0xc0]))).toThrow(/too long/)
    expect(() => decodeDictionary(new Uint8Array([5, 0]))).toThrow(/truncated/)
    // A long value takes the four-byte prefix.
    const big = new Map([[0x0001, new Uint8Array(20_000)]])
    expect(decodeDictionary(encodeDictionary(big)).get(0x0001)).toHaveLength(20_000)
  })

  it('finds at most one dictionary on an MLS object', () => {
    const ext = dictionaryExtension(new Map([[1, new Uint8Array(0)]]))
    expect(dictionaryOf([])).toBeNull()
    expect(dictionaryOf([ext])?.has(1)).toBe(true)
    expect(() => dictionaryOf([ext, ext])).toThrow(/more than one/)
  })

  it('lists components sorted and unique', () => {
    expect(decodeComponentList(encodeComponentList([0x8009, 0x8001, 0x8001]))).toEqual([0x8001, 0x8009])
    expect(() => decodeComponentList(new Uint8Array([4, 0x80, 9, 0x80, 1]))).toThrow(/sorted/)
  })
})

describe('group state components', () => {
  it('routing: a random id and a canonical relay list', () => {
    const routing = {
      nostrGroupId: GROUP_ID,
      relays: ['wss://b.example', 'wss://A.example/', 'https://x.example'],
    }
    const decoded = decodeRouting(encodeRouting(routing))
    expect(decoded).toEqual({ nostrGroupId: GROUP_ID, relays: ['wss://a.example', 'wss://b.example'] })
    expect(() => encodeRouting({ nostrGroupId: 'ab', relays: ['wss://a.example'] })).toThrow(/32 bytes/)
    expect(() => canonicalRelays(['not a url'])).toThrow(/at least one relay/)
    expect(canonicalRelays(Array.from({ length: 20 }, (_, i) => `wss://r${i}.example`))).toHaveLength(16)
  })

  it('routing: refuses what a signer should never have produced', () => {
    const id = hexToBytes(GROUP_ID)
    const url = (u: string) => [utf8ToBytes(u).length, ...utf8ToBytes(u)]
    const list = (...urls: string[]) => {
      const body = urls.flatMap(url)
      return new Uint8Array([...id, body.length, ...body])
    }
    expect(() => decodeRouting(new Uint8Array([...id, 0]))).toThrow(/size/)
    expect(() => decodeRouting(list('wss://b.example', 'wss://a.example'))).toThrow(/sorted/)
    expect(() => decodeRouting(list('wss://a.example', 'wss://a.example'))).toThrow(/sorted/)
    expect(() => decodeRouting(list('https://a.example'))).toThrow(/relay URL/)
  })

  it('knows a relay URL when it sees one', () => {
    expect(isRelayUrl('wss://relay.example')).toBe(true)
    expect(isRelayUrl('ws://relay.example:7000/path')).toBe(true)
    expect(isRelayUrl('wss://user:pw@relay.example')).toBe(false)
    expect(isRelayUrl('wss://relay.example#frag')).toBe(false)
    expect(isRelayUrl('https://relay.example')).toBe(false)
    expect(isRelayUrl('nonsense')).toBe(false)
    expect(isRelayUrl(`wss://${'a'.repeat(520)}.example`)).toBe(false)
  })

  it('profile: UTF-8, within Marmot’s limits', () => {
    expect(decodeProfile(encodeProfile({ name: 'Family · خانواده', description: '' }))).toEqual({
      name: 'Family · خانواده',
      description: '',
    })
    expect(() => encodeProfile({ name: 'x'.repeat(257), description: '' })).toThrow(/too long/)
    const tooLong = new Uint8Array([0x41, 0x01, ...new Uint8Array(257), 0])
    expect(() => decodeProfile(tooLong)).toThrow(/too long/)
  })

  it('admins: sorted, unique, never empty', () => {
    const a = 'aa'.repeat(32)
    const b = 'bb'.repeat(32)
    expect(decodeAdmins(encodeAdmins([b, a, b]))).toEqual([a, b])
    expect(() => encodeAdmins([])).toThrow(/needs an admin/)
    expect(() => encodeAdmins(['nope'])).toThrow(/not a public key/)
    expect(() => decodeAdmins(new Uint8Array([0]))).toThrow(/empty/)
    expect(() => decodeAdmins(new Uint8Array([0x40, 64, ...hexToBytes(b), ...hexToBytes(a)]))).toThrow(
      /sorted/,
    )
  })

  it('reads a GroupContext back, and requires what every Marmot group requires', () => {
    const exts = groupContextExtensions({
      routing: { nostrGroupId: GROUP_ID, relays: ['wss://a.example'] },
      admins: [pk],
      profile: { name: 'Team', description: 'd' },
    })
    const state = readGroupState(exts)
    expect(state).toMatchObject({ admins: [pk], profile: { name: 'Team' } })
    expect(state.required).toEqual([
      COMPONENT_PROFILE,
      COMPONENT_ADMIN_POLICY,
      COMPONENT_ROUTING,
      COMPONENT_IDENTITY_PROOF,
    ])
    expect(
      readGroupState(groupContextExtensions({ routing: state.routing, admins: [pk], profile: null })).profile,
    ).toBeNull()

    expect(() => readGroupState([])).toThrow(/no Marmot state/)
    const without = (
      id: number,
      required = [COMPONENT_ADMIN_POLICY, COMPONENT_ROUTING, COMPONENT_IDENTITY_PROOF],
    ) => {
      const entries = new Map([
        [COMPONENT_APP_COMPONENTS, encodeComponentList(required)],
        [COMPONENT_ADMIN_POLICY, encodeAdmins([pk])],
        [COMPONENT_ROUTING, encodeRouting(state.routing)],
      ])
      entries.delete(id)
      return [dictionaryExtension(entries)]
    }
    expect(() => readGroupState(without(COMPONENT_ROUTING))).toThrow(/missing component 0x8004/)
    expect(() => readGroupState(without(0, [COMPONENT_ROUTING]))).toThrow(/does not require component 0x8003/)
  })
})

describe('KeyPackages', () => {
  it('publishes a package any Marmot client can check, and reads it back', async () => {
    const kp = await createKeyPackage(sk, pk)
    const event = await keyPackageEvent(sk, kp.publicPackage, 'cd'.repeat(32), nowSec())
    expect(event.kind).toBe(30443)
    expect(event.tags.map((t) => t[0])).toEqual([
      'd',
      'mls_protocol_version',
      'i',
      'mls_ciphersuite',
      'mls_extensions',
      'mls_proposals',
      'app_components',
    ])
    const candidate = await parseKeyPackageEvent(event)
    expect(candidate).toMatchObject({ owner: pk, eventId: event.id, createdAt: event.created_at })
    expect(candidate.ref).toBe(event.tags.find((t) => t[0] === 'i')?.[1])
    const leaf = candidate.keyPackage.leafNode
    expect(leaf.lifetime.notAfter - leaf.lifetime.notBefore).toBeLessThanOrEqual(BigInt(MAX_LIFETIME_SEC))
  })

  it('refuses every way a package can be wrong', async () => {
    const kp = await createKeyPackage(sk, pk)
    const good = await keyPackageEvent(sk, kp.publicPackage, 'cd'.repeat(32), nowSec())
    const resign = (patch: Partial<NostrEvent>, key = sk) =>
      finalizeEvent(
        { kind: good.kind, created_at: good.created_at, tags: good.tags, content: good.content, ...patch },
        key,
      )
    const retag = (name: string, value: string[] | null) =>
      resign({
        tags:
          value === null
            ? good.tags.filter((t) => t[0] !== name)
            : good.tags.map((t) => (t[0] === name ? [name, ...value] : t)),
      })
    const check = (event: NostrEvent, opts = {}) => parseKeyPackageEvent(event, opts)

    await expect(check(resign({ kind: 1 }))).rejects.toThrow(/not a KeyPackage event/)
    await expect(check(retag('d', ['short']))).rejects.toThrow(/d tag/)
    await expect(check(resign({ tags: [...good.tags, ['d', 'ef'.repeat(32)]] }))).rejects.toThrow(
      /tag d must appear once/,
    )
    await expect(check(retag('mls_protocol_version', ['2.0']))).rejects.toThrow(/version/)
    await expect(check(retag('mls_ciphersuite', ['0x0002']))).rejects.toThrow(/ciphersuite 0x0001/)
    await expect(check(retag('mls_extensions', []))).rejects.toThrow(/distinct values/)
    await expect(check(resign({ tags: [...good.tags, ['mls_proposals', '0x0001']] }))).rejects.toThrow(
      /must appear once/,
    )
    await expect(check(retag('app_components', ['0x8001']))).rejects.toThrow(/identity proof/)
    await expect(check(resign({ content: bytesToB64(utf8ToBytes('junk')) }))).rejects.toThrow(
      /not a KeyPackage/,
    )
    await expect(check(retag('i', ['00'.repeat(32)]))).rejects.toThrow(/i tag/)
    // Someone else republishing my package under their own key.
    await expect(check(resign({}, generateSecretKey()))).rejects.toThrow(/someone else/)
    await expect(check(good, { now: nowSec() + 90 * 86400 })).rejects.toThrow(/not current/)
    await expect(check(good, { required: [0x8007] })).rejects.toThrow(/does not support 0x8007/)

    // A package whose own signature fails, and one for another suite.
    const forged: KeyPackage = { ...kp.publicPackage, signature: new Uint8Array(64) }
    const content = (keyPackage: KeyPackage) =>
      bytesToB64(encodeMlsMessage({ keyPackage, wireformat: 'mls_key_package', version: 'mls10' }))
    await expect(check(resign({ content: content(forged) }))).rejects.toThrow(/KeyPackage signature/)
    await expect(
      check(
        resign({
          content: content({ ...kp.publicPackage, cipherSuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256' }),
        }),
      ),
    ).rejects.toThrow(/ciphersuite/)

    // A properly signed package whose lifetime runs past Marmot's ceiling.
    const signature = await SUITE.signature.keygen()
    const long = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: hexToBytes(pk) },
      CAPABILITIES,
      { notBefore: BigInt(nowSec() - 60), notAfter: BigInt(nowSec() - 60 + MAX_LIFETIME_SEC + 1) },
      [],
      signature,
      SUITE,
      leafExtensions(sk, signature.publicKey, nowSec()),
    )
    await expect(
      check(await keyPackageEvent(sk, long.publicPackage, 'cd'.repeat(32), nowSec())),
    ).rejects.toThrow(/lifetime too long/)
  })

  it('reads a leaf’s account, and refuses one that is not a Nostr key', () => {
    expect(() =>
      leafIdentity({ credential: { credentialType: 'basic', identity: new Uint8Array(31) } }),
    ).toThrow(/Marmot account/)
    // x = 5 is not on secp256k1.
    const offCurve = hexToBytes('0'.repeat(63) + '5')
    expect(() => leafIdentity({ credential: { credentialType: 'basic', identity: offCurve } })).toThrow(
      /x-only/,
    )
  })

  it('refuses a leaf without the dictionary, the proof, or support for what is required', async () => {
    const kp = await createKeyPackage(sk, pk)
    const leaf = kp.publicPackage.leafNode
    expect(validateLeaf(leaf, [])).toBe(pk)
    expect(() => validateLeaf({ ...leaf, extensions: [] }, [])).toThrow(/no app_data_dictionary/)
    expect(() =>
      validateLeaf({ ...leaf, capabilities: { ...leaf.capabilities, extensions: [] } }, []),
    ).toThrow(/advertise/)
    const noProof = dictionaryExtension(new Map([[COMPONENT_APP_COMPONENTS, encodeComponentList([0x8009])]]))
    expect(() => validateLeaf({ ...leaf, extensions: [noProof] }, [])).toThrow(/missing component 0x8009/)
    const wrongProof = dictionaryExtension(
      new Map([
        [COMPONENT_APP_COMPONENTS, encodeComponentList([0x8009])],
        [COMPONENT_IDENTITY_PROOF, createIdentityProof(sk, new Uint8Array(32), nowSec())],
      ]),
    )
    expect(() => validateLeaf({ ...leaf, extensions: [wrongProof] }, [])).toThrow(/does not verify/)
  })
})

describe('Welcomes', () => {
  it('carry the KeyPackage they consumed and where to find the group', async () => {
    const welcome = {
      cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
      secrets: [],
      encryptedGroupInfo: new Uint8Array(0),
    } as const
    const rumor = welcomeRumor(sk, welcome as never, 'ef'.repeat(32), ['wss://a.example'])
    expect(rumor.kind).toBe(444)
    expect('sig' in rumor).toBe(false)
    const parsed = parseWelcomeRumor(rumor)
    expect(parsed).toMatchObject({ keyPackageEventId: 'ef'.repeat(32), relays: ['wss://a.example'] })

    const bad = (patch: Partial<typeof rumor>) => () => parseWelcomeRumor({ ...rumor, ...patch })
    expect(bad({ kind: 1 })).toThrow(/not a Welcome/)
    expect(
      bad({
        tags: [
          ['e', 'x'],
          ['relays', 'wss://a.example'],
        ],
      }),
    ).toThrow(/not an event id/)
    expect(bad({ tags: [['e', 'ef'.repeat(32)]] })).toThrow(/relays must appear once/)
    expect(
      bad({
        tags: [
          ['e', 'ef'.repeat(32)],
          ['relays', 'https://a.example'],
        ],
      }),
    ).toThrow(/relay URL/)
    expect(bad({ content: bytesToB64(utf8ToBytes('x')) })).toThrow(/not a Welcome/)
  })
})

describe('group messages', () => {
  const key = new Uint8Array(32).fill(3)

  it('are sealed under the epoch key, signed by a key used once, tagged with the group alone', () => {
    const a = sealGroupEvent(key, GROUP_ID, utf8ToBytes('mls bytes'))
    const b = sealGroupEvent(key, GROUP_ID, utf8ToBytes('mls bytes'))
    expect(a.kind).toBe(445)
    expect(a.tags).toEqual([['h', GROUP_ID]])
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(a.content).not.toBe(b.content)
    expect(groupEventRoute(a)).toBe(GROUP_ID)
    expect(new TextDecoder().decode(openGroupEvent(a.content, [new Uint8Array(32), key])!)).toBe('mls bytes')
    expect(openGroupEvent(a.content, [new Uint8Array(32)])).toBeNull()
  })

  it('refuse an envelope Marmot does not allow', () => {
    expect(() => groupEventRoute({ kind: 1, tags: [] })).toThrow(/not a group message/)
    expect(() => groupEventRoute({ kind: 445, tags: [['h', 'x']] })).toThrow(/not a group id/)
    expect(() =>
      groupEventRoute({
        kind: 445,
        tags: [
          ['h', GROUP_ID],
          ['h', GROUP_ID],
        ],
      }),
    ).toThrow(/once/)
    expect(() =>
      groupEventRoute({
        kind: 445,
        tags: [
          ['h', GROUP_ID],
          ['p', pk],
        ],
      }),
    ).toThrow(/must not/)
    expect(
      groupEventRoute({
        kind: 445,
        tags: [
          ['h', GROUP_ID],
          ['expiration', '1'],
        ],
      }),
    ).toBe(GROUP_ID)
    expect(() => openGroupEvent('%%%', [key])).toThrow(/base64/)
    expect(() => openGroupEvent(bytesToB64(new Uint8Array(27)), [key])).toThrow(/too short/)
  })
})

describe('app payloads', () => {
  const event = (): AppEvent => {
    const base = { pubkey: pk, created_at: nowSec(), kind: 9, tags: [['e', 'ab'.repeat(32)]], content: 'hi' }
    return { ...base, id: getEventHash(base) }
  }

  it('are the six Nostr members, unsigned, with a matching id', () => {
    const e = event()
    expect(decodeAppEvent(encodeAppEvent(e))).toEqual(e)
    expect(
      JSON.parse(new TextDecoder().decode(encodeAppEvent({ ...e, sig: 'x' } as AppEvent))),
    ).not.toHaveProperty('sig')
  })

  it('refuse anything else', () => {
    const e = event()
    const raw = (value: unknown) => utf8ToBytes(JSON.stringify(value))
    expect(() => decodeAppEvent(utf8ToBytes('{'))).toThrow(/not JSON/)
    expect(() => decodeAppEvent(new Uint8Array([0xff]))).toThrow(/not JSON/)
    expect(() => decodeAppEvent(raw([1]))).toThrow(/not an object/)
    expect(() => decodeAppEvent(raw({ ...e, sig: 'x' }))).toThrow(/wrong members/)
    expect(() => decodeAppEvent(raw({ ...e, id: undefined }))).toThrow(/wrong members/)
    expect(() => decodeAppEvent(raw({ ...e, kind: 'nine' }))).toThrow(/malformed/)
    expect(() => decodeAppEvent(raw({ ...e, tags: [[1]] }))).toThrow(/malformed/)
    expect(() => decodeAppEvent(raw({ ...e, content: 'changed' }))).toThrow(/id does not match/)
  })
})
