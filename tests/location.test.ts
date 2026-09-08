import { describe, expect, it } from 'vitest'
import {
  foldLive,
  locationFallback,
  locationFromTags,
  locationTags,
  MAX_ACCURACY_M,
  readFix,
  startLive,
  TRAIL_POINTS,
  type LiveState,
} from '@/core/models/location'
import {
  encodeControlFrame,
  parseControlFrame,
  PROTOCOL_VERSION,
  type LiveFrame,
} from '@/core/models/protocol'
import {
  bearingDeg,
  compassPoint,
  distanceM,
  niceStep,
  parsePosition,
  project,
  turnDeg,
  unproject,
} from '@/core/location/geo'
import { liveStatus, STALE_AFTER_MS } from '@/core/location/status'
import type { Message } from '@/core/models/types'

const REF = 'a'.repeat(64)
const TEHRAN = { lat: 35.6892, lon: 51.389 }
const frame = (seq: number, extra: Partial<LiveFrame> = {}): LiveFrame => ({
  v: PROTOCOL_VERSION,
  t: 'loc',
  ref: REF,
  seq,
  ...extra,
})

describe('a position', () => {
  it('is rounded to what travels', () => {
    expect(readFix({ lat: 35.68921234, lon: 51.38999999, acc: 12.6, hdg: 359.7, spd: 1.26 })).toEqual({
      lat: 35.689212,
      lon: 51.39,
      acc: 13,
      hdg: 0,
      spd: 1.3,
    })
    expect(readFix({ lat: -90, lon: 180 })).toEqual({ lat: -90, lon: 180 })
  })

  it('is refused whole when any part is out of range or not a number', () => {
    expect(readFix({ lat: 90.1, lon: 0 })).toBeNull()
    expect(readFix({ lat: 0, lon: -180.5 })).toBeNull()
    expect(readFix({ lat: '1', lon: 2 })).toBeNull()
    expect(readFix({ lat: Number.NaN, lon: 2 })).toBeNull()
    expect(readFix({ lat: 0, lon: 0, acc: -1 })).toBeNull()
    expect(readFix({ lat: 0, lon: 0, acc: MAX_ACCURACY_M + 1 })).toBeNull()
    expect(readFix({ lat: 0, lon: 0, hdg: 361 })).toBeNull()
    expect(readFix({ lat: 0, lon: 0, spd: 400 })).toBeNull()
    expect(readFix({ lat: 0, lon: 0, spd: Infinity })).toBeNull()
  })
})

describe('location tags', () => {
  it('round-trip a place, with its name and accuracy', () => {
    const tags = locationTags({ ...TEHRAN, acc: 12.4, place: 'Café Naderi' })
    expect(tags).toEqual([
      ['location', '35.6892', '51.389', '12'],
      ['place', 'Café Naderi'],
    ])
    expect(locationFromTags(tags)).toEqual({ ...TEHRAN, acc: 12, place: 'Café Naderi' })
  })

  it('round-trip a live location, which is nobody’s place', () => {
    const tags = locationTags({ ...TEHRAN, place: 'ignored', live: 900 })
    expect(tags).toEqual([
      ['location', '35.6892', '51.389'],
      ['live', '900'],
    ])
    expect(locationFromTags(tags)).toEqual({ ...TEHRAN, live: 900 })
    expect(locationFromTags(locationTags({ ...TEHRAN, live: 0 }))?.live).toBe(0)
    expect(locationTags(TEHRAN)).toEqual([['location', '35.6892', '51.389']])
  })

  it('reads nothing where there is no valid location', () => {
    expect(locationFromTags([])).toBeNull()
    expect(locationFromTags([['location', '35.6892']])).toBeNull()
    expect(locationFromTags([['location', '35.6892', '1e2']])).toBeNull()
    expect(locationFromTags([['location', '135.5', '0']])).toBeNull()
    expect(locationFromTags([['location', '1', '2', '-3']])).toBeNull()
    expect(locationFromTags([['location', '1', '2', '1234567']])).toBeNull()
  })

  it('refuses a live location whose time is not sensible, rather than showing it as a place', () => {
    const at = (value: string) =>
      locationFromTags([
        ['location', '1', '2'],
        ['live', value],
      ])
    expect(at('30')).toBeNull()
    expect(at(String(8 * 86_400))).toBeNull()
    expect(at('ten')).toBeNull()
    expect(locationFromTags([['location', '1', '2'], ['live']])).toBeNull()
    expect(at('60')?.live).toBe(60)
  })

  it('cleans a place name and drops an empty one', () => {
    expect(
      locationFromTags([
        ['location', '1', '2'],
        ['place', '  a\nb  '],
      ])?.place,
    ).toBe('a b')
    expect(
      locationFromTags([
        ['location', '1', '2'],
        ['place', '   '],
      ]),
    ).toEqual({ lat: 1, lon: 2 })
  })

  it('falls back to a geo: URI other clients can open', () => {
    expect(locationFallback({ ...TEHRAN, acc: 12 })).toBe('📍 geo:35.6892,51.389;u=12')
    expect(locationFallback({ ...TEHRAN, place: 'Home' })).toBe('📍 Home\ngeo:35.6892,51.389')
    expect(locationFallback({ ...TEHRAN, live: 900 })).toBe('📡 geo:35.6892,51.389')
  })
})

