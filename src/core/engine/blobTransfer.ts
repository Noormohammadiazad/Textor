import type { Event as NostrEvent } from 'nostr-tools/core'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { b64ToBytes, bytesToB64 } from '../util/bytes'
import { PROTOCOL_VERSION, type BlobChunkFrame, type ControlFrame } from '../models/protocol'
import { emptyHealth, MESSAGE_EXPIRY_DAYS } from '../models/types'
import type { IRelayPool, SubCloser } from '../transport/relayPool'
import { refusesLarge } from '../transport/relayScore'
import {
  assembleBlob,
  blobRef,
  blobRefKey,
  chunkOpens,
  openChunk,
  type BlobEnvelope,
  type BlobRef,
} from '../crypto/blobCrypto'
import type { Attachment } from '../models/attachment'
import { KIND_GIFT_WRAP } from '../crypto/giftwrap'
import { chunkEvent, chunkRetractions, dropAddress, readChunkEvent } from './blobDrop'

const log = createLogger('blob')

/**
 * How many chunks are in flight at once on the relay path.
 *
 * Each chunk is a separate gift-wrapped event: a signature, a wrap, and a
 * publish to every write relay. Firing thirty at once is how a client gets
 * rate-limited or disconnected, and the receiver cannot use them any faster
 * than they arrive anyway.
 */
const RELAY_WINDOW = 3

/** The direct channel is ours alone, so it is paced only by the send buffer. */
const DIRECT_WINDOW = 12

/**
 * How long a receiver waits for quiet before asking for what is missing.
 *
 * Long enough that a slow-but-progressing transfer is never interrupted by a
 * redundant request, short enough that a genuinely dropped chunk does not
 * strand a payload for minutes.
 */
const STALL_MS = 8_000

/** Give up asking after this many rounds; the payload stays resumable by hand. */
const MAX_REQUEST_ROUNDS = 6

/**
 * Asking the sender for a payload at its own address, after every relay has been
 * tried. Fewer: each request may cost them an upload, and opening a conversation
 * can find many that have expired.
 */
const MAX_DROP_ROUNDS = 2

/** A relay that said it has nothing is left this soon, in case it is on its way. */
const EMPTY_RELAY_MS = 2_000

/** Payloads read from relays at once. Each is about a megabyte, from one relay at a time. */
const MAX_READING = 2

/** A copy is uploaded again for someone who asks at most this often. */
const SERVE_SPACING_MS = 60_000

/**
 * Ciphertext held for chunks that arrive before the message describing them.
 *
 * This is the common case, not an edge case: the sender publishes the message
 * and starts pushing chunks in the same breath, and relays deliver in whatever
 * order they like. Dropping those chunks — which an earlier version did — threw
 * away most of a payload and left the transfer to be rebuilt entirely by resend
 * requests, which is slow when it works and silent when it does not.
 *
 * They cannot be verified yet: the key lives in the descriptor that has not
 * arrived. So they are held in memory, never written to disk, and the total is
 * capped so a peer cannot spend our memory by sending chunks for a message they
 * never send.
 */
const MAX_ORPHAN_BYTES = 4 * 1024 * 1024

export interface BlobProgress {
  id: string
  /** Which sealed copy (ADR-052): two transfers of one file are two transfers. */
  copy: string
  received: number
  total: number
  /** True for a payload we are sending. */
  outgoing: boolean
}

export type BlobTransferEvents = {
  progress: BlobProgress
  /** A payload finished arriving and passed its integrity check. */
  complete: { id: string; copy: string; bytes: Uint8Array }
  failed: { id: string; copy: string; reason: string }
}

/**
 * What the transfer engine needs from storage, narrowed to keep it testable.
 * Everything is by copy, not by payload: see `BlobRef`.
 */
