import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { niceStep, project, unproject, type LatLon } from '../../core/location/geo'
import { useI18n } from '../../i18n'
import { formatDistance } from './format'
import { useLocationText } from './locationText'

/**
 * A map drawn on this device from positions alone (ADR-064).
 *
 * There are no tiles, because there is nowhere to get them from: the content
 * policy lets the app reach relays and nothing else, and a tile server asked
 * for the streets around a point learns the point. What it can show honestly
 * it shows well — where each marker is relative to the others, how far that
 * is by the scale, how sure the position is, which way it is heading, and
 * the path behind a live one — on a grid that stays put under the markers
 * as the map moves, so it reads as a place rather than a picture.
 *
 * North is always up and east always right, in Persian too: a map does not
 * mirror with the writing direction.
 */

export interface MapMarker {
  at: LatLon
  kind: 'place' | 'live' | 'self'
  /** How sure the position is, in metres: drawn as a halo around it. */
  acc?: number
  /** Degrees clockwise from north: drawn as a beam ahead of it. */
  hdg?: number
  /** Still being shared and heard from: it pulses. */
  pulse?: boolean
  /** A live marker is its sharer: their colour and initials. */
  color?: string
  initials?: string
}

export interface MapMoves {
  onMove: (center: LatLon) => void
  onZoom: (factor: number) => void
  /** Tapped somewhere without dragging: for putting a pin there. */
  onPick?: (at: LatLon) => void
  onRecenter?: () => void
}

const WIDTH = 320
const HEIGHT = { wide: 180, tall: 240 } as const
const HALF_W = WIDTH / 2
/** How much wider than tall each shape is: what a frame has to allow for east and west. */
export const ASPECT = { wide: WIDTH / HEIGHT.wide, tall: WIDTH / HEIGHT.tall } as const
/** Further than this a drag is a drag, not a tap. */
const TAP_PX = 6

