import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { emptyHealth, type Contact, type RelayEntry, type RelayHealth } from '../models/types'
import type { VaultRepo } from '../vault/repo'
import type { IRelayPool } from './relayPool'
import { DEFAULT_DM_RELAYS } from './defaultRelays'
import { normalizeRelayUrl } from './relayUrl'
import { FANOUT, isDead, relayScore, seededReliability, usable } from './relayScore'

/**
 * Finding relays, testing them from here, and replacing the ones that died
 * (ADR-067). A lazy chunk: none of it is downloaded unless a configured relay
 * has died, or someone opens the relay settings and asks.
 *
 * Every relay is judged by a test run from this device, never by what anyone
 * says about it. A relay is usable when it opens a connection, answers a
 * gift-wrap inbox query without demanding sign-in, and accepts a gift wrap
 * from a key it has never seen — what every message to this person will be.
 * Public monitors (NIP-66) report relays as open that refuse exactly that
 * query, and measure their speed from somewhere else entirely.
 *
 * Where candidates come from, most trusted first: the relays this person's
 * contacts read their inbox on, which reveals nothing that messaging those
 * contacts does not; the relays Textor ships with; and, only when asked,
 * relays that public monitors report. Only the first two are ever added
 * without asking, and a contact's relay only once two contacts use it: one
 * contact alone could otherwise steer this inbox onto a relay they run.
 */

/** Relays Textor offers beyond its defaults, vetted with `npm run relays:probe` in October 2026. */
export const CATALOG: readonly string[] = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://relay.nos.social',
  'wss://relay.ditto.pub',
  'wss://nostr.21crypto.ch',
  'wss://relay.coinos.io',
  'wss://nostr.data.haus',
  'wss://nostr.azzamo.net',
  'wss://nostr.bitcoiner.social',
  'wss://relay.angor.io',
  'wss://relay.minibits.cash',
]

/** NIP-66 relay discovery: one monitor's report on one relay. */
export const KIND_RELAY_REPORT = 30166
const KIND_GIFT_WRAP = 1059

/** One test's whole budget, connection included. */
const PROBE_TIMEOUT_MS = 10_000
/**
 * Relays tested side by side. Handshakes run in parallel over a slow or
 * proxied link start failing together, and read as a list of dead relays.
 */
const PROBE_CONCURRENCY = 2
/** Monitors that must report a relay before it is worth a test. */
const MIN_MONITORS = 2
const DECLINED = 'relay-declined'
const REPAIRS = 'relay-repairs'

export interface Probe {
  url: string
  ok: boolean
  /** Handshake, inbox answer (EOSE) and publish acknowledgement, in ms, as far as the test got. */
  connectMs?: number
  eoseMs?: number
  okMs?: number
  /** Why it failed, in the relay's words where it gave any. */
  reason?: string
}

export type CandidateSource = 'contacts' | 'textor' | 'monitors'

export interface Candidate {
  url: string
  source: CandidateSource
  /** Contacts who read their inbox there, or monitors who report it. */
  count: number
}

/** What a repair did: relays turned off, and relays added in their place. */
export interface Repair {
  at: number
  off: string[]
  added: string[]
}

export interface ScoutHost {
  repo: Pick<VaultRepo, 'listRelays' | 'upsertRelay' | 'listContacts' | 'getState' | 'putState'>
  /** The pool also makes the sockets a test runs over, as it makes its own. */
  pool: ScoutPool
  /** Put a changed relay list into effect: the pool, the inbox, the announcement. */
  apply: () => Promise<void>
  now?: () => number
}

export type ScoutPool = Pick<IRelayPool, 'statuses' | 'query' | 'rankedReadRelays' | 'open'>

/**
 * Test one relay from this device.
 *
 * Asks for a stranger's gift wraps and publishes a real one, sealed from a
 * throwaway key to another and expiring within the hour: indistinguishable
 * from any message, readable by nobody, and gone soon after.
 */
