import { useEffect, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { distanceM, parsePosition, type LatLon } from '../../core/location/geo'
import { browserPositions, type PositionFailure } from '../../core/location/position'
import { MAX_PLACE_CHARS, type GeoFix, type LocationSpec } from '../../core/models/location'
import { Field, Modal, Spinner } from '../components/primitives'
import { formatCoordinates, formatDistance } from './format'
import { useLocationText, type LocationTextKey } from './locationText'
import { MapView, type MapMarker } from './MapView'

/** Telegram's choices, and the one it added later. */
const DURATIONS: [seconds: number, label: LocationTextKey][] = [
  [15 * 60, 'for15'],
  [60 * 60, 'for60'],
  [8 * 60 * 60, 'for480'],
  [0, 'forever'],
]

const SPAN = { min: 30, max: 200_000 }

/**
 * Send a place, or start sharing live (ADR-064).
 *
 * Where the device is comes from the browser, which asks the person first. A
 * place somewhere else is chosen by moving the pin on the map, or by pasting
 * its coordinates or a map link — there is no search, because a search for a
 * place by name is a question to a map service, and the answer tells it what
 * was looked for. Refusing location leaves every way of sending a place but
 * the current one.
 */
export function LocationPicker({ onClose }: { onClose: () => void }) {
  const text = useLocationText()
  const { locale } = useI18n()
  const shareLocation = useApp((s) => s.shareLocation)
  const [here, setHere] = useState<GeoFix | null>(null)
  const [failure, setFailure] = useState<PositionFailure | null>(null)
  const [pin, setPin] = useState<LatLon | null>(null)
  const [look, setLook] = useState<LatLon | null>(null)
  const [span, setSpan] = useState(250)
  const [typed, setTyped] = useState('')
  const [unreadable, setUnreadable] = useState(false)
  const [place, setPlace] = useState('')
  const [busy, setBusy] = useState(false)

  // Watched while the picker is open, so the accuracy settles as satellites come in.
  useEffect(
    () =>
      browserPositions().watch(
        true,
        (fix) => {
          setHere(fix)
          setFailure(null)
        },
        setFailure,
      ),
    [],
  )

  const target = pin ?? here
  const center = look ?? target
  const markers: MapMarker[] = []
  if (here) markers.push({ at: here, kind: 'self', acc: here.acc })
  if (target) markers.push({ at: target, kind: 'place' })

  const send = async (spec: LocationSpec) => {
    setBusy(true)
    const sent = await shareLocation(spec)
    setBusy(false)
    if (sent) onClose()
  }

  const status = failure
    ? text(failure)
    : pin && here
      ? text('moved', { distance: formatDistance(distanceM(here, pin), locale) })
      : pin
        ? formatCoordinates(pin, locale)
        : here
          ? `${formatCoordinates(here, locale)}${here.acc !== undefined ? ` · ${text('accuracy', { distance: formatDistance(here.acc, locale) })}` : ''}`
          : text('finding')

  return (
    <Modal title={text('title')} onClose={onClose} labelledBy="location-picker-title">
      <div className="stack location-picker">
        {center ? (
          <MapView
            shape="tall"
            center={center}
            span={span}
            markers={markers}
            label={text('map', { place: formatCoordinates(center, locale) })}
            moves={{
              onMove: setLook,
              onZoom: (factor) =>
                setSpan((current) => Math.min(SPAN.max, Math.max(SPAN.min, current * factor))),
              onPick: (at) => {
                // The view stays where it is; only the pin moves under the finger.
                setLook(center)
                setPin(at)
                setTyped('')
                setUnreadable(false)
              },
              onRecenter: () => setLook(null),
            }}
          />
        ) : (
          <div className="map map-tall map-waiting">{failure ? null : <Spinner />}</div>
        )}
        <p className={failure && failure !== 'unavailable' ? 'hint danger-text' : 'hint'} role="status">
          {status}
          {pin && here ? (
            <>
              {' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setPin(null)
                  setLook(null)
                  setTyped('')
                }}
              >
                {text('sendHere')}
              </button>
            </>
          ) : null}
        </p>
        {center ? <p className="hint">{text('tapHint')}</p> : null}

        <Field label={text('paste')} error={unreadable ? text('notAPosition') : undefined}>
          <input
            className="input"
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            placeholder="35.6892, 51.3890"
            onChange={(event) => {
              setTyped(event.target.value)
              const read = parsePosition(event.target.value)
              setUnreadable(false)
              if (!read) return
              setPin(read)
              setLook(null)
            }}
            onBlur={() => setUnreadable(typed.trim() !== '' && !parsePosition(typed))}
          />
        </Field>
        <Field label={text('placeName')}>
          <input
            className="input"
            dir="auto"
            maxLength={MAX_PLACE_CHARS}
            value={place}
            onChange={(event) => setPlace(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || !target}
          onClick={() => {
            if (!target) return
            void send({
              lat: target.lat,
              lon: target.lon,
              // Only a position the device found has an accuracy; a chosen one is exact.
              ...(!pin && here?.acc !== undefined ? { acc: here.acc } : {}),
              ...(place.trim() ? { place: place.trim() } : {}),
            })
          }}
        >
          {pin ? text('sendPin') : text('sendHere')}
        </button>

        <fieldset className="location-live-choices">
          <legend className="label">{text('shareLive')}</legend>
          <div className="location-durations">
            {DURATIONS.map(([seconds, label]) => (
              <button
                key={seconds}
                type="button"
                className="btn btn-outline"
                disabled={busy || !here}
                onClick={() => {
                  if (!here) return
                  void send({
                    lat: here.lat,
                    lon: here.lon,
                    ...(here.acc !== undefined ? { acc: here.acc } : {}),
                    live: seconds,
                  })
                }}
              >
                {text(label)}
              </button>
            ))}
          </div>
          <p className="hint">{text('liveHint')}</p>
        </fieldset>
        <p className="hint location-privacy">{text('privacy')}</p>
      </div>
    </Modal>
  )
}
