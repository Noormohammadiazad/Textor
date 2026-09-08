import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { isExpired } from '../crypto/giftwrap'
import { createLogger } from '../util/log'
import { Mutex } from '../util/mutex'
import { DAY, HOUR, MINUTE } from '../util/time'
import type { NegentropyItem } from '../transport/negentropy'
import type { IRelayPool, SubCloser } from '../transport/relayPool'
import { HORIZON_SEC, inboxFilter, SYNC_REWIND_SEC } from '../transport/nostrTransport'
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
/**
 * A stored replay this long may have stopped at the relay's limit, not at the
 * end of what it holds. Measured, primal stops at 500 and wirednet at 200, and
 * each says EOSE as if that were everything (ADR-073). Asking once more costs a
 * small read; not asking loses whatever is older, for good.
 */
const PAGE_FROM_STORED = 20
/** How long one page may take. */
const PAGE_WAIT_MS = 15_000
/** Pages asked for in a row before giving up for now: tens of thousands of wraps. */
const MAX_PAGES = 64
/** Each relay standing by is looked in on this often, and one at most this often. */
const SWEEP_EVERY_MS = DAY
const SWEEP_SPACING_MS = HOUR

interface RelayRun {
  /** The mode the relay's current REQ was sent in. */
  mode: Mode
  /** Unix ms up to which this connection is known complete; 0 until it is. */
  syncedAt: number
  /** When that became known. Compared with REQ times to tell connections apart. */
  completedAt: number
  reconciling: Promise<void> | null
  /** Reading back past where the relay's replay stopped. */
  paging: boolean
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
 *
 * A relay's replay stops at its own limit, so a long one is read on backwards
 * with `until` before the mark moves. And one relay downloads at a time, asking
 * only for what no other relay has handed over by then, so a device with
 * everything to catch up on does not fetch it once per relay (ADR-073).
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
  #downloads = new Mutex()
  #holding = false
  #sweptAt = 0

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
    // A device with no history starts at the horizon every other device keeps
    // to: older than that, nothing can say whether it was since deleted.
    if (this.#state.lastSyncSec === 0 && this.#state.floorSec === 0) {
      this.#state.floorSec = Math.floor(this.#now() / 1000) - HORIZON_SEC
      this.#dirty = true
    }
    this.open()
  }

  /**
   * Keep every mark where it is. While a restore holds what it has read uncommitted
   * (ADR-078), nothing may say it was read, or being closed then would lose it.
   */
  hold(on: boolean): void {
    this.#holding = on
    if (!on) this.#save(true)
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
    // A device with no history waits for relays still connecting: there is
    // nothing else to show, and everything to read.
    const fresh = this.#state.lastSyncSec === 0
    const proven = (url: string): boolean => {
      const progress = sub.progress?.(url)
      const run = this.#runs.get(url)
      return progress?.open === true && !!run && run.completedAt >= progress.reqAt && run.syncedAt > 0
    }
    const targets: string[] = []
    for (const url of this.#pool.readRelays) {
      const progress = sub.progress?.(url)
      const run = this.#runs.get(url)
      if (!progress?.open || !run) {
        if (fresh) targets.push(url)
        continue
      }
      if (proven(url) && !opts.force) continue
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
            return (run?.completedAt ?? 0) >= startedAt || (!fresh && !sub.progress?.(url)?.open)
          }).length
          if (done >= targets.length) finish()
          else if (done >= enough && !graceTimer) graceTimer = setTimeout(finish, opts.graceMs ?? 1200)
        }
        const maxTimer = setTimeout(finish, opts.maxWaitMs ?? 8000)
        this.#listeners.add(check)
        check()
      })
    }
    // Only once a relay has actually been read. A relay with no mark of its own
    // reads from here, so a catch-up that reached nothing — the sockets of a
    // device just restored, still connecting — must not move it: that cut the
    // device's first read down to the last three days (ADR-073).
    if (this.#pool.readRelays.some(proven)) {
      this.#state.lastSyncSec = Math.floor(startedAt / 1000)
      this.#dirty = true
    }
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
      paging: false,
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
    const reqAt = progress?.reqAt ?? this.#now()
    if ((progress?.stored ?? 0) < PAGE_FROM_STORED) {
      this.#complete(url, run, reqAt)
      return
    }
    if (run.paging) return
    run.paging = true
    void this.#readBack(url, progress!.oldestAt).then((whole) => {
      run.paging = false
      if (whole) this.#complete(url, run, reqAt)
    })
  }

  /**
   * Read a relay's wraps from `until` back to its mark, a page at a time.
   * True once there is nothing older. False if it cannot be known: stopped, or a
   * page that ended some other way than the relay saying it was done.
   */
  #readBack(url: string, until: number): Promise<boolean> {
    return this.#downloads.run(async () => {
      const filter = inboxFilter(this.#pubkey, this.sinceFor(url))
      let from = until
      for (let page = 0; page < MAX_PAGES; page++) {
        let answered = false
        const events = await this.#pool.query({ ...filter, until: from }, [url], {
          maxWait: PAGE_WAIT_MS,
          onEose: () => (answered = true),
        })
        if (this.#stopped || !answered) return false
        if (events.length === 0) return true
        for (const event of events) await this.#receive(event)
        const oldest = Math.min(...events.map((event) => event.created_at))
        // A page all from one second has reached no further: step past it.
        from = oldest < from ? oldest : from - 1
      }
      log.info(`${url}: still more after ${MAX_PAGES} pages`)
      return false
    })
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

    await this.#fetch(url, filter, outcome.need)
    if (this.#stopped) return
    log.info(`${url}: reconciled in ${outcome.rounds} round(s), ${outcome.need.length} missing`)
    this.#setNeg(url, true)
    this.#complete(url, run, startedAt)
  }

  /**
   * Fetch what a reconciliation found missing, one relay at a time, leaving out
   * whatever another relay has handed over by the time each batch is asked for.
   */
  #fetch(url: string, filter: Filter, need: readonly string[]): Promise<void> {
    return this.#downloads.run(async () => {
      for (let i = 0; i < need.length && !this.#stopped; i += FETCH_BATCH) {
        const ids = need.slice(i, i + FETCH_BATCH).filter((id) => !this.#items!.has(id))
        if (ids.length === 0) continue
        const events = await this.#pool.query({ ...filter, ids }, [url], { maxWait: PAGE_WAIT_MS })
        for (const event of events) await this.#receive(event)
      }
    })
  }

  /**
   * Look in on one relay standing by, if one is due: a contact whose copy of
   * the announced list is out of date may have written there (ADR-067). At most
   * one an hour and each once a day, and the connection lapses afterwards.
   */
  async sweepStandby(): Promise<void> {
    const now = this.#now()
    if (this.#stopped || now - this.#sweptAt < SWEEP_SPACING_MS) return
    const inUse = this.#pool.rankedReadRelays()
    const sweptAt = (url: string): number => this.#state.relays[url]?.sweptAt ?? 0
    const url = this.#pool.readRelays
      .filter((relay) => !inUse.includes(relay) && now - sweptAt(relay) >= SWEEP_EVERY_MS)
      .sort((a, b) => sweptAt(a) - sweptAt(b))[0]
    if (!url) return
    this.#sweptAt = now
    const whole = await this.#visit(url, now)
    if (this.#stopped) return
    this.#state.relays[url] = {
      hwm: 0,
      ...this.#state.relays[url],
      sweptAt: now,
    }
    if (whole) this.#advance(url, Math.floor(now / 1000))
    this.#dirty = true
  }

  /** One read of a relay this device holds no connection to. True if it read everything. */
  async #visit(url: string, now: number): Promise<boolean> {
    const filter = inboxFilter(this.#pubkey, this.sinceFor(url))
    if (this.#mode(url) === 'negentropy') {
      // A small read first: it opens the connection a reconciliation needs.
      await this.#pool.query({ ...filter, limit: 1 }, [url], { maxWait: 6000 })
      const outcome = await this.#pool.reconcile(url, filter, await this.#itemsSince(filter.since!))
      if (outcome.ok) {
        await this.#fetch(url, filter, outcome.need)
        this.#setNeg(url, true)
        return true
      }
      if (outcome.refused) this.#setNeg(url, false)
    }
    return this.#readBack(url, Math.floor(now / 1000))
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
   *
   * Nor one past its own expiry. Whatever withdrew it asked to last at least as
   * long, so a relay still offering it may be offering it without the
   * withdrawal. It is noted as held, so a reconciliation stops asking for it.
   */
  #receive(wrap: NostrEvent): Promise<void> | void {
    if (wrap.created_at < this.#state.floorSec) return
    if (isExpired(wrap, Math.floor(this.#now() / 1000))) {
      this.noteWrap(wrap.id, wrap.created_at)
      return
    }
    return this.#onWrap(wrap)
  }

  #wake(): void {
    for (const listener of [...this.#listeners]) listener()
  }

  #save(force: boolean): void {
    if (!this.#dirty || this.#holding) return
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
