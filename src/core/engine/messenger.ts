import type { Event as NostrEvent } from 'nostr-tools/core'
import { hexToBytes, randomBytes, bytesToHex } from '../util/bytes'
import { backoffDelay, MINUTE, SECOND } from '../util/time'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { coalesce } from '../util/mutex'
import { createRumor, giftWrap, unwrapGift, type Rumor } from '../crypto/giftwrap'
import {
  ACCEPTED_RUMOR_KINDS,
  cleanLine,
  KIND_MLS_WELCOME,
  MAX_MLS_MEMBERS,
  encodeControlFrame,
  isCallFrame,
  isInteractiveFrame,
  isOpeningOffer,
  KIND_CHAT,
  KIND_CONTROL,
  MAX_CHECKLIST_ITEMS,
  MAX_GROUP_MEMBERS,
  MAX_ITEM_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_RECEIPT_REFS,
  MAX_SUBJECT_CHARS,
  parseControlFrame,
  preciseTimestamp,
  PROTOCOL_VERSION,
  recipientTags,
  roomOf,
  subjectFromTags,
  subjectTag,
  threadFromTags,
  threadTags,
  timestampTag,
  type CallFrame,
  type ControlFrame,
  type InteractiveFrame,
} from '../models/protocol'
import { CALL_RING_WINDOW_MS, type CallRecord } from '../models/call'
import { attachmentFromTags, attachmentTag } from '../models/protocol'
import { isReactionBody, KIND_REACTION, reactionTags, reactionTargetFromTags } from '../models/protocol'
import { parseAttachment, transportsFor, type Attachment } from '../models/attachment'
import {
  checklistFallback,
  checklistFromTags,
  checklistTags,
  foldChecklist,
  pollFallback,
  pollFromTags,
  pollTags,
  type ChecklistSpec,
  type PollSpec,
} from '../models/interactive'
import { assembleBlob, blobId, blobRef, openChunk, sealBlob, type BlobEnvelope } from '../crypto/blobCrypto'
import { BlobTransfer } from './blobTransfer'
import {
  isGroupAddress,
  type AppSettings,
  type ChatAddress,
  type Contact,
  type Conversation,
  type Message,
  type MessageStatus,
  type OutboxItem,
  type RelayEntry,
  type Sticker,
  type StickerPack,
} from '../models/types'
import type { VaultRepo } from '../vault/repo'
import type { Vault } from '../vault/vault'
import { NostrTransport } from '../transport/nostrTransport'
import { RelayPool, type IRelayPool, type RelayStatus, type WakeReason } from '../transport/relayPool'
import { DirectManager, supportsWebRtc } from '../transport/webrtc/directManager'
import { InboxSync } from './inboxSync'
import type { MlsHost, Readiness } from '../mls/host'
import type { MlsRuntime } from '../mls/runtime'
import type { DirectState } from '../transport/webrtc/directSession'
import { DEFAULT_DM_RELAYS, DEFAULT_ICE_SERVERS } from '../transport/defaultRelays'
import { normalizeRelayList } from '../transport/relayUrl'

const log = createLogger('engine')

export type MessengerEvents = {
  message: { message: Message; conversation: Conversation }
  messageUpdated: Message
  conversationsChanged: void
  contactsChanged: void
  relayStatus: RelayStatus[]
  typing: { peerPubkey: string; active: boolean }
  directState: { peerPubkey: string; state: DirectState }
  syncState: SyncState
  /** An attachment payload gained or lost ground. Per copy: see `BlobRef`. */
  blobProgress: { id: string; copy: string; received: number; total: number; outgoing: boolean }
  /** A payload finished arriving, verified, and is ready to read from storage. */
  blobComplete: { id: string; copy: string }
  /** A reaction was added or withdrawn; the bar under that message changed. */
  reactionsChanged: { messageId: string }
  /** A sticker pack was added or removed. */
  packsChanged: void
  /** The peer withdrew messages they had sent; they are gone from storage. */
  messagesRedacted: { peerPubkey: string; ids: string[] }
  /** A vote or checklist change arrived or was made; that card needs recounting. */
  updatesChanged: { targetId: string }
  /**
   * A call signal from a contact, for the calling subsystem.
   *
   * The engine never loads that subsystem itself: it is a lazy chunk, and
   * whoever listens here decides to fetch it when an offer rings. `callId`
   * names the call NIP-AC's way — the rumor id of the offer that opened it —
   * and `at` is when the frame was sent.
   */
  callSignal: CallSignal
  error: { scope: string; message: string }
}

export interface CallSignal {
  peerPubkey: string
  frame: CallFrame
  callId: string
  at: number
}

export interface SyncState {
  online: boolean
  connectedRelays: number
  totalRelays: number
  pendingOutbox: number
  lastSyncAt: number
  syncing: boolean
}

const OUTBOX_TICK_MS = 5 * SECOND
const TYPING_TTL_MS = 6 * SECOND
const RECEIPT_DEBOUNCE_MS = 1200
const MAX_SEND_ATTEMPTS = 12
/**
 * Control frames are time-sensitive, so they get far fewer retries than chat
 * messages. Re-publishing a WebRTC offer five minutes after the session it
 * belonged to has gone is pure noise on the relays.
 */
const MAX_EPHEMERAL_ATTEMPTS = 3
/** Drop control frames left over from a previous run rather than replaying them. */
const EPHEMERAL_MAX_AGE_MS = 2 * MINUTE

/**
 * Deliveries in flight at once, per lane.
 *
 * The outbox used to deliver one item at a time and wait for every relay to
 * answer each, so a message queued behind a photo waited out every chunk of it
 * — and behind any single relay's ten-second timeout. Messages, receipts and
 * signalling now share a lane that is never blocked by attachment chunks,
 * which get a narrower lane of their own so a large payload cannot saturate
 * the uplink either.
 */
const LANE_LIMITS = { priority: 6, bulk: 2 } as const
type Lane = keyof typeof LANE_LIMITS
/**
 * Outbox ids are plaintext on disk, and their prefix is what lets the
 * scheduler pick a lane without decrypting a 55 KB chunk first. The prefix
 * reveals no more than the ciphertext's size already does.
 */
const BULK_PREFIX = 'blob-'
const CONTROL_PREFIX = 'ctl-'
/** Reactions are queued durably like messages, but are not messages. */
const REACTION_PREFIX = 'rx-'
/**
 * Votes and checklist changes: durable, copied to our own inbox like a
 * message, and — like reactions — not messages.
 */
const INTERACTIVE_PREFIX = 'ix-'
const laneOf = (id: string): Lane => (id.startsWith(BULK_PREFIX) ? 'bulk' : 'priority')
const isUserMessageId = (id: string): boolean =>
  !id.startsWith(BULK_PREFIX) &&
  !id.startsWith(CONTROL_PREFIX) &&
  !id.startsWith(REACTION_PREFIX) &&
  !id.startsWith(INTERACTIVE_PREFIX)

/** Delivery states before a copy has reached any relay. */
const UNSENT: ReadonlySet<MessageStatus | undefined> = new Set(['queued', 'sending', 'failed', undefined])

/**
 * A conversation as sending needs it: where it is stored and who gets a copy.
 * A direct conversation is a group of one as far as delivery is concerned —
 * the same rumor, sealed and wrapped once per member — which is how both kinds
 * share one path.
 */
interface Room {
  convoId: string
  kind: Conversation['kind']
  /** Everyone but us, sorted. */
  members: string[]
  /** The other person, in a direct conversation. */
  peer: string | null
  subject?: string
}

/** A rumor that has arrived, placed in the conversation it belongs to. */
interface Arrival extends Room {
  author: string
  /** Something we sent, from another device. */
  isSelfCopy: boolean
}

/** Everything about a chat message that its tags are built from. */
interface ChatShape {
  ts: number
  replyTo?: string
  rootId?: string
  subject?: string
  attachment?: Attachment
  poll?: PollSpec
  checklist?: ChecklistSpec
}

/**
 * A chat rumor's tags, in one fixed order.
 *
 * Fixed because the rumor id is a hash over them: a retry rebuilds the rumor
 * from the stored message, and a tag in a different place — or one left out,
 * which is how retrying an attachment once produced a new message with no
 * attachment — would be a different message to everyone who receives it.
 */
function chatTags(members: readonly string[], shape: ChatShape): string[][] {
  const tags = [...recipientTags(members), timestampTag(shape.ts)]
  if (shape.subject) tags.push(subjectTag(shape.subject))
  if (shape.attachment) tags.push(attachmentTag(shape.attachment))
  if (shape.poll) tags.push(...pollTags(shape.poll))
  if (shape.checklist) tags.push(...checklistTags(shape.checklist))
  if (shape.replyTo) tags.push(...threadTags(shape.rootId ?? shape.replyTo, shape.replyTo))
  return tags
}

const shapeOf = (message: Message): ChatShape => ({
  ts: message.ts,
  ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  ...(message.rootId ? { rootId: message.rootId } : {}),
  ...(message.subject ? { subject: message.subject } : {}),
  ...(message.attachment ? { attachment: message.attachment } : {}),
  ...(message.poll ? { poll: message.poll } : {}),
  ...(message.checklist ? { checklist: message.checklist } : {}),
})

/**
 * What puts a conversation's badge up when it arrives unwatched: something
 * someone else wrote, or a call of theirs that nobody answered. Any other call
 * record was seen as it happened.
 */
const countsAsUnread = (message: Message): boolean =>
  message.direction === 'in' && (!message.call || message.call.outcome === 'missed')

/** Environment-triggered catch-up reads are spaced at least this far apart. */
const RESYNC_MIN_INTERVAL_MS = 3 * SECOND
/**
 * A catch-up read is skipped when no read relay has dropped since the last one
 * — the live subscription saw everything — unless the last one is this old.
 */
const RESYNC_STALE_MS = 2 * MINUTE
/** A contact's relays are pre-warmed at most this often. */
const PREWARM_EVERY_MS = MINUTE
/** Retention and seen-table compaction rerun this often in a long session. */
const JANITOR_EVERY_MS = 12 * 60 * MINUTE
/**
 * The forward-secret group runtime is loaded this long after start when all
 * it has to do is look after a KeyPackage: off the path to reading messages.
 */
const MLS_IDLE_LOAD_MS = 20 * SECOND
/** Mirrors `KEY_PACKAGE_REFRESH_SEC` and `REPLACED_KEY_GRACE_SEC` in the runtime, so the shell knows when to load it. */
const MLS_KEY_REFRESH_SEC = 14 * 86_400
const MLS_KEY_GRACE_SEC = 7 * 86_400

/**
 * The application core.
 *
 * Everything above this line is UI; everything below is transport. The
 * messenger owns the rules that make the two paths behave as one conversation:
 * a message gets an id once, is stored once, and is deduplicated by that id no
 * matter how many relays or channels deliver it.
 *
 * Delivery model, stated plainly: every chat message is published to relays,
 * always, even when a direct channel is open. The direct channel is a latency
 * optimisation, not a delivery guarantee — SCTP accepting a frame says nothing
 * about the peer having stored it. Publishing to relays regardless costs one
 * extra small write and buys durability plus the self-addressed copy that makes
 * vault restore possible.
 */
export class Messenger {
  readonly events = new Emitter<MessengerEvents>()
  readonly pool: IRelayPool
  readonly transport: NostrTransport

  #vault: Vault
  #repo: VaultRepo
  #secretKey: Uint8Array | null = null
  #pubkey = ''
  #settings: AppSettings
  #direct: DirectManager | null = null
  #blobs: BlobTransfer | null = null
  #inbox: InboxSync | null = null
  #janitorAt = 0
  /** The forward-secret group runtime, a lazy chunk: loaded when there is a group or an invitation to keep. */
  #mls: Promise<MlsRuntime> | null = null
  #mlsReady: MlsRuntime | null = null
  #outboxTimer: ReturnType<typeof setInterval> | null = null
  #running = false
  #lastSyncAt = 0
  #syncing = false
  #lastResyncAt = 0
  /** The pool's epoch when the last catch-up read completed. */
  #resyncEpoch = -1
  #lastTickAt = 0
  #prewarmedAt = new Map<string, number>()

  /** Outbox item id -> its delivery in progress. */
  #inFlight = new Map<string, Promise<void>>()
  #laneActive: Record<Lane, number> = { priority: 0, bulk: 0 }
  readonly #launchDue: () => Promise<void>

  /** Peer pubkey -> timer clearing a stale "typing" indicator. */
  #typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Peer pubkey -> rumor ids awaiting a batched delivery receipt. */
  #pendingReceipts = new Map<string, Set<string>>()
  /** Conversations whose authors are owed a read receipt, batched on the same timer. */
  #pendingReadReceipts = new Set<string>()
  /**
   * Inbox relays learned for people who are not contacts — the other members
   * of a group someone else started. Memory only: a contact's relays live on
   * the contact, and these are re-learned next session if still needed.
   */
  #learnedRelays = new Map<string, string[]>()
  #learning = new Set<string>()
  #receiptTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The conversation on screen, and whether the app is actually showing it.
   *
   * A message that arrives in the conversation someone is looking at has been
   * read on arrival, and the engine has to know that at the moment it stores
   * the message — see `#ingestChat`.
   */
  #viewing: { convoId: string; focused: boolean } | null = null
  /** Peer pubkey -> when we last sent a typing frame, for throttling. */
  #lastTypingSentAt = new Map<string, number>()

