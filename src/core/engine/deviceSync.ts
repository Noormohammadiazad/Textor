import { finalizeEvent } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import {
  drawWrap,
  giftWrap,
  KIND_DELETION,
  KIND_GIFT_WRAP,
  RENEWAL_SPACING_SEC,
  RETRACTION_TTL_SEC,
  type Rumor,
  type WrapOptions,
} from '../crypto/giftwrap'
import { createLogger } from '../util/log'
import { Mutex } from '../util/mutex'
import { DAY, MAX_CLOCK_AHEAD_MS, MINUTE, SECOND } from '../util/time'
import { formatId, shortNpub, toNpub } from '../identity/keys'
import { randomBytes, bytesToHex, wipe } from '../util/bytes'
import { DEFAULT_DM_RELAYS } from '../transport/defaultRelays'
import {
  MAX_GROUP_MEMBERS,
  PROTOCOL_VERSION,
  type IdFrame,
  type SyncFrame,
  type SyncMark,
  type SyncPerson,
  type SyncProfile,
} from '../models/protocol'
import { countsAsUnread, orderOf } from '../models/timeline'
import {
  DEVICE_MARKS,
  emptyHealth,
  MAX_MESSAGE_EXPIRY_DAYS,
  MAX_RECORD_AVATAR,
  MESSAGE_EXPIRY_DAYS,
  PROFILE_UNSET,
  type Conversation,
  type DeviceMarks,
  type IdentityRecord,
  type Message,
  type OutboxItem,
  type ProfileStamps,
  type RelayHealth,
} from '../models/types'
import { HORIZON_SEC, type NostrTransport } from '../transport/nostrTransport'
import type { IRelayPool, QueryOptions } from '../transport/relayPool'
import { usable } from '../transport/relayScore'
import type { VaultRepo } from '../vault/repo'
import { DeletionLog, readDeletionRecord } from './deletionLog'
import {
  isBlock,
  isPerson,
  MAX_ABOUT,
  MAX_ALIAS,
  readRosterRecord,
  Roster,
  sameRoster,
  takeForFrame,
  wins,
  type ContactChange,
  type RosterHost,
} from './deviceRoster'
import {
  KIND_APP_DATA,
  newestWhole,
  openRecord,
  placesTaken,
  readProfile,
  recordKeys,
  retractParts,
  sealParts,
  sealRecord,
  wipeRecordKeys,
  type OpenedPart,
  type OpenedRecord,
  type PartSlot,
  type RecordKeys,
  type RecordSlot,
} from './profileRecord'

const log = createLogger('devices')

const DEVICE_STATE = 'device-sync'

interface DeviceState {
  /** This install's own name, inside the frames only. */
  dev: string
  /** Other installs of this identity, and when each last wrote, unix ms. */
  seen: Record<string, number>
  helloAt: number
  /** When the profile record was last read and put right, unix ms. */
  recordAt?: number
  /** Something has yet to reach the record. */
  recordDue?: boolean
  /** A device new to this one is still to be told everything. */
  owed?: boolean
  /** When the records of the contact list and of what was deleted were last seen to, unix ms. */
  listedAt?: number
  /**
   * Restored, and not yet shown what the lists hold. What it would write now could
   * only be less than what is there, and relays would keep it for being newer.
   */
  cold?: boolean
  /** When this device last put the Textor ID's record on the relays, unix ms. */
  idAt?: number
}

export interface DeviceSyncHost {
  self: string
  repo: Pick<
    VaultRepo,
    | 'getState'
    | 'putState'
    | 'getConversation'
    | 'listConversations'
    | 'listMessages'
    | 'getMessage'
    | 'getContact'
    | 'upsertContact'
    | 'lowerUnread'
    | 'withdraw'
    | 'deleteConversation'
    | 'conversationId'
    | 'conversationIdOf'
    | 'getIdentity'
    | 'updateIdentity'
  > &
    RosterHost['repo']
  marks: DeviceMarks
  /** Send a frame to this identity's own inbox. */
  send: (frame: SyncFrame) => Promise<unknown>
  /** Tell a contact what this identity's ID comes from. Queued until a relay takes it. */
  tell: (peer: string, frame: IdFrame) => Promise<unknown>
  /** Take a message out, as a deletion does: tombstone, payload and badge. */
  forget: (message: Message) => Promise<void>
  changed: (what: 'conversations' | 'contacts' | 'identity') => void
  /** A call this identity answered or declined on another device. */
  callElsewhere: (callId: string) => void
  /** On its first catch-up, with no history. */
  restoring: () => boolean
  /** The sealed records of this identity's own, on its relays. */
  record: {
    secretKey: () => Uint8Array | null
    /** Every relay in use. */
    relays: () => string[]
    query: (filter: Filter, relays: string[], options: QueryOptions) => Promise<NostrEvent[]>
    /**
     * Queued, and asked of every relay until each has answered: a record, or a deletion of one.
     * Of these relays, for one that someone else will need to find; otherwise of those written to.
     */
    write: (event: NostrEvent, relays?: readonly string[]) => Promise<void>
  }
  now?: () => number
}

/** Past this, another device is taken to be gone: nothing it wrote is still on the relays. */
const DEVICE_GONE_MS = 30 * DAY
/** A device says it exists this often, so another can find out. */
const HELLO_EVERY_MS = 7 * DAY
/** After starting: off the path to reading messages. */
const HELLO_AFTER_MS = 20 * SECOND
/** Read marks wait this long for more, and go at most this often. */
const READ_DELAY_MS = 30 * SECOND
const READ_SPACING_MS = 5 * 60 * SECOND
/** A deliberate act goes out almost at once. */
const ACT_DELAY_MS = SECOND
/** Everything this device knows is told to a new one at most this often. */
const FULL_ANSWER_MS = 5 * MINUTE
/** Entries per list in one frame, and conversations told to a new device. */
const MAX_ITEMS = 64
/** Away this long, a device may have missed what relays have since dropped: it is told everything again. */
const DEVICE_AWAY_MS = 25 * DAY
/** The record is read this often, and written again this often if nobody else has. */
const RECORD_READ_MS = 7 * DAY
const RECORD_REFRESH_MS = 30 * DAY
/**
 * After a restore, more looks, twice as far apart each time: sockets may still
 * have been opening, and the relays this identity really uses may be found by then.
 */
