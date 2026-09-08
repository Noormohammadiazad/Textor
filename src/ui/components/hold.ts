import { useRef, type MouseEvent, type PointerEvent } from 'react'

/** How long a finger rests on a message before it counts as held: about the platforms' own figure. */
export const HOLD_MS = 450
/** How far it may drift and still be holding rather than scrolling. */
const SLOP_PX = 10
/** What a tap belongs to rather than the message around it. */
const CONTROL =
  'a[href], button, input, textarea, select, label, img, video, audio, [role="button"], [role="slider"]'

/**
 * Whether an event is the message's own: begun inside it, and not in a dialog
 * it opened. React carries events up from a portal — the menu, the emoji
 * picker — as if they happened in the bubble, and a picture's lightbox is
 * drawn inside it; neither is a press on the message.
 */
export function ownEvent(event: { target: EventTarget; currentTarget: EventTarget }): boolean {
  const target = event.target as Element
  return (event.currentTarget as Element).contains(target) && !target.closest('[role="dialog"]')
}

/**
 * How a message answers a finger and a mouse, as Telegram's do (ADR-060,
 * ADR-061): a finger held on it selects it, a tap opens its menu, and the right
 * button opens its menu too.
 *
 * iOS fires no `contextmenu` for a long press, so the hold is timed here.
 * Android fires one as well, and it is swallowed. The click a lifted finger
 * can still produce after a hold is swallowed too, so a hold on a reaction or
 * a poll option does not also press it. A tap on something that is a control
 * of its own — a link, a button, a picture — is that control's. A right click
 * on a link, a picture or a selection is left to the browser: its menu is the
 * one wanted there.
 *
 * `afterHold` answers, once, whether a click is the one a lifted finger makes
 * after a hold — for a row that selects on click, and would otherwise take a
 * hold that picked it as a tap that unpicks it.
 */
export function usePress(on: { hold: (at: HTMLElement) => void; menu: (at: HTMLElement) => void }) {
  const timer = useRef(0)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)
  const finger = useRef(false)
  const cancel = () => {
    clearTimeout(timer.current)
    origin.current = null
  }

  const afterHold = () => {
    const was = held.current
    held.current = false
    return was
  }

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      cancel()
      held.current = false
      finger.current = event.pointerType !== 'mouse'
      if (!finger.current || !ownEvent(event)) return
      const at = event.currentTarget
      origin.current = { x: event.clientX, y: event.clientY }
      timer.current = window.setTimeout(() => {
        origin.current = null
        held.current = true
        on.hold(at)
      }, HOLD_MS)
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const from = origin.current
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > SLOP_PX) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!afterHold()) return
      event.preventDefault()
      event.stopPropagation()
    },
    onClick(event: MouseEvent<HTMLElement>) {
      if (!finger.current || !ownEvent(event) || (event.target as Element).closest(CONTROL)) return
      on.menu(event.currentTarget)
    },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      // A finger is down, or has just held: Android's own long press, which
      // the timer answers.
      if (origin.current !== null || held.current) {
        event.preventDefault()
        return
      }
      const target = event.target as Element
      if (!ownEvent(event)) return
      if (target.closest('a[href]:not(.bubble-quote), img, video') || String(getSelection() ?? '')) return
      event.preventDefault()
      on.menu(event.currentTarget)
    },
  }
  return { handlers, afterHold }
}
