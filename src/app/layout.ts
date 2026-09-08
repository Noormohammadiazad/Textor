import { useSyncExternalStore } from 'react'
import type { Route } from './router'

/**
 * Wide enough for a list and what was opened from it side by side (ADR-060):
 * a 20rem list leaves a conversation its full reading width beside it.
 */
export const WIDE_QUERY = '(min-width: 60rem)'

export function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(WIDE_QUERY)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => matchMedia(WIDE_QUERY).matches,
    () => false,
  )
}

/** The three lists the app is organised around, one per tab. */
export type Section = 'chats' | 'contacts' | 'settings'

/**
 * Which list a route belongs to, or null for a page reached from more than one
 * of them — adding a contact, verifying one, an invite — which stays beside
 * whichever list it was opened from.
 */
export function sectionOf(route: Route): Section | null {
  switch (route.name) {
    case 'chats':
    case 'chat':
    case 'group':
    case 'group-info':
    case 'new-group':
      return 'chats'
    case 'contacts':
    case 'contact':
      return 'contacts'
    case 'add-contact':
    case 'invite':
    case 'verify':
      return null
    default:
      return 'settings'
  }
}

/**
 * How deep a route is: 0 for a list, 1 for what a list opens, 2 for what is
 * opened from there. On a wide window a list is the side pane, so a level-1
 * page is the one that needs no way back.
 */
export function levelOf(route: Route): 0 | 1 | 2 {
  switch (route.name) {
    case 'chats':
    case 'contacts':
    case 'settings':
      return 0
    case 'chat':
    case 'group':
    case 'contact':
      return 1
    default:
      return route.name.startsWith('settings') || route.name === 'about' ? 1 : 2
  }
}
