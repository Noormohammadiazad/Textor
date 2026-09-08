import type { GeoFix } from '../models/location'
import { createLogger } from '../util/log'
import { MINUTE, SECOND } from '../util/time'
import { distanceM, turnDeg } from './geo'
import type { PositionFailure, PositionSource } from './position'

const log = createLogger('location')

/**
 * Sharing where this device is going, for as long as someone asked (ADR-064).
 *
 * One watch on the position serves every share at once, and how closely it
 * watches follows what the person is doing. Satellites and an update every ten
 * seconds while they move with the app in front of them; the cheapest position
 * the device has, and at most one update a minute, once the app is hidden or
 * they have stood still for three minutes. A position that has not moved
 * further than it is vague is not sent at all — except every ten minutes,
 * so that someone who opens the conversation late still finds a recent one.
 *
 * Shares are remembered in the vault, so closing the app or locking it pauses
 * one rather than ending it: it goes on when the vault next opens, unless its
 * time ran out meanwhile, when it is ended then. A page cannot run while the
 * browser has put it to sleep, and nothing here pretends otherwise: readers
 * see how old the newest position is.
 */

export type Precision = 'fine' | 'coarse'

export const LIVE_POLICY = {
  /** The least time between two updates to one share. */
  gapMs: { fine: 10 * SECOND, coarse: MINUTE },
  /** A move worth telling — unless the position is vaguer than that, when the vagueness is. */
  moveM: 20,
  /** A change of direction worth telling, at walking pace or faster. */
  turnDeg: 35,
  walkingMs: 1,
  /** Sent even when nothing moved; the relays drop each update after an hour. */
  heartbeatMs: 10 * MINUTE,
  /** Still for this long, and the position is watched coarsely. */
  idleMs: 3 * MINUTE,
  tickMs: 5 * SECOND,
} as const

/**
 * Whether `next` is worth sending to a share that last sent `last`, `sinceMs`
 * ago. Pure, so the policy above is what the tests hold it to.
 */
export function worthSending(
  last: GeoFix | null,
  next: GeoFix,
  sinceMs: number,
  precision: Precision,
): boolean {
  if (!last) return true
  if (sinceMs < LIVE_POLICY.gapMs[precision]) return false
  if (sinceMs >= LIVE_POLICY.heartbeatMs) return true
  if (distanceM(last, next) >= Math.max(LIVE_POLICY.moveM, next.acc ?? 0)) return true
  // Found properly at last: a position that was a guess is worth correcting.
  if (
    last.acc !== undefined &&
    next.acc !== undefined &&
    last.acc > LIVE_POLICY.moveM &&
    next.acc <= last.acc / 2
  )
    return true
  return (
    (next.spd ?? 0) >= LIVE_POLICY.walkingMs &&
    last.hdg !== undefined &&
    next.hdg !== undefined &&
    turnDeg(last.hdg, next.hdg) >= LIVE_POLICY.turnDeg
  )
}

export interface LiveShare {
  /** Rumor id of the message that started it. */
  id: string
  /** Where it went: a person's key, or a group's id. */
  address: string
  /** When it runs out, by this device's clock; null until turned off. */
  until: number | null
}

export interface SharerHost {
  positions: PositionSource
  /** Send a share's new position, or its end: false when there is no longer a share of ours to move. */
  move(id: string, fix: GeoFix | null): Promise<boolean>
  load(): Promise<LiveShare[]>
  save(shares: LiveShare[]): Promise<void>
  /** Whether anyone can see the app. */
  visible(): boolean
  changed(shares: LiveShare[]): void
  failed(failure: PositionFailure): void
}

interface Running {
  share: LiveShare
  /** What it last sent, and when; nothing yet after a resume. */
  sent: GeoFix | null
  sentAt: number
}

export class LiveSharer {
  readonly #host: SharerHost
  #running = new Map<string, Running>()
  #latest: GeoFix | null = null
  /** Where the position last moved from, and when: what says someone is standing still. */
  #anchor: GeoFix | null = null
  #movedAt = 0
  #precision: Precision | null = null
  #unwatch: (() => void) | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  /** Said once that positions stopped coming, until one comes again. */
  #failing = false

  constructor(host: SharerHost) {
    this.#host = host
  }

