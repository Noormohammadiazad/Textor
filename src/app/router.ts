import { useCallback, useSyncExternalStore } from 'react'

/**
 * Hash routing, hand-rolled.
 *
 * GitHub Pages serves static files with no rewrite rules, so a path-based route
 * like `/settings` would 404 on a hard refresh. Hash routing sidesteps that
 * entirely — and it has a second, more important property here: the fragment is
 * never sent to the server, so an invite link's payload stays on the client.
 *
 * Hand-rolled rather than react-router because the whole surface is six routes;
 * a dependency would be more code than this file, and every dependency in a
 * privacy app is another thing to audit.
 */
export type Route =
  | { name: 'chats' }
  | { name: 'chat'; peer: string }
  | { name: 'contacts' }
  | { name: 'contact'; peer: string }
  | { name: 'add-contact' }
  | { name: 'invite'; payload: string }
  | { name: 'verify'; peer: string }
  | { name: 'settings' }
  | { name: 'settings-relays' }
  | { name: 'settings-privacy' }
  | { name: 'settings-security' }
  | { name: 'settings-data' }
  | { name: 'about' }

const HEX32 = /^[0-9a-f]{64}$/

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '')
  const [head, ...rest] = path.split('/')

  switch (head) {
    case 'c': {
      const peer = rest[0] ?? ''
      return HEX32.test(peer) ? { name: 'chat', peer } : { name: 'chats' }
    }
    case 'i': {
      // Invite payloads are base64url and can be long; join in case a payload
      // ever contains a slash-like character after a future encoding change.
      const payload = rest.join('/')
      return payload ? { name: 'invite', payload } : { name: 'chats' }
    }
    case 'p': {
      const peer = rest[0] ?? ''
      return HEX32.test(peer) ? { name: 'contact', peer } : { name: 'contacts' }
    }
    case 'verify': {
      const peer = rest[0] ?? ''
      return HEX32.test(peer) ? { name: 'verify', peer } : { name: 'contacts' }
    }
    case 'contacts':
      return { name: 'contacts' }
    case 'add':
      return { name: 'add-contact' }
    case 'settings':
      switch (rest[0]) {
        case 'relays':
          return { name: 'settings-relays' }
        case 'privacy':
          return { name: 'settings-privacy' }
        case 'security':
          return { name: 'settings-security' }
        case 'data':
          return { name: 'settings-data' }
        default:
          return { name: 'settings' }
      }
    case 'about':
      return { name: 'about' }
    default:
      return { name: 'chats' }
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'chats':
      return '#/'
    case 'chat':
      return `#/c/${route.peer}`
    case 'contacts':
      return '#/contacts'
    case 'contact':
      return `#/p/${route.peer}`
    case 'add-contact':
      return '#/add'
    case 'invite':
      return `#/i/${route.payload}`
    case 'verify':
      return `#/verify/${route.peer}`
    case 'settings':
      return '#/settings'
    case 'settings-relays':
      return '#/settings/relays'
    case 'settings-privacy':
      return '#/settings/privacy'
    case 'settings-security':
      return '#/settings/security'
    case 'settings-data':
      return '#/settings/data'
    case 'about':
      return '#/about'
  }
}

const subscribe = (onChange: () => void): (() => void) => {
  addEventListener('hashchange', onChange)
  return () => removeEventListener('hashchange', onChange)
}

const getSnapshot = (): string => (typeof location === 'undefined' ? '#/' : location.hash || '#/')

export function useRoute(): Route {
  return parseHash(useSyncExternalStore(subscribe, getSnapshot, () => '#/'))
}

export function navigate(route: Route, replace = false): void {
  const hash = routeToHash(route)
  if (location.hash === hash) return
  if (replace) history.replaceState(null, '', hash)
  else location.hash = hash
  // replaceState does not fire hashchange, so nudge subscribers.
  if (replace) dispatchEvent(new HashChangeEvent('hashchange'))
}

export function useNavigate(): (route: Route, replace?: boolean) => void {
  return useCallback((route: Route, replace = false) => navigate(route, replace), [])
}

export function goBack(fallback: Route = { name: 'chats' }): void {
  if (history.length > 1) history.back()
  else navigate(fallback, true)
}
