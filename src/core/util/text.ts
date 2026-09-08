/**
 * A single line of user text, made safe to show and store: control
 * characters and line breaks become spaces, runs of space collapse, and the
 * result is trimmed and capped. `null` when nothing is left.
 */
// Matching control characters is the point here, so the lint rule against it
// does not apply.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/g

export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const line = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return null
  return [...line].slice(0, max).join('')
}