const RECORD_LOOK_AGAIN_MS = 5 * SECOND
const RECORD_LOOKS = 4
/**
 * A read does not wait long on the slowest relays once half have answered, and
 * waits as long as a slow connection can take for that: relays were measured
 * taking 6 seconds to answer on open sockets, and longer to connect.
 */
const RECORD_HURRY_MS = 3 * SECOND
const RECORD_PATIENCE_MS = 12 * SECOND
/** The record a frame says is newer may still be on its way. Then twice as long each time, this many times. */
const RECORD_AFTER_FRAME_MS = 5 * SECOND
const RECORD_CHASE_MS = 10 * SECOND
const MAX_RECORD_CHASES = 3
const RECORD_RETRY_MS = 2 * MINUTE
/** A contact who may not have heard what this ID comes from is told again this long after. */
const ID_TELL_AGAIN_MS = 30 * DAY

/** Each part of a profile's stamp. One never set counts from when the identity was made. */
function stampsOf(identity: IdentityRecord): Required<ProfileStamps> {
  const { at, createdAt } = identity
  return { name: at?.name ?? createdAt, about: at?.about ?? createdAt, avatar: at?.avatar ?? createdAt }
}

/** A profile as it is told, without the parts never set here, and without the picture itself. */
function toTell(identity: IdentityRecord): SyncProfile {
  const at = stampsOf(identity)
  const profile: SyncProfile = { at: {} }
  if (at.name > PROFILE_UNSET && identity.name) {
    profile.name = identity.name.slice(0, MAX_ALIAS)
    profile.at.name = at.name
  }
  if (at.about > PROFILE_UNSET) {
    profile.about = identity.about.slice(0, MAX_ABOUT)
    profile.at.about = at.about
  }
  if (at.avatar > PROFILE_UNSET) profile.at.avatar = at.avatar
  return profile
}

/** What each record should hold now, or nothing for one with nothing worth keeping. */
function recordsOf(identity: IdentityRecord): [RecordSlot, SyncProfile][] {
  const told = toTell(identity)
  const records: [RecordSlot, SyncProfile][] = []
  // Its stamp for the picture says there is one to look for, on a relay that keeps only this.
  if (told.at.name !== undefined || told.at.about !== undefined) records.push(['me', told])
  // No picture, never set: no record. Too large for a relay to keep: the record it had stands.
  const picture = identity.avatar ?? ''
  if (
    told.at.avatar !== undefined &&
    (picture !== '' || identity.at?.avatar !== undefined) &&
    picture.length <= MAX_RECORD_AVATAR
  ) {
    records.push(['avatar', { avatar: picture, at: { avatar: told.at.avatar } }])
  }
  return records
}

const isHex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

function readMarks(value: unknown): SyncMark[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const marks: SyncMark[] = []
  for (const entry of value as { with?: unknown; key?: unknown }[]) {
    const people = entry?.with
    if (!Array.isArray(people) || people.length === 0 || people.length >= MAX_GROUP_MEMBERS) return null
    if (!people.every(isHex64) || !isTime(entry.key)) return null
    marks.push({ with: people as string[], key: entry.key })
  }
  return marks
}

/** The ways a wrap may have been sent: each makes a different one. Renewed only at the longest (ADR-076). */
const WRAP_FORMS: readonly WrapOptions[] = [
  ...MESSAGE_EXPIRY_DAYS.map((days) => ({ expirationSec: days * 86_400 })),
  { expirationSec: MAX_MESSAGE_EXPIRY_DAYS * 86_400, generation: 1 },
  { expirationSec: MAX_MESSAGE_EXPIRY_DAYS * 86_400, generation: 2 },
]

/**
 * Ask relays to delete the wraps of this rumor to this recipient (NIP-09).
 *
 * Signed by the key that signed them, the one signature relays honour on a
 * wrap: measured, all six defaults deleted a wrap for its signer and none for
 * its recipient (ADR-073). `forms` are the ways it may have been sent, each of
 * which makes a different wrap; a relay ignores an id it does not hold.
 */
export function retraction(
  rumor: Rumor,
  senderSk: Uint8Array,
  recipientPk: string,
  forms: readonly WrapOptions[],
): NostrEvent {
  const ids = forms.map((form) => giftWrap(rumor, senderSk, recipientPk, form).id)
  const draw = drawWrap(rumor.id, senderSk, recipientPk)
  const now = Math.floor(Date.now() / 1000)
  try {
    return finalizeEvent(
      {
        kind: KIND_DELETION,
        content: '',
        created_at: now,
        tags: [
          ...ids.map((id) => ['e', id]),
          ['k', String(KIND_GIFT_WRAP)],
          ['expiration', String(now + RETRACTION_TTL_SEC)],
        ],
      },
      draw.signer,
    )
  } finally {
    wipe(draw.signer)
    wipe(draw.nonceKey)
  }
}

/** A retraction per recipient, as the outbox holds them: signed, and tried until a relay takes it. */
export function retractionItems(
  rumor: Rumor,
  senderSk: Uint8Array,
  recipients: readonly string[],
  queue: Pick<OutboxItem, 'convoId' | 'relays'> & { prefix: string },
): OutboxItem[] {
  return recipients.map((recipient) => signedItem(retraction(rumor, senderSk, recipient, WRAP_FORMS), queue))
}

/** A signed event as the outbox holds it, tried until the relays take it. */
export function signedItem(
  event: NostrEvent,
  queue: Pick<OutboxItem, 'convoId' | 'relays'> & { prefix: string },
): OutboxItem {
  return {
    id: `${queue.prefix}${event.id}`,
    convoId: queue.convoId,
    peerPubkey: '',
    recipients: [],
    rumorJson: JSON.stringify(event),
    relays: queue.relays,
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
    ephemeral: false,
  }
}

/** Times a message may be sent again: it can go unread for about eighty days, and no longer. */
export const MAX_RENEWALS = 2
/** Wraps renewed in one go, so a backlog is spread over days rather than sent at once. */
const MAX_RENEWALS_PER_RUN = 20

export interface RenewalHost {
  self: string
  secretKey: Uint8Array
  repo: Pick<VaultRepo, 'undeliveredBetween' | 'getConversation' | 'updateMessage' | 'enqueue'>
  /** What each person's client has shown it can do: only a Textor says a message arrived. */
  caps: Readonly<Record<string, number>>
  ttlSec: number
  /** The rumor a message we wrote came from, rebuilt, or null if it cannot be. */
  rumorOf: (message: Message, conversation: Conversation) => Rumor | null
  relaysFor: (person: string) => Promise<string[]>
  queue: Pick<OutboxItem, 'convoId'> & { prefix: string }
  now?: () => number
}

