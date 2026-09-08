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
/** A connection lost sooner than this after opening counts as churn. */
const CHURN_WINDOW_MS = 2 * 60_000

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
  health.connectStreak = 0
  return health
}

/** A connection lost after `livedMs` open. One that dies young counts towards churn. */
export function recordDrop(health: RelayHealth, livedMs: number): RelayHealth {
  health.drops += 1
  health.churn = health.churn * (1 - RELIABILITY_ALPHA) + (livedMs < CHURN_WINDOW_MS ? RELIABILITY_ALPHA : 0)
  return health
}

/** The relay sent everything it holds of our inbox, `ms` after being asked: it serves it. */
export function recordEose(health: RelayHealth, ms: number): RelayHealth {
  health.eoseMs = ewma(health.eoseMs, ms)
  health.readFail = 0
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
 *
 * For reading, latency is how long the relay takes to hand over the inbox,
 * where that has been measured. A relay that keeps shedding connections loses
 * up to half its score: each loss is a gap in the live inbox and a handshake.
 */
export function relayScore(
  health: RelayHealth,
  opts: { open: boolean; now: number; read?: boolean },
): number {
  const ms = (opts.read ? health.eoseMs : 0) || health.latencyMs
  // Unmeasured latency is scored as middling rather than perfect, so a relay
  // never tried does not jump ahead of one proven fast.
  const latencyFactor = ms === 0 ? 0.75 : 1 / (1 + ms / LATENCY_HALF_SCORE_MS)
  const circuit = circuitState(health, opts.now)
  const circuitFactor = circuit === 'open' ? 0.1 : circuit === 'half-open' ? 0.5 : 1
  const openBonus = opts.open ? 0.15 : 0
  return health.reliability ** 2 * latencyFactor * circuitFactor * (1 - health.churn / 2) + openBonus
}

// --- what a relay will carry (ADR-073) ----------------------------------------

/** Past this, a wrap is more than a short message: what some relays refuse from a key they do not know. */
const LARGE_EVENT_CHARS = 6 * 1024
/** A relay that refused one this size is asked again after this long: policies change. */
const LARGE_RETRY_MS = 6 * 60 * 60_000

export const isLargeEvent = (event: { content: string }): boolean => event.content.length > LARGE_EVENT_CHARS

/**
 * A refusal of a large event that going on asking would make worse: its size,
 * its signer, or how many have come from here. Measured, `wellorder` answers
 * "spam not permitted" and blocks the address if it keeps coming (ADR-070), and
 * one upload retrying against it sent 129 events, 7.8 MB, for nothing (ADR-075).
 */
export const isSizeRefusal = (error: string): boolean =>
  /too large|too big|web of trust|size|spam|blocked|rate.?limit/i.test(error)

/** Relays to ask again, of those told to take a signed event: not one that said it never will, for its size. */
export const signedOutcomes = (
  outcomes: readonly ({ url: string; ok: true } | { url: string; ok: false; error: string })[],
): string[] =>
  outcomes.flatMap((outcome) => (outcome.ok || isSizeRefusal(outcome.error) ? [] : [outcome.url]))

export const refusesLarge = (health: RelayHealth, now: number): boolean =>
  health.largeRefusedAt !== undefined && now - health.largeRefusedAt < LARGE_RETRY_MS

// --- the active set (ADR-067) ------------------------------------------------

/**
 * Relays kept connected and leaned on, for reading and for writing each.
 *
 * Four independent operators: enough that one restarting, filtering or
 * pruning loses nothing, few enough that every message is not handled six
 * times over. Each further relay held open is another keepalive waking the
 * radio every half minute, and another copy of every wrap to receive.
 */
export const FANOUT = 4
/** Failed connections in a row, while others connect, before a relay is down. */
export const DOWN_AFTER = 2
const TRIAL_BASE_MS = 30_000
const TRIAL_MAX_MS = 60 * 60_000
/** A relay that refused to serve the inbox is asked again after this long: policies change. */
export const READ_RETRY_MS = 6 * 60 * 60_000
/** Unreachable this long, across this many attempts, a relay is dead rather than down. */
export const DEAD_AFTER_MS = 3 * 24 * 60 * 60_000
const DEAD_AFTER_FAILURES = 6

/**
 * When a relay that is down may be tried again; 0 if it is not down. Thirty
 * seconds after the last failure, doubling with every failed trial, to an hour.
 */
export function trialAt(health: RelayHealth): number {
  if (health.connectStreak < DOWN_AFTER) return 0
  const doublings = Math.min(10, health.connectStreak - DOWN_AFTER)
  return health.lastErrorAt + Math.min(TRIAL_MAX_MS, TRIAL_BASE_MS * 2 ** doublings)
}

/**
 * Whether a relay can be leaned on now: it is not down, has not lately
 * refused to serve the inbox, and — for writing — its circuit is not open.
 *
 * A relay that refuses the inbox is no use for writing either. Textor reads
 * no relay that demands sign-in, so a message left there for a Textor user is
 * a message nobody will collect.
 */
export function usable(health: RelayHealth, now: number, write = false): boolean {
  return (
    health.connectStreak < DOWN_AFTER &&
    !(health.readFail > 0 && now - health.readFailAt < READ_RETRY_MS) &&
    !(write && circuitState(health, now) === 'open')
  )
}

/**
 * Dead, by evidence: unreachable for days across several attempts, or
 * refusing the inbox time after time. A dead relay is replaced in the list
 * (ADR-067); one that is merely down is only routed around.
 */
export function isDead(health: RelayHealth, now: number): boolean {
  return (
    (health.connectStreak >= DOWN_AFTER &&
      health.connectFail >= DEAD_AFTER_FAILURES &&
      now - health.lastOkAt >= DEAD_AFTER_MS) ||
    (health.readFail >= 2 && now - health.readFailAt < READ_RETRY_MS)
  )
}

/**
 * The relays to lean on for one role.
 *
 * Those already chosen stay while they work, and the free places go to the
 * best of the rest: a relay is replaced when it fails, never because another
 * scored a little higher a moment ago, which would only churn sockets. When
 * none works the best-scoring are tried anyway, since something must be.
 */
export function chooseRelays(
  urls: readonly string[],
  current: readonly string[],
  score: (url: string) => number,
  ok: (url: string) => boolean,
): string[] {
  const best = (list: string[]): string[] => list.sort((a, b) => score(b) - score(a))
  const kept = current.filter((url) => urls.includes(url) && ok(url))
  const chosen = [...kept, ...best(urls.filter((url) => !kept.includes(url) && ok(url)))].slice(0, FANOUT)
  return chosen.length > 0 ? chosen : best([...urls]).slice(0, FANOUT)
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
