import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { Emitter } from '../util/emitter'
import { createLogger } from '../util/log'
import { emptyHealth, type RelayHealth } from '../models/types'
import { KIND_GIFT_WRAP } from '../crypto/giftwrap'
import { normalizeRelayUrl } from './relayUrl'
import {
  RelaySocket,
  type PublishResult,
  type RelaySocketHooks,
  type RelaySocketOptions,
  type SocketState,
  type SubscriptionProgress,
} from './relaySocket'
import type { NegentropyClient, NegentropyItem } from './negentropy'
import {
  chooseRelays,
  circuitState,
  FANOUT,
  isLargeEvent,
  isSizeRefusal,
  quorumFor,
  READ_RETRY_MS,
  recordConnect,
  recordDrop,
  recordEose,
  recordPublish,
  refusesLarge,
  relayScore,
  seededReliability,
  trialAt,
  usable,
} from './relayScore'

const log = createLogger('relays')

export type RelayConnectionState = 'idle' | 'connecting' | 'online' | 'offline'

export interface RelayStatus {
  url: string
  state: RelayConnectionState
  health: RelayHealth
  /** Among the relays the pool keeps connected and leans on (ADR-067). */
  active: boolean
}

export type PublishOutcome = { url: string; ok: true; ms: number } | { url: string; ok: false; error: string }

/**
 * A publish in progress, observable at two moments.
 *
 * `quorum` resolves as soon as enough relays have acknowledged — the moment a
 * message can honestly be called sent — or once every relay has answered if
 * that never happens. `settled` resolves when every relay has answered. The
 * work between the two continues in the background; nothing is cancelled.
 */
export interface PublishHandle {
  quorum: Promise<PublishOutcome[]>
  settled: Promise<PublishOutcome[]>
}

export interface SubCloser {
  close: (reason?: string) => void
  /**
   * How far the subscription has got on one relay's current connection, and
   * when that relay last sent anything. Null for a relay it is not held on.
   */
  progress?: (url: string) => RelayProgress | null
  /** Send the REQ to one relay again, re-evaluating its filter. */
  resend?: (url: string) => void
}

export interface RelayProgress extends SubscriptionProgress {
  open: boolean
  lastRxAt: number
}

/**
 * How a negentropy reconciliation ended.
 *
 * `refused` means the relay does not do NIP-77 at all, as opposed to having
 * failed this once — a dropped connection, a timeout, "too many records".
 */
export type ReconcileOutcome =
  { ok: true; need: string[]; rounds: number } | { ok: false; refused: boolean; reason: string }

export interface ReconcileOptions {
  /** Without any answer to the NEG-OPEN by then, the relay is taken not to speak NIP-77. */
  firstReplyMs?: number
  /** Upper bound on the whole exchange. */
  maxWaitMs?: number
  /** Rounds after which the exchange is abandoned as not converging. */
  maxRounds?: number
}

/** Why the app thinks the network may have changed under it. */
export type WakeReason = 'online' | 'visible' | 'focus' | 'resume'

export type RelayPoolEvents = {
  statusChanged: RelayStatus[]
}

export interface QueryOptions {
  /** Upper bound on the whole query. */
  maxWait?: number
  /**
   * Resolve this long after half the reachable relays have finished, instead
   * of waiting on the slowest. Only for reads a live subscription also covers,
   * where a straggler's events are not lost, merely delivered later.
   */
  graceMs?: number
  /** A relay said it had sent everything: unlike running out of time, or the connection going. */
  onEose?: (url: string) => void
}

/**
 * The surface the rest of the app depends on. Depending on the interface rather
 * than the class keeps the engine testable against an in-memory relay network,
 * which is the only way to exercise two-peer delivery deterministically.
 */