describe('the live location frame', () => {
  const parse = (value: Record<string, unknown>) =>
    parseControlFrame(JSON.stringify({ v: PROTOCOL_VERSION, t: 'loc', ref: REF, seq: 1, ...value }))

  it('carries a position, rounded', () => {
    expect(parse({ lat: 35.12345678, lon: 51, acc: 5, hdg: 90, spd: 1.5 })).toEqual(
      frame(1, { lat: 35.123457, lon: 51, acc: 5, hdg: 90, spd: 1.5 }),
    )
  })

  it('ends with or without one', () => {
    expect(parse({ end: true })).toEqual(frame(1, { end: true }))
    expect(parse({ end: true, lat: 1, lon: 2 })).toEqual(frame(1, { lat: 1, lon: 2, end: true }))
    const echoed = parseControlFrame(encodeControlFrame(frame(4, { end: true })))
    expect(echoed).toEqual(frame(4, { end: true }))
  })

  it('refuses anything garbled', () => {
    expect(parse({})).toBeNull()
    expect(parse({ lat: 1 })).toBeNull()
    expect(parse({ end: true, lat: 1 })).toBeNull()
    expect(parse({ end: true, lat: 100, lon: 0 })).toBeNull()
    expect(parse({ end: false, lat: 1, lon: 2 })).toBeNull()
    expect(parse({ lat: 1, lon: 2, hdg: 400 })).toBeNull()
    expect(parse({ seq: 0, lat: 1, lon: 2 })).toBeNull()
    expect(parse({ seq: 1.5, lat: 1, lon: 2 })).toBeNull()
    expect(parse({ ref: 'nope', lat: 1, lon: 2 })).toBeNull()
  })
})

describe('folding a live location', () => {
  const start = startLive({ ...TEHRAN, acc: 30, live: 900 }, 1_000, 1_500)

  it('starts where the message put it, lagging by how long it took to come', () => {
    expect(start).toEqual({ ...TEHRAN, acc: 30, seq: 0, at: 1_000, lag: 500 })
    expect(startLive({ ...TEHRAN, live: 0 }, 1_000, 1_000)).toEqual({ ...TEHRAN, seq: 0, at: 1_000, lag: 0 })
  })

  it('moves on whole, keeps a trail, and learns the least lag', () => {
    const moved = foldLive(start, frame(1, { lat: 35.7, lon: 51.4, hdg: 45 }), 2_000, 2_100) as LiveState
    expect(moved).toEqual({
      lat: 35.7,
      lon: 51.4,
      hdg: 45,
      seq: 1,
      at: 2_000,
      lag: 100,
      trail: [[TEHRAN.lat, TEHRAN.lon]],
    })
    // Arriving slowly does not make the lag worse: it is a bound, not a guess.
    const slow = foldLive(moved, frame(2, { lat: 35.7, lon: 51.4 }), 3_000, 9_000) as LiveState
    expect(slow.lag).toBe(100)
    // Standing still adds nothing to the trail.
    expect(slow.trail).toEqual(moved.trail)
  })

  it('keeps no more of the trail than it draws', () => {
    let state: LiveState = start
    for (let seq = 1; seq <= TRAIL_POINTS + 5; seq++) {
      state = foldLive(state, frame(seq, { lat: seq / 100, lon: 0 }), seq, seq) as LiveState
    }
    expect(state.trail).toHaveLength(TRAIL_POINTS)
    expect(state.trail?.at(-1)).toEqual([(TRAIL_POINTS + 4) / 100, 0])
  })

  it('ignores what is older, repeated, or after the end', () => {
    const moved = foldLive(start, frame(3, { lat: 1, lon: 1 }), 2_000, 2_000) as LiveState
    expect(foldLive(moved, frame(3, { lat: 2, lon: 2 }), 3_000, 3_000)).toBeNull()
    expect(foldLive(moved, frame(2, { lat: 2, lon: 2 }), 3_000, 3_000)).toBeNull()
    const ended = foldLive(moved, frame(4, { end: true }), 4_000, 4_000) as LiveState
    expect(ended).toMatchObject({ lat: 1, lon: 1, seq: 4, at: 2_000, end: 4_000 })
    expect(foldLive(ended, frame(5, { lat: 3, lon: 3 }), 5_000, 5_000)).toBeNull()
  })

  it('draws no trail for a share that has not moved', () => {
    const still = foldLive(start, frame(1, { ...TEHRAN }), 2_000, 2_000) as LiveState
    expect(still.trail).toBeUndefined()
    expect(still.acc).toBeUndefined()
  })

  it('ends at a last position when one comes with the end', () => {
    expect(foldLive(start, frame(1, { lat: 1, lon: 1, end: true }), 2_000, 2_000)).toMatchObject({
      lat: 1,
      lon: 1,
      end: 2_000,
    })
  })

  it('takes nothing from a frame that is neither a position nor an end', () => {
    expect(foldLive(start, frame(1), 2_000, 2_000)).toBeNull()
  })
})

