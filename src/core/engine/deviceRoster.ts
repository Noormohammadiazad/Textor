import type { SyncFrame, SyncPerson } from '../models/protocol'
import type { Contact } from '../models/types'
import { normalizeRelayList } from '../transport/relayUrl'
import { utf8ToBytes } from '../util/bytes'
import { createLogger } from '../util/log'
import { Mutex } from '../util/mutex'
import { MAX_CLOCK_AHEAD_MS } from '../util/time'
import type { VaultRepo } from '../vault/repo'
import { MAX_RECORD_BYTES } from './profileRecord'

const log = createLogger('devices')

const ROSTER_STATE = 'device-roster'

/** The most of a person a frame may carry, as `parseSyncFrame` bounds it. */
export const MAX_ALIAS = 128
export const MAX_REMOTE = 128
export const MAX_ABOUT = 512
export const MAX_RELAYS = 8
/** Relay hints per person in a record of the list. */
const RECORD_RELAYS = 3
/**
 * People in one frame, in bytes. A frame is wrapped twice over, and must stay
 * under the 64 KiB some relays hold to (ADR-073): this leaves room for what
 * else the frame carries.
 */
const FRAME_PEOPLE_BYTES = 10_000
const MAX_PEOPLE_PER_FRAME = 64

/** What a contact's latest change was, kept after they are removed so a stale frame cannot bring them back. */
interface PersonStamps {
  on: boolean
  at: number
  nameAt: number
  pin?: boolean
  pinAt: number
}

interface RosterState {
  clock: number
  people: Record<string, PersonStamps>
  /** The stamp of the newest record of the list this device has read or written. */
  mark?: number
  /**
   * The stamp of the record a restore began from. Nobody it left out is taken from
   * anything older: that record is what says who was still a contact by then.
   */
  floor?: number
}

/** The list as a sealed record holds it: only who is a contact now, and who is blocked (ADR-078). */
export interface RosterRecord {
  people: SyncPerson[]
  block: NonNullable<SyncFrame['block']>
}

const isHex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const isOptional = <T>(value: unknown, ok: (value: unknown) => value is T): boolean =>
  value === undefined || ok(value)
const isText =
  (max: number) =>
  (value: unknown): value is string =>
    typeof value === 'string' && value.length <= max
const isPin = (value: unknown): value is boolean => typeof value === 'boolean'
const isRelays = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_RELAYS && value.every(isText(512))

export function isPerson(entry: SyncPerson): boolean {
  return (
    isHex64(entry.pk) &&
    typeof entry.on === 'boolean' &&
    isTime(entry.at) &&
    isOptional(entry.name, isText(MAX_ALIAS)) &&
    isOptional(entry.nameAt, isTime) &&
    // Told together: neither means anything alone.
    (entry.name === undefined) === (entry.nameAt === undefined) &&
    isOptional(entry.pin, isPin) &&
    isOptional(entry.pinAt, isTime) &&
    (entry.pin === undefined) === (entry.pinAt === undefined) &&
    isOptional(entry.remote, isText(MAX_REMOTE)) &&
    isOptional(entry.about, isText(MAX_ABOUT)) &&
    isOptional(entry.profileAt, isTime) &&
    (entry.remote === undefined) === (entry.profileAt === undefined) &&
    isOptional(entry.relays, isRelays)
  )
}

export const isBlock = (entry: NonNullable<SyncFrame['block']>[number]): boolean =>
  isHex64(entry.pk) && typeof entry.on === 'boolean' && isTime(entry.at)

/** A list read from a record, or null if it is not one. Its seal says it is ours, not that it is well made. */
export function readRosterRecord(value: unknown): RosterRecord | null {
  const { people, block } = (value ?? {}) as Partial<RosterRecord>
  if (!Array.isArray(people) || !Array.isArray(block)) return null
  const ok = people.every((person) => person && person.on === true && isPerson(person))
  return ok && block.every((entry) => entry && isBlock(entry)) ? { people, block } : null
}

/** One value for what a record says, to tell whether two say the same. Not their hints: those only add up. */
const fingerprint = ({ people, block }: RosterRecord): string =>
  [
    ...people.map((person) => `${person.pk}:${person.at}:${person.nameAt ?? 0}:${person.pinAt ?? 0}`),
    ...block.map((entry) => `${entry.pk}:${entry.on}:${entry.at}`),
  ]
    .sort()
    .join('|')

export const sameRoster = (a: RosterRecord, b: RosterRecord): boolean => fingerprint(a) === fingerprint(b)

