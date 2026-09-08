import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { b64ToBytes, bytesToB64 } from '../util/bytes'
import { PROTOCOL_VERSION, type BlobChunkFrame, type ControlFrame } from '../models/protocol'
import { assembleBlob, openChunk, type BlobEnvelope } from '../crypto/blobCrypto'
import type { Attachment } from '../models/attachment'

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
  received: number
  total: number
  /** True for a payload we are sending. */
  outgoing: boolean
}

export type BlobTransferEvents = {
  progress: BlobProgress
  /** A payload finished arriving and passed its integrity check. */
  complete: { id: string; bytes: Uint8Array }
  failed: { id: string; reason: string }
}

/** What the transfer engine needs from storage, narrowed to keep it testable. */
export interface BlobStore {
  getBlobManifest(blobId: string): Promise<{ total: number; size: number } | undefined>
  putBlobChunk(
    blobId: string,
    seq: number,
    data: Uint8Array,
    meta: { total: number; size: number; outgoing?: boolean },
  ): Promise<{ received: number; total: number; complete: number }>
  missingChunks(blobId: string, total: number): Promise<number[]>
  getBlobChunk(blobId: string, seq: number): Promise<Uint8Array | null>
  getBlobChunks(blobId: string, total: number): Promise<Uint8Array[] | null>
}

