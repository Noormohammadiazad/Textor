import { cleanLine } from '../util/text'
import type { LiveFrame } from './protocol'

/**
 * Where something is, and where someone is going (ADR-064).
 *
 * A location is an ordinary NIP-17 kind 14 message. Its coordinates ride in
 * tags inside the gift wrap, and its content is a `geo:` URI (RFC 5870), so a
 * client that has never heard of Textor's tags still shows something a map
 * application opens — the contract polls and attachments keep.
 *
 *   ["location", "<lat>", "<lon>", "<accuracy m>"?]   decimal degrees, WGS 84
 *   ["place", "<name>"]                                a named place; static only
 *   ["live", "<seconds>"]                              shared live, for this long;
 *                                                      "0" until turned off
 *
 * A live location then moves by `loc` control frames, sealed to the same
 * people like every other frame, each naming the message it moves and counting
 * up, so one overtaken in transit is known to be older. Every receiver folds
 * them into the message's `live` state; nothing about the position — not the
 * coordinates, the accuracy, the heading or the speed — is ever outside a
 * gift wrap.
 */

/** One position, as a location service gives it. */
export interface GeoFix {
  lat: number
  lon: number
  /** Radius the position is good to, in metres. */
  acc?: number
  /** Direction of travel, degrees clockwise from true north. */
  hdg?: number
  /** Speed over ground, metres per second. */
  spd?: number
}

/** A location as a message carries it. */
export interface LocationSpec {
  lat: number
  lon: number
  acc?: number
  /** A name for the place, when it is somewhere rather than someone. */
  place?: string
  /** Set on a live location: how long it is shared, in seconds; 0 until turned off. */
  live?: number
}

/**
 * A live location as it stands: its newest position, and what is needed to
 * show it truthfully on a device whose clock is not its author's.
 */
export interface LiveState extends GeoFix {
  /** The newest update folded in; 0 for the position the message carried. */
  seq: number
  /** When that position was taken, by its author's clock. */
  at: number
  /**
   * How far this device's clock runs ahead of the author's, at most: the
   * least time any update seemed to take to arrive. Nothing arrives before it
   * was sent, so the author's times plus this never claim a share has ended
   * before it has — however far apart the two clocks are.
   */
  lag: number
  /** When its author stopped sharing, by their clock. */
  end?: number
  /** Where it has been, oldest first, for the path drawn behind the marker. */
  trail?: [number, number][]
}

export const LOCATION_TAG = 'location'
export const PLACE_TAG = 'place'
export const LIVE_TAG = 'live'

export const MAX_PLACE_CHARS = 80
/** Worse than this is not a position. */
export const MAX_ACCURACY_M = 100_000
/** Faster than an airliner is not a person. */
export const MAX_SPEED_MS = 350
/** A timed share runs from a minute to a week; longer is "until turned off". */
export const MIN_LIVE_SEC = 60
export const MAX_LIVE_SEC = 7 * 86_400
/** Positions kept behind a live marker. */
export const TRAIL_POINTS = 24
/** Where this device keeps the live locations it is sharing (see `VaultRepo.getState`). */
export const LIVE_SHARES = 'live-shares'