export interface ContactChange {
  /** Added or accepted, or removed. */
  on?: boolean
  /** The name given to them was set. */
  name?: boolean
  /** Pin or unpin the conversation with them. */
  pin?: boolean
}

export interface RosterHost {
  self: string
  repo: Pick<
    VaultRepo,
    | 'getState'
    | 'putState'
    | 'getContact'
    | 'listContacts'
    | 'upsertContact'
    | 'deleteContact'
    | 'conversationId'
    | 'ensureConversation'
    | 'updateConversation'
  >
  now: () => number
}

/**
 * The later of two values, by stamp. A tie goes by value, so that every device
 * picks the same one, whichever it heard first.
 */
export const wins = (stamp: number, value: unknown, heldStamp: number, heldValue: unknown): boolean =>
  stamp > heldStamp || (stamp === heldStamp && String(value) > String(heldValue))

/** As many of these as fit in one frame, taken off the front. Always at least one. */
export function takeForFrame(people: SyncPerson[]): SyncPerson[] {
  let room = FRAME_PEOPLE_BYTES
  let count = 0
  const encoder = new TextEncoder()
  for (const person of people) {
    room -= encoder.encode(JSON.stringify(person)).length
    if ((count > 0 && room < 0) || count === MAX_PEOPLE_PER_FRAME) break
    count += 1
  }
  return people.splice(0, count)
}

/**
 * The contact list, kept the same on every device of this identity (ADR-077).
 *
 * Each part of a person goes by the latest stamp from one clock that only moves
 * forward: whether they are a contact, the name given to them, and the pin.
 * Relay hints only ever add up, being hints. So frames merge in any order, any
 * number of times, and two edits made offline to different parts both stand.
 *
 * Stamps stay after someone is removed: a catch-up read may return the frame
 * that added them later than the one that removed them. Someone who was never
 * told is stamped by when they were added here.
 *
 * Those stamps stay in the vault. The record of the list on the relays names only
 * who is a contact now, so someone removed is gone from it (ADR-078). A device
 * restored from that record learns what it left out from the record's own stamp:
 * nobody it does not name is taken from anything older.
 */
export class Roster {
  readonly #host: RosterHost
  #state: RosterState = { clock: 0, people: {} }
  #pending = new Set<string>()
  #everyone = false
  #unsaved = false
  /**
   * One change at a time. Each reads a stamp and a contact, then writes: a frame
   * part way through as a record is taken would land after it, and bring back
   * someone the record had just shown to be gone.
   */
  readonly #changes = new Mutex()

  constructor(host: RosterHost) {
    this.#host = host
  }

  /** False if this vault has not kept a roster before, so nothing it holds has been told. */
  async load(): Promise<boolean> {
    const stored = await this.#host.repo.getState<RosterState>(ROSTER_STATE)
    if (stored) this.#state = stored
    return Boolean(stored)
  }

  async save(): Promise<void> {
    if (!this.#unsaved) return
    this.#unsaved = false
    await this.#host.repo.putState(ROSTER_STATE, this.#state)
  }

  /** Tell the whole list at the next flush: another device has just appeared. */
  tellEveryone(): void {
    this.#everyone = true
    this.#unsaved = true
  }

  #stampsOf(pk: string, contact: Contact | null, floor = this.#state.floor ?? 0): PersonStamps {
    const held = this.#state.people[pk]
    if (held) return { ...held }
    const on = contact?.accepted === true
    return {
      on,
      at: on ? (contact as Contact).addedAt : floor,
      // A name never given loses to any that was.
      nameAt: contact?.name ? contact.addedAt : 0,
      pinAt: 0,
    }
  }