  readonly flushOutbox: () => Promise<void>

  constructor(vault: Vault, repo: VaultRepo, settings: AppSettings, pool?: IRelayPool) {
    this.#vault = vault
    this.#repo = repo
    this.#settings = settings
    this.pool = pool ?? new RelayPool()
    this.transport = new NostrTransport(this.pool)
    this.pool.events.on('statusChanged', (statuses) => {
      this.events.emit('relayStatus', statuses)
      this.#emitSyncState()
    })
    // Launching is coalesced and never waits on delivery, so a new message
    // starts out the moment it is queued however much is already in flight.
    this.#launchDue = coalesce(() => this.#launchDueOnce())
    this.flushOutbox = async () => {
      await this.#launchDue()
      // Drain: wait for what is in flight, then launch whatever that freed up
      // room for, until nothing due remains.
      while (this.#inFlight.size > 0) {
        await Promise.allSettled([...this.#inFlight.values()])
        await this.#launchDue()
      }
    }
  }

  get pubkey(): string {
    return this.#pubkey
  }

  get settings(): AppSettings {
    return this.#settings
  }

  get isRunning(): boolean {
    return this.#running
  }

  directStateFor(peerPubkey: string): DirectState {
    return this.#direct?.stateOf(peerPubkey) ?? 'idle'
  }

  /** Where the conversation at `address` is stored. */
  conversationIdFor(address: ChatAddress): string {
    return isGroupAddress(address) ? address : this.#repo.conversationId(this.#pubkey, address)
  }

  async #roomFor(address: ChatAddress): Promise<Room> {
    if (!isGroupAddress(address)) {
      return {
        convoId: this.#repo.conversationId(this.#pubkey, address),
        kind: 'direct',
        members: [address],
        peer: address,
      }
    }
    const conversation = await this.#repo.getConversation(address)
    if (conversation?.kind !== 'group') throw new Error('no such group')
    // Text, replies and reactions only: attachments, polls and the rest of a
    // small group's traffic are not carried in forward-secret groups (ADR-049).
    if (conversation.mls) throw new Error('not available in a forward-secret group')
    return {
      convoId: conversation.id,
      kind: 'group',
      members: conversation.members,
      peer: null,
      ...(conversation.subject ? { subject: conversation.subject } : {}),
    }
  }

  /**
   * Start a group with these people.
   *
   * Nothing is sent: under NIP-17 a group is simply the set of people a
   * message names, so it comes into existence for everyone else with its first
   * message. What this does is give it a row, a name and an address here, so
   * the conversation can be opened and written in.
   *
   * At most `MAX_GROUP_MEMBERS` people including us. The limit is enforced on
   * the way in too, so a group started elsewhere cannot exceed it either.
   */
  async createGroup(members: readonly string[], subject = ''): Promise<Conversation> {
    if (!this.#running) throw new Error('messenger is not running')
    const others = [...new Set(members)].filter((pubkey) => pubkey !== this.#pubkey)
    if (others.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) throw new Error('not a public key')
    if (others.length < 2) throw new Error('a group needs at least two other people')
    if (others.length + 1 > MAX_GROUP_MEMBERS) {
      throw new Error(`a group can have at most ${MAX_GROUP_MEMBERS} people, including you`)
    }
    const name = cleanLine(subject, MAX_SUBJECT_CHARS)
    const group = await this.#repo.ensureGroupConversation(this.#pubkey, others, {
      subject: name,
      accepted: true,
    })
    this.events.emit('conversationsChanged', undefined)
    for (const member of others) void this.#learnRelays(member)
    return group
  }

  // --- lifecycle ------------------------------------------------------------

  async start(secretKeyHex: string, pubkey: string): Promise<void> {
    if (this.#running) return
    this.#secretKey = hexToBytes(secretKeyHex)
    this.#pubkey = pubkey
    this.#running = true

    await this.#loadRelays()
    this.#inbox = new InboxSync({
      pool: this.pool,
      pubkey,
      store: {
        load: () => this.#repo.getSyncState(),
        save: (state) => this.#repo.setSyncState(state),
        items: (sinceSec) => this.#repo.seenItems(sinceSec),
      },
      onWrap: (wrap) => this.#ingestWrap(wrap),
    })

    this.#direct = new DirectManager(this.#secretKey, this.#iceServers())
    this.#direct.setEnabled(this.#settings.enableDirectConnection && supportsWebRtc())
    this.#direct.events.on('rumor', ({ peerPubkey, rumor }) => {
      void this.#ingestRumor(rumor, peerPubkey, 'direct')
    })
    this.#direct.events.on('signal', ({ peerPubkey, frame }) => {
      void this.#sendControl(peerPubkey, frame, { viaDirect: false })
    })
    this.#direct.events.on('stateChanged', (payload) => {
      this.events.emit('directState', payload)
      // A channel that comes up after a message was queued should carry it
      // immediately — that latency is the entire reason the direct path
      // exists. The relay publish continues regardless, so this is purely an
      // accelerator and the peer deduplicates by rumor id.
      if (payload.state === 'connected') void this.#pushQueuedOverDirect(payload.peerPubkey)
    })

    // Before anything reads or writes a payload: ADR-052 moved where they are
    // kept. A failure leaves older payloads unreadable until the next start,
    // which tries again; it does not stop messages.
    try {
      const { moved, dropped } = await this.#repo.migrateBlobStore()
      if (moved + dropped > 0)
        log.info(`attachment store: ${moved} payload(s) moved, ${dropped} unreadable dropped`)
    } catch (err) {
      log.warn('attachment store could not be migrated', err)
    }

    this.#blobs = new BlobTransfer({
      store: this.#repo,
      isDirect: (peerPubkey) => this.#direct?.isConnected(peerPubkey) === true,
      send: async (peerPubkey, frame) => {
        await this.#sendControl(peerPubkey, frame, { durable: frame.t === 'blob' })
      },
    })
    this.#blobs.events.on('progress', (payload) => this.events.emit('blobProgress', payload))
    this.#blobs.events.on('complete', ({ id, copy }) => this.events.emit('blobComplete', { id, copy }))
    this.#blobs.events.on('failed', ({ id, reason }) =>
      log.warn(`attachment ${id.slice(0, 8)} did not complete: ${reason}`),
    )

    await this.#inbox.start()
    this.#lastSyncAt = this.#inbox.lastSyncSec
    this.#lastTickAt = Date.now()
    this.#outboxTimer = setInterval(() => this.#tick(), OUTBOX_TICK_MS)

    void this.resync({ force: true })
    void this.#announceInboxRelays()
    this.#sweep()
    void this.#maybeStartMls().catch((err: unknown) => log.warn('forward-secret groups did not start', err))
  }

  stop(): void {
    this.#running = false
    this.#inbox?.stop()
    this.#inbox = null
    this.#mlsReady?.stop()
    this.#mlsReady = null
    this.#mls = null
    if (this.#outboxTimer) clearInterval(this.#outboxTimer)
    this.#outboxTimer = null
    if (this.#receiptTimer) clearTimeout(this.#receiptTimer)
    this.#receiptTimer = null
    for (const timer of this.#typingTimers.values()) clearTimeout(timer)
    this.#typingTimers.clear()
    this.#pendingReceipts.clear()
    this.#pendingReadReceipts.clear()
    this.#viewing = null
    this.#blobs?.stop()
    this.#blobs = null
    this.#direct?.dispose()
    this.#direct = null
    this.pool.destroy()
    this.#secretKey?.fill(0)
    this.#secretKey = null
  }

  async applySettings(settings: AppSettings): Promise<void> {
    const previous = this.#settings
    this.#settings = settings
    this.#direct?.setEnabled(settings.enableDirectConnection && supportsWebRtc())
    this.#direct?.setIceServers(this.#iceServers())
    if (previous.retention !== settings.retention) await this.#runJanitor()
    // Invitations turned on publish a KeyPackage; turned off, withdraw it.
    if (previous.mlsInvites !== settings.mlsInvites && this.#running) {
      void this.#loadMls()
        .then((runtime) => runtime.ensureKeyPackage())
        .catch((err: unknown) => log.warn('could not update the published KeyPackage', err))
    }
    // Turning the public profile on is an explicit, consequential act: it links
    // a name to a key for anyone on the relay network. Publish immediately so
    // the toggle means what it says.
    if (!previous.publishPublicProfile && settings.publishPublicProfile) {
      await this.publishPublicProfile()
    }
  }

  /**
   * Publish a NIP-01 kind-0 profile.
   *
   * Off by default and never called implicitly: a public profile is readable by
   * anyone and permanently associates a display name with a public key. Only
   * runs when the user has opted in.
   */
  async publishPublicProfile(): Promise<boolean> {
    if (!this.#secretKey || !this.#settings.publishPublicProfile) return false
    const identity = await this.#repo.getIdentity()
    if (!identity) return false
    try {
      const results = await this.transport.publishProfile(this.#secretKey, {
        name: identity.name,
        about: identity.about || undefined,
        picture: identity.avatar,
      })
      return results.some((outcome) => outcome.ok)
    } catch (err) {
      log.warn('failed to publish public profile', err)
      return false
    }
  }

  // --- relays ---------------------------------------------------------------

  async #loadRelays(): Promise<void> {
    let entries = await this.#repo.listRelays()
    if (entries.length === 0) {
      for (const url of DEFAULT_DM_RELAYS) await this.#repo.upsertRelay(url, { read: true, write: true })
      entries = await this.#repo.listRelays()
    }
    this.#applyRelayEntries(entries)
  }

  #applyRelayEntries(entries: RelayEntry[]): void {
    const active = entries.filter((entry) => entry.enabled)
    this.pool.seedHealth(active.map((entry) => ({ url: entry.url, health: entry.health })))
    this.pool.setRelays(
      active.filter((entry) => entry.read).map((entry) => entry.url),
      active.filter((entry) => entry.write).map((entry) => entry.url),
    )
  }

  async reloadRelays(): Promise<RelayEntry[]> {
    const entries = await this.#repo.listRelays()
    const before = this.pool.readRelays.join('\n')
    this.#applyRelayEntries(entries)
    // Only when the set of read relays actually changed. The UI reloads relays
    // straight after unlock, and resubscribing then closed the inbox
    // subscription the engine had opened a moment earlier — so any relay that
    // had already connected replayed three days of gift wraps twice.
    if (this.pool.readRelays.join('\n') !== before) this.#resubscribe()
    return entries
  }

  /** Persist rolling health so relay ranking survives a restart. */
  async persistRelayHealth(): Promise<void> {
    if (!this.#vault.isUnlocked) return
    for (const { url, health } of this.pool.healthSnapshot()) {
      await this.#repo.saveRelayHealth(url, health).catch(() => undefined)
    }
  }

  async #announceInboxRelays(): Promise<void> {
    if (!this.#secretKey) return
    try {
      await this.transport.publishInboxRelays(this.#secretKey, this.pool.rankedReadRelays(6))
    } catch (err) {
      log.warn('failed to announce inbox relays', err)
    }
  }

  // --- inbox subscription ---------------------------------------------------

  #resubscribe(): void {
    if (!this.#running) return
    this.#inbox?.open()
  }

  /**
   * Catch the inbox up. Runs on start, and when the environment suggests
   * something may have been missed.
   *
   * Skipped when it cannot find anything: if no read relay has dropped since
   * the last catch-up, the live subscription has been receiving throughout.
   * Forced on start, and repeated anyway once the last one is a couple of
   * minutes old. What a catch-up costs per relay is `InboxSync`'s business —
   * a negentropy exchange where the relay speaks NIP-77, otherwise a read
   * from that relay's own high-water mark.
   */
  async resync(opts: { force?: boolean } = {}): Promise<void> {
    const inbox = this.#inbox
    if (!this.#running || !this.#pubkey || this.#syncing || !inbox) return
    const now = Date.now()
    if (!opts.force) {
      if (now - this.#lastResyncAt < RESYNC_MIN_INTERVAL_MS) return
      if (this.pool.epoch === this.#resyncEpoch && now - this.#lastResyncAt < RESYNC_STALE_MS) return
    }
    const epoch = this.pool.epoch
    this.#lastResyncAt = now
    this.#syncing = true
    this.#emitSyncState()
    try {
      await inbox.catchUp({ force: opts.force === true && this.#resyncEpoch !== -1 })
      this.#lastSyncAt = inbox.lastSyncSec
      this.#resyncEpoch = epoch
      // Launched, not awaited: an attachment upload in the outbox must not
      // hold the app in its "checking for messages" state.
      void this.#launchDue()
    } catch (err) {
      log.warn('resync failed', err)
      this.events.emit('error', { scope: 'sync', message: errorText(err) })
    } finally {
      this.#syncing = false
      this.#emitSyncState()
    }
  }

  // --- receiving ------------------------------------------------------------

  async #ingestWrap(wrap: NostrEvent): Promise<void> {
    // (Nothing older than the dedup floor gets here: `InboxSync` refuses it.)
    if (!this.#secretKey || !this.#vault.isUnlocked) return
    try {
      if (await this.#repo.hasSeen(wrap.id)) return
      await this.#repo.markSeen([{ id: wrap.id, createdAt: wrap.created_at }])
      this.#inbox?.noteWrap(wrap.id, wrap.created_at)
    } catch {
      return
    }

    let rumor: Rumor
    try {
      rumor = unwrapGift(wrap, this.#secretKey)
    } catch (err) {
      // Expected in normal operation: relays return wraps addressed to us that
      // were sealed for a key we no longer hold, plus outright garbage.
      log.debug('discarding unreadable wrap', err)
      return
    }
    await this.#ingestRumor(rumor, rumor.pubkey, 'relay')
  }

  async #ingestRumor(rumor: Rumor, authorPubkey: string, via: 'relay' | 'direct'): Promise<void> {
    if (rumor.kind === KIND_MLS_WELCOME) {
      // An invitation to a forward-secret group. It names no room of its
      // own — the group it opens decides who is in it — and only ever comes
      // by relay, from someone else.
      if (via === 'relay' && authorPubkey !== this.#pubkey) {
        void this.#loadMls()
          .then((runtime) => runtime.receiveWelcome(rumor))
          .catch((err: unknown) => log.warn('could not process a group invitation', err))
      }
      return
    }
    if (!ACCEPTED_RUMOR_KINDS.has(rumor.kind)) return

    // The conversation is the set of people the rumor names (NIP-17). A rumor
    // that does not name us, that names nobody else, or that names more people
    // than a group may hold is not one we read.
    const members = roomOf(rumor, this.#pubkey)
    if (!members) return
    const isSelfCopy = authorPubkey === this.#pubkey
    const peer = members.length === 1 ? (members[0] as string) : null
    const arrival: Arrival = {
      convoId: peer
        ? this.#repo.conversationId(this.#pubkey, peer)
        : this.#repo.conversationIdOf(this.#pubkey, members),
      kind: peer ? 'direct' : 'group',
      members,
      peer,
      author: authorPubkey,
      isSelfCopy,
    }

    // A direct conversation is gated on the person it is with, including our
    // own copies of what we sent them. A group is gated on whoever wrote the
    // message: blocking someone silences them everywhere, but does not take
    // away a conversation that other people are in too.
    const gate = peer ?? (isSelfCopy ? null : authorPubkey)
    if (gate && (await this.#repo.getContact(gate))?.blocked) return

    if (rumor.kind === KIND_CHAT) {
      await this.#ingestChat(rumor, arrival, via)
      return
    }
    if (rumor.kind === KIND_REACTION) {
      await this.#ingestReaction(rumor, arrival)
      return
    }
    if (rumor.kind === KIND_CONTROL) {
      const frame = parseControlFrame(rumor.content)
      if (!frame) return
      // Votes and ticks are content, copied to our own inbox so another device
      // shows them; everything else is plumbing between two devices.
      if (isInteractiveFrame(frame)) {
        await this.#ingestUpdate(rumor, frame, arrival)
        return
      }
      if (isSelfCopy) return
      // Only withdrawal is meaningful addressed to a whole group. Receipts,
      // signalling, typing and chunks are always sent person to person.
      if (!peer && frame.t !== 'redact') return
      await this.#handleControl(authorPubkey, frame, rumor)
    }
  }

  async #ingestChat(rumor: Rumor, arrival: Arrival, via: 'relay' | 'direct'): Promise<void> {
    if (rumor.content.length > MAX_MESSAGE_CHARS) return
    // A descriptor that fails validation drops the payload, not the message:
    // the text still arrives and the bubble simply has nothing to play.
    const attachment = parseAttachment(attachmentFromTags(rumor.tags))
    // An empty rumor is noise — unless it carries an attachment, in which case
    // the payload *is* the message. This guard predated attachments and
    // silently discarded every uncaptioned photo and file on arrival.
    if (rumor.content.length === 0 && !attachment) return
    if (await this.#repo.hasMessage(rumor.id)) return
    // Deleted here, or withdrawn before it arrived: a late copy stays out.
    if (await this.#repo.isWithdrawn(rumor.id, rumor.pubkey)) return

    const { isSelfCopy } = arrival
    const ts = preciseTimestamp(rumor.tags, rumor.created_at)
    const thread = threadFromTags(rumor.tags)
    const subject = arrival.peer ? null : subjectFromTags(rumor.tags)
    let conversation: Conversation
    if (arrival.peer) {
      conversation = await this.#repo.ensureConversation(this.#pubkey, arrival.peer)
      await this.#ensureContactFor(arrival.peer, isSelfCopy)
    } else {
      conversation = await this.#ensureGroup(arrival, ts, subject)
    }

    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: isSelfCopy ? 'out' : 'in',
      // A self-copy is a message we sent from another device: it is already
      // delivered as far as this device is concerned.
      status: isSelfCopy ? 'sent' : 'delivered',
      ts,
      tsCoarse: 0,
      body: rumor.content,
      authorPubkey: rumor.pubkey,
      replyTo: thread.replyTo ?? undefined,
      rootId: thread.root ?? undefined,
      via,
    }

    if (attachment) message.attachment = attachment
    // A message carries a poll or a checklist, never both; a poll wins.
    const poll = pollFromTags(rumor.tags)
    const checklist = poll ? null : checklistFromTags(rumor.tags)
    if (poll) message.poll = poll
    if (checklist) message.checklist = checklist
    if (!arrival.peer && isSelfCopy) {
      // Sent to the group from another device, and on the relays by the time
      // it is back here. Receipts from the members arrive at this device too —
      // they are addressed to our key, not to a device — so track them here.
      message.receipts = Object.fromEntries(arrival.members.map((member) => [member, 'sent' as const]))
      if (subject) message.subject = subject
    }

    /*
     * A message arriving in the conversation on screen is read the moment it
     * lands, so it is never counted as unread — not even briefly.
     *
     * Clearing the badge afterwards instead would be wrong twice over: the
     * count is written and cleared in two separate transactions, so the list
     * can read the database in between and show a badge for a conversation
     * that is open; and the two writes race, so a refresh in flight can
     * restore the count after it has been cleared and leave it on screen until
     * something else happens to refresh. Not counting it has neither problem.
     */
    const watched = !isSelfCopy && this.#isViewing(conversation.id)
    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, message.ts, !isSelfCopy && !watched)

    const updated = (await this.#repo.getConversation(conversation.id)) ?? conversation
    this.events.emit('message', { message, conversation: updated })
    this.events.emit('conversationsChanged', undefined)

    if (!isSelfCopy) {
      // A read receipt says everything a delivery receipt does and more, so a
      // watched conversation sends one instead of both. Either goes to the
      // author alone, even in a group: nobody else is waiting on it.
      if (watched && this.#settings.sendReadReceipts) this.#queueReadReceipt(conversation.id)
      else this.#queueReceipt(arrival.author, rumor.id)
    }

    // Register interest even for a self-copy: this device wants the payload it
    // sent from another one just as much as a received one. Our own group
    // message's chunks went to its members, so one of them is asked.
    if (attachment) {
      const source = isSelfCopy ? (arrival.peer ?? arrival.members[0]) : arrival.author
      if (source) void this.#blobs?.expect(source, attachment)
    }
  }

  /**
   * The group a message arrived in, created on first sight.
   *
   * A group is taken — shown as a normal conversation — when we sent into it
   * ourselves or when whoever wrote to it is someone we have accepted. Anything
   * else is a request, exactly as a first message from a stranger is: anyone
   * can name us in a `p` tag.
   */
  async #ensureGroup(arrival: Arrival, at: number, subject: string | null): Promise<Conversation> {
    let accepted = arrival.isSelfCopy
    if (!accepted) {
      const author = await this.#repo.getContact(arrival.author)
      accepted = author?.accepted === true && !author.blocked
    }
    const group = await this.#repo.ensureGroupConversation(this.#pubkey, arrival.members, {
      subject,
      at,
      accepted,
    })
    for (const member of arrival.members) void this.#learnRelays(member)
    return group
  }

  /**
   * Store a vote or checklist change.
   *
   * Filed under the conversation its sender addressed it to, which is what
   * decides whether it counts: see `tallyPoll`. Stored even when the poll has
   * not arrived yet, for the same reason reactions are.
   */
  async #ingestUpdate(rumor: Rumor, frame: InteractiveFrame, arrival: Arrival): Promise<void> {
    const targetId = frame.t === 'vote' ? frame.poll : frame.list
    const stored = await this.#repo.putUpdate({
      id: rumor.id,
      targetId,
      convoId: arrival.convoId,
      authorPubkey: rumor.pubkey,
      ts: preciseTimestamp(rumor.tags, rumor.created_at),
      frame,
    })
    if (stored) this.events.emit('updatesChanged', { targetId })
  }

  async #handleControl(peerPubkey: string, frame: ControlFrame, rumor: Rumor): Promise<void> {
    switch (frame.t) {
      case 'receipt': {
        for (const ref of frame.refs) {
          const updated = await this.#acknowledge(ref, peerPubkey, frame.state)
          if (updated) this.events.emit('messageUpdated', updated)
        }
        if (frame.state === 'read') await this.#markEarlierRead(peerPubkey, frame.refs)
        break
      }

      case 'typing': {
        const existing = this.#typingTimers.get(peerPubkey)
        if (existing) clearTimeout(existing)
        this.events.emit('typing', { peerPubkey, active: frame.active })
        if (frame.active) {
          // Indicators expire on their own: a peer that goes offline mid-typing
          // must not leave the bubble stuck forever.
          this.#typingTimers.set(
            peerPubkey,
            setTimeout(() => {
              this.#typingTimers.delete(peerPubkey)
              this.events.emit('typing', { peerPubkey, active: false })
            }, TYPING_TTL_MS),
          )
        }
        break
      }

      case 'rtc':
        if (isCallFrame(frame)) await this.#routeCall(peerPubkey, frame, rumor)
        else await this.#direct?.handleSignal(peerPubkey, frame)
        break

      case 'presence':
        // v1 never emits these, but other clients (or a later Textor) may.
        // Recording last-seen is the useful, harmless interpretation.
        if (frame.online) await this.#repo.upsertContact(peerPubkey, { lastSeenAt: Date.now() })
        break

      case 'blob':
        await this.#blobs?.accept(peerPubkey, frame)
        return

      case 'blobreq':
        await this.#blobs?.serve(peerPubkey, frame.id, frame.copy, frame.need)
        return

      case 'redact': {
        // Honoured only for what this peer may withdraw: what they wrote, and
        // a call they were in. Without that check, anyone who can reach your
        // inbox could delete your own words out of your own conversation.
        let removed = 0
        for (const id of frame.refs) {
          // A withdrawal also covers reactions, which is how taking one back
          // removes it from the other side rather than leaving a reaction the
          // person who placed it can no longer reach.
          const reaction = await this.#repo.getReaction(id)
          if (reaction) {
            if (reaction.authorPubkey !== peerPubkey) continue
            await this.#repo.withdraw(id, peerPubkey)
            await this.#repo.deleteReaction(id)
            this.events.emit('reactionsChanged', { messageId: reaction.messageId })
            continue
          }
          const message = await this.#repo.getMessage(id)
          if (!message) {
            // Not here yet: the withdrawal overtook what it withdraws. Keep
            // the tombstone, under the peer's name, for when it arrives.
            await this.#repo.withdraw(id, peerPubkey)
            continue
          }
          if (!this.#mayWithdraw(peerPubkey, message)) continue
          await this.#forget(message)
          await this.#uncount(message)
          removed++
        }
        if (removed > 0) {
          log.info(`peer withdrew ${removed} message(s)`)
          this.events.emit('messagesRedacted', { peerPubkey, ids: frame.refs })
          this.events.emit('conversationsChanged', undefined)
        }
        return
      }

      case 'profile': {
        const patch: Partial<Contact> = {}
        if (frame.name) patch.remoteName = frame.name
        if (frame.about) patch.about = frame.about
        if (frame.avatar) patch.avatar = frame.avatar
        if (frame.relays?.length) patch.relays = normalizeRelayList(frame.relays, 6)
        if (Object.keys(patch).length > 0) {
          await this.#repo.upsertContact(peerPubkey, patch)
          this.events.emit('contactsChanged', undefined)
        }
        break
      }
    }
  }

  /**
   * Apply one receipt to one of our messages.
   *
   * Only from someone the message was actually sent to: a receipt names a
   * message by id alone, and without this check anyone who learned an id could
   * mark it delivered or read. In a group it moves that one member's state,
   * and the message's own status follows the least advanced member.
   */
  async #acknowledge(id: string, from: string, state: 'delivered' | 'read'): Promise<Message | null> {
    const message = await this.#repo.getMessage(id)
    // A call record shares its id with the offer that opened the call, which
    // the peer knows — but it is a note on this device, not something sent.
    if (message?.direction !== 'out' || message.call) return null
    if (!(await this.#isParticipant(message.convoId, from))) return null
    return message.receipts
      ? this.#repo.markRecipients(id, [from], state)
      : this.#repo.advanceMessageStatus(id, state)
  }

  async #isParticipant(convoId: string, pubkey: string): Promise<boolean> {
    if (convoId === this.#repo.conversationId(this.#pubkey, pubkey)) return true
    const conversation = await this.#repo.getConversation(convoId)
    return conversation?.kind === 'group' && conversation.members.includes(pubkey)
  }

  /**
   * A read receipt for message N implies everything the reader received before
   * N has been read too. Marking them individually would need one receipt per
   * message. In a group it is only that reader's copies that are marked.
   */
  async #markEarlierRead(from: string, refs: string[]): Promise<void> {
    const newestByConvo = new Map<string, number>()
    for (const ref of refs) {
      const message = await this.#repo.getMessage(ref)
      if (message?.direction !== 'out' || !(await this.#isParticipant(message.convoId, from))) continue
      newestByConvo.set(message.convoId, Math.max(newestByConvo.get(message.convoId) ?? 0, message.ts))
    }
    for (const [convoId, newest] of newestByConvo) {
      const earlier = (await this.#repo.listMessages(convoId, 500)).filter(
        (message) => message.direction === 'out' && !message.call && message.ts <= newest,
      )
      const direct = earlier.filter((message) => !message.receipts && message.status !== 'read')
      for (const updated of await this.#repo.advanceMessageStatuses(
        direct.map((message) => message.id),
        'read',
      )) {
        this.events.emit('messageUpdated', updated)
      }
      for (const message of earlier) {
        const was = message.receipts?.[from]
        if (was === undefined || was === 'read') continue
        const updated = await this.#repo.markRecipients(message.id, [from], 'read')
        if (updated) this.events.emit('messageUpdated', updated)
      }
    }
  }

  async #ensureContactFor(peerPubkey: string, isSelfCopy: boolean): Promise<void> {
    const existing = await this.#repo.getContact(peerPubkey)
    if (existing) {
      if (Date.now() - existing.lastSeenAt > MINUTE) {
        await this.#repo.upsertContact(peerPubkey, { lastSeenAt: Date.now() })
      }
      return
    }
    // Anyone can send us a gift wrap — that is what makes the network
    // permissionless. Unsolicited senders land as unaccepted contacts so the UI
    // can present them as a request instead of a normal thread.
    await this.#repo.upsertContact(peerPubkey, {
      name: '',
      source: isSelfCopy ? 'manual' : 'incoming',
      accepted: isSelfCopy,
      lastSeenAt: Date.now(),
    })
    this.events.emit('contactsChanged', undefined)
  }

  // --- sending --------------------------------------------------------------

  async sendMessage(address: ChatAddress, text: string, replyTo?: string): Promise<Message> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    const body = text.trim()
    if (!body) throw new Error('message is empty')
    if (body.length > MAX_MESSAGE_CHARS) throw new Error('message is too long')
    const secure = await this.#secureGroup(address)
    if (secure) return (await this.#loadMls()).chat.send(secure, body, replyTo)
    return this.#sendChat(await this.#roomFor(address), body, { replyTo })
  }

  /**
   * Send a message carrying an attachment.
   *
   * The message and the payload travel separately and deliberately so. The
   * rumor is small, goes out first, and carries everything needed to render the
   * bubble — name, size, duration, waveform, blurred preview — so the recipient
   * sees the attachment immediately and watches it fill in. A payload that
   * never finishes leaves a message rather than a hole, and one interrupted
   * halfway resumes rather than restarts.
   *
   * `caption` becomes the rumor content, so a client that does not understand
   * the attachment tag still shows something sensible instead of an empty
   * bubble. That is the whole interoperability contract of NIP-17: unknown tags
   * are ignored, content is not.
   *
   * In a group the payload is pushed to every member separately — each chunk
   * sealed to each of them — so it must fit the relay path: there is no direct
   * channel to fall back on for eight people at once.
   */
  async sendAttachment(
    address: ChatAddress,
    input: {
      bytes: Uint8Array
      kind: Attachment['kind']
      mime: string
      caption: string
      name?: string
      durationMs?: number
      waveform?: number[]
      width?: number
      height?: number
      preview?: string
      /**
       * A copy this vault already holds of exactly these bytes — a sticker —
       * to send again rather than seal and store afresh (ADR-052).
       */
      envelope?: BlobEnvelope
    },
    replyTo?: string,
  ): Promise<Message> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    if (!this.#blobs) throw new Error('attachment transport is not running')
    if (input.envelope && input.envelope.id !== blobId(input.bytes)) {
      throw new Error('that copy does not hold these bytes')
    }
    const room = await this.#roomFor(address)

    const reach = transportsFor(input.bytes.length)
    if (!reach.direct) throw new Error('attachment is too large to send')
    if (!reach.relay) {
      // Refuse rather than queue: without a direct channel this payload has no
      // route, and a message that can never complete is worse than a clear no.
      if (!room.peer) throw new Error('attachment is too large to send to a group')
      if (!this.#direct?.isConnected(room.peer)) throw new Error('attachment needs a direct connection')
    }

    let envelope = input.envelope
    if (!envelope) {
      const sealed = sealBlob(input.bytes)
      // Persisted before anything references it: the sender's own bubble reads
      // the payload back out of storage as soon as the message renders.
      await this.#blobs.store(sealed.envelope, sealed.chunk)
      envelope = sealed.envelope
    }
    const attachment: Attachment = {
      id: envelope.id,
      key: envelope.key,
      salt: envelope.salt,
      size: envelope.size,
      chunks: envelope.chunks,
      kind: input.kind,
      mime: input.mime,
      ...(input.name ? { name: input.name } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.waveform ? { waveform: input.waveform } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.preview ? { preview: input.preview } : {}),
    }

    const message = await this.#sendChat(room, input.caption, { attachment, replyTo })
    // The payload follows the message on the wire, never precedes it: a chunk
    // that reaches the peer before its descriptor has no key and is dropped.
    for (const member of room.members) void this.#blobs.push(member, blobRef(envelope), envelope.chunks)
    return message
  }

  /** Send a poll. The content is a plain-text rendering for clients without polls. */
  async sendPoll(address: ChatAddress, poll: PollSpec, replyTo?: string): Promise<Message> {
    // Round-tripped through the parser every receiver runs, so this side
    // cannot send a poll the other side would refuse to show.
    const valid = pollFromTags(pollTags(poll))
    if (!valid) throw new Error('not a valid poll')
    return this.#sendChat(await this.#roomFor(address), pollFallback(valid), { poll: valid, replyTo })
  }

  /** Send a shared checklist. The content is a plain-text rendering for clients without them. */
  async sendChecklist(address: ChatAddress, checklist: ChecklistSpec, replyTo?: string): Promise<Message> {
    const valid = checklistFromTags(checklistTags(checklist))
    if (!valid) throw new Error('not a valid checklist')
    return this.#sendChat(await this.#roomFor(address), checklistFallback(valid), {
      checklist: valid,
      replyTo,
    })
  }

  /**
   * Store and queue a chat message for everyone in a room.
   *
   * One rumor, one id, one stored message — and one outbox item naming every
   * member, which delivery turns into one sealed wrap per member. The id is
   * what every member's copy has in common, which is what makes receipts,
   * replies and deduplication work across all of them.
   */
  async #sendChat(
    room: Room,
    content: string,
    extras: { replyTo?: string; attachment?: Attachment; poll?: PollSpec; checklist?: ChecklistSpec },
  ): Promise<Message> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    const sentAt = Date.now()
    const rootId = extras.replyTo ? await this.#threadRoot(extras.replyTo) : null
    const shape: ChatShape = {
      ts: sentAt,
      ...(extras.replyTo ? { replyTo: extras.replyTo } : {}),
      ...(extras.replyTo && rootId ? { rootId } : {}),
      ...(room.subject ? { subject: room.subject } : {}),
      ...(extras.attachment ? { attachment: extras.attachment } : {}),
      ...(extras.poll ? { poll: extras.poll } : {}),
      ...(extras.checklist ? { checklist: extras.checklist } : {}),
    }
    const rumor = createRumor(
      {
        kind: KIND_CHAT,
        content,
        tags: chatTags(room.members, shape),
        created_at: Math.floor(sentAt / 1000),
      },
      this.#secretKey,
    )
    const conversation = room.peer
      ? await this.#repo.ensureConversation(this.#pubkey, room.peer)
      : await this.#repo.getConversation(room.convoId)
    if (!conversation) throw new Error('no such group')

    const { ts: _ts, ...stored } = shape
    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: 'out',
      status: 'queued',
      ts: sentAt,
      tsCoarse: 0,
      body: content,
      authorPubkey: this.#pubkey,
      ...stored,
      ...(room.peer ? {} : { receipts: Object.fromEntries(room.members.map((m) => [m, 'queued' as const])) }),
      via: 'relay',
    }
    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, message.ts, false)

    await this.#repo.enqueue({
      id: rumor.id,
      convoId: conversation.id,
      peerPubkey: room.peer ?? '',
      recipients: room.members,
      rumorJson: JSON.stringify(rumor),
      relays: room.peer ? await this.#relaysFor(room.peer) : [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })

    this.events.emit('message', { message, conversation })
    this.events.emit('conversationsChanged', undefined)

    if (room.peer) {
      // Fire the direct path immediately for latency; the relay publish below
      // still happens, and the peer dedups by rumor id.
      if (this.#direct?.send(room.peer, rumor)) {
        const updated = await this.#repo.updateMessage(rumor.id, { via: 'direct' })
        if (updated) this.events.emit('messageUpdated', updated)
      } else {
        void this.#direct?.dial(room.peer)
      }
    } else {
      // A group goes by relay. A channel already open to a member is used as a
      // head start, but none is opened for it.
      for (const member of room.members) this.#direct?.send(member, rumor)
    }

    void this.#launchDue()
    return message
  }

  /**
   * Re-register interest in incomplete attachments in one conversation.
   *
   * A transfer's durable state is the chunks on disk, but the watcher that asks
   * for the missing ones lives in memory. Without this, closing the tab halfway
   * through a photo means it never completes, however long the app is left open
   * afterwards.
   */
  async #resumeAttachments(convoId: string): Promise<void> {
    if (!this.#blobs) return
    try {
      for (const message of await this.#repo.listMessages(convoId, 100)) {
        if (!message.attachment || message.direction !== 'in') continue
        // Asked of whoever sent it, which in a group is not everyone.
        await this.#blobs.resume(message.authorPubkey, message.attachment)
      }
    } catch (err) {
      log.warn('could not resume attachments', err)
    }
  }

  /**
   * Send a raw withdrawal request.
   *
   * Exists so a test can play the part of a peer asking for something it has no
   * right to. Production code goes through `redactMessage`, which checks
   * authorship before it sends anything.
   */
  async sendRedactForTesting(peerPubkey: string, refs: string[]): Promise<void> {
    await this.#sendControl(peerPubkey, { v: PROTOCOL_VERSION, t: 'redact', refs }, { durable: true })
  }

  /**
   * Read a completed payload back out of storage, decrypted.
   *
   * Returns `null` when the payload is merely incomplete, and throws when what
   * is on disk cannot be opened. The caller has to tell those apart: one is a
   * transfer still in progress, which will very likely finish, and the other is
   * a payload that never will. Reporting both as failure — which an earlier
   * version did — put a hard error on every attachment the instant it arrived,
   * before a single chunk had.
   */
  /**
   * Delete a message here and ask the peer to delete their copy.
   *
   * Only our own messages, and calls: asking someone to delete something they
   * wrote is not ours to ask, and their client refuses it anyway. A call has
   * no author — it happened to both people — so either of them may take it
   * out of the conversation for both. The request is queued durably, so a
   * peer who is offline honours it when they next connect rather than keeping
   * the message forever because they happened to miss one event.
   *
   * This is a tombstone, not an erasure. A modified client can ignore it and a
   * relay may still hold the wrap; the UI says so rather than promising more.
   */
  async redactMessage(address: ChatAddress, messageId: string): Promise<void> {
    const message = await this.#repo.getMessage(messageId)
    if (!message) return
    if (message.authorPubkey !== this.#pubkey && !message.call) {
      throw new Error('cannot unsend a message you did not write')
    }
    const secure = await this.#secureGroup(address)
    if (secure) return (await this.#loadMls()).chat.withdraw(secure, message)
    const room = await this.#roomFor(address)
    if (message.convoId !== room.convoId) throw new Error('that message is not in this conversation')

    await this.#forget(message)
    this.events.emit('conversationsChanged', undefined)

    await this.#sendControl(
      room.members,
      { v: PROTOCOL_VERSION, t: 'redact', refs: [messageId] },
      { durable: true },
    )
  }

  /**
   * Delete a message from this device alone — and keep it deleted.
   *
   * The tombstone matters as much as the delete: the sender's outbox re-wraps
   * a message on every retry, and a relay replays an offer it still holds, so
   * without one a copy arriving a minute later would put back what was just
   * taken out.
   */
  async deleteLocally(messageId: string): Promise<void> {
    const message = await this.#repo.getMessage(messageId)
    if (!message) return
    await this.#forget(message)
    this.events.emit('conversationsChanged', undefined)
  }

  /** Tombstone first, so an interruption can lose the delete but never bring it back. */
  async #forget(message: Message): Promise<void> {
    await this.#repo.withdraw(message.id, message.authorPubkey)
    await this.#repo.deleteMessageAndPayload(message.id)
  }

  /**
   * Whether `peerPubkey` may take `message` out of this conversation: what
   * they wrote, anywhere, and a call they were in.
   *
   * A call record is written by each device for itself, under the id of the
   * offer that opened the call, so on the caller's side it names the caller as
   * its author. The check is therefore where it is kept — the direct
   * conversation with this very peer, which is the only place a call with
   * them can be — rather than who is named on it.
   */
  #mayWithdraw(peerPubkey: string, message: Message): boolean {
    if (message.authorPubkey === peerPubkey) return true
    return !!message.call && message.convoId === this.#repo.conversationId(this.#pubkey, peerPubkey)
  }

  /**
   * Take a withdrawn message off the unread count, if it was on it.
   *
   * Unread is a count, not a mark on each message (ADR-039): the newest
   * entries that count are the unread ones. So a withdrawn entry was unread
   * when fewer than `unread` counting entries are newer than it. A missed call
   * the caller took back must not leave a badge on a conversation with nothing
   * new in it.
   */
  async #uncount(message: Message): Promise<void> {
    if (!countsAsUnread(message)) return
    const conversation = await this.#repo.getConversation(message.convoId)
    if (!conversation || conversation.unread === 0) return
    const window = Math.min(conversation.unread + 200, 1000)
    const recent = await this.#repo.listMessages(message.convoId, window)
    const newer = recent.filter((m) => m.id !== message.id && m.ts > message.ts && countsAsUnread(m)).length
    if (newer >= conversation.unread) return
    // A listing that stopped short of the withdrawn entry may have left newer
    // ones unseen. Leave the count alone rather than guess it down.
    const oldest = recent[0]
    if (recent.length === window && oldest && oldest.ts > message.ts) return
    await this.#repo.uncountUnread(message.convoId)
  }

  async readAttachment(attachment: Attachment): Promise<Uint8Array | null> {
    return this.#readBlob(attachment)
  }

  /**
   * Reassemble a payload from the blob store.
   *
   * Shared by attachments and stickers, which differ only in what the
   * descriptor is attached to: both are chunked, sealed and stored by copy.
   */
  async #readBlob(envelope: BlobEnvelope): Promise<Uint8Array | null> {
    const chunks = await this.#repo.getBlobChunks(blobRef(envelope), envelope.chunks)
    if (!chunks) return null
    return assembleBlob(
      envelope,
      chunks.map((chunk, seq) => openChunk(envelope, seq, chunk)),
    )
  }

  // --- sticker packs --------------------------------------------------------

  /**
   * Take images into a pack held in this vault.
   *
   * The bytes go through exactly the same sealing and chunking as an
   * attachment, so a sticker is storable, readable and sendable by code that
   * already exists — and is encrypted at rest like everything else. Nothing is
   * fetched from anywhere: a pack is built from files the person already has.
   */
  async importStickerPack(
    name: string,
    images: readonly { bytes: Uint8Array; mime: string; width?: number; height?: number }[],
  ): Promise<StickerPack> {
    if (!this.#blobs) throw new Error('messenger is not running')
    if (images.length === 0) throw new Error('a pack needs at least one sticker')

    /*
     * The same picture in a second pack reuses the copy this vault already
     * holds, rather than sealing another: the bytes are stored once, and
     * deleting either pack keeps what the other still uses.
     */
    const held = new Map<string, Sticker>()
    for (const pack of await this.#repo.listPacks()) {
      for (const sticker of pack.stickers) held.set(sticker.id, sticker)
    }

    const stickers: Sticker[] = []
    for (const image of images) {
      const existing = held.get(blobId(image.bytes))
      let envelope: BlobEnvelope
      if (existing) {
        envelope = existing
      } else {
        const sealed = sealBlob(image.bytes)
        await this.#blobs.store(sealed.envelope, sealed.chunk)
        envelope = sealed.envelope
      }
      const sticker: Sticker = {
        id: envelope.id,
        key: envelope.key,
        salt: envelope.salt,
        size: envelope.size,
        chunks: envelope.chunks,
        mime: image.mime,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
      }
      held.set(sticker.id, sticker)
      stickers.push(sticker)
    }

    const pack: StickerPack = {
      id: bytesToHex(randomBytes(16)),
      name: name.trim().slice(0, 64) || 'Stickers',
      createdAt: Date.now(),
      stickers,
    }
    await this.#repo.putPack(pack)
    this.events.emit('packsChanged', undefined)
    return pack
  }

  async deleteStickerPack(id: string): Promise<void> {
    await this.#repo.deletePack(id)
    this.events.emit('packsChanged', undefined)
  }

  /** Decrypt a sticker for display. */
  async readSticker(sticker: Sticker): Promise<Uint8Array | null> {
    return this.#readBlob(sticker)
  }

  /**
   * Send a sticker as an ordinary image attachment.
   *
   * Deliberately not a new message type: the recipient needs no pack, no
   * shared vocabulary and no new code to see it, and it travels over the
   * chunk transport that already carries photos.
   */
  async sendSticker(address: ChatAddress, sticker: Sticker, caption = ''): Promise<Message> {
    const bytes = await this.readSticker(sticker)
    if (!bytes) throw new Error('this sticker is not on this device')
    // The pack's own copy goes out, so sending a sticker stores nothing new —
    // however often it is sent — and never touches the copy the pack reads.
    return this.sendAttachment(address, {
      bytes,
      envelope: sticker,
      kind: 'image',
      mime: sticker.mime,
      caption,
      ...(sticker.width !== undefined ? { width: sticker.width } : {}),
      ...(sticker.height !== undefined ? { height: sticker.height } : {}),
    })
  }

  /**
   * The thread a reply belongs to.
   *
   * The root is inherited from the parent, so a chain of replies all name the
   * message that started the thread rather than each other. A parent this
   * device no longer holds — one dropped by retention — becomes the root.
   */
  async #threadRoot(replyTo?: string): Promise<string | null> {
    if (!replyTo) return null
    const parent = await this.#repo.getMessage(replyTo)
    return parent?.rootId ?? parent?.id ?? replyTo
  }

  /**
   * React to a message, or take the reaction back.
   *
   * Sealed as a NIP-25 kind 7 inside the gift wrap, never published openly: a
   * public reaction announces "this key reacted to that event" to every relay,
   * which is exactly the conversation graph NIP-17 exists to hide.
   *
   * One reaction per person per message. Sending the same emoji again
   * withdraws it; a different one replaces it. Withdrawal reuses the `redact`
   * frame that already unsends a message, so the peer's copy goes too rather
   * than lingering as a reaction they cannot remove.
   */
  async react(address: ChatAddress, messageId: string, emoji: string): Promise<void> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    const body = emoji.trim()
    if (!isReactionBody(body)) throw new Error('not a reaction')

    const message = await this.#repo.getMessage(messageId)
    if (!message) throw new Error('no such message')
    const secure = await this.#secureGroup(address)
    if (secure) return (await this.#loadMls()).chat.react(secure, message, body)
    const room = await this.#roomFor(address)

    const existing = await this.#repo.findReaction(messageId, this.#pubkey)
    if (existing) {
      await this.#repo.deleteReaction(existing.id)
      this.events.emit('reactionsChanged', { messageId })
      await this.#sendControl(
        room.members,
        { v: PROTOCOL_VERSION, t: 'redact', refs: [existing.id] },
        { durable: true },
      )
      // Reacting with what is already there means "take it back".
      if (existing.emoji === body) return
    }

    const sentAt = Date.now()
    const rumor = createRumor(
      {
        kind: KIND_REACTION,
        content: body,
        tags: reactionTags(room.members, messageId),
        created_at: Math.floor(sentAt / 1000),
      },
      this.#secretKey,
    )

    await this.#repo.putReaction({
      id: rumor.id,
      messageId,
      convoId: message.convoId,
      authorPubkey: this.#pubkey,
      emoji: body,
      ts: sentAt,
    })
    this.events.emit('reactionsChanged', { messageId })

    await this.#repo.enqueue({
      id: `${REACTION_PREFIX}${rumor.id}`,
      convoId: message.convoId,
      peerPubkey: room.peer ?? '',
      recipients: room.members,
      rumorJson: JSON.stringify(rumor),
      relays: room.peer ? await this.#relaysFor(room.peer) : [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })
    for (const member of room.members) this.#direct?.send(member, rumor)
    void this.#launchDue()
  }

  /**
   * Vote on a poll, change a vote, or withdraw one with no choices.
   *
   * The whole ballot is sent every time, so a voter's newest frame is simply
   * their vote. Checked here against the poll as it was sent — options that do
   * not exist, or two choices on a single-choice poll, are refused before
   * anything leaves the device; every receiver checks again when counting.
   */
  async vote(address: ChatAddress, pollId: string, choices: readonly string[]): Promise<void> {
    const room = await this.#roomFor(address)
    const target = await this.#repo.getMessage(pollId)
    if (!target?.poll || target.convoId !== room.convoId) throw new Error('no such poll')
    const picked = [...new Set(choices)]
    const known = new Set(target.poll.options.map((option) => option.id))
    if (picked.some((choice) => !known.has(choice))) throw new Error('not an option on this poll')
    if (!target.poll.multi && picked.length > 1) throw new Error('this poll takes one choice')
    await this.#sendUpdate(room, { v: PROTOCOL_VERSION, t: 'vote', poll: pollId, choices: picked })
  }

  /** Tick or untick an item on a shared checklist. */
  async checkItem(address: ChatAddress, listId: string, itemId: string, done: boolean): Promise<void> {
    const room = await this.#roomFor(address)
    const target = await this.#repo.getMessage(listId)
    if (!target?.checklist || target.convoId !== room.convoId) throw new Error('no such checklist')
    const items = foldChecklist(target.checklist, room.convoId, await this.#repo.listUpdatesFor([listId]))
    if (!items.some((item) => item.id === itemId)) throw new Error('no such item')
    await this.#sendUpdate(room, { v: PROTOCOL_VERSION, t: 'check', list: listId, item: itemId, done })
  }

  /** Add an item to a shared checklist. Anyone in the conversation may. */
  async addChecklistItem(address: ChatAddress, listId: string, label: string): Promise<string> {
    const room = await this.#roomFor(address)
    const target = await this.#repo.getMessage(listId)
    if (!target?.checklist || target.convoId !== room.convoId) throw new Error('no such checklist')
    const text = cleanLine(label, MAX_ITEM_CHARS)
    if (!text) throw new Error('an item needs some text')
    const items = foldChecklist(target.checklist, room.convoId, await this.#repo.listUpdatesFor([listId]))
    if (items.length >= MAX_CHECKLIST_ITEMS) throw new Error('this checklist is full')
    // Random rather than sequential: two people adding at once must not both
    // pick the next number and have one addition swallow the other.
    const item = `x${bytesToHex(randomBytes(5))}`
    await this.#sendUpdate(room, { v: PROTOCOL_VERSION, t: 'check', list: listId, item, label: text })
    return item
  }

  /**
   * Record a vote or checklist change here and send it to the room.
   *
   * Stored before it is sent, like a message, so the card updates the moment
   * it is tapped; queued durably and copied to our own inbox, so a vote cast
   * offline is cast when the network returns and shows on every device.
   */
  async #sendUpdate(room: Room, frame: InteractiveFrame): Promise<void> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    const sentAt = Date.now()
    const rumor = createRumor(
      {
        kind: KIND_CONTROL,
        content: encodeControlFrame(frame),
        tags: [...recipientTags(room.members), timestampTag(sentAt)],
        created_at: Math.floor(sentAt / 1000),
      },
      this.#secretKey,
    )
    const targetId = frame.t === 'vote' ? frame.poll : frame.list
    await this.#repo.putUpdate({
      id: rumor.id,
      targetId,
      convoId: room.convoId,
      authorPubkey: this.#pubkey,
      ts: sentAt,
      frame,
    })
    this.events.emit('updatesChanged', { targetId })

    await this.#repo.enqueue({
      id: `${INTERACTIVE_PREFIX}${rumor.id}`,
      convoId: room.convoId,
      peerPubkey: room.peer ?? '',
      recipients: room.members,
      rumorJson: JSON.stringify(rumor),
      relays: [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })
    for (const member of room.members) this.#direct?.send(member, rumor)
    void this.#launchDue()
  }

  /**
   * Store a reaction from the wire.
   *
   * Stored even when the message it points at has not arrived: wraps are
   * delivered in whatever order relays choose, and a row keyed by message id
   * simply becomes visible when the message lands. Dropping it instead would
   * quietly lose reactions whenever a history is restored out of order.
   */
  async #ingestReaction(rumor: Rumor, arrival: Arrival): Promise<void> {
    const messageId = reactionTargetFromTags(rumor.tags)
    if (!messageId || !isReactionBody(rumor.content)) return
    if (await this.#repo.isWithdrawn(rumor.id, rumor.pubkey)) return

    const convoId = arrival.convoId
    // One per author per message, so a peer changing their mind replaces
    // rather than stacks.
    const existing = await this.#repo.findReaction(messageId, rumor.pubkey)
    if (existing) {
      if (existing.id === rumor.id) return
      await this.#repo.deleteReaction(existing.id)
    }
    const stored = await this.#repo.putReaction({
      id: rumor.id,
      messageId,
      convoId,
      authorPubkey: rumor.pubkey,
      emoji: rumor.content.trim(),
      ts: preciseTimestamp(rumor.tags, rumor.created_at),
    })
    if (stored || existing) this.events.emit('reactionsChanged', { messageId })
  }

  /** Open a conversation: probe for a direct channel and clear the unread badge. */
  async openConversation(address: ChatAddress): Promise<void> {
    const convoId = this.conversationIdFor(address)
    // Awaited, so the badge is gone before the caller refreshes the list.
    await this.#watch(convoId, true)
    if (!isGroupAddress(address)) {
      void this.#direct?.dial(address)
      void this.#prewarmPeer(address)
    }
    // Pick up any attachment left half-transferred by an earlier session. The
    // chunks are on disk, but nothing is watching for the missing ones until
    // something re-registers interest.
    void this.#resumeAttachments(convoId)
    // Unconditional, unlike the arrival path: opening a conversation is an
    // explicit act, and the peer should hear about it even if this device had
    // already counted the messages as read.
    if (this.#settings.sendReadReceipts) await this.#sendReadReceipts(convoId)
  }

  /**
   * Tell the engine which conversation is on screen, and whether the app is
   * really showing it — a background tab or an unfocused window is not.
   *
   * Called when a conversation opens and closes, and whenever the window's
   * visibility or focus changes. Messages that arrived while it was neither
   * visible nor focused are counted, and cleared the moment it comes back.
   */
  setActiveConversation(address: ChatAddress | null, opts: { focused?: boolean } = {}): void {
    if (!address || !this.#running || !this.#vault.isUnlocked) {
      void this.#watch(null, opts.focused ?? true)
      return
    }
    void this.#watch(this.conversationIdFor(address), opts.focused ?? true)
  }

  async #watch(convoId: string | null, focused: boolean): Promise<void> {
    const previous = this.#viewing
    this.#viewing = convoId ? { convoId, focused } : null
    if (!convoId || !focused) return
    // Already watching this one: nothing was missed, so nothing to clear.
    if (previous?.convoId === convoId && previous.focused) return
    if (!this.#running || !this.#vault.isUnlocked) return

    try {
      if (!(await this.#repo.markConversationRead(convoId))) return
      this.events.emit('conversationsChanged', undefined)
      // Something was genuinely unread and has now been seen.
      if (this.#settings.sendReadReceipts) this.#queueReadReceipt(convoId)
    } catch (err) {
      log.warn('could not clear the unread count', err)
    }
  }

  #isViewing(convoId: string): boolean {
    return this.#viewing?.convoId === convoId && this.#viewing.focused
  }

  /**
   * Tell each author their newest message here has been read.
   *
   * One receipt per person, not one to the room: a read receipt is between the
   * reader and the writer, and in a group only the writer is waiting on it.
   */
  async #sendReadReceipts(convoId: string): Promise<void> {
    // A forward-secret group has no receipts: a message is published once, to
    // the group, and nobody tracks who has read it.
    if ((await this.#repo.getConversation(convoId))?.mls) return
    const newestByAuthor = new Map<string, string>()
    for (const message of await this.#repo.listMessages(convoId, 50)) {
      // A call record is not a message the peer sent, so there is nothing
      // for them to hear about — and its id would tell them the call was seen.
      if (message.direction === 'in' && !message.call) newestByAuthor.set(message.authorPubkey, message.id)
    }
    for (const [author, id] of newestByAuthor) {
      await this.#sendControl(author, { v: PROTOCOL_VERSION, t: 'receipt', refs: [id], state: 'read' })
    }
  }

  setTyping(address: ChatAddress, active: boolean): void {
    // Typing goes only over an open direct channel, and a group has none.
    if (isGroupAddress(address)) return
    const peerPubkey = address
    if (!this.#settings.sendTypingIndicators) return
    const last = this.#lastTypingSentAt.get(peerPubkey) ?? 0
    // Throttle: a keystroke-rate indicator would be a relay-traffic disaster.
    if (active && Date.now() - last < 3 * SECOND) return
    this.#lastTypingSentAt.set(peerPubkey, Date.now())
    void this.#sendControl(peerPubkey, { v: PROTOCOL_VERSION, t: 'typing', active }, { directOnly: true })
  }

  #queueReceipt(peerPubkey: string, rumorId: string): void {
    let set = this.#pendingReceipts.get(peerPubkey)
    if (!set) {
      set = new Set()
      this.#pendingReceipts.set(peerPubkey, set)
    }
    set.add(rumorId)
    this.#armReceiptTimer()
  }

  /**
   * Batched like delivery receipts: a burst of ten messages into an open
   * conversation is one frame naming the newest, and the peer marks
   * everything before it read.
   */
  #queueReadReceipt(convoId: string): void {
    this.#pendingReadReceipts.add(convoId)
    this.#armReceiptTimer()
  }

  #armReceiptTimer(): void {
    if (this.#receiptTimer) return
    this.#receiptTimer = setTimeout(() => {
      this.#receiptTimer = null
      void this.#flushReceipts()
    }, RECEIPT_DEBOUNCE_MS)
  }

  async #flushReceipts(): Promise<void> {
    const read = [...this.#pendingReadReceipts]
    this.#pendingReadReceipts.clear()
    for (const convoId of read) {
      await this.#sendReadReceipts(convoId).catch((err: unknown) =>
        log.warn('could not send a read receipt', err),
      )
    }

    const pending = [...this.#pendingReceipts.entries()]
    this.#pendingReceipts.clear()
    for (const [peerPubkey, refs] of pending) {
      const batch = [...refs].slice(0, MAX_RECEIPT_REFS)
      if (batch.length === 0) continue
      await this.#sendControl(peerPubkey, {
        v: PROTOCOL_VERSION,
        t: 'receipt',
        refs: batch,
        state: 'delivered',
      })
    }
  }

  /**
   * Control frames are best-effort. `directOnly` frames (typing) are dropped
   * when there is no direct channel rather than costing a relay publish — a
   * typing indicator is not worth a permanent row in someone's relay database.
   */
  async #sendControl(
    to: string | readonly string[],
    frame: ControlFrame,
    opts: { directOnly?: boolean; viaDirect?: boolean; durable?: boolean } = {},
  ): Promise<string | null> {
    if (!this.#secretKey || !this.#running) return null
    const recipients = typeof to === 'string' ? [to] : [...to]
    // One recipient is a person; several are a group, which gets one rumor
    // naming all of them and one wrap each — never the direct channel.
    const peerPubkey = recipients.length === 1 ? (recipients[0] as string) : null
    const rumor = createRumor(
      { kind: KIND_CONTROL, content: encodeControlFrame(frame), tags: recipientTags(recipients) },
      this.#secretKey,
    )

    if (peerPubkey && opts.viaDirect !== false && this.#direct?.send(peerPubkey, rumor)) return rumor.id
    if (opts.directOnly) return null

    await this.#repo.enqueue({
      id: `${frame.t === 'blob' ? BULK_PREFIX : CONTROL_PREFIX}${rumor.id}-${bytesToHex(randomBytes(4))}`,
      convoId: peerPubkey
        ? this.#repo.conversationId(this.#pubkey, peerPubkey)
        : this.#repo.conversationIdOf(this.#pubkey, recipients),
      peerPubkey: peerPubkey ?? '',
      recipients,
      rumorJson: JSON.stringify(rumor),
      relays: peerPubkey ? await this.#relaysFor(peerPubkey) : [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      // Typing indicators and presence beacons are worthless once stale, so
      // they expire fast. Attachment chunks are the payload of a real message:
      // expiring them after two minutes and three attempts is how a photo sent
      // to someone who is briefly offline can never arrive.
      ephemeral: !opts.durable,
    })
    void this.#launchDue()
    return rumor.id
  }

  /**
   * Hand everything queued for this peer to a freshly opened direct channel.
   *
   * Everything, including items waiting out a retry backoff: those are
   * precisely the ones the relay path has been failing to deliver, and the
   * reason a direct channel is worth opening at all.
   *
   * Chat messages stay queued — durability still comes from the relay publish,
   * and the self-addressed copy still has to be written. Receipts and profile
   * updates are worth nothing more once the peer holds them, so one the
   * channel accepts leaves the queue. Signalling frames belong to the relay
   * path by definition, and chunks and withdrawals keep their durable delivery.
   */
  async #pushQueuedOverDirect(peerPubkey: string): Promise<void> {
    if (!this.#direct?.isConnected(peerPubkey) || !this.#vault.isUnlocked) return
    try {
      const convoId = this.#repo.conversationId(this.#pubkey, peerPubkey)
      const queued = await this.#repo.outboxForConversation(convoId, (id) => laneOf(id) !== 'bulk')
      for (const item of queued) {
        if (item.peerPubkey !== peerPubkey) continue
        const rumor = JSON.parse(item.rumorJson) as Rumor
        if (rumor.kind === KIND_CHAT) {
          if (this.#direct.send(peerPubkey, rumor)) {
            const updated = await this.#repo.updateMessage(item.id, { via: 'direct' })
            if (updated) this.events.emit('messageUpdated', updated)
          }
          continue
        }
        if (!item.ephemeral || this.#inFlight.has(item.id)) continue
        const frame = parseControlFrame(rumor.content)
        if (!frame || frame.t === 'rtc') continue
        if (this.#direct.send(peerPubkey, rumor)) await this.#repo.dequeue(item.id)
      }
    } catch (err) {
      log.warn('failed to flush queued messages over the direct channel', err)
    }
  }

  // --- outbox ---------------------------------------------------------------

  /**
   * Start delivering whatever is due, up to each lane's limit. Returns without
   * waiting for any delivery to finish; each one that does calls back in.
   */
  async #launchDueOnce(): Promise<void> {
    if (!this.#running || !this.#secretKey || !this.#vault.isUnlocked) return
    const ids = await this.#repo.dueOutboxIds()
    for (const lane of ['priority', 'bulk'] as const) {
      for (const id of ids) {
        if (this.#laneActive[lane] >= LANE_LIMITS[lane]) break
        if (laneOf(id) !== lane || this.#inFlight.has(id)) continue
        const item = await this.#repo.getOutboxItem(id)
        if (!item || this.#inFlight.has(id) || !this.#running) continue
        this.#launch(item, lane)
      }
    }
  }

  #launch(item: OutboxItem, lane: Lane): void {
    this.#laneActive[lane] += 1
    const run = this.#process(item)
      .catch(async (err: unknown) => {
        log.warn('outbox delivery threw', err)
        await this.#failItem(item, errorText(err)).catch(() => undefined)
      })
      .finally(() => {
        this.#inFlight.delete(item.id)
        this.#laneActive[lane] -= 1
        this.#emitSyncState()
        if (this.#running) void this.#launchDue()
      })
    this.#inFlight.set(item.id, run)
  }

  async #process(item: OutboxItem): Promise<void> {
    // A signalling frame or receipt that survived a restart refers to a
    // session or a screen that no longer exists.
    if (item.ephemeral && Date.now() - item.createdAt > EPHEMERAL_MAX_AGE_MS) {
      await this.#repo.dequeue(item.id)
      return
    }
    await this.#deliver(item)
  }

  /**
   * Publish one queued item and call it sent at quorum.
   *
   * The message is marked sent the moment enough relays have acknowledged it,
   * not when the slowest of up to ten finally answers or times out — measured
   * live, that was the difference between a quarter of a second and ten. The
   * remaining relays keep going in the background and the final count lands on
   * the message when they finish.
   */
  async #deliver(item: OutboxItem): Promise<void> {
    if (!this.#secretKey) return
    if (item.mls) {
      // Encrypted to the group at the moment of sending, never before.
      let runtime: MlsRuntime
      try {
        runtime = await this.#loadMls()
      } catch (err) {
        await this.#failItem(item, errorText(err))
        return
      }
      await runtime.chat.deliver(item)
      return
    }
    const rumor = JSON.parse(item.rumorJson) as Rumor
    const isChat = rumor.kind === KIND_CHAT
    // A reaction or a vote is copied to our own inbox for the same reason a
    // message is: a second device, or a restored vault, should show it.
    const selfCopy = isChat || rumor.kind === KIND_REACTION || item.id.startsWith(INTERACTIVE_PREFIX)
    const expirationSec = Math.max(1, this.#settings.messageExpirationDays) * 24 * 60 * 60
    const recipients = item.recipients?.length ? item.recipients : [item.peerPubkey]

    if (isChat) await this.#markSending(item.id, recipients)

    // One wrap per recipient, each to that person's own inbox relays, ranked
    // as of now rather than as of when the item was queued — so a retry does
    // not keep leading with a relay that has failed in the meantime. All are
    // dispatched before any is awaited: eight members cost one round trip,
    // not eight.
    const dispatched: { pubkey: string; handle: ReturnType<IRelayPool['dispatch']> }[] = []
    for (const pubkey of recipients) {
      const relays = await this.#relaysFor(pubkey)
      dispatched.push({
        pubkey,
        handle: this.pool.dispatch(giftWrap(rumor, this.#secretKey, pubkey, { expirationSec }), relays),
      })
    }

    // The self-addressed copy is what lets a restored vault, or a second
    // device, reconstruct the sent side of a conversation — so it goes to our
    // own inbox relays, where those will look, and only for content. Control
    // frames were copied too once, which doubled every attachment upload for
    // copies the receiving side discards unread.
    if (selfCopy) {
      void this.pool.publish(
        giftWrap(rumor, this.#secretKey, this.#pubkey, { expirationSec }),
        this.#selfCopyRelays(),
      )
    }

    const reached: { pubkey: string; acked: number; handle: (typeof dispatched)[number]['handle'] }[] = []
    const missed: string[] = []
    let firstError: string | null = null
    const early = await Promise.all(dispatched.map(({ handle }) => handle.quorum))
    early.forEach((outcomes, index) => {
      const { pubkey, handle } = dispatched[index] as (typeof dispatched)[number]
      const acked = outcomes.filter((outcome) => outcome.ok).length
      if (acked > 0) {
        reached.push({ pubkey, acked, handle })
        return
      }
      missed.push(pubkey)
      const failure = outcomes.find((outcome) => !outcome.ok)
      firstError ??= failure && !failure.ok ? failure.error : 'no relay accepted the message'
    })

    // Each recipient is judged on their own quorum. Whoever's copy reached
    // the relays keeps it; only the rest are retried, so nobody in a group
    // receives a message twice because somebody else's relays were down.
    if (isChat && reached.length > 0) await this.#recordSent(item.id, reached, missed.length === 0)
    if (missed.length > 0) {
      await this.#failItem({ ...item, recipients: missed }, firstError ?? 'no relay accepted the message')
      return
    }
    await this.#repo.dequeue(item.id)
  }

  async #markSending(id: string, recipients: readonly string[]): Promise<void> {
    const current = await this.#repo.getMessage(id)
    if (current?.receipts) await this.#repo.markRecipients(id, recipients, 'sending')
    else await this.#repo.advanceMessageStatus(id, 'sending')
  }

  /**
   * Record which recipients' copies reached a relay quorum.
   *
   * A direct message is marked sent the moment enough relays have acknowledged
   * it, not when the slowest of up to ten finally answers or times out —
   * measured live, that was the difference between a quarter of a second and
   * ten. The remaining relays keep going in the background and the final count
   * lands on the message when they finish. A group message moves each member's
   * state instead, and its own status follows the least advanced of them.
   */
  async #recordSent(
    id: string,
    reached: readonly { pubkey: string; acked: number; handle: ReturnType<IRelayPool['dispatch']> }[],
    complete: boolean,
  ): Promise<void> {
    const current = await this.#repo.getMessage(id)
    if (current?.receipts) {
      let updated = await this.#repo.markRecipients(
        id,
        reached.map(({ pubkey }) => pubkey),
        'sent',
      )
      if (complete && updated?.error) updated = await this.#repo.updateMessage(id, { error: undefined })
      if (updated) this.events.emit('messageUpdated', updated)
      return
    }

    const first = reached[0]
    if (!first) return
    // Advanced rather than overwritten: over a direct channel, the peer's
    // delivery receipt can arrive before the relays have finished answering.
    await this.#repo.advanceMessageStatus(id, 'sent')
    const updated = await this.#repo.updateMessage(id, { relayAcks: first.acked, error: undefined })
    if (updated) this.events.emit('messageUpdated', updated)

    void first.handle.settled.then(async (outcomes) => {
      const total = outcomes.filter((outcome) => outcome.ok).length
      if (total <= first.acked || !this.#vault.isUnlocked) return
      const final = await this.#repo.updateMessage(id, { relayAcks: total }).catch(() => null)
      if (final) this.events.emit('messageUpdated', final)
    })
  }

  async #failItem(item: OutboxItem, error: string): Promise<void> {
    const attempts = item.attempts + 1
    const exhausted = attempts >= (item.ephemeral ? MAX_EPHEMERAL_ATTEMPTS : MAX_SEND_ATTEMPTS)
    if (exhausted) {
      await this.#repo.dequeue(item.id)
    } else {
      await this.#repo.enqueue({
        ...item,
        attempts,
        nextAttemptAt: Date.now() + backoffDelay(attempts),
        lastError: error,
      })
    }
    if (item.ephemeral || !isUserMessageId(item.id)) return

    const current = await this.#repo.getMessage(item.id)
    if (current?.receipts) {
      // Only the members still owed a copy move; anyone already reached, or
      // who has acknowledged over a direct channel, keeps their state.
      const recipients = item.recipients?.length ? item.recipients : [item.peerPubkey]
      await this.#repo.markRecipients(item.id, recipients, exhausted ? 'failed' : 'queued')
      const updated = await this.#repo.updateMessage(item.id, { error })
      if (updated) this.events.emit('messageUpdated', updated)
      return
    }

    // A message the peer has already acknowledged — over a direct channel —
    // is not queued or failed however the relays are behaving.
    const acknowledged = current?.status === 'delivered' || current?.status === 'read'
    const patch: Partial<Message> = acknowledged
      ? { error }
      : { status: exhausted ? 'failed' : 'queued', error }
    const updated = await this.#repo.updateMessage(item.id, patch)
    if (updated) this.events.emit('messageUpdated', updated)
  }

  /**
   * Manual retry from the UI for a message that exhausted its attempts.
   *
   * The rumor is rebuilt from the stored message with the same tags in the
   * same order, so it has the same id and every recipient deduplicates it
   * against any copy that did get through. In a group only the members whose
   * copy never reached a relay are sent it again.
   */
  async retryMessage(messageId: string): Promise<void> {
    const message = await this.#repo.getMessage(messageId)
    if (!message || message.direction !== 'out' || !this.#secretKey) return
    const conversation = await this.#repo.getConversation(message.convoId)
    if (!conversation) return
    if (conversation.mls) return (await this.#loadMls()).chat.retry(conversation, message)

    const pending = message.receipts
      ? conversation.members.filter((member) => UNSENT.has(message.receipts?.[member]))
      : conversation.members
    if (pending.length === 0) return

    const rumor = createRumor(
      {
        kind: KIND_CHAT,
        content: message.body,
        tags: chatTags(conversation.members, shapeOf(message)),
        created_at: Math.floor(message.ts / 1000),
      },
      this.#secretKey,
    )
    const peer = conversation.kind === 'direct' ? conversation.peerPubkey : null
    await this.#repo.enqueue({
      id: message.id,
      convoId: message.convoId,
      peerPubkey: peer ?? '',
      recipients: pending,
      rumorJson: JSON.stringify(rumor),
      relays: peer ? await this.#relaysFor(peer) : [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })
    if (message.receipts) {
      await this.#repo.markRecipients(message.id, pending, 'queued')
      await this.#repo.updateMessage(message.id, { error: undefined })
    } else {
      await this.#repo.updateMessage(message.id, { status: 'queued', error: undefined })
    }
    await this.flushOutbox()
  }

  /**
   * Where to publish for a given peer: their announced inbox relays first, then
   * ours. Sending only to our own relays and hoping for an overlap is how
   * Nostr DMs used to get lost.
   */
  async #relaysFor(peerPubkey: string): Promise<string[]> {
    const contact = await this.#repo.getContact(peerPubkey)
    const known = contact?.relays?.length ? contact.relays : (this.#learnedRelays.get(peerPubkey) ?? [])
    const mine = this.pool.rankedWriteRelays(6)
    const merged = normalizeRelayList([...known, ...mine], 10)
    return merged.length > 0 ? merged : [...DEFAULT_DM_RELAYS]
  }

  /** Where our own inbox is read: the only place a self-addressed copy is useful. */
  #selfCopyRelays(): string[] {
    const read = this.pool.rankedReadRelays(6)
    return read.length > 0 ? read : this.pool.rankedWriteRelays(6)
  }

  /**
   * Open sockets to a contact's inbox relays before a message needs them.
   *
   * Our own relays are connected from unlock onwards, but a contact's may not
   * be ours, and a handshake measured one to ten seconds on a slow link. Done
   * when a conversation opens — which already publishes a signalling offer to
   * those same relays, so it reveals nothing a message would not.
   */
  async #prewarmPeer(peerPubkey: string): Promise<void> {
    const last = this.#prewarmedAt.get(peerPubkey) ?? 0
    if (Date.now() - last < PREWARM_EVERY_MS) return
    this.#prewarmedAt.set(peerPubkey, Date.now())
    try {
      const contact = await this.#repo.getContact(peerPubkey)
      if (contact?.relays?.length) this.pool.prewarm(contact.relays)
    } catch (err) {
      log.debug('could not pre-warm contact relays', err)
    }
  }

  /**
   * Learn where someone who is not a contact reads their inbox.
   *
   * Group members are often strangers to each other, and a reply sent only to
   * our own relays in the hope of an overlap is how Nostr messages used to go
   * missing. Looked up once per session per person, in the background; asking
   * a relay for someone's kind 10050 reveals no more than adding them as a
   * contact already does.
   */
  async #learnRelays(pubkey: string): Promise<void> {
    if (pubkey === this.#pubkey || this.#learnedRelays.has(pubkey) || this.#learning.has(pubkey)) return
    this.#learning.add(pubkey)
    try {
      if ((await this.#repo.getContact(pubkey))?.relays?.length) return
      const relays = normalizeRelayList(await this.transport.fetchInboxRelays(pubkey), 6)
      if (relays.length > 0) this.#learnedRelays.set(pubkey, relays)
    } catch (err) {
      log.debug("could not learn a member's inbox relays", err)
    } finally {
      this.#learning.delete(pubkey)
    }
  }

  /** Look up and cache a contact's inbox relays. Called when adding a contact. */
  async refreshPeerRelays(peerPubkey: string): Promise<string[]> {
    const relays = await this.transport.fetchInboxRelays(peerPubkey)
    if (relays.length > 0) {
      const contact = await this.#repo.getContact(peerPubkey)
      await this.#repo.upsertContact(peerPubkey, {
        relays: normalizeRelayList([...relays, ...(contact?.relays ?? [])], 8),
      })
    }
    return relays
  }

  /** Introduce ourselves to a new contact so they see a name, not a raw key. */
  async sendProfileTo(peerPubkey: string): Promise<void> {
    const identity = await this.#repo.getIdentity()
    if (!identity) return
    await this.#sendControl(peerPubkey, {
      v: PROTOCOL_VERSION,
      t: 'profile',
      name: identity.name,
      about: identity.about || undefined,
      avatar: identity.avatar,
      relays: this.pool.rankedReadRelays(4),
    })
  }

  // --- calls ----------------------------------------------------------------

  /**
   * Hand a call signal to the calling subsystem — or, for an offer too old to
   * ring, write down the missed call it stands for.
   *
   * Calls ring only for accepted contacts. A message request can wait to be
   * looked at; a ringing phone cannot, and answering one would hand a stranger
   * this device's IP address. Nothing is sent back either way, so a stranger
   * learns nothing — not even that the device is online. (A blocked sender
   * never gets this far: `#ingestRumor` has already dropped them.)
   */
  async #routeCall(peerPubkey: string, frame: CallFrame, rumor: Rumor): Promise<void> {
    if (!(await this.#repo.getContact(peerPubkey))?.accepted) return
    const at = preciseTimestamp(rumor.tags, rumor.created_at)
    const callId = frame.call ?? rumor.id
    if (isOpeningOffer(frame)) {
      // Already rang, or already recorded when an earlier sync replayed it —
      // or recorded and since deleted, which must not ring it back to life.
      if (await this.#repo.hasMessage(callId)) return
      if (await this.#callWithdrawn(peerPubkey, callId)) return
      if (Date.now() - at > CALL_RING_WINDOW_MS) {
        await this.recordCall(peerPubkey, callId, 'in', { media: frame.media, outcome: 'missed' }, at)
        return
      }
    }
    this.events.emit('callSignal', { peerPubkey, frame, callId, at })
  }

  /**
   * Send one call signal and return the id of the rumor that carried it — for
   * an opening offer, the id that names the call from then on.
   *
   * Always over relays, never the direct channel: a channel can look open on a
   * device that has gone, and a call offer swallowed by it would never ring.
   * Queued like any control frame, so a relay that is briefly down is retried
   * — but not for long, because a call signal is worthless a minute later.
   */
  async sendCallSignal(peerPubkey: string, frame: CallFrame): Promise<string> {
    // Through the parser every receiver runs, so this side cannot send a
    // signal the other would drop without a word.
    const echoed = parseControlFrame(encodeControlFrame(frame))
    if (!echoed || echoed.t !== 'rtc' || !isCallFrame(echoed)) throw new Error('malformed call signal')
    const id = await this.#sendControl(peerPubkey, frame, { viaDirect: false })
    if (!id) throw new Error('messenger is not running')
    return id
  }

  /**
   * Write a call into its conversation: a local entry, never sent.
   *
   * Each side records the same call under the same id — the opening offer's —
   * so a replayed offer is recognised as a call already accounted for, and a
   * call someone has deleted stays deleted however its offer comes back. A
   * missed call counts as unread, exactly as a message does: with no push
   * notifications, the conversation list is where someone learns they were
   * called while the app was closed.
   */
  async recordCall(
    peerPubkey: string,
    id: string,
    direction: 'in' | 'out',
    record: CallRecord,
    at = Date.now(),
  ): Promise<void> {
    if (!this.#running || !this.#vault.isUnlocked) return
    if (await this.#repo.hasMessage(id)) return
    if (await this.#callWithdrawn(peerPubkey, id)) return
    const conversation = await this.#repo.ensureConversation(this.#pubkey, peerPubkey)
    const message: Message = {
      id,
      convoId: conversation.id,
      direction,
      status: direction === 'out' ? 'sent' : 'delivered',
      ts: at,
      tsCoarse: 0,
      body: '',
      authorPubkey: direction === 'out' ? this.#pubkey : peerPubkey,
      call: record,
    }
    const unread = record.outcome === 'missed' && !this.#isViewing(conversation.id)
    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, at, unread)
    const updated = (await this.#repo.getConversation(conversation.id)) ?? conversation
    this.events.emit('message', { message, conversation: updated })
    this.events.emit('conversationsChanged', undefined)
  }

  /**
   * Whether a call has been taken out of the conversation — by this device, or
   * by the other person, whose withdrawal may have arrived first.
   *
   * Either name can be on the tombstone: deleting a record here files it under
   * the record's author, which on the caller's side is the caller, and a
   * withdrawal that found nothing to delete files it under whoever sent it.
   */
  async #callWithdrawn(peerPubkey: string, callId: string): Promise<boolean> {
    return (
      (await this.#repo.isWithdrawn(callId, peerPubkey)) ||
      (await this.#repo.isWithdrawn(callId, this.#pubkey))
    )
  }

  /** The servers and policy a call's peer connection is built with. */
  callConfig(): { iceServers: RTCIceServer[]; relayOnly: boolean } {
    return { iceServers: this.#iceServers(), relayOnly: this.#settings.callRelayOnly }
  }

  // --- forward-secret groups -------------------------------------------------

  /**
   * The group runtime, loading it on first use.
   *
   * A lazy chunk (ADR-049): MLS, the ciphersuite and Marmot's formats are
   * fetched only by someone who has a group, keeps an invitation open, or has
   * just been sent one — never on the path to reading a message.
   */
  #loadMls(): Promise<MlsRuntime> {
    if (!this.#mls) {
      const loading = import('../mls/runtime').then(async ({ MlsRuntime }) => {
        const runtime = new MlsRuntime(this.#mlsHost())
        await runtime.start()
        if (!this.#running || this.#mls !== loading) {
          runtime.stop()
          throw new Error('messenger stopped')
        }
        this.#mlsReady = runtime
        return runtime
      })
      // A failed load — offline on first use — is retried next time rather than remembered.
      loading.catch(() => {
        if (this.#mls === loading) this.#mls = null
      })
      this.#mls = loading
    }
    return this.#mls
  }

  /**
   * Load the runtime now if this device has groups to listen to, or a
   * KeyPackage to publish, refresh or withdraw. Otherwise stay out of it.
   */
  async #maybeStartMls(): Promise<void> {
    if ((await this.#repo.countMlsGroups()) > 0) {
      await this.#loadMls()
      return
    }
    const keys = await this.#repo.listMlsKeys<{
      notAfter: number
      publishedAt: number
      replacedAt?: number
    }>()
    const now = Math.floor(Date.now() / 1000)
    const live = keys.find((key) => key.replacedAt === undefined && key.notAfter >= now)
    const due = this.#settings.mlsInvites
      ? !live || live.publishedAt === 0 || live.notAfter - now < MLS_KEY_REFRESH_SEC
      : keys.length > 0
    const cleanup = keys.some(
      (key) => key.notAfter < now || (key.replacedAt ?? now) < now - MLS_KEY_GRACE_SEC,
    )
    // Off the start-up path: nothing is waiting on a KeyPackage.
    if (due || cleanup) setTimeout(() => void this.#loadMls().catch(() => undefined), MLS_IDLE_LOAD_MS)
  }

  #mlsHost(): MlsHost {
    return {
      pubkey: this.#pubkey,
      secretKey: () => this.#secretKey,
      pool: this.pool,
      repo: this.#repo,
      settings: () => this.#settings,
      relaysOf: (pubkey) => this.#relaysFor(pubkey),
      sendRumor: (pubkey, rumor) => this.#queueRumor(pubkey, rumor),
      enqueue: async (item) => {
        await this.#repo.enqueue(item)
        void this.#launchDue()
      },
      failItem: (item, error) => this.#failItem(item, error),
      emit: (name, payload) => this.events.emit(name, payload),
      forget: (message) => this.#forget(message),
      uncount: (message) => this.#uncount(message),
      isViewing: (convoId) => this.#isViewing(convoId),
      threadRoot: (replyTo) => this.#threadRoot(replyTo),
      ingestReaction: (conversation, rumor) =>
        this.#ingestReaction(rumor as Rumor, {
          convoId: conversation.id,
          kind: 'group',
          members: conversation.members,
          peer: null,
          author: rumor.pubkey,
          isSelfCopy: rumor.pubkey === this.#pubkey,
        }),
      standing: async (pubkey) => {
        const contact = await this.#repo.getContact(pubkey)
        if (contact?.blocked) return 'blocked'
        return contact?.accepted ? 'accepted' : 'unknown'
      },
    }
  }

  /** A gift-wrapped rumor to one person — a Welcome — through the ordinary outbox. */
  async #queueRumor(pubkey: string, rumor: Rumor): Promise<void> {
    await this.#repo.enqueue({
      id: `${CONTROL_PREFIX}${rumor.id}`,
      convoId: '',
      peerPubkey: pubkey,
      recipients: [pubkey],
      rumorJson: JSON.stringify(rumor),
      relays: await this.#relaysFor(pubkey),
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })
    void this.#launchDue()
  }

  /** The forward-secret group at `address`, or null for anything else. */
  async #secureGroup(address: ChatAddress): Promise<Conversation | null> {
    if (!isGroupAddress(address)) return null
    const conversation = await this.#repo.getConversation(address)
    return conversation?.mls ? conversation : null
  }

  /** Who of these contacts can be put in a forward-secret group right now. */
  async mlsReadiness(pubkeys: readonly string[]): Promise<Readiness> {
    return (await this.#loadMls()).readiness(pubkeys)
  }

  /**
   * Start a forward-secret group. Nothing is sent until the people who can
   * join have been found; returns the conversation and whoever could not be
   * added yet — they have no KeyPackage published.
   */
  async createSecureGroup(
    members: readonly string[],
    subject = '',
  ): Promise<{ id: string; missing: string[] }> {
    if (!this.#running) throw new Error('messenger is not running')
    const others = [...new Set(members)].filter((pubkey) => pubkey !== this.#pubkey)
    if (others.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) throw new Error('not a public key')
    if (others.length + 1 > MAX_MLS_MEMBERS)
      throw new Error(`a group can have at most ${MAX_MLS_MEMBERS} people`)
    const runtime = await this.#loadMls()
    const created = await runtime.createGroup({
      members: others,
      name: cleanLine(subject, MAX_SUBJECT_CHARS) ?? '',
    })
    for (const member of others) void this.#learnRelays(member)
    this.events.emit('conversationsChanged', undefined)
    return { id: created.convoId, missing: created.missing }
  }

  async addGroupMembers(
    address: ChatAddress,
    pubkeys: readonly string[],
  ): Promise<{ added: string[]; missing: string[] }> {
    const result = await (await this.#loadMls()).addMembers(address, pubkeys)
    this.events.emit('conversationsChanged', undefined)
    return result
  }

  async removeGroupMember(address: ChatAddress, pubkey: string): Promise<void> {
    await (await this.#loadMls()).removeMember(address, pubkey)
    this.events.emit('conversationsChanged', undefined)
  }

  /** Refresh this device's keys in the group now, rather than on the weekly schedule. */
  async rotateGroupKeys(address: ChatAddress): Promise<void> {
    await (await this.#loadMls()).rotate(address)
    this.events.emit('conversationsChanged', undefined)
  }

  /** Leave a forward-secret group. The history stays, read-only; the keys go. */
  async leaveGroup(address: ChatAddress): Promise<void> {
    const conversation = await this.#secureGroup(address)
    if (!conversation || conversation.mls?.left) return
    await (await this.#loadMls()).leave(address)
    this.events.emit('conversationsChanged', undefined)
  }

  // --- maintenance ----------------------------------------------------------

  /** The janitor, off the caller's path: a failure is logged, and the next run tries again. */
  #sweep(): void {
    void this.#runJanitor().catch((err: unknown) => log.warn('janitor failed', err))
  }

  async #runJanitor(): Promise<void> {
    const days: Record<AppSettings['retention'], number> = {
      forever: 0,
      '90d': 90,
      '30d': 30,
      '7d': 7,
      // "session" is enforced by clearing on lock, not by age.
      session: 0,
    }
    this.#janitorAt = Date.now()
    const retention = days[this.#settings.retention]
    if (retention > 0) {
      const removed = await this.#repo.applyRetention(retention)
      if (removed > 0) {
        // What only those messages referred to goes too. Not before: finding
        // out means reading every message, which is only worth it when some
        // have gone.
        const freed = await this.#repo.pruneUnreferencedBlobs()
        log.info(`retention removed ${removed} messages and ${freed} attachment payload(s)`)
      }
    }
    const inbox = this.#inbox
    if (!inbox) return
    const compacted = await this.#repo.compactSeen({ floorSec: inbox.floorSec })
    if (compacted.removed > 0) log.info(`seen table: pruned ${compacted.removed} marks`)
    inbox.setFloor(compacted.floorSec)
  }

  #iceServers(): RTCIceServer[] {
    return [...DEFAULT_ICE_SERVERS, ...this.#settings.iceServers]
  }

  /**
   * The environment says the network may have changed under us: it came back,
   * the device resumed, or the app became visible.
   *
   * Sockets drop stale reconnect timers and prove they are alive. Retries that
   * were backing off because the network was gone are brought forward, since
   * the reason they were waiting may no longer hold. And a catch-up read runs
   * if anything could have been missed.
   */
  wake(reason: WakeReason): void {
    if (!this.#running) return
    this.pool.wake(reason)
    const online = typeof navigator === 'undefined' || navigator.onLine !== false
    if (reason !== 'focus' && online && this.#vault.isUnlocked) {
      void this.#repo
        .expediteOutbox()
        .then(() => this.#launchDue())
        .catch(() => undefined)
    } else {
      void this.#launchDue()
    }
    void this.resync()
    this.#emitSyncState()
  }

  /**
   * The outbox heartbeat, which doubles as a sleep detector.
   *
   * Timers do not run while a device sleeps or a tab is frozen, so a tick that
   * arrives far later than scheduled means the app has just resumed — and that
   * sockets which still look open are quite possibly dead. Only trusted while
   * the page is visible: background tabs have their timers throttled anyway.
   */
  #tick(): void {
    const now = Date.now()
    const gap = now - this.#lastTickAt
    this.#lastTickAt = now
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    if (gap > OUTBOX_TICK_MS * 3 && visible) this.wake('resume')
    else void this.#launchDue()
    this.#inbox?.tick()
    this.#mlsReady?.tick()
    if (now - this.#janitorAt > JANITOR_EVERY_MS && this.#vault.isUnlocked) this.#sweep()
  }

  /**
   * Re-publish the connection state without doing any work.
   *
   * The browser's own online/offline events are the fastest signal that the
   * network has gone; waiting for relay sockets to notice and tear down can
   * take seconds, during which the app claims to be connected while nothing can
   * possibly be sent.
   */
  refreshSyncState(): void {
    this.#emitSyncState()
  }

  #emitSyncState(): void {
    void this.#repo
      // Only messages a person sent. Receipts, signalling and attachment
      // chunks are queue traffic, and "Sending 32 messages" for one photo
      // would be a lie.
      .countOutbox(isUserMessageId)
      .then((pendingOutbox) => {
        this.events.emit('syncState', {
          online: typeof navigator === 'undefined' ? true : navigator.onLine,
          connectedRelays: this.pool.onlineCount,
          totalRelays: this.pool.readRelays.length,
          pendingOutbox,
          lastSyncAt: this.#lastSyncAt * 1000,
          syncing: this.#syncing,
        })
      })
      .catch(() => undefined)
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
