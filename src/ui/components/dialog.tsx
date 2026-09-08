import { useCallback, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { Modal } from './primitives'

/**
 * Questions asked in the app's own dialog, never the browser's.
 *
 * `window.confirm` blocks the page, cannot be styled or translated beyond its
 * text, reads as the browser speaking rather than the app, and some embedded
 * browsers suppress it outright — answering "no" for the person. One dialog is
 * open at a time, drawn by `DialogHost` in the shell; asking again answers the
 * open one with "no".
 */

export interface Choice<T extends string> {
  value: T
  label: string
  /** Deletes, leaves or blocks: drawn as the dangerous action it is. */
  danger?: boolean
}

interface Question {
  title: string
  body?: string
  choices: readonly Choice<string>[]
  answer: (value: string | null) => void
}

let open: Question | null = null
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/** Ask, and resolve with the value chosen — or null for cancel, Escape or the backdrop. */
export function ask<T extends string>(
  title: string,
  choices: readonly Choice<T>[],
  body?: string,
): Promise<T | null> {
  open?.answer(null)
  return new Promise((resolve) => {
    const question: Question = {
      title,
      body,
      choices,
      answer: (value) => {
        if (open === question) {
          open = null
          for (const listener of listeners) listener()
        }
        resolve(value as T | null)
      },
    }
    open = question
    for (const listener of listeners) listener()
  })
}

/** A yes-or-no question whose yes does something that cannot be taken back. */
export async function confirmDanger(title: string, action: string, body?: string): Promise<boolean> {
  return (await ask(title, [{ value: 'yes', label: action, danger: true }], body)) === 'yes'
}

export function DialogHost() {
  const t = useT()
  const question = useSyncExternalStore(
    subscribe,
    () => open,
    () => null,
  )
  const dismiss = useCallback(() => question?.answer(null), [question])
  if (!question) return null
  return (
    <Modal title={question.title} onClose={dismiss} closable={false} labelledBy="dialog-title">
      {question.body ? <p className="muted dialog-body">{question.body}</p> : null}
      <div className="dialog-actions">
        {question.choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => question.answer(choice.value)}
          >
            {choice.label}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" data-autofocus onClick={dismiss}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}
