import { hasTurnServer } from '../models/call'
import type { IceServerSetting } from '../models/types'

/**
 * A person's own TURN servers for a call: which to bring in, in what order, and
 * with what credentials (ADR-068). Textor ships none and needs none (ADR-072).
 *
 * A call goes direct first, on STUN alone. TURN comes in only when that fails
 * — an ICE restart with the servers added — so a TURN server never learns of
 * a call that did not need it. Which servers, and in what order, is decided
 * here from what earlier calls and the Settings test measured: one that keeps
 * failing to allocate rests until its retry time, and the rest are ordered
 * best first, which is the order the browser prefers their relays in. Nothing
 * is probed on the way to a call, so none of this adds to how long one takes
 * to connect.
 *
 * Kept out of every precached chunk (ADR-040). Both the call chunk and the
 * Calls settings page need it, and a module either of them imported
 * statically would be hoisted into a shared chunk the shell precaches — so
 * both load it with `import()`, which makes it a lazy chunk of its own.
 */

/**
 * What one TURN server did when asked for a relay: produced one after `ms`,
 * or failed with a STUN error code — 0 when it did not answer at all.
 */
export type TurnOutcome = { url: string; ms: number } | { url: string; error: number }

export interface TurnHealth {
  /** Requests that produced a relay, and requests that did not. */
  ok: number
  fail: number
  /** Failures in a row. Two or more and the server rests (`turnRetryAt`). */
  streak: number
  /** Rolling means: time to a relay, and round trip through it on a call. */
  allocMs: number
  rttMs: number
  /** Bandwidth the browser estimated through the relay on a call, kbit/s; 0 unmeasured. */
  kbps: number
  /** Why it last failed: a STUN error code, or 0 for no answer. */
  error: number
  lastOkAt: number
  lastFailAt: number
}

/** By `turnKey`. Kept in the vault's own state, never in a backup. */
export type TurnHealthMap = Record<string, TurnHealth>

/** The vault state the map is kept under. */
export const TURN_HEALTH = 'turn-health'

/** Below this a relay is treated as throttled: a video call needs more. */
export const THROTTLED_KBPS = 300
const ALPHA = 0.3
const REST_BASE_MS = 10 * 60_000
const REST_MAX_MS = 24 * 60 * 60_000

/**
 * One server, however it was written: the browser reports `turn:host` back as
 * `turn:host:3478?transport=udp`, and the two must be recognised as one.
 */
export function turnKey(url: string): string {
  const match = /^(turns?):(.+?)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim())
  if (!match) return url.trim().toLowerCase()
  const [, scheme, host, port, transport] = match as unknown as [string, string, string, string?, string?]
  const secure = scheme.toLowerCase() === 'turns'
  return `${scheme}:${host}:${port ?? (secure ? 5349 : 3478)}?transport=${transport ?? (secure ? 'tcp' : 'udp')}`.toLowerCase()
}

/** The key of a server entry: each entry the user adds names one address. */
export const serverKey = (server: RTCIceServer): string =>
  turnKey((Array.isArray(server.urls) ? server.urls[0] : server.urls) ?? '')

const fresh = (): TurnHealth => ({
  ok: 0,
  fail: 0,
  streak: 0,
  allocMs: 0,
  rttMs: 0,
  kbps: 0,
  error: 0,
  lastOkAt: 0,
  lastFailAt: 0,
})

const mean = (previous: number, sample: number): number =>
  Math.round(previous === 0 ? sample : previous * (1 - ALPHA) + sample * ALPHA)

/** Fold one request's outcome in. */
export function recordTurn(map: TurnHealthMap, outcome: TurnOutcome, now: number): void {
  const health = (map[turnKey(outcome.url)] ??= fresh())
  if ('ms' in outcome) {
    health.ok += 1
    health.streak = 0
    health.allocMs = mean(health.allocMs, outcome.ms)
    health.lastOkAt = now
  } else {
    health.fail += 1
    health.streak += 1
    health.error = outcome.error
    health.lastFailAt = now
  }
}

/** How long a TURN server may take to answer before its silence counts as a failure. */
export const NO_ANSWER_MS = 10_000

/**
 * Each TURN server's outcome, from what the browser reported by address. A
 * server it reported nothing for did not answer — when it has had long enough
 * (`silent`) to be judged by that; otherwise it is left out, unjudged.
 */
export function outcomesFor(
  servers: readonly RTCIceServer[],
  reported: readonly TurnOutcome[],
  silent: boolean,
): TurnOutcome[] {
  const out: TurnOutcome[] = []
  for (const server of servers.filter((entry) => hasTurnServer([entry]))) {
    const key = serverKey(server)
    const outcome = reported.find((candidate) => turnKey(candidate.url) === key)
    if (outcome) out.push(outcome)
    else if (silent) out.push({ url: key, error: 0 })
  }
  return out
}

