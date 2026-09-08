import { project, type LatLon } from '../../core/location/geo'
import type { LiveStatus } from '../../core/location/status'
import type { LocaleCode, Message } from '../../core/models/types'
import { avatarColor, initials } from '../components/primitives'
import { formatAgo, formatLeft } from './format'
import type { LocationTextKey } from './locationText'
import { ASPECT, type MapMarker } from './MapView'
import type { Interpolations } from '../../i18n'

/** How a location is drawn and described, shared by the card and the sheet. */

/**
 * Metres from the centre to the top edge that show a marker's halo and every
 * point given — a trail, the reader — in a frame `aspect` times as wide as it
 * is tall, with room around them: a third of the way in from each edge, clear
 * of the controls and the north arrow in its corners.
 */
export function spanAround(
  center: LatLon,
  acc: number | undefined,
  points: readonly LatLon[] = [],
  aspect: number = ASPECT.wide,
): number {
  let span = Math.max(120, (acc ?? 0) * 1.4)
  for (const point of points) {
    const { x, y } = project(center, point)
    span = Math.max(span, Math.abs(y) * 1.5, (Math.abs(x) / aspect) * 1.5)
  }
  return span
}

/** What a location's marker, and a live one's trail, look like. */
export function markerFor(
  message: Message,
  status: LiveStatus | null,
  name: string,
): { marker: MapMarker; trail?: LatLon[] } {
  const spec = message.location as NonNullable<Message['location']>
  if (!status) return { marker: { at: spec, kind: 'place', acc: spec.acc } }
  const { state } = status
  return {
    marker: {
      at: state,
      kind: 'live',
      acc: state.acc,
      // Where it was going says nothing once it has stopped.
      hdg: status.active ? state.hdg : undefined,
      pulse: status.active && !status.stale,
      color: avatarColor(message.authorPubkey),
      initials: initials(name),
    },
    trail: state.trail ? [...state.trail.map(([lat, lon]) => ({ lat, lon })), state] : undefined,
  }
}

/** "Updated just now · 14 min left", or when it ended. */
export function liveLine(
  status: LiveStatus,
  now: number,
  text: (key: LocationTextKey, values?: Interpolations) => string,
  locale: LocaleCode,
): string {
  if (status.endedAt !== null) return text('endedAt', { ago: formatAgo(now - status.endedAt, locale) })
  const since = now - status.updatedAt
  const heard =
    since < 60_000
      ? text('updatedNow')
      : text(status.stale ? 'stale' : 'updated', { ago: formatAgo(since, locale) })
  const left =
    status.endsAt === null
      ? text('untilOff')
      : text('left', { time: formatLeft(status.endsAt - now, locale) })
  return `${heard} · ${left}`
}