export interface IRelayPool {
  readonly events: Emitter<RelayPoolEvents>
  /** Configured, whether or not they are in use. */
  readonly readRelays: string[]
  readonly writeRelays: string[]
  /** Open sockets among the read relays in use. */
  readonly onlineCount: number
  /**
   * Increments whenever a read relay loses its connection. If it has not
   * moved since the last catch-up read, the live subscription has seen
   * everything a new catch-up could find.
   */
  readonly epoch: number
  setRelays(read: string[], write: string[]): void
  seedHealth(entries: { url: string; health: RelayHealth }[]): void
  statuses(): RelayStatus[]
  healthSnapshot(): { url: string; health: RelayHealth }[]
  subscribe(
    filter: Filter | ((url: string) => Filter),
    handlers: {
      onEvent: (event: NostrEvent, url?: string) => void
      onEose?: (url?: string) => void
      label?: string
    },
    relays?: string[],
  ): SubCloser
  query(filter: Filter, relays?: string[], opts?: QueryOptions): Promise<NostrEvent[]>
  /** NIP-77: which events matching `filter` does this relay hold that `items` lacks? */
  reconcile(
    url: string,
    filter: Filter,
    items: readonly NegentropyItem[],
    opts?: ReconcileOptions,
  ): Promise<ReconcileOutcome>
  /** Publish and wait for every relay. For writes nobody is waiting on. */
  publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]>
  /** Publish on the critical path: see `PublishHandle`. */
  dispatch(
    event: NostrEvent,
    relays: string[],
    opts?: { quorum?: number; standbys?: string[] },
  ): PublishHandle
  /** The write relays in use, best first. */
  rankedWriteRelays(limit?: number): string[]
  /** The read relays in use, best first: where the inbox is read, and so where it is announced. */
  rankedReadRelays(limit?: number): string[]
  /** Lean on these for reading while they work: what this identity's other devices read (ADR-073). */
  preferRead(urls: readonly string[]): void
  /** Open sockets now for relays a message is likely to need shortly. */
  prewarm(relays: string[]): void
  /** A socket made as the pool makes its own, outside it: for testing a relay (ADR-067). */
  open(url: string, hooks: RelaySocketHooks): RelaySocket
  wake(reason: WakeReason): void
  destroy(): void
}

/** How long a publish may take, connection included, before it counts as failed. */
const PUBLISH_TIMEOUT_MS = 10_000
/** A pre-warmed relay is kept connected this long without being used. */
const PREWARM_HOLD_MS = 5 * 60_000
/** An unconfigured relay's socket lingers this long after last use. */
const LINGER_MS = 3 * 60_000
/** After a subscription is ended for a reason other than refusal, try again after this. */
const RESUBSCRIBE_MS = 30_000
/** Recent event ids remembered per subscription, for cross-relay dedup. */
const SEEN_CAPACITY = 4096
const NOTIFY_COALESCE_MS = 50

export interface RelayPoolOptions {
  socket?: RelaySocketOptions
  now?: () => number
  /** Where the NIP-77 client comes from: a lazy chunk, since it only ever runs online. */
  negentropy?: () => Promise<{ NegentropyClient: typeof NegentropyClient }>
}

/**
 * Relay connections, publishing policy, and health.
 *
 * Built on the premise that any relay may be slow, down, or quietly broken at
 * any moment, and that a person watching a spinner does not care which. So:
 *
 *  - Configured relays are connected as soon as they are known and kept
 *    connected. A message never waits for a handshake that could have happened
 *    earlier.
 *  - A publish goes to every target at once and is called sent at a quorum of
 *    acknowledgements, not when the slowest relay finally answers.
 *  - If that quorum is slow to form, the publish fans out to healthy relays
 *    that are already connected but were not targeted — failover to a hot
 *    standby costs a send, not a handshake.
 *  - Health is recency-weighted and a relay that keeps failing is stopped
 *    from being leaned on, without being dropped from delivery.
 *  - Only the best few are held open (ADR-067). The rest stand by, unconnected,
 *    and one is brought in the moment a relay in use goes down, refuses the
 *    inbox, or keeps failing publishes. A relay that is down is set aside and
 *    tried again at lengthening intervals, across sessions, rather than
 *    handshaken with every few seconds.
 */
export class RelayPool implements IRelayPool {
  readonly events = new Emitter<RelayPoolEvents>()

  #sockets = new Map<string, RelaySocket>()
  #health = new Map<string, RelayHealth>()
  #readUrls: string[] = []
  #writeUrls: string[] = []
  /** The relays in use, per role: see `chooseRelays`. */
  #activeRead: string[] = []
  #activeWrite: string[] = []
  #openedAt = new Map<string, number>()
  /** Subscriptions that follow the read relays in use, told whenever they change. */
  #managed = new Set<(urls: string[]) => void>()
  #trialTimer: ReturnType<typeof setTimeout> | null = null
  #pinnedUntil = new Map<string, number>()
  #lastUsed = new Map<string, number>()
  #epoch = 0
  #destroyed = false
  #socketOptions: RelaySocketOptions
  #now: () => number
  #negentropy: NonNullable<RelayPoolOptions['negentropy']>
  #notifyTimer: ReturnType<typeof setTimeout> | null = null
  #sweepTimer: ReturnType<typeof setTimeout> | null = null
  #serial = 0
  /** In-flight reads that want to hear when a relay cannot be reached. */
  #downListeners = new Set<(url: string) => void>()

  constructor(opts: RelayPoolOptions = {}) {
    this.#socketOptions = opts.socket ?? {}
    this.#now = opts.now ?? Date.now
    this.#negentropy = opts.negentropy ?? (() => import('./negentropy'))
  }