export interface BlobTransferDeps {
  store: BlobStore
  /** Deliver one control frame to a peer. Resolves when it has been handed off. */
  send(peerPubkey: string, frame: ControlFrame): Promise<void>
  /** Whether a direct channel to this peer is open right now. */
  isDirect(peerPubkey: string): boolean
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface Orphan {
  chunks: Map<number, Uint8Array>
  bytes: number
  at: number
}

interface Inbound {
  attachment: Attachment
  peerPubkey: string
  timer: ReturnType<typeof setTimeout> | null
  rounds: number
  lastCount: number
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
  readonly #inbound = new Map<string, Inbound>()
  /** Chunks waiting for the message that explains them. Memory only. */
  readonly #orphans = new Map<string, Orphan>()
  #orphanBytes = 0
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
    }
    this.#inbound.clear()
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
    for (let seq = 0; seq < envelope.chunks; seq++) {
      await this.#deps.store.putBlobChunk(envelope.id, seq, chunkAt(seq), {
        total: envelope.chunks,
        size: envelope.size,
        outgoing: true,
      })
    }
  }

  /** Send the listed chunks (or all of them) to a peer, paced by transport. */
  async push(peerPubkey: string, blobId: string, total: number, only?: readonly number[]): Promise<void> {
    const indexes = only && only.length > 0 ? [...only] : Array.from({ length: total }, (_, i) => i)
    const window = this.#deps.isDirect(peerPubkey) ? DIRECT_WINDOW : RELAY_WINDOW

    for (let i = 0; i < indexes.length; i += window) {
      const batch = indexes.slice(i, i + window)
      await Promise.all(
        batch.map(async (seq) => {
          const data = await this.#deps.store.getBlobChunk(blobId, seq)
          if (!data) {
            log.warn(`chunk ${seq} of ${blobId.slice(0, 8)} is gone; cannot serve`)
            return
          }
          const frame: BlobChunkFrame = {
            v: PROTOCOL_VERSION,
            t: 'blob',
            id: blobId,
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
   */
  async serve(peerPubkey: string, blobId: string, need: readonly number[]): Promise<void> {
    const manifest = await this.#deps.store.getBlobManifest(blobId)
    if (!manifest) {
      log.warn(`asked to resend ${blobId.slice(0, 8)}, which this device does not hold`)
      return
    }
    const wanted = need.filter((seq) => seq < manifest.total)
    if (wanted.length === 0) return
    await this.push(peerPubkey, blobId, manifest.total, wanted)
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
    if (this.#inbound.has(attachment.id)) return
    this.#inbound.set(attachment.id, {
      attachment,
      peerPubkey,
      timer: null,
      rounds: 0,
      lastCount: -1,
    })
    // Anything that raced ahead of this message can now be verified and kept.
    await this.#drainOrphans(attachment)

    const missing = await this.#deps.store.missingChunks(attachment.id, attachment.chunks)
    if (missing.length === 0) {
      await this.#finish(attachment.id)
      return
    }
    this.#armStall(attachment.id)
  }

  /**
   * Re-register interest in a payload already on disk but incomplete.
   *
   * Without this, an attachment interrupted by a reload, a lock, or a closed
   * tab is never resumed: the durable state is all there, but nothing is
   * watching it any more, so the missing chunks are never asked for again.
   */
  async resume(peerPubkey: string, attachment: Attachment): Promise<void> {
    if (this.#inbound.has(attachment.id)) return
    const missing = await this.#deps.store.missingChunks(attachment.id, attachment.chunks)
    if (missing.length === 0) return
    await this.expect(peerPubkey, attachment)
  }

  async #drainOrphans(attachment: Attachment): Promise<void> {
    const held = this.#orphans.get(attachment.id)
    if (!held) return
    this.#orphans.delete(attachment.id)
    this.#orphanBytes -= held.bytes

    for (const [seq, ciphertext] of held.chunks) {
      try {
        openChunk(attachment, seq, ciphertext)
      } catch {
        // Held before it could be checked; now it can be, and it is not ours.
        continue
      }
      await this.#deps.store.putBlobChunk(attachment.id, seq, ciphertext, {
        total: attachment.chunks,
        size: attachment.size,
      })
    }
    log.info(`recovered ${held.chunks.size} early chunk(s) for ${attachment.id.slice(0, 8)}`)
  }

  #holdOrphan(blobId: string, seq: number, ciphertext: Uint8Array): void {
    // Evict oldest first if a peer is filling the buffer.
    while (this.#orphanBytes + ciphertext.length > MAX_ORPHAN_BYTES && this.#orphans.size > 0) {
      let oldestId = ''
      let oldestAt = Infinity
      for (const [id, entry] of this.#orphans) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestId = id
        }
      }
      const evicted = this.#orphans.get(oldestId)
      if (!evicted) break
      this.#orphans.delete(oldestId)
      this.#orphanBytes -= evicted.bytes
    }
    if (ciphertext.length > MAX_ORPHAN_BYTES) return

    const entry = this.#orphans.get(blobId) ?? { chunks: new Map(), bytes: 0, at: Date.now() }
    if (!entry.chunks.has(seq)) {
      entry.chunks.set(seq, ciphertext)
      entry.bytes += ciphertext.length
      this.#orphanBytes += ciphertext.length
    }
    this.#orphans.set(blobId, entry)
  }

  /**
   * Accept one chunk from a peer.
   *
   * Chunks are verified before they are stored: `openChunk` proves the piece
   * belongs to this payload, at this index, in a payload of this length. A
   * chunk that fails is dropped rather than persisted, so a peer cannot fill
   * the database with garbage that later fails reassembly.
   */
  async accept(peerPubkey: string, frame: BlobChunkFrame): Promise<void> {
    const entry = this.#inbound.get(frame.id)
    if (!entry) {
      // The message has not arrived yet — routine on the relay path, where the
      // sender pushes chunks the moment it publishes and delivery order is
      // whatever the relay feels like. Hold the ciphertext until the descriptor
      // turns up and it can be verified; it is never written to disk unchecked.
      try {
        this.#holdOrphan(frame.id, frame.seq, b64ToBytes(frame.data))
      } catch {
        // Not decodable, so not worth holding.
      }
      return
    }
    if (entry.peerPubkey !== peerPubkey) {
      log.warn(`chunk for ${frame.id.slice(0, 8)} from the wrong peer`)
      return
    }
    if (frame.total !== entry.attachment.chunks) {
      log.warn(`chunk count disagreement for ${frame.id.slice(0, 8)}`)
      return
    }

    let ciphertext: Uint8Array
    try {
      ciphertext = b64ToBytes(frame.data)
      // Verify now, store after. Decrypting twice costs microseconds and keeps
      // unauthenticated bytes out of the database entirely.
      openChunk(entry.attachment, frame.seq, ciphertext)
    } catch (err) {
      log.warn(`chunk ${frame.seq} of ${frame.id.slice(0, 8)} failed authentication`, err)
      return
    }

    const manifest = await this.#deps.store.putBlobChunk(frame.id, frame.seq, ciphertext, {
      total: entry.attachment.chunks,
      size: entry.attachment.size,
    })

    this.events.emit('progress', {
      id: frame.id,
      received: manifest.received,
      total: manifest.total,
      outgoing: false,
    })

    if (manifest.complete === 1) {
      await this.#finish(frame.id)
      return
    }
    this.#armStall(frame.id)
  }

  /** True while a payload is still being collected. */
  isPending(blobId: string): boolean {
    return this.#inbound.has(blobId)
  }

  async #finish(blobId: string): Promise<void> {
    const entry = this.#inbound.get(blobId)
    if (!entry) return
    if (entry.timer) this.#clearTimer(entry.timer)
    this.#inbound.delete(blobId)

    const chunks = await this.#deps.store.getBlobChunks(blobId, entry.attachment.chunks)
    if (!chunks) {
      this.events.emit('failed', { id: blobId, reason: 'incomplete' })
      return
    }
    try {
      const plaintext = assembleBlob(
        entry.attachment,
        chunks.map((chunk, seq) => openChunk(entry.attachment, seq, chunk)),
      )
      this.events.emit('complete', { id: blobId, bytes: plaintext })
    } catch (err) {
      // Every chunk authenticated individually, so reaching here means the
      // sender's own descriptor was inconsistent with what they sent.
      log.warn(`payload ${blobId.slice(0, 8)} failed reassembly`, err)
      this.events.emit('failed', { id: blobId, reason: 'integrity' })
    }
  }

  /**
   * Ask for missing chunks once the transfer has been quiet for a while.
   *
   * Rearmed on every arrival, so a healthy transfer never sends a request at
   * all. The round counter stops a peer that has genuinely gone away from
   * costing an unbounded number of relay events.
   */
  #armStall(blobId: string): void {
    const entry = this.#inbound.get(blobId)
    if (!entry) return
    if (entry.timer) this.#clearTimer(entry.timer)
    entry.timer = this.#setTimer(() => {
      void this.#requestMissing(blobId)
    }, STALL_MS)
  }

  async #requestMissing(blobId: string): Promise<void> {
    const entry = this.#inbound.get(blobId)
    if (!entry) return

    const missing = await this.#deps.store.missingChunks(blobId, entry.attachment.chunks)
    if (missing.length === 0) {
      await this.#finish(blobId)
      return
    }

    // No progress since the last round and no rounds left: stop asking. The
    // payload stays on disk, so a later retry resumes rather than restarts.
    if (entry.rounds >= MAX_REQUEST_ROUNDS && missing.length === entry.lastCount) {
      this.events.emit('failed', { id: blobId, reason: 'stalled' })
      if (entry.timer) this.#clearTimer(entry.timer)
      this.#inbound.delete(blobId)
      return
    }

    entry.rounds++
    entry.lastCount = missing.length
    await this.#deps
      .send(entry.peerPubkey, {
        v: PROTOCOL_VERSION,
        t: 'blobreq',
        id: blobId,
        // Bounded: a payload missing thousands of chunks asks for the first
        // slice and repeats, rather than emitting an enormous frame.
        need: missing.slice(0, 128),
      })
      .catch((err: unknown) => log.warn('resend request failed', err))

    this.#armStall(blobId)
  }
}