export function probeRelay(pool: ScoutPool, url: string): Promise<Probe> {
  return new Promise((resolve) => {
    const probe: Probe = { url, ok: false }
    const inbox = { kinds: [KIND_GIFT_WRAP], '#p': [stranger()], limit: 1 }
    let read = false
    let wrote = false
    let done = false
    const socket = pool.open(url, {
      onOpen: (ms) => {
        probe.connectMs = ms
        void socket.publish(throwawayWrap(), PROBE_TIMEOUT_MS, false).then((result) => {
          if (!result.ok) return finish(result.error)
          probe.okMs = result.ms
          wrote = true
          if (read) finish()
        })
      },
      onConnectFailed: (reason) => finish(reason),
      onDropped: (reason) => finish(reason),
    })
    socket.subscribe('probe', {
      filter: () => inbox,
      onEvent: () => undefined,
      onEose: () => {
        const progress = socket.progressOf('probe')!
        probe.eoseMs = progress.eoseAt - progress.reqAt
        read = true
        if (wrote) finish()
      },
      onClosed: (reason) => finish(reason || 'refused the inbox query'),
    })
    const timer = setTimeout(() => finish('timed out'), PROBE_TIMEOUT_MS)

    // Called without a reason only once both have answered, so a test that
    // failed always says why.
    function finish(reason?: string): void {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      probe.ok = read && wrote
      if (!probe.ok) probe.reason = reason!.slice(0, 160)
      resolve(probe)
    }
    socket.connect()
  })
}

/**
 * Test relays a couple at a time, in order, telling `onProbe` as each
 * finishes. With `enough`, no further test starts once that many have passed.
 */
export async function probeRelays(
  pool: ScoutPool,
  urls: readonly string[],
  opts: { enough?: number; onProbe?: (probe: Probe) => void } = {},
): Promise<Probe[]> {
  const probes: Probe[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < urls.length && probes.filter((probe) => probe.ok).length < (opts.enough ?? Infinity)) {
      const probe = await probeRelay(pool, urls[next++]!)
      probes.push(probe)
      opts.onProbe?.(probe)
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker))
  return probes
}

/** The best first: fast to answer and to acknowledge, as a relay in use is ranked. */
export function rankProbes(probes: readonly Probe[], now: number): Probe[] {
  const score = (probe: Probe): number =>
    probe.ok ? relayScore(healthFromProbe(probe, now), { open: false, now, read: true }) : -1
  return [...probes].sort((a, b) => score(b) - score(a))
}

/** A starting record for a relay added on the strength of a test, so it is ranked from the start. */
export function healthFromProbe(probe: Probe, now = Date.now()): RelayHealth {
  return {
    ...emptyHealth(),
    connectOk: 1,
    connectMs: probe.connectMs ?? 0,
    eoseMs: probe.eoseMs ?? 0,
    latencyMs: probe.okMs ?? 0,
    publishOk: 1,
    reliability: seededReliability({ publishOk: 1, publishFail: 0 }),
    lastOkAt: now,
  }
}

/**
 * Relays worth testing, none of them configured or turned down by this
 * person: contacts' inbox relays (most-used first), Textor's own, and — only
 * when asked — those public monitors report.
 */
export async function findCandidates(
  host: ScoutHost,
  opts: { monitors?: boolean } = {},
): Promise<Candidate[]> {
  const [entries, contacts, declined] = await Promise.all([
    host.repo.listRelays(),
    host.repo.listContacts(),
    declinedRelays(host.repo),
  ])
  const skip = new Set([...entries.map((entry) => entry.url), ...declined])
  const found = new Map<string, Candidate>()
  const add = (raw: string, source: CandidateSource, count: number): void => {
    const url = normalizeRelayUrl(raw)
    if (!url || skip.has(url)) return
    const seen = found.get(url)
    if (!seen) found.set(url, { url, source, count })
    else if (seen.source === source) seen.count += count
  }
  for (const contact of contacts.filter(trusted)) for (const url of contact.relays) add(url, 'contacts', 1)
  for (const url of [...DEFAULT_DM_RELAYS, ...CATALOG]) add(url, 'textor', 0)
  if (opts.monitors) {
    for (const report of await monitorReports(host.pool, (host.now ?? Date.now)())) {
      add(report.url, 'monitors', report.count)
    }
  }
  const rank: Record<CandidateSource, number> = { contacts: 0, textor: 1, monitors: 2 }
  return [...found.values()].sort((a, b) => rank[a.source] - rank[b.source] || b.count - a.count)
}

/**
 * NIP-66: relays that public monitors report open to anyone, as nominations.
 *
 * Read from the single best relay in use, a day back, from a hundred reports:
 * each report runs to a kilobyte or more, and a full sweep would cost a
 * slow connection more than every message of the day. Only relays reported
 * by two or more monitors, as needing neither sign-in nor payment, on the
 * open internet. What monitors claim decides only what gets tested.
 */
