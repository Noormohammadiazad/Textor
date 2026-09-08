import { cleanLine } from '../util/text'
import { MAX_CHECKLIST_ITEMS, MAX_ITEM_CHARS, MAX_POLL_OPTIONS, type VoteFrame } from './protocol'
import {
  byArrival,
  MAX_QUESTION_CHARS,
  type ChecklistSpec,
  type InteractiveUpdate,
  type PollOption,
  type PollSpec,
} from './interactive'

/**
 * Polls and checklists as their cards and forms see them: built from what
 * someone typed, and counted. Nothing else needs either, so they travel in the
 * polls chunk rather than beside the parsing in `interactive.ts`, which the
 * engine runs on every message and every cold start downloads (ADR-064).
 */

/** Build a poll from what someone typed. Throws with a reason a person can act on. */
export function makePoll(question: string, labels: readonly string[], multi: boolean): PollSpec {
  const text = cleanLine(question, MAX_QUESTION_CHARS)
  if (!text) throw new Error('a poll needs a question')
  const options = cleanLabels(labels).map((label, index) => ({ id: `o${index}`, label }))
  if (options.length < 2) throw new Error('a poll needs at least two options')
  if (options.length > MAX_POLL_OPTIONS)
    throw new Error(`a poll can have at most ${MAX_POLL_OPTIONS} options`)
  return { question: text, options, multi }
}

export function makeChecklist(title: string, labels: readonly string[]): ChecklistSpec {
  const text = cleanLine(title, MAX_QUESTION_CHARS)
  if (!text) throw new Error('a checklist needs a title')
  const items = cleanLabels(labels).map((label, index) => ({ id: `i${index}`, label }))
  if (items.length === 0) throw new Error('a checklist needs at least one item')
  if (items.length > MAX_CHECKLIST_ITEMS) {
    throw new Error(`a checklist can have at most ${MAX_CHECKLIST_ITEMS} items`)
  }
  return { title: text, items }
}

/** Blank lines dropped, the rest cleaned; exact duplicates collapse to one. */
function cleanLabels(labels: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of labels) {
    const label = cleanLine(raw, MAX_ITEM_CHARS)
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

// --- counting ------------------------------------------------------------------

export interface PollResult {
  options: (PollOption & { count: number; voters: string[] })[]
  /** People with a vote standing, not ballots cast. */
  voters: number
  /** What `self` has chosen right now. */
  mine: string[]
}

/**
 * Count a poll.
 *
 * Only frames addressed to the poll's own conversation count. A vote is sealed
 * to a set of people, and that set is the conversation it lands in; someone
 * outside the room can address a frame to a poll's id, but it arrives in a
 * different room and is ignored here. Each voter's newest ballot stands;
 * options the poll does not have are dropped, and a single-choice poll keeps
 * only the first valid choice, so a modified client cannot vote twice.
 */
export function tallyPoll(
  spec: PollSpec,
  convoId: string,
  updates: readonly InteractiveUpdate[],
  self: string,
): PollResult {
  const latest = new Map<string, InteractiveUpdate & { frame: VoteFrame }>()
  for (const update of [...updates].sort(byArrival)) {
    if (update.convoId !== convoId || update.frame.t !== 'vote') continue
    latest.set(update.authorPubkey, update as InteractiveUpdate & { frame: VoteFrame })
  }

  const known = new Set(spec.options.map((option) => option.id))
  const counts = new Map(spec.options.map((option) => [option.id, [] as string[]]))
  let voters = 0
  let mine: string[] = []
  for (const [author, update] of latest) {
    let choices = update.frame.choices.filter((choice) => known.has(choice))
    if (!spec.multi) choices = choices.slice(0, 1)
    if (choices.length === 0) continue
    voters += 1
    if (author === self) mine = choices
    for (const choice of choices) counts.get(choice)?.push(author)
  }

  return {
    options: spec.options.map((option) => {
      const who = counts.get(option.id) ?? []
      return { ...option, count: who.length, voters: who }
    }),
    voters,
    mine,
  }
}