  async #setPin(pk: string, pin: boolean): Promise<void> {
    const { repo, self } = this.#host
    // Pinned before anything was said: it is there to be seen, and stays pinned.
    if (pin) await repo.ensureConversation(self, pk)
    await repo.updateConversation(repo.conversationId(self, pk), { pinned: pin })
  }

  /** Something the person using this device just did. */
  note(pk: string, change: ContactChange): Promise<void> {
    return this.#changes.run(() => this.#note(pk, change))
  }

  async #note(pk: string, change: ContactChange): Promise<void> {
    const stamps = this.#stampsOf(pk, await this.#host.repo.getContact(pk))
    const order = Math.max(this.#host.now(), this.#state.clock + 1)
    this.#state.clock = order
    if (change.on !== undefined) {
      stamps.on = change.on
      stamps.at = order
    }
    if (change.name) stamps.nameAt = order
    if (change.pin !== undefined) {
      stamps.pin = change.pin
      stamps.pinAt = order
      await this.#setPin(pk, change.pin)
    }
    this.#state.people[pk] = stamps
    this.#pending.add(pk)
    this.#unsaved = true
    await this.save()
  }

  /** Whoever there is to tell about, whole, and the blocks a new device would otherwise never hear of. */
  async pending(): Promise<{ people: SyncPerson[]; blocks: NonNullable<SyncFrame['block']> }> {
    const { repo } = this.#host
    const told = this.#pending
    this.#pending = new Set()
    const blocks: NonNullable<SyncFrame['block']> = []
    if (this.#everyone) {
      this.#everyone = false
      for (const contact of await repo.listContacts()) {
        if (contact.accepted) told.add(contact.pubkey)
        if (contact.blocked) {
          blocks.push({ pk: contact.pubkey, on: true, at: contact.blockedAt ?? contact.addedAt })
        }
      }
      for (const [pk, stamps] of Object.entries(this.#state.people)) if (!stamps.on) told.add(pk)
      await this.save()
    }
    const people: SyncPerson[] = []
    for (const pk of told) {
      const person = await this.#personOf(pk)
      if (person) people.push(person)
    }
    return { people, blocks }
  }

  async #personOf(pk: string): Promise<SyncPerson | null> {
    const contact = await this.#host.repo.getContact(pk)
    const stamps = this.#stampsOf(pk, contact)
    if (!stamps.on) return stamps.at > 0 ? { pk, on: false, at: stamps.at } : null
    if (!contact) return null
    const person: SyncPerson = { pk, on: true, at: stamps.at }
    if (contact.relays.length > 0) person.relays = contact.relays.slice(0, MAX_RELAYS)
    if (stamps.nameAt > 0) {
      person.name = contact.name.slice(0, MAX_ALIAS)
      person.nameAt = stamps.nameAt
    }
    if (stamps.pinAt > 0) {
      person.pin = stamps.pin as boolean
      person.pinAt = stamps.pinAt
    }
    if (contact.remoteName) {
      person.remote = contact.remoteName.slice(0, MAX_REMOTE)
      if (contact.about) person.about = contact.about.slice(0, MAX_ABOUT)
      // Told before these were kept: any stamp at all is newer.
      person.profileAt = contact.profileAt ?? 1
    }
    return person
  }

  /** What another device says of someone. Returns what changed, to tell the screens. */
  apply(person: SyncPerson): Promise<{ contacts: boolean; conversations: boolean }> {
    return this.#changes.run(() => this.#apply(person))
  }

  async #apply(person: SyncPerson, floor?: number): Promise<{ contacts: boolean; conversations: boolean }> {
    const { repo, now } = this.#host
    const result = { contacts: false, conversations: false }
    const newest = Math.max(person.at, person.nameAt ?? 0, person.pinAt ?? 0)
    // A clock this far ahead is wrong, and what it stamped would beat everything until it was right.
    if (newest > now() + MAX_CLOCK_AHEAD_MS) return result
    this.#state.clock = Math.max(this.#state.clock, newest)

    const contact = await repo.getContact(person.pk)
    const stamps = this.#stampsOf(person.pk, contact, floor)
    const decided = wins(person.at, person.on, stamps.at, stamps.on)
    if (decided) {
      stamps.on = person.on
      stamps.at = person.at
    }
    if (!stamps.on) {
      if (decided && contact?.accepted) {
        await repo.deleteContact(person.pk)
        result.contacts = true
      }
    } else {
      const patch = this.#patchFor(person, contact, stamps)
      if (Object.keys(patch).length > 0) {
        await repo.upsertContact(person.pk, patch)
        result.contacts = true
      }
      if (person.pinAt !== undefined && wins(person.pinAt, person.pin, stamps.pinAt, stamps.pin ?? false)) {
        stamps.pin = person.pin as boolean
        stamps.pinAt = person.pinAt
        await this.#setPin(person.pk, stamps.pin)
        result.conversations = true
      }
    }
    this.#state.people[person.pk] = stamps
    this.#unsaved = true
    return result
  }

  #patchFor(person: SyncPerson, contact: Contact | null, stamps: PersonStamps): Partial<Contact> {
    const patch: Partial<Contact> = {}
    if (!contact?.accepted) patch.accepted = true
    if (person.nameAt !== undefined && wins(person.nameAt, person.name, stamps.nameAt, contact?.name ?? '')) {
      patch.name = person.name as string
      stamps.nameAt = person.nameAt
    }
    if (person.profileAt !== undefined && person.profileAt > (contact?.profileAt ?? 0)) {
      patch.remoteName = person.remote as string
      if (person.about !== undefined) patch.about = person.about
      patch.profileAt = person.profileAt
    }
    const known = contact?.relays ?? []
    const relays = normalizeRelayList([...known, ...(person.relays ?? [])], MAX_RELAYS)
    if (relays.length !== known.length) patch.relays = relays
    return patch
  }

  /**
   * Whether someone with no row here may get one from a message of ours written
   * at `order`. Not if they were removed since, or left out of the record a
   * restore began from: history stays, and it does not make them a contact again.
   */
  mayAdd(pk: string, order: number): boolean {
    const held = this.#state.people[pk]
    return held ? held.on || held.at < order : (this.#state.floor ?? 0) < order
  }

  /**
   * The list as a record should hold it: everyone who is a contact now, and no
   * one who is not. Without what they wrote about themselves, which they send
   * again, and with few relay hints, so that a long list still fits. If it does not,
   * those added longest ago wait for the next frame that names them.
   */
  record(): Promise<RosterRecord> {
    return this.#changes.run(() => this.#record())
  }

  async #record(): Promise<RosterRecord> {
    const people: SyncPerson[] = []
    const block: RosterRecord['block'] = []
    for (const contact of await this.#host.repo.listContacts()) {
      if (contact.blockedAt !== undefined || contact.blocked) {
        block.push({ pk: contact.pubkey, on: contact.blocked, at: contact.blockedAt ?? contact.addedAt })
      }
      if (!contact.accepted) continue
      const person = await this.#personOf(contact.pubkey)
      if (!person?.on) continue
      delete person.about
      if (person.relays) person.relays = person.relays.slice(0, RECORD_RELAYS)
      people.push(person)
    }
    people.sort((a, b) => b.at - a.at)
    let room = MAX_RECORD_BYTES - 1024 - utf8ToBytes(JSON.stringify(block)).length
    let kept = 0
    for (const person of people) {
      room -= utf8ToBytes(JSON.stringify(person)).length + 1
      if (room < 0) break
      kept += 1
    }
    if (kept < people.length) log.warn(`the record of the list holds ${kept} of ${people.length} contacts`)
    return { people: people.slice(0, kept), block }
  }

  /**
   * Take a record of the list. Everyone it names goes by the stamps, as from any
   * device, and is taken whatever the floor: this is newer than the floor was.
   *
   * What it leaves out is taken as removed only where that can be known. Elsewhere,
   * it may mean only that whoever wrote it has not heard of them yet, and frames
   * carry a removal to any device that was around. So only when this device is
   * being restored, and anyone it holds came from frames older than the record; or
   * has been away so long that frames may have lapsed, and they were in a record it
   * had read before.
   */
  adopt(
    record: RosterRecord,
    stamp: number,
    how: { cold: boolean; away: boolean },
  ): Promise<{ contacts: boolean; conversations: boolean }> {
    return this.#changes.run(() => this.#adopt(record, stamp, how))
  }

  async #adopt(
    record: RosterRecord,
    stamp: number,
    how: { cold: boolean; away: boolean },
  ): Promise<{ contacts: boolean; conversations: boolean }> {
    const result = { contacts: false, conversations: false }
    const note = (changed: { contacts: boolean; conversations: boolean }): void => {
      result.contacts ||= changed.contacts
      result.conversations ||= changed.conversations
    }
    for (const person of record.people) note(await this.#apply(person, 0))
    const named = new Set(record.people.map((person) => person.pk))
    const mark = this.#state.mark ?? 0
    const upTo = how.cold ? stamp : how.away && stamp > mark ? mark : 0
    if (upTo > 0) {
      for (const contact of await this.#host.repo.listContacts()) {
        if (!contact.accepted || named.has(contact.pubkey)) continue
        const stamps = this.#stampsOf(contact.pubkey, contact)
        if (stamps.at <= upTo) note(await this.#apply({ pk: contact.pubkey, on: false, at: stamp }))
      }
    }
    if (how.cold) this.#state.floor = Math.max(this.#state.floor ?? 0, stamp)
    this.#state.mark = Math.max(mark, stamp)
    this.#state.clock = Math.max(this.#state.clock, stamp)
    this.#unsaved = true
    await this.save()
    return result
  }

  /** This stamp for a record of the list about to be written: past every other. */
  async nextStamp(): Promise<number> {
    const stamp = Math.max(this.#host.now(), this.#state.clock + 1, (this.#state.mark ?? 0) + 1)
    this.#state.clock = stamp
    this.#state.mark = stamp
    this.#unsaved = true
    await this.save()
    return stamp
  }
}