/** What a call measured through the relay it ran on. */
export function recordRelayUse(map: TurnHealthMap, use: { url: string; rttMs: number; kbps: number }): void {
  const health = (map[turnKey(use.url)] ??= fresh())
  if (use.rttMs > 0) health.rttMs = mean(health.rttMs, use.rttMs)
  if (use.kbps > 0) health.kbps = mean(health.kbps, use.kbps)
}

/**
 * When a server that keeps failing may be asked again; 0 when it is not
 * resting. Ten minutes after the second failure in a row, doubling with each
 * further one, to a day.
 */
export function turnRetryAt(health: TurnHealth | undefined): number {
  if (!health || health.streak < 2) return 0
  return health.lastFailAt + Math.min(REST_MAX_MS, REST_BASE_MS * 2 ** Math.min(10, health.streak - 2))
}

/**
 * Rank a server: higher is better. Reliability, smoothed so one result is not
 * a verdict, squared — a relay that fails costs the call — and scaled by how
 * quickly it answers; a relay too narrow for video loses half. A server never
 * measured scores as middling, between one proven good and one proven bad.
 */
export function turnScore(health: TurnHealth | undefined): number {
  if (!health) return 0.25
  const reliability = (health.ok + 1) / (health.ok + health.fail + 2)
  const ms = health.rttMs || health.allocMs
  const speed = ms === 0 ? 0.75 : 1 / (1 + ms / 500)
  return reliability ** 2 * speed * (throttled(health) ? 0.5 : 1)
}

/** Whether calls measured a relay too narrow for video through this server. */
export const throttled = (health: TurnHealth): boolean => health.kbps > 0 && health.kbps < THROTTLED_KBPS

/**
 * The TURN servers to bring into a call, best first. Servers resting after
 * repeated failures are left out — unless every one is, since a call that
 * fails directly has nothing else to try.
 */
export function rankTurn<T extends RTCIceServer>(
  servers: readonly T[],
  map: TurnHealthMap,
  now: number,
): T[] {
  const turn = servers.filter((server) => hasTurnServer([server]))
  const awake = turn.filter((server) => turnRetryAt(map[serverKey(server)]) <= now)
  const score = (server: T) => turnScore(map[serverKey(server)])
  return (awake.length > 0 ? awake : turn).sort((a, b) => score(b) - score(a))
}

/** How long a password made from a shared secret is good for: any call, and nothing after. */
export const MINTED_TTL_SEC = 24 * 60 * 60

/**
 * The servers as the browser takes them: a shared secret becomes a username
 * and password for this call, by the TURN REST scheme coturn implements — the
 * username is an expiry time, the password an HMAC-SHA1 of it under the
 * secret. The server checks both without asking anyone, the secret never
 * leaves this device, and what the server is shown stops working in a day.
 *
 * A server whose password cannot be made — no WebCrypto, outside a secure
 * context — is left out rather than offered with credentials sure to fail.
 */
export async function withCredentials(
  servers: readonly IceServerSetting[],
  now: number,
): Promise<RTCIceServer[]> {
  const out = await Promise.all(
    servers.map(async ({ secret, ...server }): Promise<RTCIceServer | null> => {
      if (!secret) return server
      try {
        return {
          ...server,
          ...(await mintCredential(String(server.credential ?? ''), server.username ?? '', now)),
        }
      } catch {
        return null
      }
    }),
  )
  return out.filter((server): server is RTCIceServer => server !== null)
}

export async function mintCredential(
  secret: string,
  user: string,
  now: number,
): Promise<{ username: string; credential: string }> {
  const username = `${Math.floor(now / 1000) + MINTED_TTL_SEC}${user ? `:${user}` : ''}`
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(username)))
  // Base64 by hand: importing the byte helpers here regroups the modules the
  // shell shares with lazy chunks, and that costs the precache a chunk.
  return { username, credential: btoa(String.fromCharCode(...mac)) }
}

const encode = (text: string) => new TextEncoder().encode(text)

/** The health map, read back from where it is kept. Anything unreadable starts afresh. */
export async function loadTurnHealth(store: TurnStore): Promise<TurnHealthMap> {
  try {
    return (await store.getState<TurnHealthMap>(TURN_HEALTH)) ?? {}
  } catch {
    return {}
  }
}

export type TurnStore = {
  getState<T>(name: string): Promise<T | null>
  putState(name: string, value: unknown): Promise<void>
}
