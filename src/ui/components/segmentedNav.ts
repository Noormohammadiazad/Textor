/**
 * Keyboard navigation for a radiogroup laid out as a horizontal row.
 *
 * Pulled out of the component because the direction handling is the part most
 * likely to be got wrong and the part hardest to notice when it is: an app
 * whose primary audience reads right to left needs the left arrow to move to
 * the segment that is visually to the left, which is the *next* option, not the
 * previous one. Isolating it makes that behaviour directly testable.
 */
export type Direction = 'ltr' | 'rtl'

/**
 * The index the selection should move to, or `null` when the key is not one
 * this control handles and the event should be left alone.
 *
 * Selection wraps at both ends, matching the ARIA radiogroup pattern and every
 * native segmented control.
 */
export function nextSegmentIndex(key: string, current: number, count: number, dir: Direction): number | null {
  if (count <= 0) return null

  // Only the horizontal arrows follow the writing direction. Up and down always
  // mean previous and next, because the control is never drawn vertically.
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'

  switch (key) {
    case forward:
    case 'ArrowDown':
      return (current + 1) % count
    case back:
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
