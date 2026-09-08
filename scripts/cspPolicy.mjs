/**
 * The content policy, checked as it shipped.
 *
 * A policy string is easy to loosen by accident, and a loosened one is silent:
 * nothing breaks, something more is merely allowed. `check-bundle.mjs` reads
 * the policy out of the built page and fails the build on any of these.
 *
 * One remote origin is allowed anywhere, and only for images: OpenStreetMap's
 * tile server, for street maps someone has turned on (ADR-065). Relays are
 * reached over `wss:`, which the person chooses, and nothing else is remote.
 */

/** The only remote sources the policy may name, by directive. */
export const ALLOWED_REMOTE = Object.freeze({
  'img-src': Object.freeze(['https://tile.openstreetmap.org']),
  'connect-src': Object.freeze(['wss:']),
})

const REQUIRED = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

/** A source that reaches beyond this origin: a scheme, a host, or a wildcard. */
const isRemote = (source) =>
  !source.startsWith("'") && source !== 'data:' && source !== 'blob:' && source !== 'mediastream:'

/** Directive name -> its sources. */
export function parseCsp(csp) {
  const directives = new Map()
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name.toLowerCase(), sources)
  }
  return directives
}

/** Everything wrong with a policy, as sentences; empty when it holds. */
export function cspFailures(csp) {
  const failures = []
  for (const directive of REQUIRED) {
    if (!csp.includes(directive)) failures.push(`CSP is missing: ${directive}`)
  }
  const directives = parseCsp(csp)
  if ((directives.get('script-src') ?? []).some((source) => /^'unsafe-(inline|eval)'$/.test(source))) {
    failures.push("CSP allows 'unsafe-inline' or 'unsafe-eval' for scripts")
  }
  for (const [name, sources] of directives) {
    for (const source of sources.filter(isRemote)) {
      if ((ALLOWED_REMOTE[name] ?? []).includes(source)) continue
      failures.push(
        /^(https?:|\*)/.test(source) && !/^https?:\/\/[^*]+$/.test(source)
          ? `CSP ${name} allows any origin: ${source}`
          : `CSP ${name} allows a remote origin it should not: ${source}`,
      )
    }
  }
  return failures
}
