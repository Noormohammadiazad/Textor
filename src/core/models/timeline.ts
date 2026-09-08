import { MAX_CLOCK_AHEAD_MS } from '../util/time'

/**
 * Where an entry sits in a conversation: a hybrid logical clock, one per
 * conversation (ADR-063).
 *
 * Two times travel with every chat message, and they answer different
 * questions:
 *
 *  - `ts` is when its author sent it, by their own clock: what the bubble
 *    shows, in the reader's time zone. It is never adjusted.
 *  - `order` is where it sorts. It is the author's clock too, unless the
 *    conversation had already seen something later — then it is just after
 *    that. So anything sent after seeing an entry sorts after it, on every
 *    device, however far apart the clocks: a reply from a clock an hour behind
 *    still comes after its question.
 *
 * `order` travels in an `hlc` tag, so every device sorts by the same key, and
 * ties go by id. Each conversation keeps its own high-water mark (`clock`), so
 * a peer whose clock runs ahead moves only the conversations it is in. The
 * logical counter of a textbook HLC is folded into the millisecond: a key one
 * past the mark is `mark + 1`.
 */

export const HLC_TAG = 'hlc'

export interface TimelineEntry {
  ts: number
  order?: number
  id: string
}

/** Where an entry sorts. One stored before keys existed sorts by its own time, which is what it was given. */
export const orderOf = (entry: { ts: number; order?: number }): number => entry.order ?? entry.ts

/** Oldest first by key; a tie, which one clock can make but not one conversation's keys, by id. */
export function byTimeline(a: TimelineEntry, b: TimelineEntry): number {
  return orderOf(a) - orderOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** The key for an entry sent now: this clock, or just past everything the conversation has seen. */
export const nextOrder = (now: number, mark: number): number => Math.max(now, mark + 1)

export const orderTag = (order: number): string[] => [HLC_TAG, String(order)]

/**
 * The key an arriving entry carries, or its own time when it carries none
 * that holds.
 *
 * A key is never earlier than its author's own stamp — the clock it came from
 * was at least that — and never further ahead of this clock than a rumor may
 * be dated at all (`MAX_CLOCK_AHEAD_MS`, the bound the unwrap enforces). One
 * from another client, or from before keys existed, has no tag, and sorts by
 * its time.
 */
export function carriedOrder(tags: readonly string[][], ts: number, now: number): number {
  for (const tag of tags) {
    if (tag[0] !== HLC_TAG || !/^\d{1,16}$/.test(tag[1] ?? '')) continue
    const order = Number(tag[1])
    if (order >= ts && order <= now + MAX_CLOCK_AHEAD_MS) return order
  }
  return ts
}
