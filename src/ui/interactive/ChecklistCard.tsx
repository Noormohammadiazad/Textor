import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { foldChecklist, type ChecklistSpec, type InteractiveUpdate } from '../../core/models/interactive'
import { MAX_CHECKLIST_ITEMS, MAX_ITEM_CHARS } from '../../core/models/protocol'
import { PlusIcon } from '../components/Icons'

export interface ChecklistCardProps {
  checklist: ChecklistSpec
  convoId: string
  messageId: string
  updates: readonly InteractiveUpdate[] | undefined
  nameOf: (pubkey: string) => string
  onCheck: (itemId: string, done: boolean) => void
  onAdd: (label: string) => void
}

/**
 * A checklist everyone in the conversation can tick and add to. Each line
 * shows the state the newest change gave it, and who made that change.
 */
export function ChecklistCard({
  checklist,
  convoId,
  messageId,
  updates,
  nameOf,
  onCheck,
  onAdd,
}: ChecklistCardProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const entries = useMemo(
    () => foldChecklist(checklist, convoId, updates ?? []),
    [checklist, convoId, updates],
  )
  const done = entries.filter((entry) => entry.done).length
  const headingId = `list-${messageId}`

  return (
    <div className="checklist" role="group" aria-labelledby={headingId}>
      <div className="row-between">
        <span className="poll-question" id={headingId} dir="auto">
          {checklist.title}
        </span>
        <span className="hint tabular">{t('interactive.progress', { done, total: entries.length })}</span>
      </div>
      <ul className="checklist-items">
        {entries.map((entry) => (
          <li key={entry.id}>
            <label
              className={entry.done ? 'checklist-item done' : 'checklist-item'}
              title={entry.by ? t('interactive.tickedBy', { name: nameOf(entry.by) }) : undefined}
            >
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={entry.done}
                onChange={(event) => onCheck(entry.id, event.target.checked)}
              />
              <span className="grow" dir="auto">
                {entry.label}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {entries.length < MAX_CHECKLIST_ITEMS ? (
        <form
          className="checklist-add"
          onSubmit={(event) => {
            event.preventDefault()
            const label = draft.trim()
            if (!label) return
            onAdd(label)
            setDraft('')
          }}
        >
          <input
            className="input"
            dir="auto"
            value={draft}
            maxLength={MAX_ITEM_CHARS}
            placeholder={t('interactive.newItemPlaceholder')}
            aria-label={t('interactive.addItem')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-icon"
            aria-label={t('interactive.addItem')}
            disabled={!draft.trim()}
          >
            <PlusIcon size={16} />
          </button>
        </form>
      ) : null}
    </div>
  )
}