describe('what a reader sees of a live location', () => {
  const MIN = 60_000
  const message = (patch: Partial<Message>): Message => ({
    id: REF,
    convoId: 'c',
    direction: 'in',
    status: 'delivered',
    ts: 0,
    tsCoarse: 0,
    body: '',
    authorPubkey: 'b'.repeat(64),
    location: { ...TEHRAN, live: 15 * 60 },
    ...patch,
  })

  it('is nothing for a message that is not live', () => {
    expect(liveStatus(message({ location: undefined }), 0)).toBeNull()
    expect(liveStatus(message({ location: TEHRAN }), 0)).toBeNull()
  })

  it('runs for its time on this clock, not its author’s', () => {
    // Their phone runs an hour behind: sent "at 0", it arrived an hour later here.
    const live = startLive({ ...TEHRAN, live: 900 }, 0, 60 * MIN)
    const status = liveStatus(message({ live }), 70 * MIN)
    expect(status).toMatchObject({
      active: true,
      endsAt: 75 * MIN,
      endedAt: null,
      updatedAt: 60 * MIN,
      stale: false,
    })
    expect(liveStatus(message({ live }), 75 * MIN)).toMatchObject({ active: false, endedAt: 75 * MIN })
  })

  it('reads a message never folded as having arrived when sent', () => {
    expect(liveStatus(message({}), 5 * MIN)).toMatchObject({ active: true, endsAt: 15 * MIN, updatedAt: 0 })
  })

  it('goes stale when nothing is heard, and never ends by itself when shared until turned off', () => {
    const open = message({ location: { ...TEHRAN, live: 0 } })
    expect(liveStatus(open, STALE_AFTER_MS)).toMatchObject({ active: true, endsAt: null, stale: false })
    expect(liveStatus(open, STALE_AFTER_MS + 1)).toMatchObject({ active: true, stale: true })
    expect(liveStatus(open, 1e12)).toMatchObject({ active: true })
  })

  it('believes an end at once', () => {
    const live: LiveState = { ...TEHRAN, seq: 2, at: 60_000, lag: 1_000, end: 120_000 }
    expect(liveStatus(message({ live }), 125_000)).toMatchObject({
      active: false,
      endedAt: 121_000,
      stale: false,
    })
  })
})