export async function monitorReports(
  pool: ScoutPool,
  now: number,
): Promise<{ url: string; count: number }[]> {
  const events = await pool.query(
    { kinds: [KIND_RELAY_REPORT], '#R': ['!auth'], since: Math.floor(now / 1000) - 86_400, limit: 100 },
    pool.rankedReadRelays(1),
    { maxWait: 8000 },
  )
  const monitors = new Map<string, Set<string>>()
  for (const event of events) {
    const url = normalizeRelayUrl(tagValue(event, 'd') ?? '')
    const needs = event.tags.filter((tag) => tag[0] === 'R').map((tag) => tag[1])
    const network = tagValue(event, 'n') ?? 'clearnet'
    if (!url || needs.includes('auth') || needs.includes('payment') || network !== 'clearnet') continue
    const by = monitors.get(url) ?? new Set<string>()
    monitors.set(url, by.add(event.pubkey))
  }
  return [...monitors]
    .filter(([, by]) => by.size >= MIN_MONITORS)
    .map(([url, by]) => ({ url, count: by.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
}

/**
 * Turn off configured relays that are dead (see `isDead`), and add tested
 * replacements while fewer than four would otherwise be working — never more
 * than the person had chosen to read from. Null when there was nothing to do,
 * or nothing it could safely do.
 *
 * A dead relay is turned off rather than deleted, so the list still shows it
 * and it can be turned back on. And never the last: with nothing working and
 * nothing found, turning it off would leave nothing at all to try.
 */
export async function repairRelays(host: ScoutHost): Promise<Repair | null> {
  const now = (host.now ?? Date.now)()
  const live = new Map(host.pool.statuses().map((status) => [status.url, status.health]))
  const healthOf = (entry: RelayEntry): RelayHealth => live.get(entry.url) ?? entry.health
  const entries = (await host.repo.listRelays()).filter((entry) => entry.enabled)
  const dead = entries.filter((entry) => isDead(healthOf(entry), now))
  if (dead.length === 0) return null

  const readers = entries.filter((entry) => entry.read)
  const working = readers.filter((entry) => !dead.includes(entry) && usable(healthOf(entry), now)).length
  const wanted = Math.min(FANOUT, readers.length) - working
  const candidates = (await findCandidates(host)).filter(
    (candidate) => candidate.source === 'textor' || candidate.count >= 2,
  )
  const passed =
    wanted > 0
      ? rankProbes(
          await probeRelays(
            host.pool,
            candidates.map((candidate) => candidate.url),
            { enough: wanted },
          ),
          now,
        )
          .filter((probe) => probe.ok)
          .slice(0, wanted)
      : []
  if (working + passed.length === 0) return null

  for (const probe of passed) {
    await host.repo.upsertRelay(probe.url, {
      read: true,
      write: true,
      enabled: true,
      discovered: true,
      health: healthFromProbe(probe, now),
    })
  }
  for (const entry of dead)
    await host.repo.upsertRelay(entry.url, { enabled: false, health: healthOf(entry) })
  const repair: Repair = {
    at: now,
    off: dead.map((entry) => entry.url),
    added: passed.map((probe) => probe.url),
  }
  await host.repo.putState(REPAIRS, [repair, ...(await repairs(host.repo))].slice(0, 8))
  await host.apply()
  return repair
}

/** What repairs have done, newest first, for the relay settings to say. */
export async function repairs(repo: ScoutHost['repo']): Promise<Repair[]> {
  return (await repo.getState<Repair[]>(REPAIRS)) ?? []
}

export async function clearRepairs(repo: ScoutHost['repo']): Promise<void> {
  await repo.putState(REPAIRS, [])
}

/** A relay this person removed: never suggested or added back on their behalf. */
export async function declineRelay(repo: ScoutHost['repo'], url: string): Promise<void> {
  const declined = await declinedRelays(repo)
  if (!declined.includes(url)) await repo.putState(DECLINED, [url, ...declined].slice(0, 64))
}

async function declinedRelays(repo: ScoutHost['repo']): Promise<string[]> {
  return (await repo.getState<string[]>(DECLINED)) ?? []
}

/** Someone this person has let in: not blocked, and not a stranger who wrote first. */
const trusted = (contact: Contact): boolean => contact.accepted && !contact.blocked

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((tag) => tag[0] === name)?.[1]

const stranger = (): string => getPublicKey(generateSecretKey())

/**
 * A gift wrap as NIP-59 makes one — encrypted, dated up to two days back,
 * expiring — from a throwaway key to another. Its sealed content is empty
 * padding: no relay can tell, and nobody holds the key to look.
 */
function throwawayWrap(): NostrEvent {
  const key = generateSecretKey()
  const to = stranger()
  const now = Math.floor(Date.now() / 1000)
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: now - Math.floor(Math.random() * 2 * 86_400),
      tags: [
        ['p', to],
        ['expiration', String(now + 3600)],
      ],
      content: encrypt('x'.repeat(400), getConversationKey(key, to)),
    },
    key,
  )
}
