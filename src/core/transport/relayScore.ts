import type { RelayHealth } from '../models/types'

/**
 * Relay ranking, as pure functions of health and time.
 *
 * Kept apart from the pool so the policy can be read, reasoned about, and
 * tested without a single socket. Everything that decides which relay a
 * message leans on lives here; the pool only records outcomes and asks.
 */

/** Weight of the newest publish outcome in the rolling reliability. */
const RELIABILITY_ALPHA = 0.25
/** Weight of the newest sample in the rolling latency means. */
const LATENCY_ALPHA = 0.3

/** Consecutive publish failures before a relay stops being leaned on. */
export const CIRCUIT_THRESHOLD = 3
const CIRCUIT_BASE_COOLDOWN_MS = 15_000
const CIRCUIT_MAX_COOLDOWN_MS = 5 * 60_000

/**
 * Latency at which a relay's score is halved.
 *
 * Chosen from measurement, not taste: from a network where international links
 * are slow, warm publishes to healthy public relays acknowledged in about
 * 300 ms and cold handshakes took one to ten seconds. 1.5 s separates those two
 * worlds cleanly.
 */
const LATENCY_HALF_SCORE_MS = 1500

export type CircuitState = 'closed' | 'open' | 'half-open'

/** Fold one publish outcome into the rolling figures. Mutates and returns `health`. */
export function recordPublish(
  health: RelayHealth,
  outcome: { ok: boolean; ms?: number },
  now: number,
): RelayHealth {
  health.reliability = health.reliability * (1 - RELIABILITY_ALPHA) + (outcome.ok ? RELIABILITY_ALPHA : 0)
  if (outcome.ok) {
    health.publishOk += 1
    health.failStreak = 0
    health.lastOkAt = now
    if (outcome.ms !== undefined) health.latencyMs = ewma(health.latencyMs, outcome.ms)
  } else {
    health.publishFail += 1
    health.failStreak += 1
    health.lastErrorAt = now
  }
  return health
}

export function recordConnect(health: RelayHealth, ms: number, now: number): RelayHealth {
  health.connectOk += 1
  health.connectMs = ewma(health.connectMs, ms)
  health.lastOkAt = now
  return health
}

const ewma = (previous: number, sample: number): number =>
  previous === 0 ? Math.round(sample) : Math.round(previous * (1 - LATENCY_ALPHA) + sample * LATENCY_ALPHA)

/**
 * A starting reliability for a health record that predates the field.
 *
 * Laplace-smoothed from the lifetime counters, so an upgrade does not reset a
 * relay with a long good record to a coin flip, nor promote a known-bad one.
 */
export function seededReliability(health: Pick<RelayHealth, 'publishOk' | 'publishFail'>): number {
  return (health.publishOk + 1) / (health.publishOk + health.publishFail + 2)
}

/**
 * Whether a relay may be leaned on right now.
 *
 * A textbook breaker. After `CIRCUIT_THRESHOLD` publish failures in a row it
 * opens, and stays open for a cooldown that doubles with every further failure
 * up to five minutes. Once the cooldown lapses it is half-open: the next
 * publish is its trial, and a success closes it again.
 *
 * Open does not mean excluded from delivery — see `RelayPool.dispatch`. It
 * means the relay is not trusted to be fast, is not forced to reconnect, and
 * gives up its place in a capped relay list to a relay that is working.
 */
export function circuitState(health: RelayHealth, now: number): CircuitState {
  if (health.failStreak < CIRCUIT_THRESHOLD) return 'closed'
  const doublings = Math.min(10, health.failStreak - CIRCUIT_THRESHOLD)
  const cooldown = Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * 2 ** doublings)
  return now - health.lastErrorAt >= cooldown ? 'half-open' : 'open'
}

/**
 * Rank a relay: higher is better.
 *
 * Reliability is squared before latency scales it, because a failed publish
 * costs twice: the attempt itself, and the relay that has to carry the message
 * instead. Linear weighting let a relay refusing 40% of publishes at 150 ms
 * outrank one keeping 98% at 1.2 s, which is the wrong relay to lean on.
 *
 * An open socket earns a small bonus, because a publish to it skips a
 * handshake that measured one to ten seconds. An open circuit all but zeroes
 * the score without removing the relay, so it still sorts above nothing.
 */
export function relayScore(health: RelayHealth, opts: { open: boolean; now: number }): number {
  // Unmeasured latency is scored as middling rather than perfect, so a relay
  // never tried does not jump ahead of one proven fast.
  const latencyFactor = health.latencyMs === 0 ? 0.75 : 1 / (1 + health.latencyMs / LATENCY_HALF_SCORE_MS)
  const circuit = circuitState(health, opts.now)
  const circuitFactor = circuit === 'open' ? 0.1 : circuit === 'half-open' ? 0.5 : 1
  const openBonus = opts.open ? 0.15 : 0
  return health.reliability ** 2 * latencyFactor * circuitFactor + openBonus
}

/**
 * How many relay acknowledgements make a message "sent".
 *
 * One ack proves the message left the device. A second, from an independent
 * operator, is what makes it durable against that one relay restarting,
 * pruning, or quietly discarding the event — which public relays do. Asking
 * for more than two buys little and costs the latency of the third-fastest.
 * With three or fewer targets a quorum of two would often wait on the slowest
 * relay, which is the stall this exists to remove, so it drops to one.
 */
export function quorumFor(targets: number): number {
  if (targets <= 0) return 0
  return targets <= 3 ? 1 : 2
}