const round = (value: number, places: number): number => {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/** Six decimals — eleven centimetres — which is past what any phone knows. */
const degrees = (value: number): string => String(round(value, 6))
const DEGREES = /^-?\d{1,3}(\.\d{1,6})?$/

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * A position from anywhere untrusted — a frame, a tag, the browser — checked
 * and rounded to what travels, or `null`. Strict: a heading out of range is not
 * dropped quietly but refuses the whole position, which is what a garbled one
 * deserves.
 */
export function readFix(value: Partial<Record<keyof GeoFix, unknown>>): GeoFix | null {
  const { lat, lon, acc, hdg, spd } = value
  if (!within(lat, -90, 90) || !within(lon, -180, 180)) return null
  if (acc !== undefined && !within(acc, 0, MAX_ACCURACY_M)) return null
  if (hdg !== undefined && !within(hdg, 0, 360)) return null
  if (spd !== undefined && !within(spd, 0, MAX_SPEED_MS)) return null
  return {
    lat: round(lat, 6),
    lon: round(lon, 6),
    ...(acc !== undefined ? { acc: Math.round(acc) } : {}),
    ...(hdg !== undefined ? { hdg: Math.round(hdg) % 360 } : {}),
    ...(spd !== undefined ? { spd: round(spd, 1) } : {}),
  }
}

export function locationTags(spec: LocationSpec): string[][] {
  const tags = [
    [
      LOCATION_TAG,
      degrees(spec.lat),
      degrees(spec.lon),
      ...(spec.acc !== undefined ? [String(Math.round(spec.acc))] : []),
    ],
  ]
  if (spec.live !== undefined) tags.push([LIVE_TAG, String(spec.live)])
  else if (spec.place) tags.push([PLACE_TAG, spec.place])
  return tags
}

/**
 * Read a location out of a rumor's tags, or `null` when there is not a valid
 * one. A live tag that says nothing sensible makes the whole thing invalid
 * rather than quietly static: a share its sender meant to keep moving must not
 * be shown as a place.
 */
export function locationFromTags(tags: readonly string[][]): LocationSpec | null {
  const tag = tags.find((candidate) => candidate[0] === LOCATION_TAG)
  if (!tag || !DEGREES.test(tag[1] ?? '') || !DEGREES.test(tag[2] ?? '')) return null
  const acc = tag[3]
  if (acc !== undefined && !/^\d{1,6}$/.test(acc)) return null
  const spec: LocationSpec | null = readFix({
    lat: Number(tag[1]),
    lon: Number(tag[2]),
    ...(acc !== undefined ? { acc: Number(acc) } : {}),
  })
  if (!spec) return null

  const live = tags.find((candidate) => candidate[0] === LIVE_TAG)
  if (live) {
    const seconds = /^\d{1,7}$/.test(live[1] ?? '') ? Number(live[1]) : -1
    if (seconds !== 0 && !within(seconds, MIN_LIVE_SEC, MAX_LIVE_SEC)) return null
    spec.live = seconds
    return spec
  }
  const place = cleanLine(tags.find((candidate) => candidate[0] === PLACE_TAG)?.[1], MAX_PLACE_CHARS)
  if (place) spec.place = place
  return spec
}

/** The message content other clients show: a `geo:` URI, which a map application opens. */
export function locationFallback(spec: LocationSpec): string {
  const uri = `geo:${degrees(spec.lat)},${degrees(spec.lon)}${spec.acc !== undefined ? `;u=${Math.round(spec.acc)}` : ''}`
  if (spec.live !== undefined) return `📡 ${uri}`
  return spec.place ? `📍 ${spec.place}\n${uri}` : `📍 ${uri}`
}

/** A live location before anything has moved it: where the message said, when it was sent. */
export function startLive(spec: LocationSpec, at: number, arrival: number): LiveState {
  return {
    lat: spec.lat,
    lon: spec.lon,
    ...(spec.acc !== undefined ? { acc: spec.acc } : {}),
    seq: 0,
    at,
    lag: arrival - at,
  }
}

/**
 * Fold one update into a live location, or `null` when it changes nothing: an
 * older update overtaken in transit, a repeat, or anything after the end.
 *
 * `at` is when the update was sent, by its author's clock, and `arrival` when
 * it got here, by this one's. A position replaces the last one whole — an
 * accuracy or a heading the new one lacks is no longer known — and the last
 * one joins the trail.
 */
export function foldLive(state: LiveState, frame: LiveFrame, at: number, arrival: number): LiveState | null {
  if (state.end !== undefined || frame.seq <= state.seq) return null
  const lag = Math.min(state.lag, arrival - at)
  const fix = readFix(frame)
  // Only an end may come without a position.
  if (!fix) return frame.end ? { ...state, seq: frame.seq, lag, end: at } : null
  const moved = fix.lat !== state.lat || fix.lon !== state.lon
  const trail = moved
    ? [...(state.trail ?? []), [state.lat, state.lon] as [number, number]].slice(-TRAIL_POINTS)
    : state.trail
  return {
    ...fix,
    seq: frame.seq,
    at,
    lag,
    ...(trail ? { trail } : {}),
    ...(frame.end ? { end: at } : {}),
  }
}
