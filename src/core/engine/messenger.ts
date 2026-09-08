import type { Event as NostrEvent } from 'nostr-tools/core'
import type { SubCloser } from 'nostr-tools/pool'
import { hexToBytes, randomBytes, bytesToHex } from '../util/bytes'
import { backoffDelay, DAY, MINUTE, nowSec, SECOND } from '../util/time'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { coalesce } from '../util/mutex'
import { createRumor, giftWrap, unwrapGift, type Rumor } from '../crypto/giftwrap'
import {
  ACCEPTED_RUMOR_KINDS,
  encodeControlFrame,
  KIND_CHAT,
  KIND_CONTROL,
  MAX_MESSAGE_CHARS,
  MAX_RECEIPT_REFS,
  parseControlFrame,
  preciseTimestamp,
  PROTOCOL_VERSION,
  recipientFromTags,
  replyToFromTags,
  timestampTag,
  type ControlFrame,
} from '../models/protocol'
import { attachmentFromTags, attachmentTag } from '../models/protocol'
import { parseAttachment, transportsFor, type Attachment } from '../models/attachment'
import { assembleBlob, openChunk, sealBlob } from '../crypto/blobCrypto'
import { BlobTransfer } from './blobTransfer'
import type { AppSettings, Contact, Conversation, Message, OutboxItem, RelayEntry } from '../models/types'
import type { VaultRepo } from '../vault/repo'
import type { Vault } from '../vault/vault'
import { NostrTransport } from '../transport/nostrTransport'
import { RelayPool, type IRelayPool, type RelayStatus } from '../transport/relayPool'
import { DirectManager, supportsWebRtc } from '../transport/webrtc/directManager'
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
  /** An attachment payload gained or lost ground. */
  blobProgress: { id: string; received: number; total: number; outgoing: boolean }
  /** A payload finished arriving, verified, and is ready to read from storage. */
  blobComplete: { id: string }
  /** The peer withdrew messages they had sent; they are gone from storage. */
  messagesRedacted: { peerPubkey: string; ids: string[] }
  error: { scope: string; message: string }
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
  #subscription: SubCloser | null = null
  #outboxTimer: ReturnType<typeof setInterval> | null = null
  #running = false
  #lastSyncAt = 0
  #syncing = false

  /** Peer pubkey -> timer clearing a stale "typing" indicator. */
  #typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Peer pubkey -> rumor ids awaiting a batched delivery receipt. */
  #pendingReceipts = new Map<string, Set<string>>()
  #receiptTimer: ReturnType<typeof setTimeout> | null = null
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
    // One flush at a time; extra calls collapse into a single re-run.
    this.flushOutbox = coalesce(() => this.#flushOutboxOnce())
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

  // --- lifecycle ------------------------------------------------------------

  async start(secretKeyHex: string, pubkey: string): Promise<void> {
    if (this.#running) return
    this.#secretKey = hexToBytes(secretKeyHex)
    this.#pubkey = pubkey
    this.#running = true

    await this.#loadRelays()
    this.#lastSyncAt = await this.#repo.getSyncCursor()

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

    this.#blobs = new BlobTransfer({
      store: this.#repo,
      isDirect: (peerPubkey) => this.#direct?.isConnected(peerPubkey) === true,
      send: async (peerPubkey, frame) => {
        await this.#sendControl(peerPubkey, frame, { durable: frame.t === 'blob' })
      },
    })
    this.#blobs.events.on('progress', (payload) => this.events.emit('blobProgress', payload))
    this.#blobs.events.on('complete', ({ id }) => this.events.emit('blobComplete', { id }))
    this.#blobs.events.on('failed', ({ id, reason }) =>
      log.warn(`attachment ${id.slice(0, 8)} did not complete: ${reason}`),
    )

    this.#subscribe()
    this.#outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_TICK_MS)

    void this.resync()
    void this.#announceInboxRelays()
    void this.#runJanitor()
  }

  stop(): void {
    this.#running = false
    this.#subscription?.close()
    this.#subscription = null
    if (this.#outboxTimer) clearInterval(this.#outboxTimer)
    this.#outboxTimer = null
    if (this.#receiptTimer) clearTimeout(this.#receiptTimer)
    this.#receiptTimer = null
    for (const timer of this.#typingTimers.values()) clearTimeout(timer)
    this.#typingTimers.clear()
    this.#pendingReceipts.clear()
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
    this.#applyRelayEntries(entries)
    this.#resubscribe()
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
      await this.transport.publishInboxRelays(this.#secretKey, this.pool.readRelays)
    } catch (err) {
      log.warn('failed to announce inbox relays', err)
    }
  }

  // --- inbox subscription ---------------------------------------------------

  #subscribe(): void {
    if (!this.#running || !this.#pubkey) return
    this.#subscription?.close()
    this.#subscription = this.transport.subscribeInbox(this.#pubkey, this.#lastSyncAt, (wrap) => {
      void this.#ingestWrap(wrap)
    })
  }

  #resubscribe(): void {
    this.#subscribe()
  }

  /** Full catch-up read. Runs on start, on regaining focus, and on reconnect. */
  async resync(): Promise<void> {
    if (!this.#running || !this.#pubkey || this.#syncing) return
    this.#syncing = true
    this.#emitSyncState()
    try {
      const wraps = await this.transport.fetchInbox(this.#pubkey, this.#lastSyncAt)
      log.info(`resync fetched ${wraps.length} wraps`)
      for (const wrap of wraps) await this.#ingestWrap(wrap)
      this.#lastSyncAt = nowSec()
      await this.#repo.setSyncCursor(this.#lastSyncAt)
      await this.flushOutbox()
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
    if (!this.#secretKey || !this.#vault.isUnlocked) return
    try {
      if (await this.#repo.hasSeen(wrap.id)) return
      await this.#repo.markSeen([wrap.id])
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
    if (!ACCEPTED_RUMOR_KINDS.has(rumor.kind)) return

    const isSelfCopy = authorPubkey === this.#pubkey
    // A self-addressed copy names the real counterparty in its `p` tag; an
    // inbound message names us there.
    const tagged = recipientFromTags(rumor.tags)
    const peerPubkey = isSelfCopy ? tagged : authorPubkey
    if (!peerPubkey || peerPubkey === this.#pubkey) return
    if (!isSelfCopy && tagged && tagged !== this.#pubkey) {
      // Delivered to us but addressed to someone else — a relay or peer error.
      return
    }

    const contact = await this.#repo.getContact(peerPubkey)
    if (contact?.blocked) return

    if (rumor.kind === KIND_CHAT) {
      await this.#ingestChat(rumor, peerPubkey, isSelfCopy, via)
      return
    }
    if (rumor.kind === KIND_CONTROL) {
      if (isSelfCopy) return
      const frame = parseControlFrame(rumor.content)
      if (frame) await this.#handleControl(peerPubkey, frame)
    }
  }

  async #ingestChat(
    rumor: Rumor,
    peerPubkey: string,
    isSelfCopy: boolean,
    via: 'relay' | 'direct',
  ): Promise<void> {
    if (rumor.content.length > MAX_MESSAGE_CHARS) return
    // A descriptor that fails validation drops the payload, not the message:
    // the text still arrives and the bubble simply has nothing to play.
    const attachment = parseAttachment(attachmentFromTags(rumor.tags))
    // An empty rumor is noise — unless it carries an attachment, in which case
    // the payload *is* the message. This guard predated attachments and
    // silently discarded every uncaptioned photo and file on arrival.
    if (rumor.content.length === 0 && !attachment) return
    if (await this.#repo.hasMessage(rumor.id)) return

    const conversation = await this.#repo.ensureConversation(this.#pubkey, peerPubkey)
    await this.#ensureContactFor(peerPubkey, isSelfCopy)

    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: isSelfCopy ? 'out' : 'in',
      // A self-copy is a message we sent from another device: it is already
      // delivered as far as this device is concerned.
      status: isSelfCopy ? 'sent' : 'delivered',
      ts: preciseTimestamp(rumor.tags, rumor.created_at),
      tsCoarse: 0,
      body: rumor.content,
      authorPubkey: rumor.pubkey,
      replyTo: replyToFromTags(rumor.tags) ?? undefined,
      via,
    }

    if (attachment) message.attachment = attachment

    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, message.ts, !isSelfCopy)

    const updated = (await this.#repo.getConversation(conversation.id)) ?? conversation
    this.events.emit('message', { message, conversation: updated })
    this.events.emit('conversationsChanged', undefined)

    if (!isSelfCopy) this.#queueReceipt(peerPubkey, rumor.id)

    // Register interest even for a self-copy: this device wants the payload it
    // sent from another one just as much as a received one.
    if (attachment) void this.#blobs?.expect(peerPubkey, attachment)
  }

  async #handleControl(peerPubkey: string, frame: ControlFrame): Promise<void> {
    switch (frame.t) {
      case 'receipt': {
        for (const ref of frame.refs) {
          const updated = await this.#repo.advanceMessageStatus(ref, frame.state)
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
        await this.#direct?.handleSignal(peerPubkey, frame)
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
        await this.#blobs?.serve(peerPubkey, frame.id, frame.need)
        return

      case 'redact': {
        // Honoured only for messages this peer actually wrote. Without that
        // check, anyone who can reach your inbox could delete your own words
        // out of your own conversation.
        let removed = 0
        for (const id of frame.refs) {
          const message = await this.#repo.getMessage(id)
          if (!message || message.authorPubkey !== peerPubkey) continue
          await this.#repo.deleteMessageAndPayload(id)
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
   * A read receipt for message N implies everything the peer received before N
   * has been read too. Marking them individually would need one receipt per
   * message.
   */
  async #markEarlierRead(peerPubkey: string, refs: string[]): Promise<void> {
    const convoId = this.#repo.conversationId(this.#pubkey, peerPubkey)
    let newest = 0
    for (const ref of refs) {
      const message = await this.#repo.getMessage(ref)
      if (message) newest = Math.max(newest, message.ts)
    }
    if (newest === 0) return
    const stale = (await this.#repo.listMessages(convoId, 500))
      .filter((message) => message.direction === 'out' && message.ts <= newest && message.status !== 'read')
      .map((message) => message.id)
    for (const updated of await this.#repo.advanceMessageStatuses(stale, 'read')) {
      this.events.emit('messageUpdated', updated)
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

  async sendMessage(peerPubkey: string, text: string, replyTo?: string): Promise<Message> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    const body = text.trim()
    if (!body) throw new Error('message is empty')
    if (body.length > MAX_MESSAGE_CHARS) throw new Error('message is too long')

    const sentAt = Date.now()
    const tags: string[][] = [['p', peerPubkey], timestampTag(sentAt)]
    if (replyTo) tags.push(['e', replyTo, '', 'reply'])

    const rumor = createRumor(
      { kind: KIND_CHAT, content: body, tags, created_at: Math.floor(sentAt / 1000) },
      this.#secretKey,
    )
    const conversation = await this.#repo.ensureConversation(this.#pubkey, peerPubkey)

    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: 'out',
      status: 'queued',
      ts: sentAt,
      tsCoarse: 0,
      body,
      authorPubkey: this.#pubkey,
      replyTo,
      via: 'relay',
    }
    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, message.ts, false)

    await this.#repo.enqueue({
      id: rumor.id,
      convoId: conversation.id,
      peerPubkey,
      rumorJson: JSON.stringify(rumor),
      relays: await this.#relaysFor(peerPubkey),
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })

    this.events.emit('message', { message, conversation })
    this.events.emit('conversationsChanged', undefined)

    // Fire the direct path immediately for latency; the relay publish below
    // still happens, and the peer dedups by rumor id.
    if (this.#direct?.send(peerPubkey, rumor)) {
      const updated = await this.#repo.updateMessage(rumor.id, { via: 'direct' })
      if (updated) this.events.emit('messageUpdated', updated)
    } else {
      void this.#direct?.dial(peerPubkey)
    }

    void this.flushOutbox()
    return message
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
   */
  async sendAttachment(
    peerPubkey: string,
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
    },
    replyTo?: string,
  ): Promise<Message> {
    if (!this.#secretKey) throw new Error('messenger is not running')
    if (!this.#blobs) throw new Error('attachment transport is not running')

    const reach = transportsFor(input.bytes.length)
    if (!reach.direct) throw new Error('attachment is too large to send')
    if (!reach.relay && !this.#direct?.isConnected(peerPubkey)) {
      // Refuse rather than queue: without a direct channel this payload has no
      // route, and a message that can never complete is worse than a clear no.
      throw new Error('attachment needs a direct connection')
    }

    const { envelope, chunk } = sealBlob(input.bytes)
    // Persisted before anything references it: the sender's own bubble reads
    // the payload back out of storage as soon as the message renders.
    await this.#blobs.store(envelope, chunk)
    const attachment: Attachment = {
      ...envelope,
      kind: input.kind,
      mime: input.mime,
      ...(input.name ? { name: input.name } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.waveform ? { waveform: input.waveform } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.preview ? { preview: input.preview } : {}),
    }

    const sentAt = Date.now()
    const tags: string[][] = [['p', peerPubkey], timestampTag(sentAt), attachmentTag(attachment)]
    if (replyTo) tags.push(['e', replyTo, '', 'reply'])

    const rumor = createRumor(
      { kind: KIND_CHAT, content: input.caption, tags, created_at: Math.floor(sentAt / 1000) },
      this.#secretKey,
    )
    const conversation = await this.#repo.ensureConversation(this.#pubkey, peerPubkey)

    const message: Message = {
      id: rumor.id,
      convoId: conversation.id,
      direction: 'out',
      status: 'queued',
      ts: sentAt,
      tsCoarse: 0,
      body: input.caption,
      authorPubkey: this.#pubkey,
      attachment,
      replyTo,
      via: 'relay',
    }
    await this.#repo.putMessage(message)
    await this.#repo.bumpConversation(conversation.id, message.ts, false)

    await this.#repo.enqueue({
      id: rumor.id,
      convoId: conversation.id,
      peerPubkey,
      rumorJson: JSON.stringify(rumor),
      relays: await this.#relaysFor(peerPubkey),
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })

    this.events.emit('message', { message, conversation })
    this.events.emit('conversationsChanged', undefined)

    if (this.#direct?.send(peerPubkey, rumor)) {
      const updated = await this.#repo.updateMessage(rumor.id, { via: 'direct' })
      if (updated) this.events.emit('messageUpdated', updated)
    } else {
      void this.#direct?.dial(peerPubkey)
    }

    void this.flushOutbox()
    // The payload follows the message on the wire, never precedes it: a chunk
    // that reaches the peer before its descriptor has no key and is dropped.
    void this.#blobs.push(peerPubkey, envelope.id, envelope.chunks)
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
  async #resumeAttachments(peerPubkey: string): Promise<void> {
    if (!this.#blobs) return
    try {
      const convoId = this.#repo.conversationId(this.#pubkey, peerPubkey)
      for (const message of await this.#repo.listMessages(convoId, 100)) {
        if (!message.attachment || message.direction !== 'in') continue
        await this.#blobs.resume(peerPubkey, message.attachment)
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
   * Only our own messages: asking someone to delete something they wrote is not
   * ours to ask, and their client refuses it anyway. The request is queued
   * durably, so a peer who is offline honours it when they next connect rather
   * than keeping the message forever because they happened to miss one event.
   *
   * This is a tombstone, not an erasure. A modified client can ignore it and a
   * relay may still hold the wrap; the UI says so rather than promising more.
   */
  async redactMessage(peerPubkey: string, messageId: string): Promise<void> {
    const message = await this.#repo.getMessage(messageId)
    if (!message) return
    if (message.authorPubkey !== this.#pubkey) {
      throw new Error('cannot unsend a message you did not write')
    }

    await this.#repo.deleteMessageAndPayload(messageId)
    this.events.emit('conversationsChanged', undefined)

    await this.#sendControl(
      peerPubkey,
      { v: PROTOCOL_VERSION, t: 'redact', refs: [messageId] },
      { durable: true },
    )
  }

  async readAttachment(attachment: Attachment): Promise<Uint8Array | null> {
    const chunks = await this.#repo.getBlobChunks(attachment.id, attachment.chunks)
    if (!chunks) return null
    return assembleBlob(
      attachment,
      chunks.map((chunk, seq) => openChunk(attachment, seq, chunk)),
    )
  }

  /** Open a conversation: probe for a direct channel and clear the unread badge. */
  async openConversation(peerPubkey: string): Promise<void> {
    void this.#direct?.dial(peerPubkey)
    // Pick up any attachment left half-transferred by an earlier session. The
    // chunks are on disk, but nothing is watching for the missing ones until
    // something re-registers interest.
    void this.#resumeAttachments(peerPubkey)
    const convoId = this.#repo.conversationId(this.#pubkey, peerPubkey)
    await this.#repo.markConversationRead(convoId)
    this.events.emit('conversationsChanged', undefined)
    if (this.#settings.sendReadReceipts) await this.#sendReadReceipt(peerPubkey, convoId)
  }

  async #sendReadReceipt(peerPubkey: string, convoId: string): Promise<void> {
    const messages = await this.#repo.listMessages(convoId, 50)
    const newestIncoming = [...messages].reverse().find((message) => message.direction === 'in')
    if (!newestIncoming) return
    await this.#sendControl(peerPubkey, {
      v: PROTOCOL_VERSION,
      t: 'receipt',
      refs: [newestIncoming.id],
      state: 'read',
    })
  }

  setTyping(peerPubkey: string, active: boolean): void {
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
    if (this.#receiptTimer) return
    this.#receiptTimer = setTimeout(() => {
      this.#receiptTimer = null
      void this.#flushReceipts()
    }, RECEIPT_DEBOUNCE_MS)
  }

  async #flushReceipts(): Promise<void> {
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
    peerPubkey: string,
    frame: ControlFrame,
    opts: { directOnly?: boolean; viaDirect?: boolean; durable?: boolean } = {},
  ): Promise<void> {
    if (!this.#secretKey || !this.#running) return
    const rumor = createRumor(
      { kind: KIND_CONTROL, content: encodeControlFrame(frame), tags: [['p', peerPubkey]] },
      this.#secretKey,
    )

    if (opts.viaDirect !== false && this.#direct?.send(peerPubkey, rumor)) return
    if (opts.directOnly) return

    await this.#repo.enqueue({
      id: `ctl-${rumor.id}-${bytesToHex(randomBytes(4))}`,
      convoId: this.#repo.conversationId(this.#pubkey, peerPubkey),
      peerPubkey,
      rumorJson: JSON.stringify(rumor),
      relays: await this.#relaysFor(peerPubkey),
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      // Typing indicators and presence beacons are worthless once stale, so
      // they expire fast. Attachment chunks are the payload of a real message:
      // expiring them after two minutes and three attempts is how a photo sent
      // to someone who is briefly offline can never arrive.
      ephemeral: !opts.durable,
    })
    void this.flushOutbox()
  }

  /**
   * Hand any already-queued chat messages for this peer to a freshly-opened
   * direct channel. Nothing is dequeued: durability still comes from the relay
   * publish, and the self-addressed copy still has to be written.
   */
  async #pushQueuedOverDirect(peerPubkey: string): Promise<void> {
    if (!this.#direct?.isConnected(peerPubkey) || !this.#vault.isUnlocked) return
    try {
      const pending = await this.#repo.dueOutbox(Date.now() + OUTBOX_TICK_MS, 64)
      for (const item of pending) {
        if (item.ephemeral || item.peerPubkey !== peerPubkey) continue
        const rumor = JSON.parse(item.rumorJson) as Rumor
        if (this.#direct.send(peerPubkey, rumor)) {
          const updated = await this.#repo.updateMessage(item.id, { via: 'direct' })
          if (updated) this.events.emit('messageUpdated', updated)
        }
      }
    } catch (err) {
      log.warn('failed to flush queued messages over the direct channel', err)
    }
  }

  // --- outbox ---------------------------------------------------------------

  async #flushOutboxOnce(): Promise<void> {
    if (!this.#running || !this.#secretKey || !this.#vault.isUnlocked) return
    const due = await this.#repo.dueOutbox()
    if (due.length === 0) return

    for (const item of due) {
      // A signalling frame or receipt that survived a restart refers to a
      // session or a screen that no longer exists.
      if (item.ephemeral && Date.now() - item.createdAt > EPHEMERAL_MAX_AGE_MS) {
        await this.#repo.dequeue(item.id)
        continue
      }
      try {
        await this.#deliver(item)
      } catch (err) {
        log.warn('outbox delivery threw', err)
        await this.#failItem(item, errorText(err))
      }
    }
    this.#emitSyncState()
  }

  async #deliver(item: OutboxItem): Promise<void> {
    if (!this.#secretKey) return
    const rumor = JSON.parse(item.rumorJson) as Rumor
    const expirationSec = Math.max(1, this.#settings.messageExpirationDays) * 24 * 60 * 60

    const relays = item.relays.length > 0 ? item.relays : this.pool.rankedWriteRelays()
    if (relays.length === 0) {
      await this.#failItem(item, 'no write relays configured')
      return
    }

    if (!item.ephemeral) {
      await this.#repo.advanceMessageStatus(item.id, 'sending')
    }

    const wraps: NostrEvent[] = [giftWrap(rumor, this.#secretKey, item.peerPubkey, { expirationSec })]
    // The self-addressed copy is what lets a restored vault, or a second
    // device, reconstruct the sent side of a conversation. Only chat messages
    // are worth the extra publish.
    if (!item.ephemeral) {
      wraps.push(giftWrap(rumor, this.#secretKey, this.#pubkey, { expirationSec }))
    }

    const results = await Promise.all(wraps.map((wrap) => this.transport.publishWrap(wrap, relays)))
    const peerAcks = (results[0] ?? []).filter((outcome) => outcome.ok).length

    if (peerAcks === 0) {
      const firstError = (results[0] ?? []).find((outcome) => !outcome.ok)
      await this.#failItem(
        item,
        firstError && !firstError.ok ? firstError.error : 'no relay accepted the message',
      )
      return
    }

    await this.#repo.dequeue(item.id)
    if (!item.ephemeral) {
      const updated = await this.#repo.updateMessage(item.id, { status: 'sent', relayAcks: peerAcks })
      if (updated) this.events.emit('messageUpdated', updated)
    }
  }

  async #failItem(item: OutboxItem, error: string): Promise<void> {
    const attempts = item.attempts + 1
    if (attempts >= (item.ephemeral ? MAX_EPHEMERAL_ATTEMPTS : MAX_SEND_ATTEMPTS)) {
      await this.#repo.dequeue(item.id)
      if (!item.ephemeral) {
        const updated = await this.#repo.updateMessage(item.id, { status: 'failed', error })
        if (updated) this.events.emit('messageUpdated', updated)
      }
      return
    }
    await this.#repo.enqueue({
      ...item,
      attempts,
      nextAttemptAt: Date.now() + backoffDelay(attempts),
      lastError: error,
    })
    if (!item.ephemeral) {
      const updated = await this.#repo.updateMessage(item.id, { status: 'queued', error })
      if (updated) this.events.emit('messageUpdated', updated)
    }
  }

  /** Manual retry from the UI for a message that exhausted its attempts. */
  async retryMessage(messageId: string): Promise<void> {
    const message = await this.#repo.getMessage(messageId)
    if (!message || message.direction !== 'out' || !this.#secretKey) return
    const conversation = await this.#repo.getConversation(message.convoId)
    if (!conversation) return

    const tags: string[][] = [['p', conversation.peerPubkey], timestampTag(message.ts)]
    if (message.replyTo) tags.push(['e', message.replyTo, '', 'reply'])
    // Rebuilding from the stored body reproduces the same id only if the
    // timestamp matches, so carry the original timestamp through.
    const rumor = {
      ...createRumor(
        { kind: KIND_CHAT, content: message.body, tags, created_at: Math.floor(message.ts / 1000) },
        this.#secretKey,
      ),
    }
    await this.#repo.enqueue({
      id: message.id,
      convoId: message.convoId,
      peerPubkey: conversation.peerPubkey,
      rumorJson: JSON.stringify(rumor),
      relays: await this.#relaysFor(conversation.peerPubkey),
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      ephemeral: false,
    })
    await this.#repo.updateMessage(message.id, { status: 'queued', error: undefined })
    await this.flushOutbox()
  }

  /**
   * Where to publish for a given peer: their announced inbox relays first, then
   * ours. Sending only to our own relays and hoping for an overlap is how
   * Nostr DMs used to get lost.
   */
  async #relaysFor(peerPubkey: string): Promise<string[]> {
    const contact = await this.#repo.getContact(peerPubkey)
    const known = contact?.relays ?? []
    const mine = this.pool.rankedWriteRelays(6)
    const merged = normalizeRelayList([...known, ...mine], 10)
    return merged.length > 0 ? merged : [...DEFAULT_DM_RELAYS]
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
      relays: this.pool.readRelays.slice(0, 4),
    })
  }

  // --- maintenance ----------------------------------------------------------

  async #runJanitor(): Promise<void> {
    const days: Record<AppSettings['retention'], number> = {
      forever: 0,
      '90d': 90,
      '30d': 30,
      '7d': 7,
      // "session" is enforced by clearing on lock, not by age.
      session: 0,
    }
    const retention = days[this.#settings.retention]
    if (retention > 0) {
      const removed = await this.#repo.applyRetention(retention)
      if (removed > 0) log.info(`retention removed ${removed} messages`)
    }
    await this.#repo.pruneSeen(45 * DAY)
  }

  #iceServers(): RTCIceServer[] {
    return [...DEFAULT_ICE_SERVERS, ...this.#settings.iceServers]
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
      .countOutbox()
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
