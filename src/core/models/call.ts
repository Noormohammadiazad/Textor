/**
 * What the rest of the app needs to know about calls, without loading them.
 *
 * The calling subsystem itself — peer connections, media, the in-call screen —
 * is a lazy chunk that loads only when a call is placed or rings (ADR-046).
 * What lives here is the small part everything else touches: the words a call
 * frame and a call record are made of, and the one rule the engine applies
 * before it wakes the chunk up. Keep it that way: anything added here is
 * downloaded by every user on every cold start.
 */

/** What a call carries. A video call has audio too. */
export type CallMedia = 'audio' | 'video'

/**
 * Why one side ended a call, as sent in a `bye`.
 *
 * NIP-AC stops at offer, answer and candidate; hanging up, declining and being
 * busy are the call state machine it leaves to the application, so they are
 * carried here as the reason on a `bye`.
 */
export type CallEndReason = 'hangup' | 'declined' | 'busy' | 'unanswered' | 'failed'

export const CALL_END_REASONS: readonly CallEndReason[] = [
  'hangup',
  'declined',
  'busy',
  'unanswered',
  'failed',
]

/** How a call turned out, from this device's side, as kept in the conversation. */
export type CallOutcome = 'completed' | 'missed' | 'declined' | 'unanswered' | 'cancelled' | 'busy' | 'failed'

/**
 * A call, as the conversation remembers it.
 *
 * Stored on this device only, like everything else in the vault, and never
 * sent: each side writes its own record of the same call under the same id,
 * which is the rumor id of the offer that opened it. That shared id is what a
 * `redact` names to take the call out of both conversations, which either
 * person in it may do (ADR-047).
 */
export interface CallRecord {
  media: CallMedia
  outcome: CallOutcome
  /** How long the call was connected, for a completed call. */
  durationMs?: number
}

const OUTCOMES: ReadonlySet<string> = new Set([
  'completed',
  'missed',
  'declined',
  'unanswered',
  'cancelled',
  'busy',
  'failed',
])

/** Validate a record read back from storage or a backup file. */
export function isCallRecord(value: unknown): value is CallRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.media !== 'audio' && record.media !== 'video') return false
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome)) return false
  if (record.durationMs === undefined) return true
  return typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
}

/**
 * How old an offer may be and still ring.
 *
 * Relays keep what they are given, so a device that comes online replays every
 * offer sent while it was away. One that rang would be a call from someone who
 * gave up long ago; instead it is written into the conversation as a missed
 * call, which is exactly what it is. A minute covers relay latency and clock
 * disagreement between two ordinary devices.
 */
export const CALL_RING_WINDOW_MS = 60_000

/** The candidate type in an ICE candidate line: `typ host`, `typ srflx`, … */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay'

export function candidateType(candidate: string): CandidateType | null {
  const match = / typ (host|srflx|prflx|relay)(?: |$)/.exec(candidate)
  return match ? (match[1] as CandidateType) : null
}

export interface CandidateSummary {
  host: boolean
  srflx: boolean
  relay: boolean
}

/** Which kinds of address a set of candidates offers. */
export function summarizeCandidates(candidates: readonly string[]): CandidateSummary {
  const types = new Set<CandidateType | null>(candidates.map(candidateType))
  return {
    host: types.has('host'),
    // A peer-reflexive address is a public address too, learned from the
    // other side's checks rather than from a STUN server.
    srflx: types.has('srflx') || types.has('prflx'),
    relay: types.has('relay'),
  }
}

/**
 * Whether this device's NAT gave different public ports to different STUN
 * servers — endpoint-dependent mapping, which is what "symmetric NAT" means.
 *
 * The defaults deliberately name STUN servers run by two different operators,
 * which is what makes this observable at all: behind a symmetric NAT each of
 * them sees the same public address on a different port, and a port learned
 * from one is useless to anybody else. A heuristic, and labelled as one: two
 * network interfaces behind the same NAT can produce the same pattern.
 *
 * Here rather than in the call chunk because Settings runs the same check
 * when it tests a network — and a module shared by two lazy chunks is hoisted
 * into one the shell precaches.
 */
export function looksSymmetric(candidates: readonly string[]): boolean {
  const ports = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    if (candidateType(candidate) !== 'srflx') continue
    // candidate:<foundation> <component> <transport> <priority> <address> <port> typ srflx …
    const [, component, transport, , address, port] = candidate.replace(/^candidate:/, '').split(/\s+/)
    if (!component || !transport || !address || !port) continue
    const key = `${component}/${transport.toLowerCase()}/${address}`
    const seen = ports.get(key) ?? new Set<string>()
    seen.add(port)
    ports.set(key, seen)
  }
  return [...ports.values()].some((seen) => seen.size > 1)
}

/** Whether a server list can relay media at all, which "always relay" depends on. */
export const hasTurnServer = (servers: readonly RTCIceServer[]): boolean =>
  servers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)),
  )