/**
 * Send again what nobody has confirmed, shortly before relays are due to drop it
 * (ADR-076).
 *
 * A device away for over a month would otherwise never see it. Only to someone
 * whose client has sent a receipt before: anyone else never confirms anything,
 * and might show it twice. Only the message itself: a payload is asked for by
 * whoever needs it. Being derived, a device doing this makes the same wrap as
 * another of ours doing the same, and a receiver knows the rumor by its id.
 */
export async function renewUndelivered(host: RenewalHost): Promise<number> {
  const { repo, caps } = host
  const now = (host.now ?? Date.now)()
  const spacing = RENEWAL_SPACING_SEC * 1000
  let sent = 0
  for (const message of await repo.undeliveredBetween(now - (MAX_RENEWALS + 1) * spacing, now - spacing)) {
    if (sent >= MAX_RENEWALS_PER_RUN) break
    const generation = Math.floor((now - message.ts) / spacing)
    if (generation > MAX_RENEWALS || generation <= (message.renewed ?? 0)) continue
    const conversation = await repo.getConversation(message.convoId)
    if (!conversation || conversation.mls) continue
    const unconfirmed = conversation.members.filter(
      (person) => (caps[person] ?? 0) >= 1 && (!message.receipts || message.receipts[person] === 'sent'),
    )
    if (unconfirmed.length === 0) continue
    const rumor = host.rumorOf(message, conversation)
    if (!rumor) continue
    for (const person of unconfirmed) {
      const event = giftWrap(rumor, host.secretKey, person, { expirationSec: host.ttlSec, generation })
      await repo.enqueue(signedItem(event, { ...host.queue, relays: await host.relaysFor(person) }))
      sent += 1
    }
    await repo.updateMessage(message.id, { renewed: generation })
  }
  return sent
}

/**
 * What to announce as the inbox (kind 10050), given what is announced already,
 * or null when that needs no change.
 *
 * The list belongs to every device of this identity, and each reads the ones it
 * chose, so one device's view must not stand for all of them. A relay this
 * device merely has standing by stays: another device may read it. It goes when
 * this device has evidence that it cannot be used, and every relay this device
 * reads is added, up to `cap`, its own first.
 */
export function planAnnouncement(
  mine: readonly string[],
  announced: readonly string[],
  ok: (url: string) => boolean,
  cap: number,
): string[] | null {
  const kept = announced.filter((url) => ok(url))
  if (kept.length === announced.length && announced.length > 0 && mine.every((url) => kept.includes(url))) {
    return null
  }
  return [...new Set([...mine, ...kept])].slice(0, cap)
}

/** Where the relay scout notes a relay this person removed: never added back on their behalf. */
const DECLINED = 'relay-declined'

export interface AnnounceHost {
  pubkey: string
  secretKey: Uint8Array
  repo: Pick<VaultRepo, 'getState' | 'listRelays' | 'upsertRelay'>
  pool: Pick<IRelayPool, 'readRelays' | 'writeRelays' | 'rankedReadRelays' | 'statuses' | 'preferRead'>
  transport: Pick<NostrTransport, 'fetchInboxRelays' | 'publishInboxRelays'>
  /** Put newly added relays into effect. */
  reload: () => Promise<void>
  running: () => boolean
}

/**
 * Say where the inbox is read: the read relays in use, so contacts write where
 * this device is listening, and not to a relay set aside as down. Returns those
 * relays, or null if the engine stopped on the way.
 *
 * What is announced already is read first. The list belongs to every device of
 * this identity, and each used to overwrite it with its own view at start: a
 * device restored on the defaults could point contacts away from the relays
 * another device reads. Now a device takes up what is announced, adding relays
 * it has never had, and changes the list only for what it knows (ADR-073).
 */
export async function announceInbox(host: AnnounceHost): Promise<string[] | null> {
  const { repo, pool, transport } = host
  // Where it is read now, which should hold it: asking every relay would wake
  // those standing by. Only if they know of no list are the rest asked.
  const inUse = pool.rankedReadRelays()
  let announced = await transport.fetchInboxRelays(host.pubkey, inUse)
  if (announced.length === 0) {
    const others = [...pool.readRelays, ...pool.writeRelays].filter((url) => !inUse.includes(url))
    if (others.length > 0) announced = await transport.fetchInboxRelays(host.pubkey, [...new Set(others)])
  }
  if (!host.running()) return null
  if (announced.length > 0) {
    const held = new Set((await repo.listRelays()).map((entry) => entry.url))
    const declined = (await repo.getState<string[]>(DECLINED)) ?? []
    const missing = announced.filter((url) => !held.has(url) && !declined.includes(url))
    for (const url of missing) await repo.upsertRelay(url, { read: true, write: true })
    if (missing.length > 0) await host.reload()
    pool.preferRead(announced)
  }
  const relays = pool.rankedReadRelays(6)
  const health = new Map<string, RelayHealth>(pool.statuses().map((status) => [status.url, status.health]))
  const plan = planAnnouncement(
    relays,
    announced,
    (url) => usable(health.get(url) ?? emptyHealth(), Date.now()),
    6,
  )
  if (plan) await transport.publishInboxRelays(host.secretKey, plan)
  return relays
}

/** Bounded on parse, as every frame is (PROTOCOL §3). Anything out of bounds drops the whole frame. */
export function parseSyncFrame(
  json: string,
): (Required<Omit<SyncFrame, 'me'>> & Pick<SyncFrame, 'me'>) | null {
  let value: Partial<Record<keyof SyncFrame, unknown>>
  try {
    value = JSON.parse(json) as typeof value
  } catch {
    return null
  }
  if (value?.v !== PROTOCOL_VERSION || value.t !== 'sync') return null
  if (typeof value.dev !== 'string' || !/^[0-9a-f]{16}$/.test(value.dev)) return null
  const read = readMarks(value.read)
  const clear = readMarks(value.clear)
  if (!read || !clear) return null
  const list = <T>(raw: unknown, ok: (entry: T) => boolean): T[] | null =>
    raw === undefined
      ? []
      : Array.isArray(raw) && raw.length <= MAX_ITEMS && (raw as T[]).every((entry) => entry && ok(entry))
        ? (raw as T[])
        : null
  const gone = list<NonNullable<SyncFrame['gone']>[number]>(value.gone, (e) => isHex64(e.id) && isHex64(e.by))
  const block = list<NonNullable<SyncFrame['block']>[number]>(value.block, isBlock)
  const call = list<NonNullable<SyncFrame['call']>[number]>(
    value.call,
    (e) => isHex64(e.id) && isHex64(e.with),
  )
  const people = list<SyncPerson>(value.people, isPerson)
  if (!gone || !block || !call || !people) return null
  const parsed = {
    v: PROTOCOL_VERSION,
    t: 'sync',
    dev: value.dev,
    read,
    clear,
    gone,
    block,
    call,
    people,
  } as const
  if (value.me === undefined) return parsed
  const me = readProfile(value.me)
  return me ? { ...parsed, me } : null
}

