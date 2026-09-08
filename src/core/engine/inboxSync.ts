import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { createLogger } from '../util/log'
import { DAY, MINUTE } from '../util/time'
import type { NegentropyItem } from '../transport/negentropy'
import type { IRelayPool, SubCloser } from '../transport/relayPool'
import { inboxFilter, SYNC_REWIND_SEC } from '../transport/nostrTransport'
import type { SyncState } from '../vault/repo'

const log = createLogger('sync')

/** Where the sync state lives. The vault, in the app; a map, in tests. */
export interface InboxSyncStore {
  load(): Promise<SyncState>
  save(state: SyncState): Promise<void>
  /** Inbox wraps already held, created at or after `sinceSec`. */
  items(sinceSec: number): Promise<NegentropyItem[]>
}

export interface InboxSyncOptions {
  pool: IRelayPool
  store: InboxSyncStore
  pubkey: string
  onWrap: (wrap: NostrEvent) => Promise<void> | void
  now?: () => number
}

/** How a relay's inbox is being caught up on its current connection. */
type Mode = 'window' | 'negentropy'

/** After a relay says it does not do NIP-77, ask again this much later. */
const NEG_REFUSED_RETRY_MS = 7 * DAY
/** After a reconciliation fails for another reason, fall back for this long. */
const NEG_FAILED_FALLBACK_MS = 10 * MINUTE
/** Ids asked for per REQ when fetching what a reconciliation found missing. */
const FETCH_BATCH = 200
/** The sync state is written at most this often while it changes. */
const SAVE_EVERY_MS = 30_000

interface RelayRun {
  /** The mode the relay's current REQ was sent in. */
  mode: Mode
  /** Unix ms up to which this connection is known complete; 0 until it is. */
  syncedAt: number
  /** When that became known. Compared with REQ times to tell connections apart. */
  completedAt: number
  reconciling: Promise<void> | null
}

/**
 * Keeps the inbox complete, relay by relay, while downloading as little as
 * possible.
 *
 * Two things made catching up expensive. Gift-wrap timestamps are fuzzed up to
 * two days into the past, so every read has to reach three days behind the
 * point it resumes from — and it resumed from one cursor shared by every
 * relay, which only moved when a full catch-up finished. A session that stayed
 * connected for a week and then dropped a socket asked that relay for ten
 * days of wraps; and at start-up the live subscription and the catch-up read
 * each downloaded the same three days, from every relay.
 *
 * Now each relay has its own high-water mark, and advances it only on
 * evidence: the relay finished sending stored events for a REQ (EOSE), or a
 * reconciliation with it completed, and after that, every frame that arrives
 * on the same connection. A relay that speaks NIP-77 is subscribed live-only
 * (`limit: 0`) and then reconciled with negentropy, so only the wraps this
 * device lacks cross the network. One that does not, says so — usually as a
 * NOTICE — and is switched to the window query on the spot, and not asked
 * again for a week. See ADR-050.
 */
export class InboxSync {
  readonly #pool: IRelayPool
  readonly #store: InboxSyncStore
  readonly #pubkey: string
  readonly #onWrap: (wrap: NostrEvent) => Promise<void> | void
  readonly #now: () => number

  #state: SyncState = { lastSyncSec: 0, floorSec: 0, relays: {} }
  #sub: SubCloser | null = null
  #runs = new Map<string, RelayRun>()
  #fallbackUntil = new Map<string, number>()
  #items: Map<string, number> | null = null
  #itemsFrom = Infinity
  #dirty = false
  #lastSaveAt = 0
  #listeners = new Set<() => void>()
  #stopped = false

  constructor(opts: InboxSyncOptions) {
    this.#pool = opts.pool
    this.#store = opts.store
    this.#pubkey = opts.pubkey
    this.#onWrap = opts.onWrap
    this.#now = opts.now ?? Date.now
  }

  /** When the inbox was last caught up across the relays, unix seconds. */
  get lastSyncSec(): number {
    return this.#state.lastSyncSec
  }

  /** Wraps created before this are refused: see `SyncState.floorSec`. */
  get floorSec(): number {
    return this.#state.floorSec
  }

  /** A copy of the persisted state, for tests and diagnostics. */
  snapshot(): SyncState {
    return structuredClone(this.#state)
  }

  async start(): Promise<void> {
    this.#state = await this.#store.load()
    this.#stopped = false
    this.open()
  }

  /** (Re)open the live subscription, e.g. after the read relays changed. */
  open(): void {
    if (this.#stopped) return
    this.#sub?.close()
    this.#runs.clear()
    this.#sub = this.#pool.subscribe((url) => this.#filterFor(url), {
      onEvent: (wrap) => void this.#receive(wrap),
      onEose: (url) => this.#onEose(url ?? ''),
      label: 'inbox',
    })
  }

