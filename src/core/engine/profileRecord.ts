import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { KIND_DELETION, RETRACTION_TTL_SEC } from '../crypto/giftwrap'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { SyncProfile } from '../models/protocol'
import type { ProfileStamps } from '../models/types'
import {
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
  wipe,
} from '../util/bytes'

/** NIP-78, application data: replaceable, so relays keep only the newest of each. */
export const KIND_APP_DATA = 30078
/** Refreshed monthly while any device runs. Long, because this is what a restore has left to read. */
export const RECORD_TTL_SEC = 365 * 86_400

const MAX_NAME = 128
const MAX_ABOUT = 512
const MAX_AVATAR = 64 * 1024

const AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

export type RecordSlot = 'me' | 'avatar'
/** A list, which may take several events. */
export type PartSlot = 'people' | 'gone'

/** What one event of a list holds: as base64, under the size NIP-44 pads up to `MAX_RECORD_AVATAR`. */
const PART_BYTES = 30_000
export const MAX_RECORD_PARTS = 8
/** The most a list may come to, whole. */
export const MAX_RECORD_BYTES = MAX_RECORD_PARTS * PART_BYTES

export interface RecordKeys {
  /** Signs the records. Nothing ties it to the identity without the identity's secret key. */
  signer: Uint8Array
  pubkey: string
  sealKey: Uint8Array
  /** Each record's `d`. Drawn, so it does not mark these out as Textor's. */
  d: Record<RecordSlot, string>
  /** Draws the `d` of each event of a list. */
  tagKey: Uint8Array
}

/** The same on every device with this secret key, and nowhere else. */
export function recordKeys(secretKey: Uint8Array): RecordKeys {
  // Asking for more only adds to the end, so records already on relays keep their keys.
  const drawn = hkdf(sha256, secretKey, undefined, utf8ToBytes('textor/profile/v1'), 144)
  const signer = schnorr.utils.randomSecretKey(drawn.subarray(0, 48))
  const keys: RecordKeys = {
    signer,
    pubkey: getPublicKey(signer),
    sealKey: drawn.slice(48, 80),
    d: { me: bytesToHex(drawn.subarray(80, 96)), avatar: bytesToHex(drawn.subarray(96, 112)) },
    tagKey: drawn.slice(112, 144),
  }
  wipe(drawn)
  return keys
}

export function wipeRecordKeys(keys: RecordKeys): void {
  wipe(keys.signer)
  wipe(keys.sealKey)
  wipe(keys.tagKey)
}

const isStamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** A profile as another device or a record told it, bounded as every frame is. */
export function readProfile(raw: unknown): SyncProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { name, about, avatar, at } = raw as Record<string, unknown>
  if (name !== undefined && (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME)) {
    return null
  }
  if (about !== undefined && (typeof about !== 'string' || about.length > MAX_ABOUT)) return null
  if (
    avatar !== undefined &&
    (typeof avatar !== 'string' || avatar.length > MAX_AVATAR || (avatar !== '' && !AVATAR.test(avatar)))
  ) {
    return null
  }
  if (typeof at !== 'object' || at === null) return null
  const stamps: ProfileStamps = {}
  for (const part of ['name', 'about', 'avatar'] as const) {
    const stamp = (at as ProfileStamps)[part]
    if (stamp === undefined) continue
    if (!isStamp(stamp)) return null
    stamps[part] = stamp
  }
  const profile: SyncProfile = { at: stamps }
  if (name !== undefined) profile.name = name as string
  if (about !== undefined) profile.about = about as string
  if (avatar !== undefined) profile.avatar = avatar as string
  return profile
}

/**
 * A record of part of this identity's own profile, for its other devices and
 * for whoever restores it from the twelve words (ADR-077).
 *
 * Sealed with a key only the identity's secret key gives, and signed by a key
 * nothing public ties to it. A relay holds an opaque event from a key seen
 * nowhere else, and never a kind 0.
 */
export function sealRecord(
  slot: RecordSlot,
  profile: SyncProfile,
  keys: RecordKeys,
  nowSec: number,
): NostrEvent {
  return seal(keys.d[slot], { slot, ...profile }, keys, nowSec)
}

function seal(d: string, body: object, keys: RecordKeys, nowSec: number): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: nowSec,
      tags: [
        ['d', d],
        ['expiration', String(nowSec + RECORD_TTL_SEC)],
      ],
      content: nip44.encrypt(JSON.stringify(body), keys.sealKey),
    },
    keys.signer,
  )
}

