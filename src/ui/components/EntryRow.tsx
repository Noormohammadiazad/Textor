import type { ReactNode } from 'react'
import type { Message } from '../../core/models/types'
import { useT } from '../../i18n'
import { ownEvent } from './hold'

/** What every entry in a conversation shares: its place in a run, and being picked while selecting. */
export interface EntryProps {
  /** First of a run from one side: announced, and spaced from what came before. */
  groupStart: boolean
  /** Last of a run: the one whose bubble has the tail. */
  groupEnd: boolean
  /** The conversation is selecting entries: a tap picks rather than acts. */
  selecting: boolean
  selected: boolean
  /** Pick or unpick this entry, starting to select if nothing is yet. */
  onSelect: (message: Message) => void
  /** Ask how — for me, or for both — and delete. */
  onDelete: (message: Message) => void
}

/**
 * One entry's row: it spans the conversation's column, and its side is its
 * alignment (ADR-060). While selecting, the whole row is one target — a tap
 * anywhere on it picks it, and never also presses a link, a poll option or a
 * picture inside — and a check at its start edge says whether it is picked.
 */
export function EntryRow({
  message,
  groupStart,
  groupEnd,
  selecting,
  selected,
  onSelect,
  failed,
  afterHold,
  children,
}: Omit<EntryProps, 'onDelete'> & {
  message: Message
  failed?: boolean
  /** Whether this click is the one a hold that picked the entry leaves behind. */
  afterHold: () => boolean
  children: ReactNode
}) {
  const t = useT()
  const classes = ['bubble-row', message.direction === 'out' ? 'out' : 'in']
  if (groupStart) classes.push('group-start')
  if (groupEnd) classes.push('group-end')
  if (failed) classes.push('failed')
  if (selected) classes.push('selected')
  return (
    <div
      className={classes.join(' ')}
      id={`msg-${message.id}`}
      onClickCapture={
        selecting
          ? (event) => {
              if (!ownEvent(event)) return
              event.preventDefault()
              event.stopPropagation()
              if (!afterHold()) onSelect(message)
            }
          : undefined
      }
    >
      {selecting ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t('chat.select')}
          className="select-mark"
        />
      ) : null}
      {children}
    </div>
  )
}

export function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'menuitem-danger' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
