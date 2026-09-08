import { useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { Field, Modal, Toggle } from '../components/primitives'
import { CloseIcon, PlusIcon } from '../components/Icons'
import { makeChecklist, makePoll, MAX_QUESTION_CHARS } from '../../core/models/interactive'
import { MAX_CHECKLIST_ITEMS, MAX_ITEM_CHARS, MAX_POLL_OPTIONS } from '../../core/models/protocol'

/**
 * Write a poll or a checklist and send it to the open conversation.
 *
 * Validation is the same `makePoll`/`makeChecklist` the protocol layer uses,
 * so a form this lets through is one every receiver accepts, and the error it
 * shows is the reason the receiver would have refused it.
 */

function Lines({
  values,
  onChange,
  min,
  max,
  label,
  placeholder,
  addLabel,
}: {
  values: string[]
  onChange: (values: string[]) => void
  /** Rows that cannot be removed: a poll with one option is not a choice. */
  min: number
  max: number
  label: string
  placeholder: (n: number) => string
  addLabel: string
}) {
  const { t } = useI18n()
  return (
    <fieldset className="stack-sm composer-lines">
      <legend className="label">{label}</legend>
      {values.map((value, index) => (
        <div key={index} className="row">
          <input
            className="input grow"
            dir="auto"
            value={value}
            maxLength={MAX_ITEM_CHARS}
            placeholder={placeholder(index + 1)}
            aria-label={placeholder(index + 1)}
            onChange={(event) => onChange(values.map((v, i) => (i === index ? event.target.value : v)))}
          />
          {values.length > min ? (
            <button
              type="button"
              className="btn btn-icon"
              aria-label={t('interactive.removeRow')}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <CloseIcon size={16} />
            </button>
          ) : null}
        </div>
      ))}
      {values.length < max ? (
        <button type="button" className="btn btn-ghost small" onClick={() => onChange([...values, ''])}>
          <PlusIcon size={15} />
          {addLabel}
        </button>
      ) : null}
    </fieldset>
  )
}

export function PollComposer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const sendPoll = useApp((s) => s.sendPoll)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    // The two things a person can get wrong here, said in their language.
    // `makePoll` checks again — and everything else — on the way out.
    if (!question.trim()) return setError(t('interactive.needQuestion'))
    if (options.filter((option) => option.trim()).length < 2) return setError(t('interactive.needOptions'))
    let poll
    try {
      poll = makePoll(question, options, multi)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setBusy(true)
    const sent = await sendPoll(poll)
    setBusy(false)
    if (sent) onClose()
  }

  return (
    <Modal title={t('interactive.newPoll')} onClose={onClose} labelledBy="poll-composer-title">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <Field label={t('interactive.question')} error={error ?? undefined}>
          <input
            className="input"
            dir="auto"
            value={question}
            maxLength={MAX_QUESTION_CHARS}
            placeholder={t('interactive.questionPlaceholder')}
            onChange={(event) => {
              setQuestion(event.target.value)
              setError(null)
            }}
          />
        </Field>
        <Lines
          values={options}
          onChange={(next) => {
            setOptions(next)
            setError(null)
          }}
          min={2}
          max={MAX_POLL_OPTIONS}
          label={t('interactive.options')}
          placeholder={(n) => t('interactive.option', { n })}
          addLabel={t('interactive.addOption')}
        />
        <Toggle label={t('interactive.multi')} checked={multi} onChange={setMulti} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {t('interactive.send')}
        </button>
      </form>
    </Modal>
  )
}

export function ChecklistComposer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const sendChecklist = useApp((s) => s.sendChecklist)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState(['', ''])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!title.trim()) return setError(t('interactive.needTitle'))
    if (!items.some((item) => item.trim())) return setError(t('interactive.needItems'))
    let checklist
    try {
      checklist = makeChecklist(title, items)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setBusy(true)
    const sent = await sendChecklist(checklist)
    setBusy(false)
    if (sent) onClose()
  }

  return (
    <Modal title={t('interactive.newChecklist')} onClose={onClose} labelledBy="checklist-composer-title">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <Field label={t('interactive.title')} error={error ?? undefined}>
          <input
            className="input"
            dir="auto"
            value={title}
            maxLength={MAX_QUESTION_CHARS}
            placeholder={t('interactive.titlePlaceholder')}
            onChange={(event) => {
              setTitle(event.target.value)
              setError(null)
            }}
          />
        </Field>
        <Lines
          values={items}
          onChange={(next) => {
            setItems(next)
            setError(null)
          }}
          min={1}
          max={MAX_CHECKLIST_ITEMS}
          label={t('interactive.items')}
          placeholder={(n) => t('interactive.item', { n })}
          addLabel={t('interactive.addItem')}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {t('interactive.send')}
        </button>
      </form>
    </Modal>
  )
}