  get readRelays(): string[] {
    return [...this.#readUrls]
  }

  get writeRelays(): string[] {
    return [...this.#writeUrls]
  }

  get epoch(): number {
    return this.#epoch
  }

  get onlineCount(): number {
    return this.#activeRead.filter((url) => this.#sockets.get(url)?.isOpen).length
  }

  /**
   * Replace the configured relay set.
   *
   * The relays chosen to be used are connected immediately. This is the
   * pre-warm that matters most: it runs the moment the vault is unlocked, so
   * by the time someone has picked a conversation and typed a message, the
   * handshakes — one to ten seconds each on a slow link — are already behind
   * them.
   */
  setRelays(read: string[], write: string[]): void {
    this.#readUrls = dedupe(read)
    this.#writeUrls = dedupe(write)
    this.#rebalance()
  }

  seedHealth(entries: { url: string; health: RelayHealth }[]): void {
    for (const { url, health } of entries) {
      const key = normalizeRelayUrl(url)
      if (!key) continue
      // Merge onto a full default rather than spreading the stored record
      // directly. A vault written by an earlier build lacks newer counters, and
      // `undefined += 1` is NaN — which silently disables every comparison that
      // depends on it, so the relay keeps reporting itself healthy.
      const merged = { ...emptyHealth(), ...health }
      if (typeof (health as Partial<RelayHealth>).reliability !== 'number') {
        merged.reliability = seededReliability(merged)
      }
      this.#health.set(key, merged)
    }
    // A relay that was down last session is not handshaken with again until
    // its wait is over.
    this.#rebalance()
  }

  statuses(): RelayStatus[] {
    const urls = new Set([...this.#readUrls, ...this.#writeUrls, ...this.#health.keys()])
    const active = this.#activeSet()
    return [...urls].map((url) => ({
      url,
      state: connectionState(this.#sockets.get(url)?.state),
      health: { ...this.#healthFor(url) },
      active: active.has(url),
    }))
  }

  healthSnapshot(): { url: string; health: RelayHealth }[] {
    return [...this.#health.entries()].map(([url, health]) => ({ url, health: { ...health } }))
  }

  // --- reading --------------------------------------------------------------

  /**
   * Long-lived subscription, one per relay.
   *
   * One per relay rather than pooled so that a single relay refusing the
   * subscription — which is what NIP-42 `auth-required` looks like — is
   * attributable and visible (ADR-020). Events are deduplicated across relays
   * here, so the caller sees each once and the expensive work happens once.
   *
   * A function filter is re-evaluated on every reconnect, for that relay,
   * which is how the inbox resumes from each relay's own high-water mark
   * rather than from wherever that relay's newest event happened to be.
   *
   * Without `relays` it is held on the read relays in use, and follows them:
   * a relay brought in is subscribed at once, and asks from its own mark, so
   * a failover loses nothing (ADR-067).
   *
   * On an inbox read, the time to EOSE is measured, and an EOSE clears any
   * earlier refusal: the relay serves the inbox now, whatever it once said.
   */
  subscribe(
    filter: Filter | ((url: string) => Filter),
    handlers: {
      onEvent: (event: NostrEvent, url?: string) => void
      onEose?: (url?: string) => void
      label?: string
    },
    relays?: string[],
  ): SubCloser {
    let targets = relays ? dedupe(relays) : [...this.#activeRead]
    if (relays && targets.length === 0) {
      log.warn('subscribe called with no relays')
      return { close: () => undefined }
    }

    const id = `${handlers.label ?? 'sub'}:${++this.#serial}`
    const filterFn = typeof filter === 'function' ? filter : () => filter
    // A payload's chunks are wraps too (ADR-075), and say nothing about the inbox.
    const inboxRead = (url: string): boolean => handlers.label !== 'blob' && isInboxRead(filterFn(url))
    const seen = new RecentIds(SEEN_CAPACITY)
    const retries = new Map<string, ReturnType<typeof setTimeout>>()
    let closed = false

    const attach = (url: string): void => {
      if (closed || this.#destroyed) return
      const socket = this.#socket(url)
      socket.subscribe(id, {
        filter: () => filterFn(url),
        alreadyHave: (eventId) => {
          if (!seen.has(eventId)) return false
          this.#healthFor(url).eventsReceived += 1
          return true
        },
        // Only events no relay has delivered yet reach here: `alreadyHave`
        // is asked first, for every frame.
        onEvent: (event) => {
          this.#healthFor(url).eventsReceived += 1
          seen.add(event.id)
          handlers.onEvent(event, url)
        },
        onEose: () => {
          const progress = socket.progressOf(id)!
          if (inboxRead(url)) recordEose(this.#healthFor(url), progress.eoseAt - progress.reqAt)
          handlers.onEose?.(url)
        },
        onClosed: (reason) => {
          const health = this.#healthFor(url)
          health.lastErrorAt = this.#now()
          health.lastError = reason.slice(0, 160)
          if (isSubscriptionRefusal(reason)) {
            // Up and talking, but it will not hand us this. Retrying would
            // only hide that from the relay panel. A refused inbox puts the
            // relay out of use until it is asked again (`READ_RETRY_MS`).
            if (inboxRead(url)) {
              health.readFail += 1
              health.readFailAt = this.#now()
              health.lastReadError = reason.slice(0, 160)
              this.#rebalance()
            }
          } else {
            // (Not after `close`: that unsubscribes, and the relay's frames
            // for this subscription are dropped unread from then on.)
            retries.set(
              url,
              setTimeout(() => {
                retries.delete(url)
                attach(url)
              }, RESUBSCRIBE_MS),
            )
          }
          this.#notify()
        },
      })
      socket.connect()
    }

    const detach = (url: string): void => {
      clearTimeout(retries.get(url))
      retries.delete(url)
      this.#sockets.get(url)?.unsubscribe(id)
    }
    const follow = (urls: string[]): void => {
      for (const url of targets) if (!urls.includes(url)) detach(url)
      for (const url of urls) if (!targets.includes(url)) attach(url)
      targets = [...urls]
    }
    if (!relays) this.#managed.add(follow)
    for (const url of targets) attach(url)

    return {
      close: () => {
        closed = true
        this.#managed.delete(follow)
        for (const url of targets) detach(url)
      },
      progress: (url) => {
        const socket = this.#sockets.get(url)
        const progress = socket?.progressOf(id)
        if (!socket || !progress) return null
        return { ...progress, open: socket.isOpen, lastRxAt: socket.lastRxAt }
      },
      resend: (url) => {
        if (closed || !targets.includes(url)) return
        detach(url)
        attach(url)
      },
    }
  }

  /**
   * Run a NIP-77 negentropy reconciliation with one relay.
   *
   * Only over a connection that is already open: this is a catch-up that
   * follows a live subscription, never the reason to connect, so a relay that
   * is down simply reports it and is tried again when it comes back.
   */
  async reconcile(
    url: string,
    filter: Filter,
    items: readonly NegentropyItem[],
    opts: ReconcileOptions = {},
  ): Promise<ReconcileOutcome> {
    // A chunk that cannot be fetched is a failure, not a refusal: the window
    // query does the job for now, and the relay is asked again soon.
    const loaded = await this.#negentropy().catch(() => null)
    if (!loaded) return { ok: false, refused: false, reason: 'could not load' }
    const socket = this.#sockets.get(url)
    if (!socket?.isOpen) return { ok: false, refused: false, reason: 'not connected' }
    const firstReplyMs = opts.firstReplyMs ?? 6000
    const maxWaitMs = opts.maxWaitMs ?? 30_000
    const maxRounds = opts.maxRounds ?? 64

    return new Promise<ReconcileOutcome>((resolve) => {
      const id = `neg:${++this.#serial}`
      const client = new loaded.NegentropyClient(items)
      const need = new Set<string>()
      let rounds = 0
      // Once only, by construction: closing the exchange here means the
      // socket forgets it, and nothing reaches these handlers after.
      const finish = (outcome: ReconcileOutcome): void => {
        clearTimeout(firstReply)
        clearTimeout(overall)
        socket.negClose(id)
        resolve(outcome)
      }
      const firstReply = setTimeout(
        () => finish({ ok: false, refused: true, reason: 'no answer to NEG-OPEN' }),
        firstReplyMs,
      )
      const overall = setTimeout(
        () => finish({ ok: false, refused: false, reason: 'reconciliation timed out' }),
        maxWaitMs,
      )
      socket.negOpen(id, {
        filter,
        initial: client.initiate(),
        onMessage: (message) => {
          clearTimeout(firstReply)
          rounds += 1
          try {
            const step = client.reconcile(message)
            for (const eventId of step.need) need.add(eventId)
            if (step.next === null) finish({ ok: true, need: [...need], rounds })
            else if (rounds >= maxRounds) finish({ ok: false, refused: false, reason: 'did not converge' })
            else socket.negSend(id, step.next)
          } catch (err) {
            // A NegentropyError: the relay's message does not parse.
            finish({ ok: false, refused: false, reason: (err as Error).message })
          }
        },
        onError: (reason, refused) => finish({ ok: false, refused, reason }),
      })
    })
  }

  /**
   * One-shot read that resolves when the relays have finished sending.
   *
   * "Finished" is judged against relays that could answer at all: a relay
   * whose socket is down is not waited on. With `graceMs`, the read resolves
   * shortly after half of those have finished instead of waiting on the slowest.
   */
  async query(filter: Filter, relays?: string[], opts: QueryOptions = {}): Promise<NostrEvent[]> {
    const targets = relays ? dedupe(relays) : [...this.#activeRead]
    if (targets.length === 0) return []
    const maxWait = opts.maxWait ?? 6000

    return new Promise<NostrEvent[]>((resolve) => {
      const id = `q:${++this.#serial}`
      const events = new Map<string, NostrEvent>()
      const finished = new Set<string>()
      const timers: ReturnType<typeof setTimeout>[] = []
      let done = false

      const enough = Math.max(1, Math.ceil(targets.length / 2))

      // Once only: it clears every timer and listener that could call it again.
      const finish = (): void => {
        done = true
        for (const timer of timers) clearTimeout(timer)
        this.#downListeners.delete(onDown)
        for (const url of targets) this.#sockets.get(url)?.unsubscribe(id)
        resolve([...events.values()])
      }
      // A relay answers by finishing its stored events or by refusing; one
      // that cannot be reached at all has answered too, and is not waited on.
      const onFinished = (url: string): void => {
        if (done || finished.has(url)) return
        finished.add(url)
        if (finished.size >= targets.length) finish()
        else if (opts.graceMs !== undefined && finished.size === enough) {
          timers.push(setTimeout(finish, opts.graceMs))
        }
      }
      const onDown = (url: string): void => {
        if (targets.includes(url)) onFinished(url)
      }
      this.#downListeners.add(onDown)

      timers.push(setTimeout(finish, maxWait))
      for (const url of targets) {
        const socket = this.#socket(url)
        socket.subscribe(id, {
          filter: () => filter,
          alreadyHave: (eventId) => events.has(eventId),
          onEvent: (event) => {
            events.set(event.id, event)
          },
          onEose: () => {
            opts.onEose?.(url)
            onFinished(url)
          },
          onClosed: () => onFinished(url),
        })
        // Someone is waiting on this read, so a pending backoff is cut short.
        socket.connect(true)
      }
    })
  }

  // --- writing --------------------------------------------------------------

  async publish(event: NostrEvent, relays?: string[]): Promise<PublishOutcome[]> {
    return this.dispatch(event, relays ?? this.#writeUrls, { standbys: [] }).settled
  }

  /**
   * Publish on the critical path.
   *
   * Every target is published to at once. Relays whose circuit is open are
   * still included — they may be the only relay the recipient reads — but are
   * not forced to reconnect, so a relay known to be failing costs nothing
   * unless it has already recovered on its own.
   *
   * If the quorum has not formed within a delay derived from the targets' own
   * measured latency, the event also goes to standbys: healthy, already
   * connected relays that were not targeted. The same happens at once if every
   * target has failed. That is the difference between a failover that costs a
   * send and one that costs a handshake.
   */
  dispatch(
    event: NostrEvent,
    relays: string[],
    opts: { quorum?: number; standbys?: string[] } = {},
  ): PublishHandle {
    const now = this.#now()
    const large = isLargeEvent(event)
    // Not to a relay that has just refused one this size, unless there is
    // nowhere else: every byte of it would be uploaded to be turned away.
    const wanted = dedupe(relays)
    const willing = large ? wanted.filter((url) => !refusesLarge(this.#healthFor(url), now)) : wanted
    const targets = this.#rank(willing.length > 0 ? willing : wanted, now)
    const quorum = Math.min(opts.quorum ?? quorumFor(targets.length), Math.max(1, targets.length))

    const outcomes: PublishOutcome[] = []
    let acked = 0
    let pending = 0
    let quorumResolved = false
    let resolveQuorum!: (value: PublishOutcome[]) => void
    let resolveSettled!: (value: PublishOutcome[]) => void
    const quorumPromise = new Promise<PublishOutcome[]>((resolve) => (resolveQuorum = resolve))
    const settledPromise = new Promise<PublishOutcome[]>((resolve) => (resolveSettled = resolve))

    const launched = new Set<string>()
    const answered = new Set<string>()
    let standbys = dedupe(opts.standbys ?? this.#writeUrls)
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null

    const reachQuorum = (): void => {
      if (quorumResolved) return
      quorumResolved = true
      if (hedgeTimer) clearTimeout(hedgeTimer)
      this.#downListeners.delete(onDown)
      resolveQuorum([...outcomes])
    }

    // A target whose connection has just failed is not answering any time
    // soon, though its publish stays queued in case the relay comes back. If
    // every target still outstanding is in that state, waiting out the hedge
    // delay would be waiting on nothing.
    const stalled = new Set<string>()
    const maybeFailover = (): void => {
      if (quorumResolved || acked >= quorum || standbys.length === 0) return
      if ([...launched].every((u) => answered.has(u) || stalled.has(u))) launchStandbys()
    }
    const onDown = (url: string): void => {
      if (quorumResolved || !launched.has(url) || answered.has(url)) return
      stalled.add(url)
      maybeFailover()
    }
    this.#downListeners.add(onDown)

    const launchStandbys = (): boolean => {
      const ready = this.#rank(
        standbys.filter(
          (url) =>
            !launched.has(url) &&
            this.#sockets.get(url)?.isOpen === true &&
            circuitState(this.#healthFor(url), this.#now()) === 'closed',
        ),
        this.#now(),
      ).slice(0, Math.max(1, quorum - acked))
      standbys = []
      for (const url of ready) launch(url)
      return ready.length > 0
    }

    const launch = (url: string): void => {
      launched.add(url)
      pending += 1
      const socket = this.#socket(url)
      const urgent = circuitState(this.#healthFor(url), this.#now()) !== 'open'
      void socket.publish(event, PUBLISH_TIMEOUT_MS, urgent).then((result: PublishResult) => {
        answered.add(url)
        this.#recordPublish(url, result, large)
        outcomes.push(result.ok ? { url, ok: true, ms: result.ms } : { url, ok: false, error: result.error })
        if (result.ok) acked += 1
        pending -= 1
        if (acked >= quorum) reachQuorum()
        if (pending > 0) {
          maybeFailover()
          return
        }
        // Every relay tried so far has answered. Short of quorum, spend the
        // standbys before giving up rather than after a retry backoff.
        if (acked < quorum && !quorumResolved && standbys.length > 0 && launchStandbys()) return
        reachQuorum()
        resolveSettled([...outcomes])
      })
    }

    if (targets.length === 0) {
      this.#downListeners.delete(onDown)
      resolveQuorum([])
      resolveSettled([])
      return { quorum: quorumPromise, settled: settledPromise }
    }

    for (const url of targets) launch(url)

    if (standbys.length > 0) {
      hedgeTimer = setTimeout(
        // Cleared the moment the quorum forms, so it fires only short of one.
        () => {
          hedgeTimer = null
          launchStandbys()
        },
        this.#hedgeDelay(targets, quorum),
      )
    }

    return { quorum: quorumPromise, settled: settledPromise }
  }

  /**
   * How long to wait for a quorum before bringing in standbys.
   *
   * Two and a half times the expected latency of the relay that would complete
   * the quorum: long enough that a healthy relay is not second-guessed, short
   * enough that a stalled one is. Bounded so a relay that has never been
   * measured cannot make the wait unreasonable in either direction.
   */
  #hedgeDelay(ranked: string[], quorum: number): number {
    const latencies = ranked.map((url) => this.#healthFor(url).latencyMs).filter((ms) => ms > 0)
    latencies.sort((a, b) => a - b)
    const expected = latencies[Math.min(quorum, latencies.length) - 1]
    if (expected === undefined) return 2500
    return Math.min(4000, Math.max(1000, expected * 2.5))
  }

  rankedWriteRelays(limit = 8): string[] {
    return this.#rank(this.#activeWrite, this.#now()).slice(0, limit)
  }

  rankedReadRelays(limit = 8): string[] {
    return this.#rank(this.#activeRead, this.#now(), true).slice(0, limit)
  }

  preferRead(urls: readonly string[]): void {
    const wanted = dedupe([...urls]).filter((url) => this.#readUrls.includes(url))
    this.#activeRead = [...wanted, ...this.#activeRead.filter((url) => !wanted.includes(url))]
    this.#rebalance()
  }

  // --- connection management ------------------------------------------------

  prewarm(relays: string[]): void {
    const until = this.#now() + PREWARM_HOLD_MS
    for (const url of dedupe(relays)) {
      this.#pinnedUntil.set(url, until)
      this.#lastUsed.set(url, this.#now())
      const socket = this.#socket(url)
      if (circuitState(this.#healthFor(url), this.#now()) !== 'open') socket.connect()
    }
    this.#scheduleSweep()
  }

  open(url: string, hooks: RelaySocketHooks): RelaySocket {
    return new RelaySocket(url, hooks, this.#socketOptions)
  }

  /**
   * The network may have changed. Every socket the app wants is told so:
   * stale reconnect timers are dropped, and — unless this is merely a focus
   * change, which cannot have changed the network — apparently open sockets
   * are probed, because after sleep or a network switch many are dead.
   */
  wake(reason: WakeReason): void {
    const probe = reason !== 'focus'
    for (const [url, socket] of this.#sockets) {
      if (this.#isWanted(url)) socket.wake(probe)
    }
    this.#notify()
  }

  destroy(): void {
    this.#destroyed = true
    clearTimeout(this.#notifyTimer ?? undefined)
    clearTimeout(this.#sweepTimer ?? undefined)
    clearTimeout(this.#trialTimer ?? undefined)
    this.#notifyTimer = null
    this.#sweepTimer = null
    for (const socket of this.#sockets.values()) socket.close()
    this.#sockets.clear()
    this.events.clear()
  }

  #socket(url: string): RelaySocket {
    let socket = this.#sockets.get(url)
    if (socket) return socket
    socket = new RelaySocket(
      url,
      {
        onState: (state) => {
          if (state === 'closed' && !this.#isWanted(url)) {
            this.#sockets.delete(url)
            // A relay waiting for a trial is tried once nothing holds it open.
            this.#scheduleTrial(this.#now())
          }
          this.#notify()
        },
        onOpen: (ms) => {
          recordConnect(this.#healthFor(url), ms, this.#now())
          this.#openedAt.set(url, this.#now())
          // A relay back from being down may fill a place left empty.
          this.#rebalance()
        },
        onConnectFailed: (reason) => {
          const health = this.#healthFor(url)
          health.connectFail += 1
          // Counted towards being down only while another relay answers. With
          // none reachable the fault is this device's network, not the relay.
          if ([...this.#sockets.values()].some((other) => other.isOpen)) health.connectStreak += 1
          this.#lost(url, reason)
          // A trial of one of ours that is down: one attempt, not a retry loop.
          const socket = this.#sockets.get(url)!
          if (this.#configured().has(url) && !this.#isWanted(url) && socket.pendingPublishes === 0)
            socket.close()
          this.#rebalance()
        },
        onDropped: (reason) => {
          recordDrop(this.#healthFor(url), this.#now() - this.#openedAt.get(url)!)
          this.#lost(url, reason)
          this.#notify()
        },
      },
      this.#socketOptions,
    )
    this.#sockets.set(url, socket)
    this.#lastUsed.set(url, this.#now())
    if (!this.#activeSet().has(url)) this.#scheduleSweep()
    return socket
  }

  #lost(url: string, reason: string): void {
    const health = this.#healthFor(url)
    health.lastErrorAt = this.#now()
    health.lastError = reason.slice(0, 160)
    if (this.#activeRead.includes(url)) this.#epoch += 1
    for (const listener of [...this.#downListeners]) listener(url)
  }

  #recordPublish(url: string, result: PublishResult, large: boolean): void {
    const health = this.#healthFor(url)
    // Refused for its size, which says nothing of how the relay is working:
    // measured, offchain.pub takes small wraps and turns down anything over
    // a few kilobytes from a key it does not know (ADR-073).
    if (large && !result.ok && isSizeRefusal(result.error)) {
      health.largeRefusedAt = this.#now()
      health.lastError = result.error.slice(0, 160)
      return this.#notify()
    }
    recordPublish(health, result.ok ? { ok: true, ms: result.ms } : { ok: false }, this.#now())
    this.#lastUsed.set(url, this.#now())
    if (result.ok) return this.#notify()
    health.lastError = result.error.slice(0, 160)
    // A relay in use whose circuit has just opened gives up its place.
    if (this.#activeWrite.includes(url) && !usable(health, this.#now(), true)) this.#rebalance()
    else this.#notify()
  }

  #score(url: string, now: number, read = false): number {
    return relayScore(this.#healthFor(url), { open: this.#sockets.get(url)?.isOpen === true, now, read })
  }

  #rank(urls: string[], now: number, read = false): string[] {
    return [...urls].sort((a, b) => this.#score(b, now, read) - this.#score(a, now, read))
  }

  /**
   * Choose the relays to use, and bring the sockets in line (ADR-067).
   *
   * Called whenever something that bears on the choice changes: the
   * configuration, a connection opening or failing, a refused inbox, a
   * circuit opening. A relay dropped from use is disconnected unless
   * something else still wants it or a publish is waiting on it, in which
   * case the sweep lets it go once it is idle.
   */
  #rebalance(): void {
    if (this.#destroyed) return
    const now = this.#now()
    const before = this.#activeSet()
    const pick = (urls: string[], current: string[], write: boolean): string[] =>
      chooseRelays(
        urls,
        current,
        (url) => this.#score(url, now, !write),
        (url) => usable(this.#healthFor(url), now, write),
      )
    this.#activeRead = pick(this.#readUrls, this.#activeRead, false)
    this.#activeWrite = pick(this.#writeUrls, this.#activeWrite, true)
    for (const follow of this.#managed) follow(this.#activeRead)
    for (const url of before) {
      const socket = this.#sockets.get(url)
      if (!socket || this.#isWanted(url)) continue
      if (socket.pendingPublishes > 0) {
        this.#lastUsed.set(url, now)
        this.#scheduleSweep()
      } else {
        socket.close()
      }
    }
    for (const url of this.#activeSet()) this.#socket(url).connect()
    this.#scheduleTrial(now)
    this.#notify()
  }

  /**
   * Bring a relay back into consideration once its wait is over: try one
   * that is down, or let one that refused the inbox be asked again. Only
   * while a place in use is empty — with enough relays working, one that is
   * down is not needed, and trying it would be a handshake for nothing.
   */
  #scheduleTrial(now: number): void {
    clearTimeout(this.#trialTimer ?? undefined)
    this.#trialTimer = null
    const short =
      this.#activeRead.length < Math.min(FANOUT, this.#readUrls.length) ||
      this.#activeWrite.length < Math.min(FANOUT, this.#writeUrls.length)
    if (!short) return
    let due = Infinity
    for (const url of this.#configured()) {
      const health = this.#healthFor(url)
      const at = trialAt(health)
      if (at > 0) {
        if (!this.#sockets.has(url)) due = Math.min(due, at)
      } else if (!usable(health, now)) {
        due = Math.min(due, health.readFailAt + READ_RETRY_MS)
      }
    }
    if (due === Infinity) return
    this.#trialTimer = setTimeout(
      () => {
        this.#trialTimer = null
        const t = this.#now()
        for (const url of this.#configured()) {
          const at = trialAt(this.#healthFor(url))
          if (at > 0 && at <= t && !this.#sockets.has(url)) this.#socket(url).connect()
        }
        this.#rebalance()
      },
      Math.max(0, due - now),
    )
  }

  #activeSet(): Set<string> {
    return new Set([...this.#activeRead, ...this.#activeWrite])
  }

  #configured(): Set<string> {
    return new Set([...this.#readUrls, ...this.#writeUrls])
  }

  #isPinned(url: string): boolean {
    return (this.#pinnedUntil.get(url) ?? 0) > this.#now()
  }

  /**
   * In use, pinned, or carrying a subscription — a forward-secret group's
   * relays are whatever its creator chose, and must stay up while the group
   * is being listened to there.
   */
  #isWanted(url: string): boolean {
    return (
      this.#activeSet().has(url) || this.#isPinned(url) || this.#sockets.get(url)?.hasSubscriptions === true
    )
  }

  /**
   * Close sockets to relays not in use once they have gone unused for a
   * while — typically a contact's inbox relays after a conversation ends, or
   * a standby that was tried and not needed. Kept open until then so a
   * follow-up message is not another handshake.
   */
  #scheduleSweep(): void {
    if (this.#sweepTimer || this.#destroyed) return
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = null
      let transient = 0
      for (const [url, socket] of this.#sockets) {
        if (this.#activeSet().has(url)) continue
        if (this.#isPinned(url)) {
          // Still counted, so the sweep is around to close it once the pin lapses.
          transient += 1
          continue
        }
        const idle = this.#now() - this.#lastUsed.get(url)!
        if (idle >= LINGER_MS && socket.pendingPublishes === 0 && !socket.hasSubscriptions) {
          socket.close()
          this.#sockets.delete(url)
          this.#pinnedUntil.delete(url)
        } else {
          transient += 1
        }
      }
      if (transient > 0) this.#scheduleSweep()
    }, LINGER_MS / 3)
  }

  #healthFor(url: string): RelayHealth {
    let health = this.#health.get(url)
    if (!health) {
      health = emptyHealth()
      this.#health.set(url, health)
    }
    return health
  }

  /** Coalesced: a burst of socket events becomes one status update. */
  #notify(): void {
    if (this.#destroyed || this.#notifyTimer) return
    // Cleared by `destroy`, so it never fires on a pool that is gone.
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null
      this.events.emit('statusChanged', this.statuses())
    }, NOTIFY_COALESCE_MS)
  }
}

function connectionState(state: SocketState | undefined): RelayConnectionState {
  switch (state) {
    case 'open':
      return 'online'
    case 'connecting':
      return 'connecting'
    case 'backoff':
    case 'closed':
      return 'offline'
    default:
      return 'idle'
  }
}

/** A bounded set of recently seen ids; the oldest are forgotten first. */
class RecentIds {
  #ids = new Set<string>()
  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.#ids.has(id)
  }

  add(id: string): void {
    this.#ids.add(id)
    if (this.#ids.size > this.capacity) this.#ids.delete(this.#ids.values().next().value!)
  }
}

function dedupe(urls: string[]): string[] {
  const out = new Set<string>()
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url)
    if (normalized) out.add(normalized)
  }
  return [...out]
}

/**
 * The relay is up and talking, but declined to serve this subscription.
 *
 * Overwhelmingly NIP-42 (`auth-required: ...`), which several large relays have
 * begun demanding for gift-wrap inbox reads. Textor is anonymous by design and
 * does not authenticate to relays, so such a relay can never deliver mail — the
 * user needs to see that rather than a green tick.
 */
/** A read of our inbox: what a refusal or an EOSE says something about. */
const isInboxRead = (filter: Filter): boolean => filter.kinds?.includes(KIND_GIFT_WRAP) === true

function isSubscriptionRefusal(reason: string): boolean {
  const normalized = reason.toLowerCase()
  return (
    normalized.includes('auth-required') ||
    normalized.includes('restricted') ||
    normalized.includes('blocked') ||
    normalized.includes('not supported')
  )
}
