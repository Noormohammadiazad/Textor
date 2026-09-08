import type { ReactNode } from 'react'
import { DisplayControls } from './DisplayControls'
import { LockIcon } from './Icons'

/**
 * Chrome shared by every screen shown before the vault is open: welcome,
 * onboarding, restore, and lock.
 *
 * The bar holds the wordmark and the language and theme switches. Putting them
 * here rather than on each screen means there is no state of the app in which
 * someone can see the interface but not change its language — which, for an app
 * whose first audience reads Persian, is the difference between usable and not.
 */
export function EntryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="entry">
      <div className="entry-bar">
        <Brand />
        <DisplayControls />
      </div>
      <div className="entry-body stack">{children}</div>
    </div>
  )
}

/**
 * Wordmark. The name is never translated — it is the product — so it is pinned
 * to LTR and to the Latin face even when the surrounding page is Persian.
 */
export function Brand() {
  return (
    <span className="brand" dir="ltr">
      <span className="brand-mark" aria-hidden="true">
        <LockIcon size={13} />
      </span>
      Textor
    </span>
  )
}
