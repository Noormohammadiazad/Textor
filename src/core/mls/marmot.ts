import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { schnorr } from '@noble/curves/secp256k1.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  decodeMlsMessage,
  encodeMlsMessage,
  encodeRequiredCapabilities,
  generateKeyPackageWithKey,
  mlsExporter,
  type Capabilities,
  type ClientState,
  type Extension,
  type KeyPackage,
  type LeafNode,
  type MLSMessage,
  type Welcome,
} from 'ts-mls'
import { makeKeyPackageRef, verifyKeyPackage, type PrivateKeyPackage } from 'ts-mls/keyPackage.js'
import { createRumor, type Rumor } from '../crypto/giftwrap'
import { KIND_MLS_WELCOME } from '../models/protocol'
import { b64ToBytes, bytesToB64, bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '../util/bytes'
import { normalizeRelayUrl } from '../transport/relayUrl'
import { CIPHERSUITE_ID, SIGNATURE_SCHEME, SUITE } from './suite'

/**
 * Marmot, as far as this app speaks it: the event shapes that carry MLS over
 * Nostr, and the application components that make an MLS group a Marmot one.
 *
 * Followed byte for byte where Textor implements the feature — the kind 30443
 * KeyPackage, kind 444 Welcome and kind 445 group message envelopes, the
 * account identity proof on every leaf, and the routing, profile and admin
 * components of group state. Where it does not, it says so in
 * `docs/DECISIONS.md` (ADR-049) rather than half-implementing it: no
 * `AppDataUpdate` or `SelfRemove` proposals, which ts-mls does not have, so
 * settings change through RFC 9420 GroupContextExtensions and a member leaves
 * with an ordinary Remove proposal for their own leaf.
 *
 * Spec: github.com/marmot-protocol/marmot — `transports/nostr.md`,
 * `foundation/*`, `app-components/*`.
 */

// --- registries -------------------------------------------------------------

export const KIND_KEY_PACKAGE = 30443
export const KIND_WELCOME = KIND_MLS_WELCOME
export const KIND_GROUP_EVENT = 445
/** The local-only event an identity proof signs. Never published. */
const KIND_IDENTITY_PROOF = 450

/** MLS extensions draft: the extension that carries application components. */
export const EXT_APP_DATA_DICTIONARY = 0x0006
/** MLS extensions draft component ids. */
export const COMPONENT_APP_COMPONENTS = 0x0001
/** Marmot component ids (foundation/registries.md). */
export const COMPONENT_PROFILE = 0x8001
export const COMPONENT_ADMIN_POLICY = 0x8003
export const COMPONENT_ROUTING = 0x8004
export const COMPONENT_IDENTITY_PROOF = 0x8009

/** Every component this client understands, advertised on each leaf. */
export const SUPPORTED_COMPONENTS = [
  COMPONENT_PROFILE,
  COMPONENT_ADMIN_POLICY,
  COMPONENT_ROUTING,
  COMPONENT_IDENTITY_PROOF,
] as const

/** The RFC 9420 proposal types this client sends or accepts, advertised on KeyPackages. */
const SUPPORTED_PROPOSALS = [0x0001, 0x0002, 0x0003, 0x0007]

const PROOF_CONTENT = 'Authorize this MLS leaf key for my Marmot account'
const PROOF_D_TAG = 'marmot.account-identity-proof.v2'
/** KeyPackage lifetimes may span at most 84 days and an hour of clock skew. */
export const MAX_LIFETIME_SEC = 7_261_200
const MAX_RELAYS = 16
const HEX64 = /^[0-9a-f]{64}$/

export class MarmotError extends Error {}

const hex16 = (id: number): string => `0x${id.toString(16).padStart(4, '0')}`

// --- Marmot binary profile ----------------------------------------------------

/**
 * TLS presentation language with QUIC variable-length prefixes, which is
 * also how MLS itself encodes vectors. Decoding is canonical: a longer
 * length prefix than needed is rejected, as are trailing bytes.
 */
class Writer {
  #parts: Uint8Array[] = []

  u16(value: number): this {
    this.#parts.push(new Uint8Array([value >> 8, value & 0xff]))
    return this
  }

  u64(value: number): this {
    const out = new Uint8Array(8)
    let rest = value
    for (let i = 7; i >= 0; i--) {
      out[i] = rest % 256
      rest = Math.floor(rest / 256)
    }
    this.#parts.push(out)
    return this
  }

  fixed(bytes: Uint8Array): this {
    this.#parts.push(bytes)
    return this
  }

  vec(bytes: Uint8Array): this {
    const n = bytes.length
    const prefix =
      n < 64
        ? [n]
        : n < 16384
          ? [0x40 | (n >> 8), n & 0xff]
          : [0x80 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
    this.#parts.push(new Uint8Array(prefix), bytes)
    return this
  }

  bytes(): Uint8Array {
    return concatBytes(...this.#parts)
  }
}

class Reader {
  #at = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.#at === this.buf.length
  }

  #take(n: number): Uint8Array {
    if (this.#at + n > this.buf.length) throw new MarmotError('truncated')
    const out = this.buf.subarray(this.#at, this.#at + n)
    this.#at += n
    return out
  }

  u16(): number {
    const [a, b] = this.#take(2) as unknown as [number, number]
    return (a << 8) | b
  }

  u64(): number {
    let value = 0
    for (const byte of this.#take(8)) value = value * 256 + byte
    return value
  }

  fixed(n: number): Uint8Array {
    return this.#take(n)
  }

  vec(): Uint8Array {
    const first = this.#take(1)[0] as number
    const size = 1 << (first >> 6)
    if (size === 8) throw new MarmotError('length prefix too long')
    let length = first & 0x3f
    for (const byte of this.#take(size - 1)) length = length * 256 + byte
    const shortest = length < 64 ? 1 : length < 16384 ? 2 : 4
    if (size !== shortest) throw new MarmotError('length prefix is not minimal')
    return this.#take(length)
  }

  /** A vector of items, each decoded by `item` from the vector's own bytes. */
  list<T>(item: (r: Reader) => T): T[] {
    const inner = new Reader(this.vec())
    const out: T[] = []
    while (!inner.done) out.push(item(inner))
    return out
  }

  end(): void {
    if (!this.done) throw new MarmotError('trailing bytes')
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  }
  return a.length - b.length
}

/** Sorted, and free of duplicates, by exact bytes — the order Marmot lists are signed in. */
function assertSortedUnique(items: Uint8Array[], what: string): void {
  for (let i = 1; i < items.length; i++) {
    if (compareBytes(items[i - 1] as Uint8Array, items[i] as Uint8Array) >= 0) {
      throw new MarmotError(`${what} is not sorted and unique`)
    }
  }
}

// --- app_data_dictionary ------------------------------------------------------

export type Dictionary = Map<number, Uint8Array>

export function encodeDictionary(entries: Dictionary): Uint8Array {
  const body = new Writer()
  for (const id of [...entries.keys()].sort((a, b) => a - b)) body.u16(id).vec(entries.get(id) as Uint8Array)
  return new Writer().vec(body.bytes()).bytes()
}

export function decodeDictionary(data: Uint8Array): Dictionary {
  const r = new Reader(data)
  const out: Dictionary = new Map()
  let previous = -1
  for (const [id, value] of r.list((item) => [item.u16(), item.vec()] as const)) {
    if (id <= previous) throw new MarmotError('dictionary is not sorted and unique')
    previous = id
    out.set(id, value)
  }
  r.end()
  return out
}

export const dictionaryExtension = (entries: Dictionary): Extension => ({
  extensionType: EXT_APP_DATA_DICTIONARY,
  extensionData: encodeDictionary(entries),
})

/** The dictionary an MLS object carries, or null if it has none. More than one is malformed. */
export function dictionaryOf(extensions: readonly Extension[]): Dictionary | null {
  const found = extensions.filter((e) => e.extensionType === EXT_APP_DATA_DICTIONARY)
  if (found.length > 1) throw new MarmotError('more than one app_data_dictionary')
  return found[0] ? decodeDictionary(found[0].extensionData) : null
}

export function encodeComponentList(ids: readonly number[]): Uint8Array {
  const body = new Writer()
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) body.u16(id)
  return new Writer().vec(body.bytes()).bytes()
}

export function decodeComponentList(data: Uint8Array): number[] {
  const r = new Reader(data)
  const ids = r.list((item) => item.u16())
  r.end()
  for (let i = 1; i < ids.length; i++) {
    if ((ids[i] as number) <= (ids[i - 1] as number)) throw new MarmotError('component list is not sorted')
  }
  return ids
}

// --- group state components -----------------------------------------------------

export interface Routing {
  /** 32 random bytes, hex: the `h` tag of every group message. */
  nostrGroupId: string
  /** Canonical sorted list, 1 to 16 relay URLs. */
  relays: string[]
}

export function encodeRouting(routing: Routing): Uint8Array {
  const id = hexToBytes(routing.nostrGroupId)
  if (id.length !== 32) throw new MarmotError('nostr_group_id is not 32 bytes')
  const urls = canonicalRelays(routing.relays)
  const list = new Writer()
  for (const url of urls) list.vec(utf8ToBytes(url))
  return new Writer().fixed(id).vec(list.bytes()).bytes()
}

export function decodeRouting(data: Uint8Array): Routing {
  const r = new Reader(data)
  const id = r.fixed(32)
  const urls = r.list((item) => item.vec())
  r.end()
  if (urls.length === 0 || urls.length > MAX_RELAYS) throw new MarmotError('relay list size')
  assertSortedUnique(urls, 'relay list')
  const relays = urls.map((bytes) => {
    const url = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!isRelayUrl(url)) throw new MarmotError('not a relay URL')
    return url
  })
  return { nostrGroupId: bytesToHex(id), relays }
}

/** The relay URL profile of transports/nostr.md, checked without rewriting anything. */
export function isRelayUrl(url: string): boolean {
  if (utf8ToBytes(url).length > 512) return false
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

/** Producer side: normalise, keep valid ones, sort by bytes, cap. */
export function canonicalRelays(relays: readonly string[]): string[] {
  const set = new Set<string>()
  for (const relay of relays) {
    const url = normalizeRelayUrl(relay)
    if (url && isRelayUrl(url)) set.add(url)
  }
  const sorted = [...set].sort((a, b) => compareBytes(utf8ToBytes(a), utf8ToBytes(b)))
  if (sorted.length === 0) throw new MarmotError('a group needs at least one relay')
  return sorted.slice(0, MAX_RELAYS)
}

export interface Profile {
  name: string
  description: string
}

export function encodeProfile(profile: Profile): Uint8Array {
  const name = utf8ToBytes(profile.name)
  const description = utf8ToBytes(profile.description)
  if (name.length > 256 || description.length > 4096) throw new MarmotError('profile too long')
  return new Writer().vec(name).vec(description).bytes()
}

export function decodeProfile(data: Uint8Array): Profile {
  const r = new Reader(data)
  const name = r.vec()
  const description = r.vec()
  r.end()
  if (name.length > 256 || description.length > 4096) throw new MarmotError('profile too long')
  const text = new TextDecoder('utf-8', { fatal: true })
  return { name: text.decode(name), description: text.decode(description) }
}

export function encodeAdmins(admins: readonly string[]): Uint8Array {
  const keys = [...new Set(admins)].map((admin) => {
    if (!HEX64.test(admin)) throw new MarmotError('admin is not a public key')
    return hexToBytes(admin)
  })
  if (keys.length === 0) throw new MarmotError('a group needs an admin')
  keys.sort(compareBytes)
  return new Writer().vec(concatBytes(...keys)).bytes()
}

export function decodeAdmins(data: Uint8Array): string[] {
  const r = new Reader(data)
  const keys = r.list((item) => item.fixed(32))
  r.end()
  if (keys.length === 0) throw new MarmotError('admin list is empty')
  assertSortedUnique(keys, 'admin list')
  return keys.map(bytesToHex)
}

/** Everything a Marmot group's GroupContext says about it, decoded and validated. */
export interface GroupState {
  routing: Routing
  admins: string[]
  profile: Profile | null
  required: number[]
}

export function groupContextExtensions(state: {
  routing: Routing
  admins: readonly string[]
  profile: Profile | null
}): Extension[] {
  const required = [COMPONENT_ADMIN_POLICY, COMPONENT_ROUTING, COMPONENT_IDENTITY_PROOF]
  const entries: Dictionary = new Map([
    [COMPONENT_ADMIN_POLICY, encodeAdmins(state.admins)],
    [COMPONENT_ROUTING, encodeRouting(state.routing)],
  ])
  if (state.profile) {
    entries.set(COMPONENT_PROFILE, encodeProfile(state.profile))
    required.push(COMPONENT_PROFILE)
  }
  entries.set(COMPONENT_APP_COMPONENTS, encodeComponentList(required))
  return [
    // RFC 9420: every member must understand the dictionary and hold a basic credential.
    {
      extensionType: 'required_capabilities',
      extensionData: encodeRequiredCapabilities({
        extensionTypes: [EXT_APP_DATA_DICTIONARY],
        proposalTypes: [],
        credentialTypes: ['basic'],
      }),
    },
    dictionaryExtension(entries),
  ]
}

export function readGroupState(extensions: readonly Extension[]): GroupState {
  const dictionary = dictionaryOf(extensions)
  if (!dictionary) throw new MarmotError('group has no Marmot state')
  const required = decodeComponentList(requiredEntry(dictionary, COMPONENT_APP_COMPONENTS))
  for (const id of [COMPONENT_ADMIN_POLICY, COMPONENT_ROUTING, COMPONENT_IDENTITY_PROOF]) {
    if (!required.includes(id)) throw new MarmotError(`group does not require component ${hex16(id)}`)
  }
  const profileBytes = dictionary.get(COMPONENT_PROFILE)
  return {
    routing: decodeRouting(requiredEntry(dictionary, COMPONENT_ROUTING)),
    admins: decodeAdmins(requiredEntry(dictionary, COMPONENT_ADMIN_POLICY)),
    profile: profileBytes ? decodeProfile(profileBytes) : null,
    required,
  }
}

function requiredEntry(dictionary: Dictionary, id: number): Uint8Array {
  const value = dictionary.get(id)
  if (!value) throw new MarmotError(`missing component ${hex16(id)}`)
  return value
}

// --- account identity proof (0x8009) -------------------------------------------

function proofEventFields(signer: string, createdAt: number, signatureKey: Uint8Array) {
  return {
    pubkey: signer,
    created_at: createdAt,
    kind: KIND_IDENTITY_PROOF,
    tags: [
      ['d', PROOF_D_TAG],
      ['component', hex16(COMPONENT_IDENTITY_PROOF)],
      ['ciphersuite', hex16(CIPHERSUITE_ID)],
      ['signature_scheme', hex16(SIGNATURE_SCHEME)],
      ['mls_signature_key', bytesToHex(signatureKey)],
    ],
    content: PROOF_CONTENT,
  }
}

/** The event id an identity proof signs. Exposed for the spec's test vector. */
export function identityProofEventId(signer: string, createdAt: number, signatureKey: Uint8Array): string {
  return getEventHash(proofEventFields(signer, createdAt, signatureKey))
}

/**
 * The 104-byte proof that this Nostr account authorised this MLS signature
 * key: signed as a local-only kind 450 event, never published.
 */
export function createIdentityProof(
  secretKey: Uint8Array,
  signatureKey: Uint8Array,
  createdAt: number,
): Uint8Array {
  const event = finalizeEvent(
    {
      kind: KIND_IDENTITY_PROOF,
      created_at: createdAt,
      tags: proofEventFields('', createdAt, signatureKey).tags,
      content: PROOF_CONTENT,
    },
    secretKey,
  )
  return new Writer().fixed(hexToBytes(event.pubkey)).u64(createdAt).fixed(hexToBytes(event.sig)).bytes()
}

/** Does this proof bind `signatureKey` to `identity`? */
export function verifyIdentityProof(proof: Uint8Array, identity: string, signatureKey: Uint8Array): boolean {
  if (proof.length !== 104) return false
  const r = new Reader(proof)
  const signer = bytesToHex(r.fixed(32))
  const createdAt = r.u64()
  const signature = r.fixed(64)
  if (signer !== identity || createdAt < 1 || createdAt > Number.MAX_SAFE_INTEGER) return false
  // noble answers false, rather than throwing, for a key or signature that is not valid.
  return schnorr.verify(
    signature,
    hexToBytes(identityProofEventId(signer, createdAt, signatureKey)),
    hexToBytes(signer),
  )
}

// --- leaves -----------------------------------------------------------------------

/** The dictionary every leaf of ours carries: what it supports, and its proof. */
export function leafExtensions(
  secretKey: Uint8Array,
  signatureKey: Uint8Array,
  createdAt: number,
): Extension[] {
  return [
    dictionaryExtension(
      new Map([
        [COMPONENT_APP_COMPONENTS, encodeComponentList(SUPPORTED_COMPONENTS)],
        [COMPONENT_IDENTITY_PROOF, createIdentityProof(secretKey, signatureKey, createdAt)],
      ]),
    ),
  ]
}

/** The Nostr account a leaf belongs to: its 32-byte basic credential identity. */
export function leafIdentity(leaf: Pick<LeafNode, 'credential'>): string {
  const { credential } = leaf
  if (credential.credentialType !== 'basic' || credential.identity.length !== 32) {
    throw new MarmotError('leaf credential is not a Marmot account identity')
  }
  const identity = bytesToHex(credential.identity)
  try {
    schnorr.utils.lift_x(BigInt(`0x${identity}`))
  } catch {
    throw new MarmotError('credential identity is not a valid x-only public key')
  }
  return identity
}

/**
 * Validate a member leaf as Marmot requires: a Marmot identity, an identity
 * proof for exactly this signature key, and support for every component the
 * group requires. Returns the account it belongs to.
 */
export function validateLeaf(leaf: LeafNode, required: readonly number[]): string {
  const identity = leafIdentity(leaf)
  const dictionary = dictionaryOf(leaf.extensions)
  if (!dictionary) throw new MarmotError('leaf has no app_data_dictionary')
  if (!leaf.capabilities.extensions.includes(EXT_APP_DATA_DICTIONARY)) {
    throw new MarmotError('leaf does not advertise app_data_dictionary')
  }
  const supported = decodeComponentList(requiredEntry(dictionary, COMPONENT_APP_COMPONENTS))
  for (const id of new Set([...required, COMPONENT_IDENTITY_PROOF])) {
    if (!supported.includes(id)) throw new MarmotError(`leaf does not support ${hex16(id)}`)
  }
  const proof = requiredEntry(dictionary, COMPONENT_IDENTITY_PROOF)
  if (!verifyIdentityProof(proof, identity, leaf.signaturePublicKey)) {
    throw new MarmotError('leaf identity proof does not verify')
  }
  return identity
}

/** Every current member leaf's account, in tree order. Throws if any leaf is not valid Marmot. */
export function memberIdentities(state: ClientState, required: readonly number[]): string[] {
  const out: string[] = []
  for (const node of state.ratchetTree) {
    if (node?.nodeType === 'leaf') out.push(validateLeaf(node.leaf, required))
  }
  return out
}

// --- KeyPackages (kind 30443) -------------------------------------------------------

/** What this client's leaves advertise. No GREASE: every value here is one it handles. */
export const CAPABILITIES: Capabilities = {
  versions: ['mls10'],
  ciphersuites: ['MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'],
  extensions: [EXT_APP_DATA_DICTIONARY],
  proposals: [],
  credentials: ['basic'],
}

/** How long a KeyPackage of ours is valid: within Marmot's 84-day ceiling. */
export const KEY_PACKAGE_DAYS = 83

/**
 * A fresh KeyPackage for this account: a new Ed25519 leaf key, authorised by
 * the account's Nostr key through the identity proof, and new HPKE keys.
 */
export async function createKeyPackage(
  secretKey: Uint8Array,
  pubkey: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const signature = await SUITE.signature.keygen()
  return generateKeyPackageWithKey(
    { credentialType: 'basic', identity: hexToBytes(pubkey) },
    CAPABILITIES,
    { notBefore: BigInt(now - 3600), notAfter: BigInt(now + KEY_PACKAGE_DAYS * 86_400) },
    [],
    signature,
    SUITE,
    leafExtensions(secretKey, signature.publicKey, now),
  )
}

export interface KeyPackageCandidate {
  keyPackage: KeyPackage
  /** The KeyPackageRef, hex: what a Welcome names. */
  ref: string
  eventId: string
  owner: string
  createdAt: number
}

export async function keyPackageRef(keyPackage: KeyPackage): Promise<string> {
  return bytesToHex(await makeKeyPackageRef(keyPackage, SUITE.hash))
}

/** The public kind 30443 event advertising one of our KeyPackages. */
export async function keyPackageEvent(
  secretKey: Uint8Array,
  keyPackage: KeyPackage,
  slot: string,
  createdAt: number,
): Promise<NostrEvent> {
  const message: MLSMessage = { keyPackage, wireformat: 'mls_key_package', version: 'mls10' }
  return finalizeEvent(
    {
      kind: KIND_KEY_PACKAGE,
      created_at: createdAt,
      content: bytesToB64(encodeMlsMessage(message)),
      tags: [
        ['d', slot],
        ['mls_protocol_version', '1.0'],
        ['i', await keyPackageRef(keyPackage)],
        ['mls_ciphersuite', hex16(CIPHERSUITE_ID)],
        ['mls_extensions', hex16(EXT_APP_DATA_DICTIONARY)],
        ['mls_proposals', ...SUPPORTED_PROPOSALS.map(hex16)],
        ['app_components', ...SUPPORTED_COMPONENTS.map(hex16)],
      ],
    },
    secretKey,
  )
}

/** The single value of a tag that must appear exactly once with exactly one value. */
function singleton(event: Pick<NostrEvent, 'tags'>, name: string): string {
  const found = event.tags.filter((tag) => tag[0] === name)
  if (found.length !== 1 || found[0]!.length !== 2 || !found[0]![1]) {
    throw new MarmotError(`tag ${name} must appear once with one value`)
  }
  return found[0]![1]
}

/** The values of a list tag that must appear exactly once, non-empty, without repeats. */
function listTag(event: Pick<NostrEvent, 'tags'>, name: string): string[] {
  const found = event.tags.filter((tag) => tag[0] === name)
  if (found.length !== 1) throw new MarmotError(`tag ${name} must appear once`)
  const values = found[0]!.slice(1)
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new MarmotError(`tag ${name} must list distinct values`)
  }
  return values
}

/**
 * Check a fetched kind 30443 event from end to end and return the KeyPackage
 * it carries — or throw, naming what is wrong. The event's own signature is
 * checked by the socket that received it.
 */
export async function parseKeyPackageEvent(
  event: NostrEvent,
  opts: { now?: number; required?: readonly number[] } = {},
): Promise<KeyPackageCandidate> {
  if (event.kind !== KIND_KEY_PACKAGE) throw new MarmotError('not a KeyPackage event')
  if (!HEX64.test(singleton(event, 'd'))) throw new MarmotError('d tag is not 32 bytes of hex')
  if (singleton(event, 'mls_protocol_version') !== '1.0') throw new MarmotError('unsupported MLS version')
  const refHint = singleton(event, 'i')
  if (!listTag(event, 'mls_ciphersuite').includes(hex16(CIPHERSUITE_ID))) {
    throw new MarmotError('KeyPackage is not for ciphersuite 0x0001')
  }
  listTag(event, 'mls_extensions')
  listTag(event, 'mls_proposals')
  if (!listTag(event, 'app_components').includes(hex16(COMPONENT_IDENTITY_PROOF))) {
    throw new MarmotError('KeyPackage does not advertise the identity proof')
  }

  const decoded = decodeMlsMessage(b64ToBytes(event.content), 0)?.[0]
  if (decoded?.wireformat !== 'mls_key_package') throw new MarmotError('content is not a KeyPackage')
  const keyPackage = decoded.keyPackage
  if (keyPackage.version !== 'mls10' || keyPackage.cipherSuite !== SUITE.name) {
    throw new MarmotError('KeyPackage version or ciphersuite')
  }
  if (!(await verifyKeyPackage(keyPackage, SUITE.signature))) throw new MarmotError('KeyPackage signature')
  const ref = await keyPackageRef(keyPackage)
  if (ref !== refHint) throw new MarmotError('i tag does not match the KeyPackage')

  const leaf = keyPackage.leafNode
  const owner = validateLeaf(leaf, opts.required ?? SUPPORTED_COMPONENTS)
  if (owner !== event.pubkey) throw new MarmotError('KeyPackage belongs to someone else')
  const { notBefore, notAfter } = leaf.lifetime
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000))
  if (notAfter - notBefore > BigInt(MAX_LIFETIME_SEC)) throw new MarmotError('lifetime too long')
  if (now < notBefore || now > notAfter) throw new MarmotError('KeyPackage is not current')

  return { keyPackage, ref, eventId: event.id, owner, createdAt: event.created_at }
}

// --- Welcome (kind 444, gift-wrapped) --------------------------------------------------

/** The unsigned kind 444 rumor that goes inside a gift wrap to one new member. */
export function welcomeRumor(
  secretKey: Uint8Array,
  welcome: Welcome,
  keyPackageEventId: string,
  relays: readonly string[],
): Rumor {
  return createRumor(
    {
      kind: KIND_WELCOME,
      content: bytesToB64(encodeMlsMessage({ welcome, wireformat: 'mls_welcome', version: 'mls10' })),
      tags: [
        ['e', keyPackageEventId],
        ['relays', ...relays],
      ],
    },
    secretKey,
  )
}

export function parseWelcomeRumor(rumor: Pick<Rumor, 'kind' | 'tags' | 'content'>): {
  welcome: Welcome
  keyPackageEventId: string
  relays: string[]
} {
  if (rumor.kind !== KIND_WELCOME) throw new MarmotError('not a Welcome')
  const keyPackageEventId = singleton(rumor, 'e')
  if (!HEX64.test(keyPackageEventId)) throw new MarmotError('e tag is not an event id')
  const relays = listTag(rumor, 'relays')
  if (!relays.every(isRelayUrl)) throw new MarmotError('relays tag holds something that is not a relay URL')
  const decoded = decodeMlsMessage(b64ToBytes(rumor.content), 0)?.[0]
  if (decoded?.wireformat !== 'mls_welcome') throw new MarmotError('content is not a Welcome')
  return { welcome: decoded.welcome, keyPackageEventId, relays }
}

// --- group messages (kind 445) ---------------------------------------------------------

/** MLS-Exporter("marmot", "group-event", 32): the epoch's outer key. */
export async function groupEventKey(state: ClientState): Promise<Uint8Array> {
  return mlsExporter(state.keySchedule.exporterSecret, 'marmot', utf8ToBytes('group-event'), 32, SUITE)
}

/** Wrap MLS message bytes for relays: ChaCha20-Poly1305, signed by a key used once. */
export function sealGroupEvent(key: Uint8Array, nostrGroupId: string, mlsBytes: Uint8Array): NostrEvent {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = chacha20poly1305(key, nonce).encrypt(mlsBytes)
  return finalizeEvent(
    {
      kind: KIND_GROUP_EVENT,
      created_at: Math.floor(Date.now() / 1000),
      content: bytesToB64(concatBytes(nonce, ciphertext)),
      tags: [['h', nostrGroupId]],
    },
    generateSecretKey(),
  )
}

/** The group a kind 445 event is addressed to. Its envelope must be exactly so. */
export function groupEventRoute(event: Pick<NostrEvent, 'kind' | 'tags'>): string {
  if (event.kind !== KIND_GROUP_EVENT) throw new MarmotError('not a group message')
  const route = singleton(event, 'h')
  if (!HEX64.test(route)) throw new MarmotError('h tag is not a group id')
  if (event.tags.some((tag) => tag[0] !== 'h' && tag[0] !== 'expiration')) {
    throw new MarmotError('group message carries a tag it must not')
  }
  return route
}

/** Try each candidate key; null when none authenticates, which is not the same as invalid. */
export function openGroupEvent(content: string, keys: readonly Uint8Array[]): Uint8Array | null {
  let raw: Uint8Array
  try {
    raw = b64ToBytes(content)
  } catch {
    throw new MarmotError('content is not base64')
  }
  if (raw.length < 28) throw new MarmotError('content too short')
  const nonce = raw.subarray(0, 12)
  const ciphertext = raw.subarray(12)
  for (const key of keys) {
    try {
      return chacha20poly1305(key, nonce).decrypt(ciphertext)
    } catch {
      /* not this epoch */
    }
  }
  return null
}

/** SHA-256 over the MLS bytes: Marmot's message id, and a commit's digest. */
export const messageId = (mlsBytes: Uint8Array): string => bytesToHex(sha256(mlsBytes))

// --- app payloads -----------------------------------------------------------------------

export interface AppEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

const APP_EVENT_KEYS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content']

/** Serialise an inner app event: exactly the six members, no signature. */
export function encodeAppEvent(event: AppEvent): Uint8Array {
  const { id, pubkey, created_at, kind, tags, content } = event
  return utf8ToBytes(JSON.stringify({ id, pubkey, created_at, kind, tags, content }))
}

/** Decode an inner app event and check its id. Author binding is the caller's to check. */
export function decodeAppEvent(bytes: Uint8Array): AppEvent {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new MarmotError('app payload is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MarmotError('app payload is not an object')
  }
  const keys = Object.keys(value)
  if (keys.length !== APP_EVENT_KEYS.length || !APP_EVENT_KEYS.every((key) => keys.includes(key))) {
    throw new MarmotError('app payload has the wrong members')
  }
  const event = value as AppEvent
  if (
    !HEX64.test(event.id) ||
    !HEX64.test(event.pubkey) ||
    !Number.isSafeInteger(event.created_at) ||
    !Number.isSafeInteger(event.kind) ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags) ||
    !event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
  ) {
    throw new MarmotError('app payload is malformed')
  }
  if (getEventHash(event) !== event.id) throw new MarmotError('app payload id does not match')
  return event
}
