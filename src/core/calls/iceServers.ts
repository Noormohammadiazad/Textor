/**
 * STUN and TURN servers the user types in, checked before they are saved.
 *
 * Only Settings reads this, so it rides in the settings chunk.
 */

export interface IceServerInput {
  url: string
  username?: string
  credential?: string
}

export type IceServerError = 'invalid' | 'credentials'

const MAX_URL_CHARS = 512
const MAX_CREDENTIAL_CHARS = 256

/**
 * Validate one server. A `turn:` or `turns:` server needs credentials — every
 * real one does, and one without them fails at call time with nothing to show
 * why. A `stun:` server takes none, and any given are dropped rather than
 * stored for no reason.
 */
export function parseIceServer(input: IceServerInput): { server: RTCIceServer } | { error: IceServerError } {
  const url = input.url.trim()
  // stun:host[:port], turn:host[:port][?transport=udp|tcp], turns:…
  if (url.length > MAX_URL_CHARS || !/^(stuns?|turns?):[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(url)) {
    return { error: 'invalid' }
  }
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  const normalized = `${scheme}${url.slice(scheme.length)}`
  if (!scheme.startsWith('turn')) return { server: { urls: normalized } }

  const username = (input.username ?? '').trim()
  const credential = input.credential ?? ''
  if (!username || !credential) return { error: 'credentials' }
  if (username.length > MAX_CREDENTIAL_CHARS || credential.length > MAX_CREDENTIAL_CHARS)
    return { error: 'invalid' }
  return { server: { urls: normalized, username, credential } }
}

/** The addresses a server entry names. */
export const serverUrls = (server: RTCIceServer): string[] =>
  Array.isArray(server.urls) ? server.urls : [server.urls]

/** Whether `server` names an address already in `servers`. */
export const alreadyListed = (servers: readonly RTCIceServer[], server: RTCIceServer): boolean =>
  servers.some((existing) =>
    serverUrls(existing).some((url) =>
      serverUrls(server).some((other) => other.toLowerCase() === url.toLowerCase()),
    ),
  )
