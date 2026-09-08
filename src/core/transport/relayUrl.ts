/**
 * Relay URLs arrive from invites, profile frames, and user input, and they get
 * compared constantly (dedup, health lookups, publish targets). Normalising
 * once at every boundary keeps `wss://nos.lol` and `wss://nos.lol/` from being
 * treated as two different relays.
 *
 * Returns `null` for anything we refuse to connect to.
 *
 * `ws://` is accepted only for loopback, and only when the page itself is not
 * served over HTTPS — that is, during local development. A deployed page
 * cannot open an insecure socket at all: mixed-content rules block it, the
 * Content-Security-Policy lists only `wss:`, and `upgrade-insecure-requests`
 * would rewrite it regardless. Accepting such a URL in production would put a
 * relay in the user's list that can never connect, and report it as a mystery
 * connection failure rather than an address the app should not have taken.
 */
export function normalizeRelayUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Only bare hosts get a scheme prepended. Blindly prefixing anything without
  // a `wss://` prefix turns `http://relay.example` into
  // `wss://http//relay.example`, which parses cleanly and silently adds a
  // nonsense relay. A host:port like `relay.example:8080` must still work, so
  // "has a scheme" means "has a scheme *and* an authority", plus an explicit
  // deny-list for the schemeless-authority cases that carry code.
  let withScheme: string
  if (/^wss?:\/\//i.test(trimmed)) {
    withScheme = trimmed
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null
  } else if (/^(javascript|data|file|blob|vbscript|about):/i.test(trimmed)) {
    return null
  } else {
    withScheme = `wss://${trimmed}`
  }

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'wss:' && protocol !== 'ws:') return null
  if (!url.hostname) return null

  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (protocol === 'ws:' && (!isLoopback || isSecurePage())) return null

  url.hash = ''
  url.username = ''
  url.password = ''
  // A trailing slash on the root path is noise; deeper paths are meaningful.
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const port = url.port && !isDefaultPort(protocol, url.port) ? `:${url.port}` : ''

  return `${protocol}//${url.hostname.toLowerCase()}${port}${path}${url.search}`
}

/** True when the app is served over HTTPS, where insecure sockets cannot work. */
function isSecurePage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:'
}

const isDefaultPort = (protocol: string, port: string): boolean =>
  (protocol === 'wss:' && port === '443') || (protocol === 'ws:' && port === '80')

/** Hostname only — what the relay-health UI shows. */
export function relayLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function normalizeRelayList(urls: Iterable<string>, limit = 24): string[] {
  const seen = new Set<string>()
  for (const raw of urls) {
    const normalized = normalizeRelayUrl(raw)
    if (normalized) seen.add(normalized)
    if (seen.size >= limit) break
  }
  return [...seen]
}
