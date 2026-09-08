import { useRef, useState, type PointerEvent } from 'react'
import { useT } from '../../i18n'

const DOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/** A dot's centre, in the pad's 300×300 drawing space. */
const centre = (dot: number) => ({ x: 50 + ((dot - 1) % 3) * 100, y: 50 + Math.floor((dot - 1) / 3) * 100 })

/**
 * A 3×3 grid to draw a pattern on (ADR-058): press, drag through the dots,
 * let go. What is drawn is handed over as the dots' numbers, 1 to 9, in order.
 *
 * The grid runs left to right in every language. A pattern is a shape, and a
 * Persian interface mirroring it would turn the shape someone set in English
 * into a different one.
 *
 * Each dot is a button, so keyboards and screen readers choose them one at a
 * time and finish with the button beneath. A pointer's own clicks are not
 * counted twice: only a click with no pointer behind it (`detail` 0) chooses
 * a dot.
 */
export function PatternPad({
  label,
  onDone,
  disabled,
}: {
  label: string
  onDone: (code: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const pad = useRef<HTMLDivElement>(null)
  const drawing = useRef(false)
  const chosen = useRef<number[]>([])
  const [path, setPath] = useState<number[]>([])
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)

  const choose = (next: number[]) => {
    chosen.current = next
    setPath(next)
  }

  const finish = () => {
    const code = chosen.current.join('')
    choose([])
    if (code) onDone(code)
  }

  /** Where the pointer is in drawing space, and the dot it is over, if any. */
  const locate = (event: PointerEvent) => {
    const box = (pad.current as HTMLDivElement).getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * 300
    const y = ((event.clientY - box.top) / box.height) * 300
    // Near enough a centre to mean it, and far enough that a line between two
    // dots does not catch a third by its corner.
    const dot = DOTS.find((candidate) => {
      const at = centre(candidate)
      return Math.hypot(at.x - x, at.y - y) < 36
    })
    return { x, y, dot }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    try {
      // Keeps the stroke when a finger strays off the pad. Some webviews
      // refuse it; drawing works without, as long as it stays on the pad.
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Drawn without capture.
    }
    drawing.current = true
    const { x, y, dot } = locate(event)
    choose(dot ? [dot] : [])
    setPointer({ x, y })
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawing.current) return
    const { x, y, dot } = locate(event)
    if (dot && !chosen.current.includes(dot)) choose([...chosen.current, dot])
    setPointer({ x, y })
  }

  const onPointerUp = () => {
    if (!drawing.current) return
    drawing.current = false
    setPointer(null)
    finish()
  }

  const points = path.map((dot) => centre(dot))
  const last = points[points.length - 1]
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')

  return (
    <div className="stack-sm">
      <div
        ref={pad}
        className="pattern-pad"
        dir="ltr"
        role="group"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg viewBox="0 0 300 300" aria-hidden="true">
          {points.length > 1 ? <polyline points={line} /> : null}
          {last && pointer ? <line x1={last.x} y1={last.y} x2={pointer.x} y2={pointer.y} /> : null}
        </svg>
        <div className="pattern-dots">
          {DOTS.map((dot) => (
            <button
              key={dot}
              type="button"
              className="pattern-dot"
              aria-label={t('lock.patternDot', { n: dot })}
              aria-pressed={path.includes(dot)}
              disabled={disabled}
              onClick={(event) => {
                if (event.detail !== 0 || chosen.current.includes(dot)) return
                choose([...chosen.current, dot])
              }}
            />
          ))}
        </div>
      </div>
      {path.length > 0 && !pointer ? (
        <div className="row center" style={{ gap: 'var(--space-2)', justifyContent: 'center' }}>
          <button type="button" className="btn btn-ghost small" onClick={() => choose([])}>
            {t('lock.patternClear')}
          </button>
          <button type="button" className="btn btn-outline small" onClick={finish}>
            {t('lock.patternDone')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