export function MapView({
  center,
  span,
  markers,
  trail,
  label,
  shape = 'wide',
  moves,
}: {
  center: LatLon
  /** Metres from the centre to the top edge. */
  span: number
  markers: MapMarker[]
  trail?: { points: LatLon[]; color?: string }
  label: string
  shape?: keyof typeof HEIGHT
  moves?: MapMoves
}) {
  const { locale } = useI18n()
  const text = useLocationText()
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; from: LatLon; moved: boolean } | null>(null)
  const latest = useRef(moves)
  useEffect(() => {
    latest.current = moves
  })

  const halfH = HEIGHT[shape] / 2
  const perUnit = span / halfH
  const toView = (point: LatLon) => {
    const { x, y } = project(center, point)
    return { x: x / perUnit, y: -y / perUnit }
  }

  // The grid is fixed to the ground, not to the frame, so it slides under a drag.
  const step = niceStep(span * 0.6)
  const originX = project({ lat: center.lat, lon: 0 }, center).x
  const originY = project({ lat: 0, lon: center.lon }, center).y
  const lines = (origin: number, half: number, vertical: boolean) => {
    const out = []
    for (let k = Math.ceil((origin - half * perUnit) / step); k * step <= origin + half * perUnit; k++) {
      const at = ((k * step - origin) / perUnit) * (vertical ? 1 : -1)
      out.push(
        vertical ? (
          <line key={`x${k}`} x1={at} x2={at} y1={-halfH} y2={halfH} />
        ) : (
          <line key={`y${k}`} x1={-HALF_W} x2={HALF_W} y1={at} y2={at} />
        ),
      )
    }
    return out
  }

  // A wheel over the map zooms it rather than scrolling the page, which takes a
  // listener that is allowed to say no to the scroll.
  const interactive = moves !== undefined
  useEffect(() => {
    const node = svg.current
    if (!node || !interactive) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      latest.current?.onZoom(event.deltaY > 0 ? 1.25 : 0.8)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [interactive])

  const unitsPerPx = () => WIDTH / (svg.current?.getBoundingClientRect().width || WIDTH)
  const interaction = moves
    ? {
        tabIndex: 0,
        onPointerDown(event: PointerEvent<SVGSVGElement>) {
          event.currentTarget.setPointerCapture?.(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY, from: center, moved: false }
        },
        onPointerMove(event: PointerEvent<SVGSVGElement>) {
          const from = drag.current
          if (!from) return
          const dx = event.clientX - from.x
          const dy = event.clientY - from.y
          if (!from.moved && Math.hypot(dx, dy) < TAP_PX) return
          from.moved = true
          const k = unitsPerPx() * perUnit
          moves.onMove(unproject(from.from, -dx * k, dy * k))
        },
        onPointerUp(event: PointerEvent<SVGSVGElement>) {
          const from = drag.current
          drag.current = null
          if (!from || from.moved || !moves.onPick) return
          const rect = event.currentTarget.getBoundingClientRect()
          const k = unitsPerPx()
          const x = (event.clientX - rect.left) * k - HALF_W
          const y = (event.clientY - rect.top) * k - halfH
          moves.onPick(unproject(center, x * perUnit, -y * perUnit))
        },
        onPointerCancel() {
          drag.current = null
        },
        onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
          const nudge = span / 2
          const by: Record<string, [number, number]> = {
            ArrowUp: [0, nudge],
            ArrowDown: [0, -nudge],
            ArrowLeft: [-nudge, 0],
            ArrowRight: [nudge, 0],
          }
          const offset = by[event.key]
          if (offset) moves.onMove(unproject(center, offset[0], offset[1]))
          else if (event.key === '+' || event.key === '=') moves.onZoom(0.8)
          else if (event.key === '-') moves.onZoom(1.25)
          else return
          event.preventDefault()
        },
      }
    : {}

  const scaleLength = step / perUnit
  return (
    <div className={`map map-${shape}${moves ? ' map-interactive' : ''}`}>
      <svg
        ref={svg}
        viewBox={`${-HALF_W} ${-halfH} ${WIDTH} ${HEIGHT[shape]}`}
        role="img"
        aria-label={label}
        {...interaction}
      >
        <rect className="map-ground" x={-HALF_W} y={-halfH} width={WIDTH} height={HEIGHT[shape]} />
        <g className="map-grid">
          {lines(originX, HALF_W, true)}
          {lines(originY, halfH, false)}
        </g>
        {trail && trail.points.length > 1 ? (
          <polyline
            className="map-trail"
            style={trail.color ? { stroke: trail.color } : undefined}
            points={trail.points
              .map(toView)
              .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
              .join(' ')}
          />
        ) : null}
        {markers.map((marker, index) =>
          marker.acc ? (
            <circle
              key={`acc${index}`}
              className={`map-halo map-halo-${marker.kind}`}
              style={marker.color ? { fill: marker.color, stroke: marker.color } : undefined}
              {...point(toView(marker.at))}
              r={Math.min(marker.acc / perUnit, WIDTH)}
            />
          ) : null,
        )}
        {markers.map((marker, index) => {
          const { x, y } = toView(marker.at)
          return (
            <g key={index} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
              {marker.hdg !== undefined ? (
                // A beam that fades as it widens: two cones, one inside the other.
                <g
                  className="map-beam"
                  style={marker.color ? { fill: marker.color } : undefined}
                  transform={`rotate(${marker.hdg})`}
                >
                  <path d="M0 0 L-20.1 -32.2 A 38 38 0 0 1 20.1 -32.2 Z" />
                  <path d="M0 0 L-9.6 -26.3 A 28 28 0 0 1 9.6 -26.3 Z" />
                </g>
              ) : null}
              <Glyph marker={marker} />
            </g>
          )
        })}
        <g className="map-north" transform={`translate(${HALF_W - 16} ${-halfH + 16})`} aria-hidden="true">
          <path d="M0 -9 L5 5 L0 2 L-5 5 Z" />
          <text y={17}>N</text>
        </g>
        <g className="map-scale" transform={`translate(${-HALF_W + 12} ${halfH - 10})`} aria-hidden="true">
          <path d={`M0 -4 V0 H${scaleLength.toFixed(1)} V-4`} />
          <text x={0} y={-7}>
            {formatDistance(step, locale)}
          </text>
        </g>
      </svg>
      {moves ? (
        <div className="map-controls">
          <button
            type="button"
            className="map-control"
            aria-label={text('zoomIn')}
            onClick={() => moves.onZoom(0.5)}
          >
            +
          </button>
          <button
            type="button"
            className="map-control"
            aria-label={text('zoomOut')}
            onClick={() => moves.onZoom(2)}
          >
            −
          </button>
          {moves.onRecenter ? (
            <button
              type="button"
              className="map-control"
              aria-label={text('recenter')}
              title={text('recenter')}
              onClick={moves.onRecenter}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const point = ({ x, y }: { x: number; y: number }) => ({ cx: x.toFixed(1), cy: y.toFixed(1) })

function Glyph({ marker }: { marker: MapMarker }) {
  if (marker.kind === 'place') {
    // A pin whose point is the place.
    return (
      <g className="map-pin">
        <path d="M0 0 C-2 -6 -9 -10 -9 -17 A 9 9 0 1 1 9 -17 C 9 -10 2 -6 0 0 Z" />
        <circle cy={-17} r={3.4} />
      </g>
    )
  }
  if (marker.kind === 'self') return <circle className="map-self" r={6} />
  return (
    <g className="map-live">
      {marker.pulse ? <circle className="map-pulse" r={11} style={{ fill: marker.color }} /> : null}
      <circle className="map-live-dot" r={11} style={{ fill: marker.color }} />
      {marker.initials ? (
        <text className="map-live-initials" dy="0.35em">
          {marker.initials}
        </text>
      ) : null}
    </g>
  )
}
