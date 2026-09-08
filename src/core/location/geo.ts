/**
 * The geometry a location needs, done on this device (ADR-064).
 *
 * Distances and directions for a share and for the person reading it, a flat
 * projection to draw them on, and reading a position out of whatever someone
 * pastes. No map service is asked anything: there is none to ask under a
 * policy that lets the app reach relays alone.
 */

export interface LatLon {
  lat: number
  lon: number
}

/** The mean radius of the Earth, in metres (IUGG). */
const EARTH_M = 6_371_008.8
const rad = (degrees: number): number => (degrees * Math.PI) / 180
const deg = (radians: number): number => (radians * 180) / Math.PI

/** Great-circle distance, in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The direction to set off in from `a` to reach `b`: degrees clockwise from true north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat))
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon))
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** How far apart two headings are, the short way round: 0 to 180. */
export function turnDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Longitude difference, wrapped across the antimeridian. */
const dLon = (from: number, to: number): number => ((((to - from) % 360) + 540) % 360) - 180

/**
 * Metres east and north of `origin`: an equirectangular projection about it,
 * true to within a fraction of a percent across the few kilometres a map of a
 * share ever spans. Kept away from the poles' zero scale, where east stops
 * meaning anything.
 */
export function project(origin: LatLon, point: LatLon): { x: number; y: number } {
  const scale = Math.max(0.01, Math.cos(rad(origin.lat)))
  return {
    x: rad(dLon(origin.lon, point.lon)) * EARTH_M * scale,
    y: rad(point.lat - origin.lat) * EARTH_M,
  }
}

/** The position `x` metres east and `y` north of `origin`; the inverse of `project`. */
export function unproject(origin: LatLon, x: number, y: number): LatLon {
  const scale = Math.max(0.01, Math.cos(rad(origin.lat)))
  const lat = Math.max(-90, Math.min(90, origin.lat + deg(y / EARTH_M)))
  const lon = ((((origin.lon + deg(x / (EARTH_M * scale)) + 180) % 360) + 360) % 360) - 180
  return { lat, lon }
}

/** Eight points of the compass, for "north-east of you". */
export const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
export type CompassPoint = (typeof COMPASS)[number]

export const compassPoint = (degrees: number): CompassPoint =>
  COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] as CompassPoint

/** The round distance — 1, 2 or 5 times a power of ten — nearest below `metres`: a scale bar's length. */
export function niceStep(metres: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(metres, 1e-3)))
  const lead = metres / power
  return (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * power
}

// --- reading a position someone pasted -----------------------------------------

/** Persian and Arabic digits and separators, read as the ASCII ones. */
function asciiDigits(text: string): string {
  return text
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066b/g, '.')
    .replace(/[\u060c\u066c]/g, ',')
}

const NUMBER = '[-+]?\\d{1,3}(?:\\.\\d+)?'
/**
 * Where map links keep a position, in the order they are tried: a `geo:` URI;
 * OpenStreetMap's marker and its `#map=zoom/lat/lon`; the `@lat,lon` in Google
 * Maps' paths; and the `q`, `ll`, `query` or `center` parameter of Google,
 * Apple and most others.
 */
const LINK_PATTERNS = [
  new RegExp(`geo:(${NUMBER}),(${NUMBER})`, 'i'),
  new RegExp(`[?&]mlat=(${NUMBER})&mlon=(${NUMBER})`, 'i'),
  new RegExp(`#map=\\d+(?:\\.\\d+)?/(${NUMBER})/(${NUMBER})`, 'i'),
  new RegExp(`@(${NUMBER}),(${NUMBER})`),
  new RegExp(`[?&](?:q|ll|sll|query|center|daddr)=(?:loc:)?(${NUMBER})(?:,|%2C)\\s*(${NUMBER})`, 'i'),
]

/**
 * One angle, in decimal degrees or degrees, minutes and seconds, with or
 * without a hemisphere: `35.6892`, `-51.389`, `35.6892° N`, `35°41'21.1"N`.
 */
const ANGLE =
  /(?<![\d.])([-+]?\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')\s*)?)?\s*([NSEW])?(?![\d.])/gi

interface Angle {
  value: number
  hemisphere: string | null
}

function readAngles(text: string): Angle[] | null {
  const angles: Angle[] = []
  for (const match of text.matchAll(ANGLE)) {
    const minutes = Number(match[2] ?? 0)
    const seconds = Number(match[3] ?? 0)
    if (minutes >= 60 || seconds >= 60) return null
    const whole = Number(match[1])
    const magnitude = Math.abs(whole) + minutes / 60 + seconds / 3600
    const hemisphere = match[4]?.toUpperCase() ?? null
    const negative = whole < 0 || Object.is(whole, -0) || hemisphere === 'S' || hemisphere === 'W'
    angles.push({ value: negative ? -magnitude : magnitude, hemisphere })
  }
  return angles
}

const inRange = (position: LatLon): LatLon | null =>
  Math.abs(position.lat) <= 90 && Math.abs(position.lon) <= 180 ? position : null

/**
 * A position read out of what someone pasted or typed — a map link, a `geo:`
 * URI, or a pair of coordinates in decimal or degrees-minutes-seconds — or
 * `null`. Latitude comes first unless hemispheres say otherwise.
 */
export function parsePosition(input: string): LatLon | null {
  const text = asciiDigits(input.trim())
  if (!text) return null
  for (const pattern of LINK_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return inRange({ lat: Number(match[1]), lon: Number(match[2]) })
  }
  // Anything else that looks like a link names a place by words, which only a
  // map service could turn into a position.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null
  const angles = readAngles(text)
  if (angles?.length !== 2) return null
  const [first, second] = angles as [Angle, Angle]
  const swapped = first.hemisphere === 'E' || first.hemisphere === 'W' || second.hemisphere === 'N'
  const [lat, lon] = swapped ? [second, first] : [first, second]
  // A hemisphere on the wrong half — two latitudes, say — is not a position.
  if (lat.hemisphere === 'E' || lat.hemisphere === 'W' || lon.hemisphere === 'N' || lon.hemisphere === 'S')
    return null
  return inRange({ lat: lat.value, lon: lon.value })
}
