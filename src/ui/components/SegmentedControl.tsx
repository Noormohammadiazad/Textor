import { useRef, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { nextSegmentIndex } from './segmentedNav'

export interface Segment<T extends string> {
  value: T
  /** Visible text. Omitted from the button when `icon` is present and `compact`. */
  label: string
  icon?: ReactNode
  /**
   * Fuller name used for the accessible label and tooltip when `label` is an
   * abbreviation — "English" behind a segment drawn as "EN".
   */
  title?: string
}

/**
 * A row of mutually exclusive options.
 *
 * Built on the ARIA radiogroup pattern rather than a row of independent
 * buttons, which is what makes it behave the way people expect from a native
 * segmented control:
 *
 *  - the group is one tab stop, not one per option (roving tabindex)
 *  - arrow keys move between options and select as they go
 *  - screen readers announce "Dark, radio button, 3 of 3"
 *
 * Left and right arrows follow the writing direction, so in Persian the left
 * arrow moves to the next option rather than the previous one — matching how
 * the segments are actually drawn on screen.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  compact = false,
}: {
  value: T
  options: readonly Segment<T>[]
  onChange: (next: T) => void
  /** Names the group for assistive technology. Never rendered. */
  label: string
  /** Draw icons only, with the label moved to the accessible name. */
  compact?: boolean
}) {
  const { dir } = useI18n()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  const select = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    buttons.current[index]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const target = nextSegmentIndex(event.key, index, options.length, dir)
    if (target === null) return
    event.preventDefault()
    select(target)
  }

  const selected = options.findIndex((option) => option.value === value)

  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // Exactly one button is reachable by Tab; arrows move within the
            // group. Falls back to the first option if nothing matches.
            tabIndex={checked || (selected === -1 && index === 0) ? 0 : -1}
            {...(option.title
              ? { 'aria-label': option.title, title: option.title }
              : compact
                ? { 'aria-label': option.label, title: option.label }
                : {})}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon}
            {compact && option.icon ? null : <span className="segmented-label">{option.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