  get shares(): LiveShare[] {
    return [...this.#running.values()].map((running) => running.share)
  }

  /** How closely the position is being watched; null while nothing is shared. */
  get precision(): Precision | null {
    return this.#precision
  }

  /** Move on a share just sent, from `first`, the position it started at. */
  async start(share: LiveShare, first: GeoFix): Promise<void> {
    const now = Date.now()
    this.#running.set(share.id, { share, sent: first, sentAt: now })
    // Starting counts as moving: the first minutes are watched closely.
    this.#anchor = first
    this.#movedAt = now
    await this.#changed()
  }

  /**
   * End a share, for everyone it went to — ours, or one our other device is
   * running, which stops when it hears.
   */
  async stop(id: string): Promise<void> {
    this.#running.delete(id)
    await this.#changed()
    await this.#host.move(id, null).catch((err: unknown) => log.warn('could not end a live location', err))
  }

  /**
   * Take the shares up again once the vault is open. One whose time ran out
   * while it was closed is ended now, and the rest send where the device is as
   * soon as it knows.
   */
  async resume(): Promise<void> {
    const now = Date.now()
    for (const share of await this.#host.load()) {
      if (this.#running.has(share.id)) continue
      if (share.until !== null && share.until <= now) {
        await this.#host
          .move(share.id, null)
          .catch((err: unknown) => log.warn('could not end a live location', err))
        continue
      }
      this.#running.set(share.id, { share, sent: null, sentAt: 0 })
    }
    this.#movedAt = now
    await this.#changed()
  }

  /** Ended somewhere else — on our other device, or taken out of the conversation. */
  async ended(id: string): Promise<void> {
    if (this.#running.delete(id)) await this.#changed()
  }

  /** Stop watching, and keep what is shared for `resume`: the vault is locking. */
  pause(): void {
    this.#running.clear()
    this.#latest = null
    this.#retune()
  }

  /** The page was hidden or shown: watch as closely as that calls for, now. */
  retune(): void {
    this.#tick()
  }

  async #changed(): Promise<void> {
    const shares = this.shares
    this.#host.changed(shares)
    this.#retune()
    await this.#host.save(shares).catch((err: unknown) => log.warn('could not remember live locations', err))
  }

  /** Watch as closely as the moment calls for — or not at all, with nothing shared — and say how closely. */
  #retune(): Precision {
    const precision: Precision =
      this.#host.visible() && Date.now() - this.#movedAt < LIVE_POLICY.idleMs ? 'fine' : 'coarse'
    if (this.#running.size === 0) {
      this.#unwatch?.()
      this.#unwatch = null
      this.#precision = null
      if (this.#timer) clearInterval(this.#timer)
      this.#timer = null
      return precision
    }
    this.#timer ??= setInterval(() => this.#tick(), LIVE_POLICY.tickMs)
    if (precision === this.#precision) return precision
    this.#unwatch?.()
    this.#precision = precision
    this.#unwatch = this.#host.positions.watch(
      precision === 'fine',
      (fix) => this.#onFix(fix),
      (failure) => void this.#onFailure(failure),
    )
    return precision
  }

  #onFix(fix: GeoFix): void {
    this.#failing = false
    this.#latest = fix
    if (!this.#anchor || distanceM(this.#anchor, fix) >= Math.max(LIVE_POLICY.moveM, fix.acc ?? 0)) {
      this.#anchor = fix
      this.#movedAt = Date.now()
    }
    this.#tick()
  }

  #tick(): void {
    const precision = this.#retune()
    const now = Date.now()
    for (const [id, running] of this.#running) {
      if (running.share.until !== null && now >= running.share.until) {
        void this.stop(id)
        continue
      }
      const latest = this.#latest
      if (!latest || !worthSending(running.sent, latest, now - running.sentAt, precision)) continue
      running.sent = latest
      running.sentAt = now
      void this.#send(id, latest)
    }
  }

  async #send(id: string, fix: GeoFix): Promise<void> {
    try {
      if (!(await this.#host.move(id, fix))) await this.ended(id)
    } catch (err) {
      // Locked or offline mid-update: the next one tries again.
      log.warn('could not move a live location', err)
    }
  }

  async #onFailure(failure: PositionFailure): Promise<void> {
    if (failure === 'unavailable') {
      if (!this.#failing) this.#host.failed(failure)
      this.#failing = true
      return
    }
    // Refused, or never there: nothing more can be shared, so say so to
    // everyone rather than leave them watching a marker that will not move.
    for (const id of [...this.#running.keys()]) await this.stop(id)
    this.#host.failed(failure)
  }
}
