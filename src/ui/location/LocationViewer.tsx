import { useEffect, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { bearingDeg, compassPoint, distanceM, type LatLon } from '../../core/location/geo'
import { browserPositions } from '../../core/location/position'
import { liveStatus } from '../../core/location/status'
import type { GeoFix } from '../../core/models/location'
import type { Message } from '../../core/models/types'
import { Modal } from '../components/primitives'
import { displayName } from '../screens/ChatList'
import { formatDateTime } from '../format'
import { formatCoordinates, formatDegrees, formatDistance, formatSpeed, plainCoordinates } from './format'
import { locationText, useLocationText } from './locationText'
import { liveLine, markerFor, spanAround } from './present'
import { ASPECT, MapView, type MapMarker } from './MapView'
import { useNow } from './useNow'

/** The closest and furthest a map may be drawn: a room, and a province. */
const SPAN = { min: 30, max: 200_000 }

/**
 * A location opened from the conversation: a map to look around, what is known
 * about the position, and — only if the reader asks — where they are in
 * relation to it. Their own position stays on this device; it is shown, never
 * sent. Handing the place to a maps application or OpenStreetMap is offered,
 * and is the one step that tells anyone outside the conversation where it is.
 */
export function LocationViewer({ message, onClose }: { message: Message; onClose: () => void }) {
  const text = useLocationText()
  const { locale } = useI18n()
  const toast = useApp((s) => s.toast)
  const stopSharing = useApp((s) => s.stopSharing)
  const contacts = useApp((s) => s.contacts)
  const selfName = useApp((s) => s.identity?.name ?? '')
  const moving = message.location?.live !== undefined && message.live?.end === undefined
  const now = useNow(moving ? 15_000 : null)
  const [look, setLook] = useState<LatLon | null>(null)
  const [zoom, setZoom] = useState(1)
  const [showMe, setShowMe] = useState(false)
  const [me, setMe] = useState<GeoFix | null>(null)

  // Only while asked, coarsely, and only here. Watched once for as long as it
  // is asked — not again on every render, which each new position causes.
  useEffect(() => {
    if (!showMe) return
    return browserPositions().watch(false, setMe, (failure) => {
      const { settings, toast: say } = useApp.getState()
      say(locationText(settings.locale, failure), 'danger')
      setShowMe(false)
    })
  }, [showMe])

  const status = liveStatus(message, now)
  const name =
    message.direction === 'out'
      ? selfName
      : displayName(contacts.get(message.authorPubkey), message.authorPubkey)
  const { marker, trail } = markerFor(message, status, name)
  const at = marker.at
  const mine = showMe ? me : null
  const markers: MapMarker[] = mine ? [{ at: mine, kind: 'self', acc: mine.acc }, marker] : [marker]
  // Framed on the marker — and on the reader too, once they are shown — until
  // they look around for themselves.
  const framed = mine ? { lat: (at.lat + mine.lat) / 2, lon: (at.lon + mine.lon) / 2 } : at
  const fit = spanAround(framed, marker.acc, [...(trail ?? []), at, ...(mine ? [mine] : [])], ASPECT.tall)
  const span = Math.min(SPAN.max, Math.max(SPAN.min, fit * zoom))
  const title = status
    ? status.active
      ? text('live')
      : text('liveEnded')
    : (message.location?.place ?? text('place'))

  const pair = (label: string, value: string) => (
    <div key={label} className="info-pair">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )

  const copy = () => {
    void navigator.clipboard
      ?.writeText(plainCoordinates(at))
      .then(() => toast(text('copied')))
      .catch(() => undefined)
  }

  const { lat, lon } = { lat: at.lat.toFixed(6), lon: at.lon.toFixed(6) }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack location-viewer">
        <MapView
          shape="tall"
          center={look ?? framed}
          span={span}
          markers={markers}
          trail={trail ? { points: trail, color: marker.color } : undefined}
          label={text('map', { place: title })}
          moves={{
            onMove: setLook,
            onZoom: (factor) =>
              setZoom((current) => Math.min(SPAN.max / fit, Math.max(SPAN.min / fit, current * factor))),
            onRecenter: () => {
              setLook(null)
              setZoom(1)
            },
          }}
        />
        {status ? <p className="location-detail">{liveLine(status, now, text, locale)}</p> : null}

        <dl className="info-list">
          {pair(text('coordinates'), formatCoordinates(at, locale))}
          {marker.acc !== undefined
            ? pair(text('accuracyLabel'), `±${formatDistance(marker.acc, locale)}`)
            : null}
          {marker.hdg !== undefined
            ? pair(text('heading'), `${formatDegrees(marker.hdg)} · ${text(compassPoint(marker.hdg))}`)
            : null}
          {status?.active && status.state.spd !== undefined
            ? pair(text('speed'), formatSpeed(status.state.spd, locale))
            : null}
          {status ? pair(text('updatedLabel'), formatDateTime(status.updatedAt, locale)) : null}
          {status?.active
            ? pair(
                text('endsLabel'),
                status.endsAt === null ? text('untilOff') : formatDateTime(status.endsAt, locale),
              )
            : null}
          {mine
            ? pair(
                text('fromYou'),
                text('away', {
                  distance: formatDistance(distanceM(mine, at), locale),
                  direction: text(compassPoint(bearingDeg(mine, at))),
                }),
              )
            : null}
        </dl>

        <div className="location-actions">
          <button type="button" className="btn btn-outline" onClick={() => setShowMe((on) => !on)}>
            {showMe ? text('hideMe') : text('showMe')}
          </button>
          <button type="button" className="btn btn-outline" onClick={copy}>
            {text('copy')}
          </button>
          <a className="btn btn-outline" href={`geo:${lat},${lon}`}>
            {text('openApp')}
          </a>
          <a
            className="btn btn-outline"
            href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {text('openOsm')}
          </a>
          {status?.active && message.direction === 'out' ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                void stopSharing(message.id)
                onClose()
              }}
            >
              {text('stop')}
            </button>
          ) : null}
        </div>
        <p className="hint">
          {text('drawn')} {text('osmNote')}
        </p>
      </div>
    </Modal>
  )
}
