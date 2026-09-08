import type { LocaleCode } from '../core/models/types'

/**
 * Date and number formatting.
 *
 * `Intl` is used for month and weekday names so Persian gets correct forms, but
 * numerals stay Western (`latn`) in both locales: Iranian users overwhelmingly
 * expect Western digits in timestamps and technical readouts, and mixing
 * numeral systems inside an RTL layout is a legibility problem.
 */
const localeTag = (locale: LocaleCode): string => (locale === 'fa' ? 'fa-IR-u-nu-latn-ca-gregory' : 'en-GB')

const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: LocaleCode, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`
  let instance = cache.get(key)
  if (!instance) {
    instance = new Intl.DateTimeFormat(localeTag(locale), options)
    cache.set(key, instance)
  }
  return instance
}

export const formatTime = (ts: number, locale: LocaleCode): string =>
  formatter(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ts)

export const formatDate = (ts: number, locale: LocaleCode): string =>
  formatter(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(ts)

export const formatDateTime = (ts: number, locale: LocaleCode): string =>
  `${formatDate(ts, locale)} ${formatTime(ts, locale)}`

const startOfDay = (ts: number): number => {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export const isSameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b)

/** "Today"/"Yesterday" for the last two days, otherwise a full date. */
export function formatDayLabel(
  ts: number,
  locale: LocaleCode,
  labels: { today: string; yesterday: string },
): string {
  const today = startOfDay(Date.now())
  const day = startOfDay(ts)
  if (day === today) return labels.today
  if (day === today - 86_400_000) return labels.yesterday
  return formatDate(ts, locale)
}

/** Time for today, weekday within the week, date beyond that. */
export function formatListTimestamp(ts: number, locale: LocaleCode): string {
  if (ts === 0) return ''
  const today = startOfDay(Date.now())
  const day = startOfDay(ts)
  if (day === today) return formatTime(ts, locale)
  if (today - day < 6 * 86_400_000) return formatter(locale, { weekday: 'short' }).format(ts)
  return formatter(locale, { day: 'numeric', month: 'short' }).format(ts)
}

export const formatNumber = (value: number, locale: LocaleCode): string =>
  new Intl.NumberFormat(localeTag(locale)).format(value)