/**
 * Keeps this identity's devices in step, through frames addressed to itself.
 *
 * Every device holds the same key, so messages already reach them all (PROTOCOL
 * §4.2). This carries what is not a message: what has been read, what was
 * deleted for this person alone, which conversations were deleted, who is
 * blocked, which call was picked up where, this identity's own profile, and the
 * contact list.
 *
 * Everything merges in any order, any number of times, because a catch-up read
 * returns frames in any order and a relay may replay them: a mark only moves
 * forward, a block goes by the latest time, and a deletion stays deleted. No
 * device has to be online with another.
 *
 * A device with nobody to tell sends almost nothing: a hello a week. Read marks
 * and calls wait until another device has been heard from in the last month.
 * Deletions, blocks and changes to the contact list always go, since a device
 * restored next week should still learn of them. See ADR-073.
 *
 * The profile is also kept in a sealed record on the relays, which is all a
 * restore can read when no other device is left, and the only way a picture
 * travels: it would not fit a frame. See ADR-077.
 */
export class DeviceSync {
  readonly #host: DeviceSyncHost
  readonly #now: () => number
  #state: DeviceState = { dev: '', seen: {}, helloAt: 0 }
  #timer: ReturnType<typeof setTimeout> | null = null
  #timerAt = 0
  #stopped = false
  #flushing: Promise<void> = Promise.resolve()
  #lastReadAt = 0
  #answeredAt = 0
  #hello = false
  #everything = false
  #read = new Set<string>()
  #clear: SyncMark[] = []
  #gone: NonNullable<SyncFrame['gone']> = []
  #block: NonNullable<SyncFrame['block']> = []
  #call: NonNullable<SyncFrame['call']> = []
  #me = false
  readonly #roster: Roster
  #recordTimer: ReturnType<typeof setTimeout> | null = null
  #recordTimerAt = 0
  #recording: Promise<void> = Promise.resolve()
  readonly #deleted: DeletionLog
  /** A frame and a record may arrive together, and each writes back the stamps it read. */
  readonly #profileChanges = new Mutex()
  #looksLeft = 0
  #wantedAvatar = 0
  #chases = 0
  #writtenSec = 0
  #firstLook: Promise<void> = Promise.resolve()
  #endFirstLook: () => void = () => undefined
  #idWork: Promise<string | null> | null = null
  #learning: Promise<void> = Promise.resolve()
  readonly #telling = new Set<string>()

  constructor(host: DeviceSyncHost) {
    this.#host = host
    this.#now = host.now ?? Date.now
    this.#roster = new Roster({ self: host.self, repo: host.repo, now: this.#now })
    this.#deleted = new DeletionLog(host.repo, this.#now)
  }

  /** Settled once a restored device has heard from a relay what it holds, or has given up asking. */
  get firstLook(): Promise<void> {
    return this.#firstLook
  }

  /** Whether someone may get a row here from a message of ours written at `order`. See `Roster`. */
  mayAdd(pubkey: string, order: number): boolean {
    return this.#roster.mayAdd(pubkey, order)
  }

