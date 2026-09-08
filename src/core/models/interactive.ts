import {
  cleanLine,
  isItemId,
  MAX_CHECKLIST_ITEMS,
  MAX_ITEM_CHARS,
  MAX_POLL_OPTIONS,
  type CheckFrame,
  type VoteFrame,
} from './protocol'

/**
 * Polls and shared checklists.
 *
 * Both are ordinary NIP-17 kind 14 messages. The structure rides in tags, and
 * the content is a plain-text rendering of it, so a client that has never
 * heard of either shows a readable question and its options — the same
 * contract attachments keep (ADR-041). Poll tags borrow NIP-88's shape
 * (`option` with an id and a label, `polltype`) so the vocabulary is one other
 * Nostr developers already know, but everything stays inside the gift wrap: a
 * public NIP-88 poll would publish who asked what of whom.
 *
 * Votes and ticks travel as sealed control frames (`vote`, `check`) to every
 * participant, and every participant counts them for themselves. There is no
 * tally authority to trust, because there is no server to hold one — and so
 * the counting rules have to be deterministic: two devices holding the same
 * frames must show the same result whatever order the frames arrived in.
 *
 * Building one from a form and counting its votes are in `interactiveForms.ts`:
 * only the cards and forms need them, and they travel in their chunk.
 */

export interface PollOption {
  id: string
  label: string
}

export interface PollSpec {
  question: string
  options: PollOption[]
  /** Whether a voter may choose more than one option. */
  multi: boolean
}

export interface ChecklistItem {
  id: string
  label: string
}

export interface ChecklistSpec {
  title: string
  items: ChecklistItem[]
}

/**
 * A vote or checklist change as stored: who sent it, when, where, and what it
 * said. `convoId` is the room the frame was addressed to, and it is what stops
 * someone outside a conversation from voting in it — see `tallyPoll`.
 */
export interface InteractiveUpdate {
  /** Rumor id of the frame. */
  id: string
  /** Rumor id of the poll or checklist it applies to. */
  targetId: string
  convoId: string
  authorPubkey: string
  ts: number
  frame: VoteFrame | CheckFrame
}

export const POLL_TAG = 'poll'
/** NIP-88's name and values. */
export const POLL_TYPE_TAG = 'polltype'
export const OPTION_TAG = 'option'
export const CHECKLIST_TAG = 'checklist'
export const ITEM_TAG = 'item'

export const MAX_QUESTION_CHARS = 200

// --- the wire ------------------------------------------------------------------

export function pollTags(spec: PollSpec): string[][] {
  return [
    [POLL_TAG, spec.question],
    [POLL_TYPE_TAG, spec.multi ? 'multiplechoice' : 'singlechoice'],
    ...spec.options.map((option) => [OPTION_TAG, option.id, option.label]),
  ]
}

export function checklistTags(spec: ChecklistSpec): string[][] {
  return [[CHECKLIST_TAG, spec.title], ...spec.items.map((item) => [ITEM_TAG, item.id, item.label])]
}

/**
 * Read a poll out of a rumor's tags, or `null` when there is not a valid one.
 *
 * Strict: a poll with a duplicated option id, or only one usable option, is
 * not a poll, and rendering half of one would invite votes that cannot mean
 * what the voter thought.
 */
export function pollFromTags(tags: readonly string[][]): PollSpec | null {
  const questionTag = tags.find((tag) => tag[0] === POLL_TAG)
  if (!questionTag) return null
  const question = cleanLine(questionTag[1], MAX_QUESTION_CHARS)
  if (!question) return null
  const options = entriesFromTags(tags, OPTION_TAG, MAX_POLL_OPTIONS)
  if (!options || options.length < 2) return null
  const type = tags.find((tag) => tag[0] === POLL_TYPE_TAG)?.[1]
  return { question, options, multi: type === 'multiplechoice' }
}

export function checklistFromTags(tags: readonly string[][]): ChecklistSpec | null {
  const titleTag = tags.find((tag) => tag[0] === CHECKLIST_TAG)
  if (!titleTag) return null
  const title = cleanLine(titleTag[1], MAX_QUESTION_CHARS)
  if (!title) return null
  const items = entriesFromTags(tags, ITEM_TAG, MAX_CHECKLIST_ITEMS)
  if (!items || items.length === 0) return null
  return { title, items }
}

function entriesFromTags(tags: readonly string[][], name: string, max: number): PollOption[] | null {
  const out: PollOption[] = []
  for (const tag of tags) {
    if (tag[0] !== name) continue
    const id = tag[1]
    const label = cleanLine(tag[2], MAX_ITEM_CHARS)
    if (!isItemId(id) || !label) return null
    if (out.some((entry) => entry.id === id)) return null
    out.push({ id, label })
    if (out.length > max) return null
  }
  return out
}

/**
 * The message content other clients show. Symbols rather than words, so it
 * reads the same whatever language the recipient's client speaks.
 */
export const pollFallback = (spec: PollSpec): string =>
  [`📊 ${spec.question}`, ...spec.options.map((option) => `○ ${option.label}`)].join('\n')

export const checklistFallback = (spec: ChecklistSpec): string =>
  [`☑️ ${spec.title}`, ...spec.items.map((item) => `☐ ${item.label}`)].join('\n')

// --- counting ------------------------------------------------------------------

/** Newest last. Ties on time break on id, so every device sorts identically. */
export const byArrival = (a: InteractiveUpdate, b: InteractiveUpdate): number =>
  a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface ChecklistEntry extends ChecklistItem {
  done: boolean
  /** Who last changed it, and when. Absent for an item nobody has touched. */
  by?: string
  at?: number
  /** True for items added after the checklist was sent. */
  added: boolean
}

/**
 * Settle a checklist from the changes made to it.
 *
 * Additions are applied before ticks, so an item exists however the frames
 * that created and ticked it were ordered in transit. Each item then takes the
 * newest tick anyone gave it. Additions stop at `MAX_CHECKLIST_ITEMS`, in
 * arrival order, so every device drops the same ones.
 */
export function foldChecklist(
  spec: ChecklistSpec,
  convoId: string,
  updates: readonly InteractiveUpdate[],
): ChecklistEntry[] {
  const changes = updates
    .filter((update) => update.convoId === convoId && update.frame.t === 'check')
    .sort(byArrival) as (InteractiveUpdate & { frame: CheckFrame })[]

  const entries: ChecklistEntry[] = spec.items.map((item) => ({ ...item, done: false, added: false }))
  for (const change of changes) {
    const label = change.frame.label
    if (label === undefined || entries.some((entry) => entry.id === change.frame.item)) continue
    if (entries.length >= MAX_CHECKLIST_ITEMS) continue
    entries.push({ id: change.frame.item, label, done: false, added: true })
  }

  for (const change of changes) {
    if (change.frame.done === undefined) continue
    const entry = entries.find((candidate) => candidate.id === change.frame.item)
    if (!entry) continue
    entry.done = change.frame.done
    entry.by = change.authorPubkey
    entry.at = change.ts
  }
  return entries
}
