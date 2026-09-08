import { useMemo } from 'react'
import { useI18n } from '../../i18n'
import { tallyPoll, type InteractiveUpdate, type PollSpec } from '../../core/models/interactive'
import { CheckIcon } from '../components/Icons'

export interface PollCardProps {
  poll: PollSpec
  /** The poll message's own conversation: only votes addressed there count. */
  convoId: string
  messageId: string
  updates: readonly InteractiveUpdate[] | undefined
  selfPubkey: string
  nameOf: (pubkey: string) => string
  onVote: (choices: string[]) => void
}

/**
 * A poll, counted on this device from the votes this device holds.
 *
 * Each option is a toggle button rather than a radio: tapping your own choice
 * again withdraws it, which a radio group cannot express. The bar behind each
 * option fills from the reading edge, so it grows rightwards in English and
 * leftwards in Persian.
 */
export function PollCard({ poll, convoId, messageId, updates, selfPubkey, nameOf, onVote }: PollCardProps) {
  const { t } = useI18n()
  const result = useMemo(
    () => tallyPoll(poll, convoId, updates ?? [], selfPubkey),
    [poll, convoId, updates, selfPubkey],
  )
  const headingId = `poll-${messageId}`

  const choose = (optionId: string) => {
    const mine = result.mine
    if (poll.multi) {
      onVote(mine.includes(optionId) ? mine.filter((id) => id !== optionId) : [...mine, optionId])
    } else {
      onVote(mine[0] === optionId ? [] : [optionId])
    }
  }

  return (
    <div className="poll" role="group" aria-labelledby={headingId}>
      <div className="poll-question" id={headingId} dir="auto">
        {poll.question}
      </div>
      <div className="hint">{poll.multi ? t('interactive.chooseAny') : t('interactive.chooseOne')}</div>
      <ul className="poll-options">
        {result.options.map((option) => {
          const mine = result.mine.includes(option.id)
          const share = result.voters > 0 ? (option.count / result.voters) * 100 : 0
          return (
            <li key={option.id}>
              <button
                type="button"
                className={mine ? 'poll-option mine' : 'poll-option'}
                aria-pressed={mine}
                title={option.voters.map(nameOf).join('\n') || undefined}
                onClick={() => choose(option.id)}
              >
                <span className="poll-bar" style={{ inlineSize: `${share}%` }} aria-hidden="true" />
                <span className="poll-mark" aria-hidden="true">
                  {mine ? <CheckIcon size={12} /> : null}
                </span>
                <span className="poll-label" dir="auto">
                  {option.label}
                </span>
                <span className="poll-count tabular">{option.count}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="hint" aria-live="polite">
        {result.voters > 0 ? t('interactive.votes', { n: result.voters }) : t('interactive.noVotes')}
      </div>
    </div>
  )
}