  /** When each other device of this identity was last heard from, unix ms. */
  get others(): number[] {
    return Object.values(this.#state.seen)
  }

  async start(): Promise<void> {
    const { repo, marks } = this.#host
    const stored = await repo.getState<DeviceState>(DEVICE_STATE)
    const now = this.#now()
    this.#state = stored ?? { dev: bytesToHex(randomBytes(8)), seen: {}, helloAt: 0 }
    for (const [dev, at] of Object.entries(this.#state.seen)) {
      if (now - at >= DEVICE_GONE_MS) delete this.#state.seen[dev]
    }
    // Older than the floor, nothing they could stop can arrive any more.
    const floor = now - HORIZON_SEC * SECOND
    for (const table of [marks.read, marks.cleared]) {
      for (const [id, key] of Object.entries(table)) if (key < floor) delete table[id]
    }
    if (!stored) await repo.putState(DEVICE_STATE, this.#state)
    // Restored just now: nothing is here yet, and whoever can say what should be
    // ought to hear of it at once. Otherwise this stays off the path to reading messages.
    const restored = this.#host.restoring() && (await repo.getIdentity())?.at?.name === PROFILE_UNSET
    if (restored) {
      this.#state.cold = true
      this.#firstLook = new Promise((resolve) => (this.#endFirstLook = resolve))
    }
    await this.#deleted.load()
    if (now - this.#state.helloAt >= HELLO_EVERY_MS) {
      this.#hello = true
      this.#schedule(restored ? ACT_DELAY_MS : HELLO_AFTER_MS)
    }
    // Devices that kept their own lists until now have them to compare.
    if (!(await this.#roster.load()) && this.#accompanied) {
      this.#roster.tellEveryone()
      this.#me = true
      this.#schedule(HELLO_AFTER_MS)
    }
    if (this.#state.owed) this.#schedule(HELLO_AFTER_MS)
    // Not waiting on any relay, for someone who has just made or restored an identity.
    this.#ensureId().catch((err: unknown) => log.warn('could not work out this ID', err))
    if (restored) {
      this.#looksLeft = RECORD_LOOKS
      this.#recordSoon(0)
    } else if (
      this.#state.recordDue ||
      this.#state.listedAt === undefined ||
      this.#state.idAt === undefined ||
      now - (this.#state.recordAt ?? 0) >= RECORD_READ_MS
    ) {
      this.#recordSoon(HELLO_AFTER_MS)
    }
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#recordTimer) clearTimeout(this.#recordTimer)
    this.#recordTimer = null
  }

  /** Another device of this identity has been heard from lately. */
  get #accompanied(): boolean {
    const now = this.#now()
    return Object.values(this.#state.seen).some((at) => now - at < DEVICE_GONE_MS)
  }

  // --- what happened here ---------------------------------------------------

  noteRead(convoId: string): void {
    if (!this.#accompanied) return
    this.#read.add(convoId)
    const spaced = this.#lastReadAt + READ_SPACING_MS - this.#now()
    this.#schedule(Math.max(READ_DELAY_MS, spaced))
  }

  async noteGone(id: string, by: string): Promise<void> {
    this.#gone.push({ id, by })
    this.#schedule(ACT_DELAY_MS)
    await this.noteDeleted(id)
  }

  /** A message taken out here, for whoever restores this identity later. */
  async noteDeleted(id: string): Promise<void> {
    await this.#deleted.note(id)
    this.#listsChanged()
  }

  #listsChanged(): void {
    this.#state.recordDue = true
    this.#recordSoon(ACT_DELAY_MS)
  }

  /** A conversation deleted here. Not a forward-secret group, which only ever lives on one device. */
  async noteCleared(conversation: Conversation): Promise<void> {
    if (conversation.mls) return
    const key = conversation.clock ?? conversation.lastActivity
    await this.#setCleared(conversation.id, key)
    this.#clear.push({ with: conversation.members, key })
    this.#schedule(ACT_DELAY_MS)
    await this.#deleted.noteClear({ with: conversation.members, key })
    this.#listsChanged()
  }

  async noteBlocked(pubkey: string, on: boolean): Promise<void> {
    const at = this.#now()
    await this.#host.repo.upsertContact(pubkey, { blockedAt: at })
    this.#block.push({ pk: pubkey, on, at })
    this.#schedule(ACT_DELAY_MS)
    this.#listsChanged()
  }

  noteCall(id: string, peer: string): void {
    if (!this.#accompanied) return
    this.#call.push({ id, with: peer })
    this.#schedule(ACT_DELAY_MS)
  }

  /** This identity's own profile was changed here. Its stamps are already on it. */
  noteProfile(): void {
    this.#me = true
    this.#schedule(ACT_DELAY_MS)
    this.#state.recordDue = true
    this.#recordSoon(ACT_DELAY_MS)
  }

  async noteContact(pubkey: string, change: ContactChange): Promise<void> {
    await this.#roster.note(pubkey, change)
    if (change.pin !== undefined) this.#host.changed('conversations')
    this.#schedule(ACT_DELAY_MS)
    this.#listsChanged()
    if (change.on) {
      await this.#tellId(pubkey)
      await this.learnIds()
    }
  }

  /**
   * A message written to someone: the first since this version, they should hear what
   * the ID comes from. Again after a month, as a frame can run out of tries while
   * offline with nothing to say it did, and this says nothing a message does not.
   */
  async noteWrote(pubkey: string): Promise<void> {
    const contact = await this.#host.repo.getContact(pubkey)
    if (!contact?.accepted || contact.blocked) return
    if (this.#now() - (contact.idToldAt ?? 0) >= ID_TELL_AGAIN_MS) await this.#tellId(pubkey)
  }

  // --- sending --------------------------------------------------------------

  #schedule(delayMs: number): void {
    if (this.#stopped) return
    const at = this.#now() + delayMs
    if (this.#timer && this.#timerAt <= at) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timerAt = at
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, delayMs)
  }

  /** One at a time, so two flushes never tell the same thing twice. */
  flush(): Promise<void> {
    this.#flushing = this.#flushing
      .then(() => this.#flushOnce())
      .catch((err: unknown) => {
        log.warn('could not tell the other devices', err)
      })
    return this.#flushing
  }

  async #flushOnce(): Promise<void> {
    const { repo, send } = this.#host
    this.#settleOwed()
    const read = await this.#marksToTell()
    const { people, blocks } = await this.#roster.pending()
    this.#block.push(...blocks)
    let me = await this.#profileToTell()
    let hello = this.#hello
    this.#hello = false
    while (
      hello ||
      me ||
      read.length +
        this.#clear.length +
        this.#gone.length +
        this.#block.length +
        this.#call.length +
        people.length >
        0
    ) {
      hello = false
      const take = <T>(list: T[]): T[] | undefined => {
        const taken = list.splice(0, MAX_ITEMS)
        return taken.length > 0 ? taken : undefined
      }
      const frame: SyncFrame = { v: PROTOCOL_VERSION, t: 'sync', dev: this.#state.dev }
      const marks = take(read)
      const clear = take(this.#clear)
      const gone = take(this.#gone)
      const block = take(this.#block)
      const call = take(this.#call)
      if (marks) frame.read = marks
      if (clear) frame.clear = clear
      if (gone) frame.gone = gone
      if (block) frame.block = block
      if (call) frame.call = call
      if (me) frame.me = me
      me = undefined
      const told = takeForFrame(people)
      if (told.length > 0) frame.people = told
      await send(frame)
      this.#state.helloAt = this.#now()
    }
    await repo.putState(DEVICE_STATE, this.#state)
  }

  async #profileToTell(): Promise<SyncProfile | undefined> {
    if (!this.#me) return undefined
    this.#me = false
    const identity = await this.#host.repo.getIdentity()
    const profile = identity && toTell(identity)
    return profile && Object.keys(profile.at).length > 0 ? profile : undefined
  }

  async #marksToTell(): Promise<SyncMark[]> {
    const { repo } = this.#host
    const asked = this.#read
    this.#read = new Set()
    const everything = this.#everything
    this.#everything = false
    const conversations = everything
      ? (await repo.listConversations()).slice(0, MAX_ITEMS)
      : (await Promise.all([...asked].map((id) => repo.getConversation(id)))).filter(
          (conversation): conversation is Conversation => conversation !== null && conversation !== undefined,
        )
    const marks: SyncMark[] = []
    for (const conversation of conversations) {
      if (conversation.mls) continue
      const key = await this.#readUpTo(conversation)
      if (key !== null) marks.push({ with: conversation.members, key })
    }
    if (marks.length > 0) this.#lastReadAt = this.#now()
    return marks
  }

  /**
   * The key of the newest entry read here: the one just before whatever still
   * counts as unread. Never the conversation's clock, which also moves for what
   * this device sent, and would mark as read a message that crossed with it.
   */
  async #readUpTo(conversation: Conversation): Promise<number | null> {
    const recent = await this.#host.repo.listMessages(
      conversation.id,
      Math.min(conversation.unread + 50, 1000),
    )
    const read = recent.filter(countsAsUnread).at(-1 - conversation.unread)
    return read ? orderOf(read) : null
  }

  // --- what happened elsewhere ----------------------------------------------

  /** A frame from this identity's own key. Anyone else's never reaches here: see `Messenger`. */
  async receive(json: string, atMs: number): Promise<void> {
    const frame = parseSyncFrame(json)
    if (!frame || frame.dev === this.#state.dev) return
    const before = this.#state.seen[frame.dev]
    const known = before !== undefined && atMs - before < DEVICE_AWAY_MS
    this.#state.seen[frame.dev] = Math.max(before ?? 0, atMs)

    let conversations = false
    for (const mark of frame.read) if (await this.#applyRead(mark)) conversations = true
    for (const mark of frame.clear) if (await this.#applyClear(mark)) conversations = true
    for (const { id, by } of frame.gone) if (await this.#applyGone(id, by)) conversations = true
    for (const { id, with: peer } of frame.call) {
      if (await this.#applyGone(id, peer)) conversations = true
      this.#host.callElsewhere(id)
    }
    let contacts = false
    for (const person of frame.people) {
      const changed = await this.#roster.apply(person)
      if (changed.contacts) contacts = true
      if (changed.conversations) conversations = true
    }
    await this.#roster.save()
    for (const entry of frame.block) if (await this.#applyBlock(entry)) contacts = true
    if (conversations) this.#host.changed('conversations')
    if (contacts) this.#host.changed('contacts')
    if (frame.me && (await this.#mergeProfile(frame.me))) this.#host.changed('identity')

    if (!known) this.#answer()
    await this.#host.repo.putState(DEVICE_STATE, this.#state)
  }

  /**
   * A device not heard from before: it is new, so tell it what has been read,
   * who the contacts are, this profile, and that this one exists, or it would
   * stay quiet thinking itself alone.
   */
  #answer(): void {
    this.#state.owed = true
    this.#schedule(Math.max(ACT_DELAY_MS, this.#answeredAt + FULL_ANSWER_MS - this.#now()))
  }

  /** What is owed goes when it may. Another device arriving in the meantime hears the same. */
  #settleOwed(): void {
    if (!this.#state.owed) return
    const now = this.#now()
    const wait = this.#answeredAt + FULL_ANSWER_MS - now
    if (wait > 0) {
      this.#schedule(wait)
      return
    }
    this.#state.owed = false
    this.#answeredAt = now
    this.#everything = true
    this.#hello = true
    this.#me = true
    this.#roster.tellEveryone()
  }

  #convoOf(people: readonly string[]): string {
    const { repo, self } = this.#host
    return people.length === 1
      ? repo.conversationId(self, people[0] as string)
      : repo.conversationIdOf(self, people)
  }

  async #applyRead(mark: SyncMark): Promise<boolean> {
    const { repo, marks } = this.#host
    const id = this.#convoOf(mark.with)
    if ((marks.read[id] ?? 0) >= mark.key) return false
    marks.read[id] = mark.key
    await repo.putState(DEVICE_MARKS, marks)
    const conversation = await repo.getConversation(id)
    if (!conversation?.unread) return false
    const recent = await repo.listMessages(id, Math.min(conversation.unread + 200, 1000))
    const unread = recent.filter((message) => countsAsUnread(message) && orderOf(message) > mark.key).length
    return repo.lowerUnread(id, unread)
  }

  async #setCleared(id: string, key: number): Promise<void> {
    const { repo, marks } = this.#host
    marks.cleared[id] = Math.max(marks.cleared[id] ?? 0, key)
    await repo.putState(DEVICE_MARKS, marks)
  }

  /** Everything up to the key. A conversation with something newer stays, with that. */
  async #applyClear(mark: SyncMark): Promise<boolean> {
    const { repo, forget } = this.#host
    const id = this.#convoOf(mark.with)
    await this.#setCleared(id, mark.key)
    const conversation = await repo.getConversation(id)
    if (!conversation || conversation.mls) return false
    const held = await repo.listMessages(id, 1000)
    const gone = held.filter((message) => orderOf(message) <= mark.key)
    if (gone.length === held.length && held.length < 1000) {
      await repo.deleteConversation(id)
      return true
    }
    for (const message of gone) await forget(message)
    return gone.length > 0
  }

  async #applyGone(id: string, by: string): Promise<boolean> {
    // First, whatever is found. Not here yet, a catch-up read returns things in
    // any order, and it may be on its way in right now: see `Messenger`.
    await this.#host.repo.withdraw(id, by)
    const message = await this.#host.repo.getMessage(id)
    if (!message) return false
    await this.#host.forget(message)
    return true
  }

  async #applyBlock({ pk, on, at }: { pk: string; on: boolean; at: number }): Promise<boolean> {
    const { repo } = this.#host
    const contact = await repo.getContact(pk)
    if ((contact?.blockedAt ?? 0) >= at) return false
    await repo.upsertContact(pk, { blocked: on, blockedAt: at })
    return true
  }

  // --- this identity's own profile ------------------------------------------

  /** Each part by the latest stamp. Says whether anything here changed. */
  #mergeProfile(told: SyncProfile): Promise<boolean> {
    return this.#profileChanges.run(() => this.#mergeProfileNow(told))
  }

  async #mergeProfileNow(told: SyncProfile): Promise<boolean> {
    const { repo } = this.#host
    const identity = await repo.getIdentity()
    if (!identity) return false
    const at = stampsOf(identity)
    const limit = this.#now() + MAX_CLOCK_AHEAD_MS
    const patch: Partial<IdentityRecord> = {}
    for (const part of ['name', 'about', 'avatar'] as const) {
      const stamp = told.at[part]
      const value = told[part]
      // A clock this far ahead is wrong, and what it stamped would beat everything until it was right.
      if (stamp === undefined || stamp > limit) continue
      if (value === undefined) {
        if (part === 'avatar' && stamp > at.avatar) this.#chaseAvatar(stamp)
        continue
      }
      if (!wins(stamp, value, at[part], identity[part] ?? '')) continue
      at[part] = stamp
      if (part === 'avatar') patch.avatar = value === '' ? undefined : value
      else patch[part] = value
    }
    if (Object.keys(patch).length === 0) return false
    await repo.updateIdentity({ ...patch, at })
    return true
  }

  /** A newer picture is in the record. It may take a moment to reach it, so the look is repeated. */
  #chaseAvatar(stamp: number): void {
    if (stamp <= this.#wantedAvatar) return
    this.#wantedAvatar = stamp
    this.#chases = 0
    this.#recordSoon(RECORD_AFTER_FRAME_MS)
  }

  #recordSoon(delayMs: number): void {
    if (this.#stopped) return
    const at = this.#now() + delayMs
    if (this.#recordTimer && this.#recordTimerAt <= at) return
    if (this.#recordTimer) clearTimeout(this.#recordTimer)
    this.#recordTimerAt = at
    this.#recordTimer = setTimeout(() => {
      this.#recordTimer = null
      void this.syncRecord()
    }, delayMs)
  }

  /** One at a time: reading and writing the record each take a while, and neither should run twice over. */
  syncRecord(): Promise<void> {
    this.#recording = this.#recording
      .then(() => this.#syncRecordOnce())
      .catch((err: unknown) => {
        log.warn('could not bring the profile record up to date', err)
        this.#state.recordDue = true
        this.#recordSoon(RECORD_RETRY_MS)
      })
    return this.#recording
  }

  /**
   * Read the records, take what is newer, and write what the relays are missing.
   *
   * Relays keep the newest event by the time on it, not by what is inside, so a
   * device can only write safely what it has first compared with what is there.
   * If no relay answered, nothing is known of what they hold, and nothing is
   * written over it. What was deleted goes first, so that nothing it deleted is
   * there to be shown, and a contact it took out is not told about.
   */
  async #syncRecordOnce(): Promise<void> {
    const { repo, record, changed } = this.#host
    const secretKey = record.secretKey()
    if (this.#stopped || !secretKey) return
    const keys = recordKeys(secretKey)
    try {
      const relays = record.relays()
      let answers = 0
      const events = await record.query({ kinds: [KIND_APP_DATA], authors: [keys.pubkey] }, relays, {
        onEose: () => {
          answers += 1
        },
        graceMs: RECORD_HURRY_MS,
        maxWait: RECORD_PATIENCE_MS,
      })
      if (this.#stopped) return
      const held: Partial<Record<RecordSlot, OpenedRecord>> = {}
      const parts: OpenedPart[] = []
      let merged = false
      for (const event of events) {
        const opened = openRecord(event, keys)
        if (!opened) continue
        this.#writtenSec = Math.max(this.#writtenSec, opened.createdAt)
        if ('stamp' in opened) {
          parts.push(opened)
          continue
        }
        // Every copy, as relays may differ: an older one changes nothing.
        if (await this.#mergeProfile(opened.profile)) merged = true
        const newest = held[opened.slot]
        if (!newest || opened.createdAt > newest.createdAt) held[opened.slot] = opened
      }
      if (merged) changed('identity')
      const found = await this.#mergeLists(parts)

      const identity = await repo.getIdentity()
      // Nothing to go on but a few relays: what looks like no record may be one they do not hold.
      if (this.#state.cold && (found || (this.#looksLeft === 0 && answers * 2 >= relays.length))) {
        this.#state.cold = false
      }
      const wrote = answers > 0 && identity !== null && !this.#state.cold
      if (wrote) {
        await this.#writeProfile(identity as IdentityRecord, held, keys)
        await this.#writeLists(parts, keys)
        await this.#writeId()
        await this.learnIds()
        this.#state.recordAt = this.#now()
        this.#state.listedAt = this.#now()
      }
      this.#state.recordDue = !wrote
      await repo.putState(DEVICE_STATE, this.#state)
      this.#afterRecord(wrote, answers > 0, found, identity)
    } finally {
      wipeRecordKeys(keys)
    }
  }

  /** Take what the records of the lists say. Says whether the contact list was among them. */
  async #mergeLists(parts: readonly OpenedPart[]): Promise<boolean> {
    const { repo, self, changed, forget } = this.#host
    let contacts = false
    let conversations = false

    const deletions = readDeletionRecord(newestWhole(parts, 'gone')?.value)
    if (deletions) {
      const { ids, clear } = await this.#deleted.merge(deletions)
      for (const id of ids) {
        // Under our own name: we are who said so, whoever wrote it.
        await repo.withdraw(id, self)
        const message = await repo.getMessage(id)
        if (!message) continue
        await forget(message)
        conversations = true
      }
      for (const mark of clear) if (await this.#applyClear(mark)) conversations = true
    }

    const whole = newestWhole(parts, 'people')
    const roster = readRosterRecord(whole?.value)
    if (whole && roster) {
      const adopted = await this.#roster.adopt(roster, whole.stamp, {
        cold: this.#state.cold === true,
        away: this.#now() - (this.#state.recordAt ?? 0) >= DEVICE_AWAY_MS,
      })
      contacts = adopted.contacts
      conversations ||= adopted.conversations
      for (const entry of roster.block) if (await this.#applyBlock(entry)) contacts = true
    }
    if (conversations) changed('conversations')
    if (contacts) changed('contacts')
    return roster !== null
  }

  /** The next time to write with: past anything seen, or a relay would keep what it has. */
  #nextWriteSec(): number {
    this.#writtenSec = Math.max(Math.floor(this.#now() / SECOND), this.#writtenSec + 1)
    return this.#writtenSec
  }

  async #writeProfile(
    identity: IdentityRecord,
    held: Partial<Record<RecordSlot, OpenedRecord>>,
    keys: RecordKeys,
  ): Promise<void> {
    const now = this.#now()
    for (const [slot, profile] of recordsOf(identity)) {
      const current = held[slot]
      const newer = (['name', 'about', 'avatar'] as const).some(
        (part) => (profile.at[part] ?? 0) > (current?.profile.at[part] ?? 0),
      )
      if (current && !newer && now - current.createdAt * SECOND < RECORD_REFRESH_MS) continue
      await this.#host.record.write(sealRecord(slot, profile, keys, this.#nextWriteSec()))
    }
  }

  /** Write the lists if they say anything the relays do not, or have held for a month. */
  async #writeLists(parts: readonly OpenedPart[], keys: RecordKeys): Promise<void> {
    const now = this.#now()
    const old = (slot: PartSlot): boolean =>
      parts.some((part) => part.slot === slot && now - part.createdAt * SECOND >= RECORD_REFRESH_MS)

    const mine = await this.#roster.record()
    const whole = newestWhole(parts, 'people')
    const roster = readRosterRecord(whole?.value)
    const same = roster ? sameRoster(mine, roster) : mine.people.length + mine.block.length === 0
    if (!same || old('people')) {
      await this.#writeList('people', mine, await this.#roster.nextStamp(), parts, keys)
    }

    const deletions = this.#deleted.record()
    const told = readDeletionRecord(newestWhole(parts, 'gone')?.value)
    const covered = told ? this.#deleted.isIn(told) : deletions.ids.length + deletions.clear.length === 0
    if (!covered || old('gone')) {
      const newest = Math.max(0, ...parts.filter((part) => part.slot === 'gone').map((part) => part.stamp))
      await this.#writeList('gone', deletions, Math.max(now, newest + 1), parts, keys)
    }
  }

  async #writeList(
    slot: PartSlot,
    value: unknown,
    stamp: number,
    parts: readonly OpenedPart[],
    keys: RecordKeys,
  ): Promise<void> {
    const sec = this.#nextWriteSec()
    for (const event of sealParts(slot, value, stamp, keys, sec, placesTaken(parts, slot))) {
      await this.#host.record.write(event)
    }
    // Someone removed must not stay named on a relay that would not take this.
    const replaced = parts.filter((part) => part.slot === slot).map((part) => part.id)
    if (slot === 'people' && replaced.length > 0) {
      await this.#host.record.write(retractParts(replaced, keys, sec))
    }
  }

  /**
   * This identity's ID, worked out if it has not been, and kept. A stand-in for a name,
   * given when none was, becomes the ID too, which says more than a piece of a key.
   */
  #ensureId(): Promise<string | null> {
    this.#idWork ??= this.#ensureIdNow().finally(() => {
      this.#idWork = null
    })
    return this.#idWork
  }

  async #ensureIdNow(): Promise<string | null> {
    const { record, repo, changed } = this.#host
    const identity = await repo.getIdentity()
    if (!identity) return null
    if (identity.textorId) return identity.textorId
    const held = record.secretKey()
    if (this.#stopped || !held) return null
    const secretKey = held.slice()
    try {
      const { deriveTextorId } = await import('../identity/textorId')
      const id = await deriveTextorId(secretKey)
      const standIn = identity.name === shortNpub(toNpub(identity.pubkey))
      await repo.updateIdentity({ textorId: id, ...(standIn ? { name: formatId(id) } : {}) })
      changed('identity')
      return id
    } finally {
      wipe(secretKey)
    }
  }

  /**
   * Keep this identity's ID where it can be found (ADR-079).
   *
   * On the default relays too, unlike every other record: whoever looks it up may
   * share no relay with this identity, and those are where they start from. Nobody
   * reads this back to compare, since every device writes the same thing, so each
   * goes by when it last did. A copy of the key, since working out where the record
   * goes takes a while and the vault may lock in the meantime.
   */
  async #writeId(): Promise<void> {
    const { record } = this.#host
    const now = this.#now()
    if (now - (this.#state.idAt ?? 0) < RECORD_REFRESH_MS) return
    const id = await this.#ensureId()
    const held = record.secretKey()
    if (!id || this.#stopped || !held) return
    const secretKey = held.slice()
    try {
      const { textorIdEvent } = await import('../identity/textorId')
      const relays = record.relays()
      const event = await textorIdEvent(secretKey, id, relays, this.#nextWriteSec())
      await record.write(event, [...new Set([...relays, ...DEFAULT_DM_RELAYS])])
      this.#state.idAt = now
    } finally {
      wipe(secretKey)
    }
  }

  // --- contacts' IDs --------------------------------------------------------

  /**
   * Tell a contact what this identity's ID comes from, so they can show it in place of
   * a key. Only as someone is added or accepted, or is written to, or has just told us
   * theirs: never all at once, as a relay watching one connection write to everyone in
   * the same moment would be reading off the contact list (ADR-079).
   */
  async #tellId(pubkey: string): Promise<void> {
    const { record, repo, tell } = this.#host
    const held = record.secretKey()
    if (this.#stopped || !held || this.#telling.has(pubkey)) return
    this.#telling.add(pubkey)
    const secretKey = held.slice()
    try {
      const { idSaltOf } = await import('../identity/textorId')
      await repo.upsertContact(pubkey, { idToldAt: this.#now() })
      await tell(pubkey, { v: PROTOCOL_VERSION, t: 'id', w: idSaltOf(secretKey) })
    } finally {
      wipe(secretKey)
      this.#telling.delete(pubkey)
    }
  }

  /** Someone said what their ID comes from. It cannot change, so the first that checks out stands. */
  async receiveId(pubkey: string, salt: string): Promise<void> {
    const { repo } = this.#host
    if ((await repo.getContact(pubkey))?.textorId) return
    await repo.upsertContact(pubkey, { idSalt: salt })
    await this.learnIds()
  }

  /** One at a time: each takes a phone a second or two, and however many arrive, this is off to one side. */
  learnIds(): Promise<void> {
    this.#learning = this.#learning
      .then(() => this.#learnIdsNow())
      .catch((err: unknown) => {
        log.warn("could not work out a contact's ID", err)
      })
    return this.#learning
  }

  /**
   * Work out the IDs of those who have said where theirs comes from. Only a contact's:
   * anyone at all can write to this inbox, and could otherwise keep a phone busy for
   * nothing. Each one then hears ours, if it has been a while: they may have been on a
   * version that could not read it, and now are not.
   */
  async #learnIdsNow(): Promise<void> {
    const { repo, changed } = this.#host
    for (const contact of await repo.listContacts()) {
      if (this.#stopped) return
      if (!contact.accepted || contact.blocked || contact.textorId || !contact.idSalt) continue
      const { textorIdFrom } = await import('../identity/textorId')
      await repo.upsertContact(contact.pubkey, {
        textorId: await textorIdFrom(contact.pubkey, contact.idSalt),
      })
      changed('contacts')
      this.#listsChanged()
      if (this.#now() - (contact.idToldAt ?? 0) >= DAY) await this.#tellId(contact.pubkey)
    }
  }

  #afterRecord(wrote: boolean, answered: boolean, found: boolean, identity: IdentityRecord | null): void {
    if (found) this.#looksLeft = 0
    if (!found && this.#looksLeft > 0) {
      this.#recordSoon(RECORD_LOOK_AGAIN_MS * 2 ** (RECORD_LOOKS - this.#looksLeft))
      this.#looksLeft -= 1
    } else if (!wrote) {
      this.#recordSoon(RECORD_RETRY_MS)
    }
    if (answered || this.#looksLeft === 0) this.#endFirstLook()
    if (identity && this.#wantedAvatar > stampsOf(identity).avatar && this.#chases < MAX_RECORD_CHASES) {
      this.#recordSoon(RECORD_CHASE_MS * 2 ** this.#chases)
      this.#chases += 1
    }
  }
}