const partTag = (keys: RecordKeys, slot: PartSlot, index: number): string =>
  bytesToHex(hmac(sha256, keys.tagKey, utf8ToBytes(`${slot}/${index}`)).subarray(0, 16))

/**
 * A whole list, as however many events it takes (ADR-078).
 *
 * Each replaces the event before it at that place, and those a longer list took
 * and this one does not need are named in `staleParts`, and written empty: what
 * they held would otherwise stay on the relays for good.
 */
export function sealParts(
  slot: PartSlot,
  value: unknown,
  stamp: number,
  keys: RecordKeys,
  nowSec: number,
  staleParts = 0,
): NostrEvent[] {
  const bytes = utf8ToBytes(JSON.stringify(value))
  const count = Math.max(1, Math.ceil(bytes.length / PART_BYTES))
  const events: NostrEvent[] = []
  for (let index = 0; index < Math.max(count, staleParts); index++) {
    const piece = index < count ? bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES) : null
    events.push(
      seal(
        partTag(keys, slot, index),
        { slot, s: stamp, i: index, n: count, data: piece ? bytesToB64(piece) : '' },
        keys,
        nowSec,
      ),
    )
  }
  return events
}

/**
 * Ask relays to delete versions of a list that a newer one replaces (NIP-09).
 *
 * A relay that took the new one has dropped the old already. This is for one that
 * would not: small enough to get through where the list is not, and signed by the
 * records' own key, the one signature relays honour (ADR-073).
 */
export function retractParts(ids: readonly string[], keys: RecordKeys, nowSec: number): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_DELETION,
      created_at: nowSec,
      tags: [
        ...ids.map((id) => ['e', id]),
        ['k', String(KIND_APP_DATA)],
        ['expiration', String(nowSec + RETRACTION_TTL_SEC)],
      ],
      content: '',
    },
    keys.signer,
  )
}

export interface OpenedRecord {
  slot: RecordSlot
  profile: SyncProfile
  createdAt: number
}

export interface OpenedPart {
  id: string
  slot: PartSlot
  stamp: number
  index: number
  count: number
  data: string
  createdAt: number
}

const isPlace = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RECORD_PARTS

/** What is inside an event. Its seal is what proves it ours: a relay can only withhold it or replay it. */
export function openRecord(event: NostrEvent, keys: RecordKeys): OpenedRecord | OpenedPart | null {
  try {
    const raw = JSON.parse(nip44.decrypt(event.content, keys.sealKey)) as Record<string, unknown>
    if (raw.slot === 'people' || raw.slot === 'gone') {
      const { s, i, n, data } = raw
      if (!isStamp(s) || !isPlace(i) || !isPlace(n) || n === 0 || typeof data !== 'string') return null
      return { id: event.id, slot: raw.slot, stamp: s, index: i, count: n, data, createdAt: event.created_at }
    }
    const profile = readProfile(raw)
    if (!profile || (raw.slot !== 'me' && raw.slot !== 'avatar')) return null
    return { slot: raw.slot, profile, createdAt: event.created_at }
  } catch {
    return null
  }
}

/**
 * The newest list found, once all of it is.
 *
 * Only ever the newest. Part of it missing means looking again, not settling for
 * an older one: an older one may name someone since removed, and whoever writes
 * next would have no way to tell they should not be there.
 */
export function newestWhole(
  parts: readonly OpenedPart[],
  slot: PartSlot,
): { stamp: number; value: unknown } | null {
  const mine = parts.filter((part) => part.slot === slot)
  if (mine.length === 0) return null
  const stamp = Math.max(...mine.map((part) => part.stamp))
  const newest = mine.filter((part) => part.stamp === stamp)
  const { count } = newest[0] as OpenedPart
  try {
    // A part not found throws here, as anything unreadable does.
    const pieces = Array.from({ length: count }, (_, index) =>
      b64ToBytes((newest.find((part) => part.index === index) as OpenedPart).data),
    )
    return { stamp, value: JSON.parse(bytesToUtf8(concatBytes(...pieces))) }
  } catch {
    return null
  }
}

/** How many places this list is seen to hold something in: those the next write must not leave behind. */
export const placesTaken = (parts: readonly OpenedPart[], slot: PartSlot): number =>
  Math.max(0, ...parts.filter((part) => part.slot === slot && part.data).map((part) => part.index + 1))
