import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { liveStatus, type LiveStatus } from '../../core/location/status'
import type { Message } from '../../core/models/types'
import { displayName } from '../screens/ChatList'
import { formatCoordinates, formatDistance, formatLeft } from './format'
import { useLocationText } from './locationText'
import { MapView } from './MapView'
import { LocationViewer } from './LocationViewer'
import { liveLine, markerFor, spanAround } from './present'
import { useNow } from './useNow'

/**
 * A location in the conversation (ADR-064): a place with its pin, or someone's
 * live location with their marker, the way they came, whether it is still
 * moving, and how long it has to run. Tapped, it opens in a sheet with the
 * details and a way to see where the reader is in relation to it.
 */

export function LocationCard({ message }: { message: Message }) {
  const text = useLocationText()
  const { locale } = useI18n()
  const stopSharing = useApp((s) => s.stopSharing)
  const contacts = useApp((s) => s.contacts)
  const selfName = useApp((s) => s.identity?.name ?? '')
  const [open, setOpen] = useState(false)
  const spec = message.location
  const moving = spec?.live !== undefined && message.live?.end === undefined
  const now = useNow(moving ? 15_000 : null)
  if (!spec) return null

  const status = liveStatus(message, now)
  const name =
    message.direction === 'out'
      ? selfName
      : displayName(contacts.get(message.authorPubkey), message.authorPubkey)
  const { marker, trail } = markerFor(message, status, name)
  const title = status ? (status.active ? text('live') : text('liveEnded')) : (spec.place ?? text('place'))
  const detail = status
    ? liveLine(status, now, text, locale)
    : `${formatCoordinates(spec, locale)}${spec.acc ? ` · ±${formatDistance(spec.acc, locale)}` : ''}`

  return (
    <div className={status?.active ? 'location-card location-live' : 'location-card'}>
      <button type="button" className="location-map" onClick={() => setOpen(true)} aria-label={text('open')}>
        <MapView
          center={marker.at}
          span={spanAround(marker.at, marker.acc, trail)}
          markers={[marker]}
          trail={trail ? { points: trail, color: marker.color } : undefined}
          label={text('map', { place: title })}
        />
      </button>
      <div className="location-caption">
        <span className="location-lines">
          <span className="location-title" dir="auto">
            {title}
          </span>
          <span className="location-detail">{detail}</span>
        </span>
        {status?.active ? <Countdown status={status} seconds={spec.live ?? 0} now={now} /> : null}
      </div>
      {status?.active && message.direction === 'out' ? (
        <button type="button" className="location-stop" onClick={() => void stopSharing(message.id)}>
          {text('stop')}
        </button>
      ) : null}
      {/* Out of the bubble, whose colours and wrapping it would otherwise take on. */}
      {open
        ? createPortal(<LocationViewer message={message} onClose={() => setOpen(false)} />, document.body)
        : null}
    </div>
  )
}

/** Telegram's ring: how much of the time is left, or an open loop for "until turned off". */
function Countdown({ status, seconds, now }: { status: LiveStatus; seconds: number; now: number }) {
  const text = useLocationText()
  const { locale } = useI18n()
  const CIRCUMFERENCE = 2 * Math.PI * 15
  const open = status.endsAt === null
  const fraction = open ? 1 : Math.max(0, Math.min(1, ((status.endsAt ?? now) - now) / (seconds * 1000)))
  const label = open
    ? text('untilOff')
    : text('left', { time: formatLeft((status.endsAt ?? now) - now, locale) })
  return (
    <span className="location-countdown" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="ring-track" cx="18" cy="18" r="15" />
        <circle
          className="ring-left"
          cx="18"
          cy="18"
          r="15"
          transform="rotate(-90 18 18)"
          strokeDasharray={`${(fraction * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`}
        />
        {open ? (
          <text x="18" y="18" dy="0.35em">
            ∞
          </text>
        ) : null}
      </svg>
    </span>
  )
}