export interface BlobStore {
  getBlobManifest(ref: BlobRef): Promise<{ total: number; size: number } | undefined>
  putBlobChunk(
    ref: BlobRef,
    seq: number,
    data: Uint8Array,
    meta: { total: number; size: number; outgoing?: boolean },
  ): Promise<{ received: number; total: number; complete: number }>
  missingChunks(ref: BlobRef, total: number): Promise<number[]>
  getBlobChunk(ref: BlobRef, seq: number): Promise<Uint8Array | null>
  getBlobChunks(ref: BlobRef, total: number): Promise<Uint8Array[] | null>
  /** Every copy held of a payload, for a request that does not name one. */
  copiesOf(blobId: string): Promise<BlobRef[]>
  /** The address a copy's chunks wait at, once it has been put on relays (ADR-075). */
  setBlobAddress(ref: BlobRef, address: string): Promise<void>
  getBlobAddress(ref: BlobRef): Promise<string | null>
}

/** Payloads on the relays at their own address (ADR-075). */
export interface DropDeps {
  senderSk: Uint8Array
  pool: Pick<IRelayPool, 'subscribe' | 'rankedReadRelays' | 'rankedWriteRelays' | 'statuses'>
  /** Where to reach this person: where they read first, if that is known. */
  relaysFor(person: string): Promise<string[]>
  /** Whether what this person says may send us to a relay they chose. */
  trusted(person: string): Promise<boolean>
  /** Queue signed events for these relays. */
  queue(events: NostrEvent[], relays: string[]): Promise<void>
  /** How long relays are asked to keep what is uploaded now. */
  ttlSec(): number
}

export interface BlobTransferDeps {
  store: BlobStore
  /** Deliver one control frame to a peer. Resolves when it has been handed off. */
  send(peerPubkey: string, frame: ControlFrame): Promise<void>
  /** Whether a direct channel to this peer is open right now. */
  isDirect(peerPubkey: string): boolean
  drop?: DropDeps
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface Orphan {
  chunks: Map<number, Uint8Array>
  bytes: number
}

interface Inbound {
  attachment: Attachment
  ref: BlobRef
  peerPubkey: string
  timer: ReturnType<typeof setTimeout> | null
  rounds: number
  lastCount: number
  /** Reading it from relays: the order to try them, how far along, and the one open now. */
  relays: string[]
  relayAt: number
  sub: SubCloser | null
  heard: boolean
}

/**
 * Moves attachment payloads between two peers.
 *
 * Deliberately transport-agnostic: it hands frames to `send` and lets the
 * messenger decide whether they travel over the direct channel or as
 * gift-wrapped events. The only thing it changes based on the answer is how
 * many chunks it keeps in flight.
 *
 * The receiver drives completion. A sender pushes the payload once and then
 * stops caring; if anything is lost the receiver asks for exactly the missing
 * indexes. That is what makes a transfer resumable across a reload, a lock, or
 * a week offline — the state lives in the database, not in this object.
 */
export class BlobTransfer {
  readonly events = new Emitter<BlobTransferEvents>()

  readonly #deps: BlobTransferDeps
  /** Transfers under way, by copy (`blobRefKey`). */
  readonly #inbound = new Map<string, Inbound>()
  /**
   * Chunks waiting for the message that explains them. Memory only. Held by
   * `id:copy`, or `id:` for a chunk from a client that does not name its copy.
   */
  readonly #orphans = new Map<string, Orphan>()
  #orphanBytes = 0
  /** Copies being read from relays, and those waiting their turn. */
  readonly #reading = new Set<string>()
  #waiting: string[] = []
  readonly #servedAt = new Map<string, number>()
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(deps: BlobTransferDeps) {
    this.#deps = deps
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** Drop all timers. Called when the vault locks or the messenger stops. */
  stop(): void {
    for (const entry of this.#inbound.values()) {
      if (entry.timer) this.#clearTimer(entry.timer)
      entry.sub?.close()
    }
    this.#inbound.clear()
    this.#reading.clear()
    this.#waiting = []
    this.#orphans.clear()
    this.#orphanBytes = 0
  }

  // --- sending --------------------------------------------------------------

  /**
   * Persist an outgoing payload.
   *
   * Must complete before the message describing it is emitted: the sender's own
   * bubble reads the payload straight back out of this store, and a message
   * that arrives first would render as a permanently broken attachment. It is
   * also what lets a resend request be served after a reload, since the
   * sender's copy and the receiver's live in the same table.
   */
  async store(envelope: BlobEnvelope, chunkAt: (index: number) => Uint8Array): Promise<void> {
    const ref = blobRef(envelope)
    for (let seq = 0; seq < envelope.chunks; seq++) {
      await this.#deps.store.putBlobChunk(ref, seq, chunkAt(seq), {
        total: envelope.chunks,
        size: envelope.size,
        outgoing: true,
      })
    }
  }

