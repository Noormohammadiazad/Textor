import type { LatLon } from '../../core/location/geo'
import type { LocaleCode } from '../../core/models/types'
import { localeTag } from '../format'

/**
 * Distances, speeds, times and coordinates in the reader's own language, from
 * the browser's own unit names — "350 m" and "350 متر" alike, with nothing to
 * translate by hand — and in Western digits in both, like every other readout
 * in the app (see `src/ui/format.ts`).
 */

/*
 * Persian takes the long names: its short forms run the number into the word
 * ("350متر") or leave the unit in Latin ("12 km/h"), which the long ones do not.
 */
const unit = (locale: LocaleCode, name: string, digits: number, value: number): string =>
  new Intl.NumberFormat(localeTag(locale), {
    style: 'unit',
    unit: name,
    unitDisplay: locale === 'fa' ? 'long' : 'short',
    maximumFractionDigits: digits,
  }).format(value)

export function formatDistance(metres: number, locale: LocaleCode): string {
  if (metres < 1000) return unit(locale, 'meter', 0, Math.round(metres))
  return unit(locale, 'kilometer', metres < 10_000 ? 1 : 0, metres / 1000)
}

export const formatSpeed = (metresPerSecond: number, locale: LocaleCode): string =>
  unit(locale, 'kilometer-per-hour', 0, metresPerSecond * 3.6)

/** A bearing, as a compass reads it in any language: `270°`. */
export const formatDegrees = (degrees: number): string => `${Math.round(degrees)}°`

/** How long is left, to the minute below an hour and to the hour above. */
export function formatLeft(ms: number, locale: LocaleCode): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes < 60 ? unit(locale, 'minute', 0, minutes) : unit(locale, 'hour', 0, Math.round(minutes / 60))
}

/** "2 minutes ago", "2 دقیقه پیش": how long since `ms` ago. */
export function formatAgo(ms: number, locale: LocaleCode): string {
  const format = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: 'auto' })
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return format.format(-Math.max(1, minutes), 'minute')
  const hours = Math.round(minutes / 60)
  return hours < 48 ? format.format(-hours, 'hour') : format.format(-Math.round(hours / 24), 'day')
}

/** Signed decimal degrees, to a metre. */
export function formatCoordinates(point: LatLon, locale: LocaleCode): string {
  const format = new Intl.NumberFormat(localeTag(locale), {
    minimumFractionDigits: 5,
    maximumFractionDigits: 5,
  })
  return `${format.format(point.lat)}${locale === 'fa' ? '، ' : ', '}${format.format(point.lon)}`
}

/** As any map application reads them, whatever the reader's language. */
export const plainCoordinates = (point: LatLon): string => `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`