  stop(): void {
    this.#stopped = true
    this.#sub?.close()
    this.#sub = null
    this.#runs.clear()
    this.#wake()
    this.#save(true)
  }

  /** The earliest `created_at` a read from this relay needs to ask for. */
  sinceFor(url: string): number {
    const mark = this.#state.relays[url]?.hwm ?? this.#state.lastSyncSec
    return Math.max(this.#state.floorSec, mark - SYNC_REWIND_SEC, 0)
  }

  /** A wrap this device now holds, so reconciliations stop asking for it. */
  noteWrap(id: string, createdAt: number): void {
    if (this.#items && createdAt >= this.#itemsFrom) this.#items.set(id, createdAt)
  }

  /** The dedup horizon moved (see `VaultRepo.compactSeen`). */
  setFloor(floorSec: number): void {
    if (floorSec <= this.#state.floorSec) return
    this.#state.floorSec = floorSec
    if (this.#items) for (const [id, at] of this.#items) if (at < floorSec) this.#items.delete(id)
    this.#dirty = true
    this.#save(true)
  }

  /**
   * Catch every read relay up, and resolve once enough of them have.
   *
   * A relay whose current connection is already complete has nothing to do
   * unless `force` is set. Resolves when every relay is done, shortly after
   * half of them are, or after `maxWaitMs` — the live subscription keeps
   * running regardless, so a straggler's wraps still arrive, later.
   */
  async catchUp(opts: { force?: boolean; maxWaitMs?: number; graceMs?: number } = {}): Promise<void> {
    const sub = this.#sub
    if (!sub) return
    const startedAt = this.#now()
    const targets: string[] = []
    for (const url of this.#pool.readRelays) {
      const progress = sub.progress?.(url)
      const run = this.#runs.get(url)
      if (!progress?.open || !run) continue
      const complete = run.completedAt >= progress.reqAt && run.syncedAt > 0
      if (complete && !opts.force) continue
      targets.push(url)
      if (progress.eoseAt === 0) continue // still replaying; its EOSE finishes the job
      if (run.mode === 'negentropy') void this.#reconcile(url, run)
      else if (opts.force) sub.resend?.(url)
    }

    if (targets.length > 0) {
      await new Promise<void>((resolve) => {
        const enough = Math.max(1, Math.ceil(targets.length / 2))
        let graceTimer: ReturnType<typeof setTimeout> | null = null
        const finish = (): void => {
          this.#listeners.delete(check)
          clearTimeout(maxTimer)
          if (graceTimer) clearTimeout(graceTimer)
          resolve()
        }
        const check = (): void => {
          if (this.#stopped) return finish()
          const done = targets.filter((url) => {
            const run = this.#runs.get(url)
            return (run?.completedAt ?? 0) >= startedAt || !sub.progress?.(url)?.open
          }).length
          if (done >= targets.length) finish()
          else if (done >= enough && !graceTimer) graceTimer = setTimeout(finish, opts.graceMs ?? 1200)
        }
        const maxTimer = setTimeout(finish, opts.maxWaitMs ?? 8000)
        this.#listeners.add(check)
        check()
      })
    }
    this.#state.lastSyncSec = Math.floor(startedAt / 1000)
    this.#dirty = true
    this.tick()
  }

  /**
   * Advance each relay's high-water mark from what its connection has proved,
   * and write the state down now and then. Cheap; the engine calls it on its
   * heartbeat.
   */
  tick(): void {
    const sub = this.#sub
    if (sub) {
      for (const url of this.#pool.readRelays) {
        const progress = sub.progress?.(url)
        const run = this.#runs.get(url)
        if (!progress || !run || run.syncedAt === 0 || progress.reqAt === 0) continue
        // Only a connection this device finished catching up on proves anything.
        if (run.completedAt < progress.reqAt) continue
        const provenMs = Math.max(run.syncedAt, progress.lastRxAt)
        this.#advance(url, Math.floor(provenMs / 1000))
      }
    }
    this.#save(false)
  }

  // --- per relay ------------------------------------------------------------

  #mode(url: string): Mode {
    if ((this.#fallbackUntil.get(url) ?? 0) > this.#now()) return 'window'
    const neg = this.#state.relays[url]?.neg
    if (neg && !neg.ok && this.#now() - neg.at < NEG_REFUSED_RETRY_MS) return 'window'
    return 'negentropy'
  }

  #filterFor(url: string): Filter {
    const mode = this.#mode(url)
    const run = this.#runs.get(url)
    this.#runs.set(url, {
      mode,
      syncedAt: run?.syncedAt ?? 0,
      completedAt: run?.completedAt ?? 0,
      reconciling: null,
    })
    // Live-only still needs the rewind: a wrap published a minute from now
    // may carry a timestamp two days old, and must still match.
    if (mode === 'negentropy') {
      return { ...inboxFilter(this.#pubkey, Math.floor(this.#now() / 1000) - SYNC_REWIND_SEC), limit: 0 }
    }
    return inboxFilter(this.#pubkey, this.sinceFor(url))
  }

  #onEose(url: string): void {
    // A relay this subscription never asked, or asked before it was reopened.
    const run = this.#runs.get(url)
    if (!run) return
    if (run.mode === 'negentropy') {
      void this.#reconcile(url, run)
      return
    }
    const progress = this.#sub?.progress?.(url)
    this.#complete(url, run, progress?.reqAt ?? this.#now())
  }

  /** One reconciliation per relay at a time: a second request joins the first. */
  #reconcile(url: string, run: RelayRun): Promise<void> {
    run.reconciling ??= this.#reconcileOnce(url, run).finally(() => {
      run.reconciling = null
    })
    return run.reconciling
  }

  async #reconcileOnce(url: string, run: RelayRun): Promise<void> {
    const startedAt = this.#now()
    const since = this.sinceFor(url)
    const filter = inboxFilter(this.#pubkey, since)
    const outcome = await this.#pool.reconcile(url, filter, await this.#itemsSince(since))
    if (this.#stopped) return

    if (!outcome.ok) {
      log.info(`${url}: negentropy ${outcome.refused ? 'not supported' : 'failed'} (${outcome.reason})`)
      if (outcome.refused) this.#setNeg(url, false)
      else this.#fallbackUntil.set(url, this.#now() + NEG_FAILED_FALLBACK_MS)
      // Fall back on this connection: the window query replays what the
      // relay holds, and its EOSE completes the relay.
      this.#sub?.resend?.(url)
      this.#wake()
      return
    }

    for (let i = 0; i < outcome.need.length; i += FETCH_BATCH) {
      const ids = outcome.need.slice(i, i + FETCH_BATCH)
      const events = await this.#pool.query({ ...filter, ids }, [url], { maxWait: 15_000 })
      for (const event of events) await this.#receive(event)
      if (this.#stopped) return
    }
    log.info(`${url}: reconciled in ${outcome.rounds} round(s), fetched ${outcome.need.length}`)
    this.#setNeg(url, true)
    this.#complete(url, run, startedAt)
  }

  /**
   * The relay is complete up to `syncedAt`. Recorded on the run it was
   * learned on — even one the subscription has since replaced, since what a
   * reconciliation proved about the relay stays true.
   */
  #complete(url: string, run: RelayRun, syncedAt: number): void {
    run.syncedAt = syncedAt
    run.completedAt = this.#now()
    this.#advance(url, Math.floor(syncedAt / 1000))
    this.#wake()
  }

  #advance(url: string, sec: number): void {
    const mark = this.#state.relays[url]
    if (mark && mark.hwm >= sec) return
    this.#state.relays[url] = { ...mark, hwm: sec }
    this.#dirty = true
  }

  #setNeg(url: string, ok: boolean): void {
    const mark = this.#state.relays[url] ?? { hwm: 0 }
    if (mark.neg?.ok === ok && ok) return
    this.#state.relays[url] = { ...mark, neg: { ok, at: this.#now() } }
    this.#dirty = true
  }

  async #itemsSince(since: number): Promise<NegentropyItem[]> {
    if (!this.#items || since < this.#itemsFrom) {
      const loaded = await this.#store.items(since)
      const items = this.#items ?? new Map<string, number>()
      for (const { id, createdAt } of loaded) items.set(id, createdAt)
      this.#items = items
      this.#itemsFrom = since
    }
    const out: NegentropyItem[] = []
    for (const [id, createdAt] of this.#items) if (createdAt >= since) out.push({ id, createdAt })
    return out
  }

  /**
   * Hand a wrap on, unless it is older than the floor: its seen mark may have
   * been pruned, so there is no telling whether it was processed already, and
   * it is refused rather than risk bringing back something deleted.
   */
  #receive(wrap: NostrEvent): Promise<void> | void {
    if (wrap.created_at < this.#state.floorSec) return
    return this.#onWrap(wrap)
  }

  #wake(): void {
    for (const listener of [...this.#listeners]) listener()
  }

  #save(force: boolean): void {
    if (!this.#dirty) return
    if (!force && this.#now() - this.#lastSaveAt < SAVE_EVERY_MS) return
    this.#dirty = false
    this.#lastSaveAt = this.#now()
    this.#store.save(structuredClone(this.#state)).catch((err: unknown) => {
      this.#dirty = true
      log.warn('could not save sync state', err)
    })
  }
}

/** Exposed for tests: how long each fallback lasts, and how often state is written. */
export const INBOX_SYNC_TIMING = { NEG_REFUSED_RETRY_MS, NEG_FAILED_FALLBACK_MS, SAVE_EVERY_MS }
