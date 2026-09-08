import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from './Icons'
import { useT } from '../../i18n'

/** Deterministic avatar colour from a public key — stable across devices. */
export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  // Fixed saturation and lightness keep contrast with white text predictable.
  return `hsl(${Math.abs(hash) % 360} 46% 42%)`
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...(words[0] as string)][0] ?? '?'
  if (words.length === 1) return first.toUpperCase()
  const second = [...(words[words.length - 1] as string)][0] ?? ''
  return (first + second).toUpperCase()
}

export function Avatar({
  name,
  seed,
  src,
  size = 'md',
}: {
  name: string
  seed: string
  src?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const className = `avatar${size === 'sm' ? ' avatar-sm' : size === 'lg' ? ' avatar-lg' : ''}`
  if (src) {
    return (
      <div className={className}>
        <img src={src} alt="" />
      </div>
    )
  }
  return (
    <div className={className} style={{ background: avatarColor(seed) }} aria-hidden="true">
      {initials(name)}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: '0.5rem' }}>
      <span className="spinner" />
      {label ? <span className="muted small">{label}</span> : null}
    </span>
  )
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'accent'
  children: ReactNode
}) {
  const cls = tone === 'info' ? 'banner' : `banner banner-${tone}`
  return (
    <div className={cls} role={tone === 'danger' ? 'alert' : undefined}>
      {children}
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      {label ? <span className="label">{label}</span> : null}
      {children}
      {error ? (
        <span className="error-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  )
}

/**
 * Accessible modal: focus moves in on open and returns on close, Escape
 * dismisses, and a click on the backdrop dismisses. Focus is trapped so
 * keyboard users cannot tab into the inert page behind it.
 */
export function Modal({
  title,
  onClose,
  children,
  labelledBy = 'modal-title',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    const node = ref.current
    const focusable = node?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    focusable?.[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const items = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ]
      if (items.length === 0) return
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreTo.current?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <div className="row-between" style={{ marginBottom: 'var(--space-4)' }}>
          <h2 id={labelledBy} style={{ fontSize: 'var(--step-1)' }}>
            {title}
          </h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label
      className="row-between"
      style={{ padding: 'var(--space-3) var(--space-4)', cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <span className="grow">
        <span style={{ display: 'block', fontWeight: 'var(--weight-medium)' }}>{label}</span>
        {description ? (
          <span className="hint" style={{ display: 'block', marginTop: 'var(--space-0-5)' }}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        className="checkbox"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {body ? (
        <p className="muted" style={{ maxWidth: '28rem' }}>
          {body}
        </p>
      ) : null}
      {action}
    </div>
  )
}

/** Copy-to-clipboard button with a transient confirmation label. */
export function CopyButton({
  value,
  label,
  className = 'btn btn-outline',
}: {
  value: string
  label?: string
  className?: string
}) {
  const t = useT()
  const [copied, setCopied] = useCopyState()
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied()
        } catch {
          // Clipboard access can be denied; the value is always visible and
          // selectable next to the button, so there is nothing to recover from.
        }
      }}
    >
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  )
}

/** Shows "Copied" for a moment, then reverts. Cleans up on unmount. */
function useCopyState(): [boolean, () => void] {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const flash = useCallback(() => {
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }, [])

  return [copied, flash]
}
