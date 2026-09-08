import type { SyncMark } from '../models/protocol'
import { MAX_GROUP_MEMBERS } from '../models/protocol'
import { DAY } from '../util/time'
import type { VaultRepo } from '../vault/repo'

const LOG_STATE = 'device-deleted'

/**
 * How long a deletion is remembered. A message can be sent again for about eighty
 * days if nobody confirms it (ADR-076). Past that, every copy has expired, and a
 * relay still offering one is refused for it.
 */
const KEEP_MS = 90 * DAY
/** So the record of them fits: the newest are kept, and frames still carry the rest for a month. */
const MAX_IDS = 2500
const MAX_CLEARS = 200

/** What has been deleted, as the sealed record holds it: rumor ids, and conversations up to a point. */
export interface DeletionRecord {
  ids: [string, number][]
  clear: (SyncMark & { at: number })[]
}

const isHex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** A record read from the relays, or null if it is not one. Its seal says it is ours, not that it is well made. */
export function readDeletionRecord(value: unknown): DeletionRecord | null {
  const { ids, clear } = (value ?? {}) as Partial<DeletionRecord>
  if (!Array.isArray(ids) || !Array.isArray(clear)) return null
  const idsOk = ids.every((entry) => Array.isArray(entry) && isHex64(entry[0]) && isTime(entry[1]))
  const clearOk = clear.every(
    (entry) =>
      entry &&
      Array.isArray(entry.with) &&
      entry.with.length > 0 &&
      entry.with.length < MAX_GROUP_MEMBERS &&
      entry.with.every(isHex64) &&
      isTime(entry.key) &&
      isTime(entry.at),
  )
  return idsOk && clearOk ? { ids, clear } : null
}

const clearKey = (mark: SyncMark): string => [...mark.with].sort().join()

/**
 * What this identity has deleted, kept so that a restore knows before it reads
 * anything (ADR-078).
 *
 * Frames say so too, but a relay may refuse a frame and go on serving what it
 * deleted, as `offchain` was measured doing. This adds up from every device, so it
 * can only grow until it expires, and being kept in a record, it reaches a restore
 * from any relay that holds it, whatever the rest hold.
 */
export class DeletionLog {
  readonly #repo: Pick<VaultRepo, 'getState' | 'putState'>
  readonly #now: () => number
  #ids = new Map<string, number>()
  #clear = new Map<string, SyncMark & { at: number }>()

  constructor(repo: Pick<VaultRepo, 'getState' | 'putState'>, now: () => number) {
    this.#repo = repo
    this.#now = now
  }

  async load(): Promise<void> {
    const stored = await this.#repo.getState<DeletionRecord>(LOG_STATE)
    if (!stored) return
    this.#ids = new Map(stored.ids)
    this.#clear = new Map(stored.clear.map((mark) => [clearKey(mark), mark]))
  }

  #save(): Promise<void> {
    return this.#repo.putState(LOG_STATE, this.record())
  }

  async note(id: string): Promise<void> {
    this.#ids.set(id, this.#now())
    await this.#save()
  }

  async noteClear(mark: SyncMark): Promise<void> {
    const key = clearKey(mark)
    this.#clear.set(key, { ...mark, at: this.#now() })
    await this.#save()
  }

  /** Add up what a record says, returning what this device had not heard of. */
  async merge(record: DeletionRecord): Promise<{ ids: string[]; clear: SyncMark[] }> {
    const ids: string[] = []
    const clear: SyncMark[] = []
    for (const [id, at] of record.ids) {
      if (!this.#ids.has(id)) ids.push(id)
      this.#ids.set(id, Math.max(this.#ids.get(id) ?? 0, at))
    }
    for (const mark of record.clear) {
      const key = clearKey(mark)
      const held = this.#clear.get(key)
      if (!held || held.key < mark.key) {
        this.#clear.set(key, mark)
        clear.push({ with: mark.with, key: mark.key })
      }
    }
    if (ids.length + clear.length > 0) await this.#save()
    return { ids, clear }
  }

  /** What the record should hold now: nothing expired, and the newest if there is too much. */
  record(): DeletionRecord {
    const floor = this.#now() - KEEP_MS
    return {
      ids: [...this.#ids]
        .filter(([, at]) => at >= floor)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_IDS),
      clear: [...this.#clear.values()]
        .filter((mark) => mark.at >= floor)
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_CLEARS),
    }
  }

  /** Whether a record already says everything this device would write. */
  isIn(held: DeletionRecord): boolean {
    const { ids, clear } = this.record()
    const has = new Set(held.ids.map(([id]) => id))
    const marks = new Map(held.clear.map((mark) => [clearKey(mark), mark.key]))
    return (
      ids.every(([id]) => has.has(id)) && clear.every((mark) => (marks.get(clearKey(mark)) ?? 0) >= mark.key)
    )
  }
}