  /** Send the listed chunks (or all of them) of one copy to a peer, paced by transport. */
  async push(peerPubkey: string, ref: BlobRef, total: number, only?: readonly number[]): Promise<void> {
    const indexes = only && only.length > 0 ? [...only] : Array.from({ length: total }, (_, i) => i)
    const window = this.#deps.isDirect(peerPubkey) ? DIRECT_WINDOW : RELAY_WINDOW

    for (let i = 0; i < indexes.length; i += window) {
      const batch = indexes.slice(i, i + window)
      await Promise.all(
        batch.map(async (seq) => {
          const data = await this.#deps.store.getBlobChunk(ref, seq)
          if (!data) {
            log.warn(`chunk ${seq} of ${ref.id.slice(0, 8)} is gone; cannot serve`)
            return
          }
          const frame: BlobChunkFrame = {
            v: PROTOCOL_VERSION,
            t: 'blob',
            id: ref.id,
            copy: ref.copy,
            seq,
            total,
            data: bytesToB64(data),
          }
          await this.#deps.send(peerPubkey, frame).catch((err: unknown) => {
            // One failed chunk is not a failed transfer: the receiver will ask
            // for whatever did not arrive.
            log.warn(`chunk ${seq} failed to send`, err)
          })
        }),
      )
    }
  }

  /**
   * Serve a peer's resend request.
   *
   * The total comes from our own manifest, never from the request. Inferring it
   * from the highest missing index — which an earlier version did — is wrong
   * whenever the tail chunk is not among the missing ones, and it is wrong in a
   * way that cannot be recovered from: `total` is bound into each chunk's AAD
   * and re-checked by the receiver, so every resent chunk fails authentication
   * and the transfer can never complete.
   *
   * A request that names no copy comes from a client that predates ADR-052.
   * Every copy held is offered: the requester keeps only the one its key
   * opens, and it is almost always the only one there is.
   */
  async serve(
    peerPubkey: string,
    blobId: string,
    copy: string | undefined,
    need: readonly number[],
  ): Promise<void> {
    const refs = copy ? [{ id: blobId, copy }] : await this.#deps.store.copiesOf(blobId)
    let held = false
    for (const ref of refs) {
      const manifest = await this.#deps.store.getBlobManifest(ref)
      if (!manifest) continue
      held = true
      const wanted = need.filter((seq) => seq < manifest.total)
      if (wanted.length === 0) continue
      const address = await this.#deps.store.getBlobAddress(ref)
      if (address && this.#deps.drop)
        await this.#uploadAgain(this.#deps.drop, peerPubkey, ref, address, wanted)
      else await this.push(peerPubkey, ref, manifest.total, wanted)
    }
    if (!held) log.warn(`asked to resend ${blobId.slice(0, 8)}, which this device does not hold`)
  }

  // --- on the relays, at its own address (ADR-075) ----------------------------

  /**
   * Which relays a new copy goes on, for these people: the first each reads that
   * takes events this large, then ours, so someone can reach it whichever side
   * of a border a relay is on. Relays are for the descriptor to name, so it is
   * settled before the message is.
   */
  async dropRelays(people: readonly string[]): Promise<string[]> {
    const drop = this.#deps.drop!
    const now = Date.now()
    const health = new Map(drop.pool.statuses().map((status) => [status.url, status.health]))
    const willing = (url: string): boolean => !refusesLarge(health.get(url) ?? emptyHealth(), now)
    const known = await Promise.all(people.map((person) => drop.relaysFor(person)))
    const theirs = known.flatMap((relays) => relays.filter(willing).slice(0, 1))
    const chosen = new Set([...theirs, ...drop.pool.rankedWriteRelays(4).filter(willing)])
    return [...chosen].slice(0, people.length === 1 ? 3 : 4)
  }

  /** Queue a copy for those relays. `at` counts from the message, so it can be worked out again. */
  async upload(envelope: BlobEnvelope, at: number, relays: readonly string[]): Promise<void> {
    const drop = this.#deps.drop!
    const ref = blobRef(envelope)
    const address = dropAddress(envelope)
    await this.#deps.store.setBlobAddress(ref, address)
    const place = { address, copy: ref.copy, senderSk: drop.senderSk, at, ttlSec: drop.ttlSec() }
    const events: NostrEvent[] = []
    for (let seq = 0; seq < envelope.chunks; seq++) {
      const data = await this.#deps.store.getBlobChunk(ref, seq)
      if (data) events.push(chunkEvent(place, seq, data))
    }
    await drop.queue(events, [...relays])
  }

  /**
   * Someone asked for chunks that are no longer where they were: expired, or on
   * relays they cannot reach. They go to where that person reads, counted from now.
   */
  async #uploadAgain(
    drop: DropDeps,
    peerPubkey: string,
    ref: BlobRef,
    address: string,
    wanted: readonly number[],
  ): Promise<void> {
    const key = blobRefKey(ref)
    const now = Date.now()
    if (now - (this.#servedAt.get(key) ?? 0) < SERVE_SPACING_MS) return
    this.#servedAt.set(key, now)
    const place = {
      address,
      copy: ref.copy,
      senderSk: drop.senderSk,
      at: Math.floor(now / 1000),
      ttlSec: drop.ttlSec(),
    }
    const events: NostrEvent[] = []
    for (const seq of wanted) {
      const data = await this.#deps.store.getBlobChunk(ref, seq)
      if (data) events.push(chunkEvent(place, seq, data))
    }
    if (events.length > 0) await drop.queue(events, await this.dropRelays([peerPubkey]))
  }

  /**
   * Ask relays to delete an upload of a copy we hold: nothing if we do not hold
   * it all, since an event's id takes its bytes to work out.
   */
  async retractions(attachment: Attachment, at: number): Promise<NostrEvent[]> {
    const ref = blobRef(attachment)
    const chunks = await this.#deps.store.getBlobChunks(ref, attachment.chunks)
    if (!chunks) return []
    return chunkRetractions(
      { address: dropAddress(attachment), copy: ref.copy, senderSk: this.#deps.drop!.senderSk, at },
      MESSAGE_EXPIRY_DAYS.map((days) => days * 86_400),
      chunks,
    )
  }

  /** Read now, or when another has finished: each is a megabyte or so. */
  #queueRead(key: string): void {
    if (this.#reading.size >= MAX_READING) {
      this.#waiting.push(key)
      return
    }
    this.#reading.add(key)
    void this.#startRound(key)
  }

  /** Done with this one, whichever way: its place goes to the next. */
  #release(key: string, entry: Inbound): void {
    if (entry.timer) this.#clearTimer(entry.timer)
    entry.sub?.close()
    this.#inbound.delete(key)
    this.#waiting = this.#waiting.filter((waiting) => waiting !== key)
    if (!this.#reading.delete(key)) return
    const next = this.#waiting.shift()
    if (next) this.#queueRead(next)
  }

  /**
   * Every relay it might be on, one at a time. Those it was put on that are open
   * already, then the rest it was put on, then the ones we read. A stranger's
   * descriptor does not send us to a relay of their choosing, which would tell
   * them this device's address: what they sent has to be where we already read,
   * and they put a copy there.
   */
  async #startRound(key: string): Promise<void> {
    const entry = this.#inbound.get(key)!
    const drop = this.#deps.drop!
    const mine = drop.pool.rankedReadRelays()
    const named = entry.attachment.relays!
    const trusted = await drop.trusted(entry.peerPubkey)
    if (this.#inbound.get(key) !== entry) return
    entry.relays = [
      ...new Set([...named.filter((url) => mine.includes(url)), ...(trusted ? named : []), ...mine]),
    ]
    entry.relayAt = 0
    this.#readNext(key, entry)
  }

  #readNext(key: string, entry: Inbound): void {
    entry.sub?.close()
    entry.sub = null
    const url = entry.relays[entry.relayAt++]
    if (url === undefined) {
      // Tried them all, and something is still missing.
      this.#armStall(key)
      return
    }
    entry.heard = false
    const drop = this.#deps.drop!
    entry.sub = drop.pool.subscribe(
      { kinds: [KIND_GIFT_WRAP], '#p': [dropAddress(entry.attachment)] },
      {
        onEvent: (event) => void this.#acceptDropped(key, entry, event),
        onEose: () => {
          if (!entry.heard) this.#armNextRelay(key, entry, EMPTY_RELAY_MS)
        },
        label: 'blob',
      },
      [url],
    )
    this.#armNextRelay(key, entry, STALL_MS)
  }

  #armNextRelay(key: string, entry: Inbound, ms: number): void {
    if (this.#inbound.get(key) !== entry) return
    if (entry.timer) this.#clearTimer(entry.timer)
    entry.timer = this.#setTimer(() => this.#readNext(key, entry), ms)
  }

  /** Anyone can write to an address, so nothing is kept unless the copy's key opens it. */
  async #acceptDropped(key: string, entry: Inbound, event: NostrEvent): Promise<void> {
    const chunk = readChunkEvent(event)
    if (!chunk || chunk.seq >= entry.attachment.chunks) return
    if (!chunkOpens(entry.attachment, chunk.seq, chunk.ciphertext)) return
    if (this.#inbound.get(key) !== entry) return
    entry.heard = true
    const manifest = await this.#deps.store.putBlobChunk(entry.ref, chunk.seq, chunk.ciphertext, {
      total: entry.attachment.chunks,
      size: entry.attachment.size,
    })
    if (this.#inbound.get(key) !== entry) return
    this.events.emit('progress', {
      id: entry.ref.id,
      copy: entry.ref.copy,
      received: manifest.received,
      total: manifest.total,
      outgoing: false,
    })
    if (manifest.complete === 1) await this.#finish(key)
    else this.#armNextRelay(key, entry, STALL_MS)
  }

  // --- receiving ------------------------------------------------------------

  /**
   * Register interest in a payload we have been told about.
   *
   * Called when a message with an attachment arrives, whether or not any chunk
   * has. That is what lets a transfer be driven to completion even if every
   * chunk was lost — the receiver knows what it is owed.
   */
  async expect(peerPubkey: string, attachment: Attachment): Promise<void> {
    const ref = blobRef(attachment)
    const key = blobRefKey(ref)
    if (this.#inbound.has(key)) return
    const entry: Inbound = {
      attachment,
      ref,
      peerPubkey,
      timer: null,
      rounds: 0,
      lastCount: -1,
      relays: [],
      relayAt: 0,
      sub: null,
      heard: false,
    }
    this.#inbound.set(key, entry)
    // Anything that raced ahead of this message can now be verified and kept.
    await this.#drainOrphans(entry)

    const missing = await this.#deps.store.missingChunks(ref, attachment.chunks)
    if (missing.length === 0) {
      await this.#finish(key)
      return
    }
    if (attachment.relays && this.#deps.drop) this.#queueRead(key)
    else this.#armStall(key)
  }

  /**
   * Re-register interest in a payload already on disk but incomplete.
   *
   * Without this, an attachment interrupted by a reload, a lock, or a closed
   * tab is never resumed: the durable state is all there, but nothing is
   * watching it any more, so the missing chunks are never asked for again.
   */
  async resume(peerPubkey: string, attachment: Attachment): Promise<void> {
    const ref = blobRef(attachment)
    if (this.#inbound.has(blobRefKey(ref))) return
    const missing = await this.#deps.store.missingChunks(ref, attachment.chunks)
    if (missing.length === 0) return
    await this.expect(peerPubkey, attachment)
  }

  /**
   * Keep what arrived early for this copy. Chunks that named it are all its
   * own, so any that fail are junk. Chunks that named no copy may belong to
   * another copy of the same file still to be described, so those that do
   * not open stay held for it.
   */
  async #drainOrphans(entry: Inbound): Promise<void> {
    const { attachment, ref } = entry
    let recovered = 0
    for (const bucket of [blobRefKey(ref), `${ref.id}:`]) {
      const held = this.#orphans.get(bucket)
      if (!held) continue
      for (const [seq, ciphertext] of held.chunks) {
        // Held before it could be checked; now it can be, and may not be ours.
        if (!chunkOpens(attachment, seq, ciphertext)) continue
        held.chunks.delete(seq)
        held.bytes -= ciphertext.length
        this.#orphanBytes -= ciphertext.length
        await this.#deps.store.putBlobChunk(ref, seq, ciphertext, {
          total: attachment.chunks,
          size: attachment.size,
        })
        recovered++
      }
      if (bucket !== `${ref.id}:` || held.chunks.size === 0) {
        this.#orphans.delete(bucket)
        this.#orphanBytes -= held.bytes
      }
    }
    if (recovered > 0) log.info(`recovered ${recovered} early chunk(s) for ${ref.id.slice(0, 8)}`)
  }

  #holdOrphan(bucket: string, seq: number, ciphertext: Uint8Array): void {
    // One chunk bigger than the whole buffer is not held, and costs nothing held.
    if (ciphertext.length > MAX_ORPHAN_BYTES) return
    // Evict oldest first if a peer is filling the buffer. A Map iterates in
    // insertion order, so the first bucket is the oldest.
    while (this.#orphanBytes + ciphertext.length > MAX_ORPHAN_BYTES && this.#orphans.size > 0) {
      const [oldest, evicted] = this.#orphans.entries().next().value as [string, Orphan]
      this.#orphans.delete(oldest)
      this.#orphanBytes -= evicted.bytes
    }

    const entry = this.#orphans.get(bucket) ?? { chunks: new Map(), bytes: 0 }
    if (!entry.chunks.has(seq)) {
      entry.chunks.set(seq, ciphertext)
      entry.bytes += ciphertext.length
      this.#orphanBytes += ciphertext.length
    }
    this.#orphans.set(bucket, entry)
  }

  /**
   * Accept one chunk from a peer.
   *
   * Chunks are verified before they are stored: `openChunk` proves the piece
   * belongs to this payload, at this index, in a payload of this length. A
   * chunk that fails is dropped rather than persisted, so a peer cannot fill
   * the database with garbage that later fails reassembly.
   *
   * A chunk names its copy. One from a client that predates ADR-052 does not,
   * and goes to whichever expected copy of that payload its key opens.
   */
  async accept(peerPubkey: string, frame: BlobChunkFrame): Promise<void> {
    const candidates = frame.copy
      ? [this.#inbound.get(blobRefKey({ id: frame.id, copy: frame.copy }))].filter((e) => e !== undefined)
      : [...this.#inbound.values()].filter((e) => e.ref.id === frame.id)
    let ciphertext: Uint8Array
    try {
      ciphertext = b64ToBytes(frame.data)
    } catch {
      return // not decodable, so not worth holding
    }
    if (candidates.length === 0) {
      // The message has not arrived yet — routine on the relay path, where the
      // sender pushes chunks the moment it publishes and delivery order is
      // whatever the relay feels like. Hold the ciphertext until the descriptor
      // turns up and it can be verified; it is never written to disk unchecked.
      this.#holdOrphan(`${frame.id}:${frame.copy ?? ''}`, frame.seq, ciphertext)
      return
    }

    // Verify now, store after. Decrypting twice costs microseconds and keeps
    // unauthenticated bytes out of the database entirely.
    const entry = candidates.find(
      (e) =>
        e.peerPubkey === peerPubkey &&
        frame.total === e.attachment.chunks &&
        chunkOpens(e.attachment, frame.seq, ciphertext),
    )
    if (!entry) {
      log.warn(`chunk ${frame.seq} of ${frame.id.slice(0, 8)} refused: wrong peer, length or key`)
      return
    }

    const manifest = await this.#deps.store.putBlobChunk(entry.ref, frame.seq, ciphertext, {
      total: entry.attachment.chunks,
      size: entry.attachment.size,
    })

    this.events.emit('progress', {
      id: entry.ref.id,
      copy: entry.ref.copy,
      received: manifest.received,
      total: manifest.total,
      outgoing: false,
    })

    const key = blobRefKey(entry.ref)
    if (manifest.complete === 1) {
      await this.#finish(key)
      return
    }
    this.#armStall(key)
  }

  /** True while a copy is still being collected. */
  isPending(ref: BlobRef): boolean {
    return this.#inbound.has(blobRefKey(ref))
  }

  async #finish(key: string): Promise<void> {
    const entry = this.#inbound.get(key)
    if (!entry) return
    this.#release(key, entry)
    const { id, copy } = entry.ref

    const chunks = await this.#deps.store.getBlobChunks(entry.ref, entry.attachment.chunks)
    if (!chunks) {
      this.events.emit('failed', { id, copy, reason: 'incomplete' })
      return
    }
    try {
      const plaintext = assembleBlob(
        entry.attachment,
        chunks.map((chunk, seq) => openChunk(entry.attachment, seq, chunk)),
      )
      this.events.emit('complete', { id, copy, bytes: plaintext })
    } catch (err) {
      // Every chunk authenticated individually, so reaching here means the
      // sender's own descriptor was inconsistent with what they sent.
      log.warn(`payload ${id.slice(0, 8)} failed reassembly`, err)
      this.events.emit('failed', { id, copy, reason: 'integrity' })
    }
  }

  /**
   * Ask for missing chunks once the transfer has been quiet for a while.
   *
   * Rearmed on every arrival, so a healthy transfer never sends a request at
   * all. The round counter stops a peer that has genuinely gone away from
   * costing an unbounded number of relay events.
   */
  #armStall(key: string): void {
    // Gone if it was stopped, or finished, while its caller was waiting.
    const entry = this.#inbound.get(key)
    if (!entry) return
    if (entry.timer) this.#clearTimer(entry.timer)
    // Every path that drops an entry clears this timer first, so when it fires
    // the entry is still the one it was armed for.
    entry.timer = this.#setTimer(() => {
      void this.#requestMissing(key, entry)
    }, STALL_MS)
  }

  async #requestMissing(key: string, entry: Inbound): Promise<void> {
    const missing = await this.#deps.store.missingChunks(entry.ref, entry.attachment.chunks)
    // Stopped, or completed by a chunk, while that was read: nothing to ask for.
    if (this.#inbound.get(key) !== entry) return
    if (missing.length === 0) {
      await this.#finish(key)
      return
    }

    // No progress since the last round and no rounds left: stop asking. The
    // payload stays on disk, so a later retry resumes rather than restarts.
    const fromRelays = entry.attachment.relays !== undefined && this.#deps.drop !== undefined
    const rounds = fromRelays ? MAX_DROP_ROUNDS : MAX_REQUEST_ROUNDS
    if (entry.rounds >= rounds && missing.length === entry.lastCount) {
      // Its timer is the one that just fired: nothing left to clear.
      this.events.emit('failed', { id: entry.ref.id, copy: entry.ref.copy, reason: 'stalled' })
      this.#release(key, entry)
      return
    }

    entry.rounds++
    entry.lastCount = missing.length
    await this.#deps
      .send(entry.peerPubkey, {
        v: PROTOCOL_VERSION,
        t: 'blobreq',
        id: entry.ref.id,
        copy: entry.ref.copy,
        // Bounded: a payload missing thousands of chunks asks for the first
        // slice and repeats, rather than emitting an enormous frame.
        need: missing.slice(0, 128),
      })
      .catch((err: unknown) => log.warn('resend request failed', err))

    if (this.#inbound.get(key) !== entry) return
    // Whatever they send goes to the relays, so that is where to look.
    if (fromRelays) await this.#startRound(key)
    else this.#armStall(key)
  }
}