describe('geometry', () => {
  const LONDON = { lat: 51.5007, lon: -0.1246 }
  const PARIS = { lat: 48.8584, lon: 2.2945 }

  it('measures along the Earth', () => {
    expect(distanceM(LONDON, PARIS) / 1000).toBeCloseTo(340.6, 0)
    expect(distanceM(TEHRAN, TEHRAN)).toBe(0)
    // Either side of the antimeridian is close, not a world apart.
    expect(distanceM({ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 })).toBeLessThan(300)
  })

  it('gives the way to go', () => {
    expect(bearingDeg(LONDON, PARIS)).toBeCloseTo(148.7, 0)
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0)
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270)
    expect(compassPoint(148)).toBe('se')
    expect(compassPoint(350)).toBe('n')
    expect(compassPoint(-90)).toBe('w')
  })

  it('turns the short way round', () => {
    expect(turnDeg(350, 10)).toBe(20)
    expect(turnDeg(10, 350)).toBe(20)
    expect(turnDeg(0, 180)).toBe(180)
    expect(turnDeg(90, 450)).toBe(0)
  })

  it('projects and comes back', () => {
    const point = { lat: 35.7, lon: 51.4 }
    const { x, y } = project(TEHRAN, point)
    expect(x).toBeGreaterThan(0)
    expect(y).toBeGreaterThan(0)
    const back = unproject(TEHRAN, x, y)
    expect(back.lat).toBeCloseTo(point.lat, 9)
    expect(back.lon).toBeCloseTo(point.lon, 9)
    // Across the antimeridian, and clamped at the pole.
    expect(project({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }).x).toBeGreaterThan(0)
    expect(unproject({ lat: 0, lon: 179.9 }, 50_000, 0).lon).toBeLessThan(-179)
    expect(unproject({ lat: 89.9, lon: 0 }, 0, 1e6).lat).toBe(90)
    expect(Number.isFinite(project({ lat: 90, lon: 0 }, { lat: 89, lon: 10 }).x)).toBe(true)
  })

  it('picks a round length for a scale', () => {
    expect(niceStep(740)).toBe(500)
    expect(niceStep(260)).toBe(200)
    expect(niceStep(19)).toBe(10)
    expect(niceStep(0)).toBe(0.001)
  })
})

describe('reading a position someone pasted', () => {
  const close = (text: string, lat: number, lon: number) => {
    const read = parsePosition(text)
    expect(read, text).not.toBeNull()
    expect(read?.lat).toBeCloseTo(lat, 5)
    expect(read?.lon).toBeCloseTo(lon, 5)
  }

  it('reads decimal pairs, however they are written', () => {
    close('35.6892, 51.3890', 35.6892, 51.389)
    close('35.6892 51.389', 35.6892, 51.389)
    close('-33.8568,151.2153', -33.8568, 151.2153)
    close('meet at 35.6892, 51.389 please', 35.6892, 51.389)
    close('۳۵٫۶۸۹۲، ۵۱٫۳۸۹', 35.6892, 51.389)
    close('٣٥٫٦٨٩٢، ٥١٫٣٨٩', 35.6892, 51.389)
  })

  it('reads hemispheres and degrees, minutes and seconds, in either order', () => {
    close(`35°41'21.1"N 51°23'20.4"E`, 35.689194, 51.389)
    close('33°51′24.5″S 151°12′55.1″E', -33.856806, 151.215306)
    close('51.389 E, 35.6892 N', 35.6892, 51.389)
    close('40.7 N 74.0 W', 40.7, -74)
    close(`35°41.35'N 51°23.34'E`, 35.689167, 51.389)
  })

  it('reads map links and geo: URIs', () => {
    close('geo:35.6892,51.389;u=12', 35.6892, 51.389)
    close('https://www.openstreetmap.org/?mlat=35.6892&mlon=51.389#map=16/35.6/51.3', 35.6892, 51.389)
    close('https://www.openstreetmap.org/#map=17/35.6892/51.389', 35.6892, 51.389)
    close('https://www.google.com/maps/place/Somewhere/@35.6892,51.389,17z', 35.6892, 51.389)
    close('https://maps.google.com/?q=35.6892,51.389', 35.6892, 51.389)
    close('https://maps.apple.com/?ll=35.6892%2C51.389&q=Pin', 35.6892, 51.389)
  })

  it('refuses what is not a position', () => {
    for (const text of [
      '',
      '   ',
      'somewhere nice',
      '35.6892',
      '1 2 3',
      '95, 10',
      '10, 190',
      '1045.5 12',
      `35°61'N 51°E`,
      '35 N, 51 S',
      '51 E, 35 W',
      'https://maps.example.com/place/Tehran',
      'https://www.openstreetmap.org/?mlat=95&mlon=10',
    ]) {
      expect(parsePosition(text), text).toBeNull()
    }
  })
})
