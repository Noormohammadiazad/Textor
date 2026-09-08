import { startLive, type LiveState } from '../models/location'
import type { Message } from '../models/types'
import { MINUTE } from '../util/time'

/**
 * No news from a live share for this long, and its marker stops pulsing: a
 * share still running sends at least every ten minutes (see `LIVE_POLICY`), so
 * a quiet one is on a device that has gone to sleep or lost its signal.
 */
export const STALE_AFTER_MS = 15 * MINUTE

export interface LiveStatus {
  /** Where it is now, and how it got there. */
  state: LiveState
  /** Still being shared, as far as this device can tell. */
  active: boolean
  /** When it stops, by this device's clock; null for "until turned off". */
  endsAt: number | null
  /** When it stopped, by this device's clock, once it has. */
  endedAt: number | null
  /** When its newest position was taken, by this device's clock. */
  updatedAt: number
  /** Active, but nothing heard for longer than a running share goes quiet. */
  stale: boolean
}

/**
 * A live location as this device should show it at `now`, or `null` for a
 * message that is not one.
 *
 * Every time here is the author's, moved onto this clock by the share's
 * `lag`: the least any update seemed to take to arrive, which is how far
 * ahead this clock runs of theirs, at most. So a share is never shown as
 * over before it is, however far apart the two clocks are — the failure a
 * phone an hour behind would otherwise cause the moment it began to share
 * (ADR-064). An end the author sent is believed at once.
 */
export function liveStatus(message: Message, now: number): LiveStatus | null {
  const seconds = message.location?.live
  if (!message.location || seconds === undefined) return null
  const state = message.live ?? startLive(message.location, message.ts, message.ts)
  const endsAt = seconds > 0 ? message.ts + seconds * 1000 + state.lag : null
  const endedAt =
    state.end !== undefined ? state.end + state.lag : endsAt !== null && now >= endsAt ? endsAt : null
  const updatedAt = state.at + state.lag
  const active = endedAt === null
  return { state, active, endsAt, endedAt, updatedAt, stale: active && now - updatedAt > STALE_AFTER_MS }
}
