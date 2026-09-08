import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'

/**
 * A floating panel anchored to a trigger, kept inside the viewport.
 *
 * Rendered through a portal for a reason that is not cosmetic: the message list
 * is a scroll container, and a panel positioned inside it is clipped by that
 * container's overflow the moment it reaches an edge. Portalling to the body
 * and positioning with `fixed` puts it above every clipping ancestor.
 *
 * Placement is measured rather than assumed. A menu hanging off a bubble near
 * the bottom of a conversation, or off a narrow incoming bubble at the edge of
 * a phone screen, has no room where it "should" go — so it flips and clamps
 * based on what is actually there.
 */

/** Breathing room kept between the panel and the viewport edge. */
const MARGIN = 8
/** Gap between the trigger and the panel. */
const OFFSET = 4

export interface PopoverProps {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  /** Names the panel for assistive technology. */
  label: string
}

interface Placement {
  left: number
  top: number
  /** Which way it actually ended up, for the entrance animation. */
  above: boolean
}

export function Popover({ anchor, onClose, children, label }: PopoverProps) {
  const { dir } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const reposition = useCallback(() => {
    const panel = panelRef.current
    if (!anchor || !panel) return

    const trigger = anchor.getBoundingClientRect()
    const { width, height } = panel.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight

    // Vertical: below by default, flipped above when the space below cannot
    // hold it and the space above can.
    const below = trigger.bottom + OFFSET
    const roomBelow = viewportHeight - below - MARGIN
    const roomAbove = trigger.top - OFFSET - MARGIN
    const above = roomBelow < height && roomAbove > roomBelow
    let top = above ? trigger.top - height - OFFSET : below

    // Horizontal: the panel's trailing edge lines up with the trigger's, which
    // is the right edge in a left-to-right layout and the left edge in a
    // right-to-left one. Written in physical pixels because that is what
    // getBoundingClientRect and `fixed` positioning speak.
    let left = dir === 'rtl' ? trigger.left : trigger.right - width

    // Then clamp both axes, which is what actually keeps it on screen when the
    // trigger is in a corner and neither preferred side has room.
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewportWidth - width - MARGIN))
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewportHeight - height - MARGIN))

    setPlacement({ left, top, above })
  }, [anchor, dir])

  // Measured before paint, so the panel never appears in the wrong place first.
  useLayoutEffect(reposition, [reposition])

  useEffect(() => {
    // `true` for scroll: the conversation scrolls in a nested container, and a
    // non-capturing listener on window would never hear it.
    const onScroll = () => reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [reposition])

  /*
   * Re-measure whenever the panel's own size settles.
   *
   * The first measurement happens before the browser has finished laying the
   * content out, so it can read narrower than the panel ends up. Clamping
   * against that stale width leaves the panel flush against the screen edge —
   * precisely the overflow this component exists to prevent.
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => reposition())
    observer.observe(panel)
    return () => observer.disconnect()
  }, [reposition])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        anchor?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchor, onClose])

  // Focus the first item so the menu is usable from the keyboard immediately.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  return createPortal(
    <div
      ref={panelRef}
      className="popover"
      role="menu"
      aria-label={label}
      data-above={placement?.above ? 'true' : 'false'}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        // Hidden for the single frame before it has been measured, rather than
        // flashing at the top-left corner.
        visibility: placement ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => {
        const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        if (items.length === 0) return
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          items[(index + 1) % items.length]?.focus()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          items[(index - 1 + items.length) % items.length]?.focus()
        }
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
