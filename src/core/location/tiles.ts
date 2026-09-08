import type { LatLon } from './geo'

/**
 * Street maps from OpenStreetMap's standard tiles, for someone who has asked
 * for them (ADR-065).
 *
 * Raster tiles drawn as plain images under the map Textor already draws: no
 * map engine, no vector decoder, no worker, nothing evaluated. The one host is
 * named in the content policy's `img-src` and nowhere else, so nothing but
 * these images can be fetched from it, and nothing at all from anywhere else.
 * Its operator's policy is followed to the letter: the URL it gives, the
 * page's origin as referrer, its attribution on every map, tiles only for what
 * is on screen, and the browser's own cache, which honours its headers.
 */

export const TILE_ORIGIN = 'https://tile.openstreetmap.org'
export const TILE_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright'
/** The deepest zoom the standard tiles are drawn at. */
export const MAX_TILE_ZOOM = 19
/** More than a screenful asks too much of a server run on donations: then there are no tiles. */
export const MAX_TILES = 16

/** Metres one 256-pixel tile's pixel spans at the equator at zoom 0 (WGS 84 semi-major axis). */
const EQUATOR_M_PER_PX = (2 * Math.PI * 6_378_137) / 256
/** Web Mercator stops here; past it the projection runs to infinity. */
const MAX_LAT = 85.051_128_78

export interface Tile {
  z: number
  /** Column and row, the column wrapped onto the one world. */
  x: number
  y: number
  url: string
  /** Its corners, in the continuous longitude the map was asked about. */
  nw: LatLon
  se: LatLon
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const rad = (degrees: number): number => (degrees * Math.PI) / 180

/** Where a position falls in the grid of tiles at zoom `z`: a fractional column and row. */
export function tileOf(point: LatLon, z: number): { x: number; y: number } {
  const n = 2 ** z
  const lat = rad(clamp(point.lat, -MAX_LAT, MAX_LAT))
  return {
    x: ((point.lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  }
}

/** The north-west corner of the tile at column `x` and row `y`; the inverse of `tileOf`. */
export function cornerOf(x: number, y: number, z: number): LatLon {
  const n = 2 ** z
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    lon: (x / n) * 360 - 180,
  }
}

/**
 * The zoom whose tiles are drawn nearest their own size where one screen pixel
 * covers `metresPerPixel` at latitude `lat`: so a street's name reads at the
 * size it was lettered.
 */
export function zoomFor(metresPerPixel: number, lat: number): number {
  const z = Math.round(
    Math.log2((EQUATOR_M_PER_PX * Math.cos(rad(clamp(lat, -MAX_LAT, MAX_LAT)))) / metresPerPixel),
  )
  return clamp(z, 0, MAX_TILE_ZOOM)
}

export const tileUrl = (z: number, x: number, y: number): string => `${TILE_ORIGIN}/${z}/${x}/${y}.png`

/**
 * The tiles that cover the box from `nw` to `se` at zoom `z`, or none if that
 * would be more than `MAX_TILES`. Longitudes may run past ±180 — a map across
 * the antimeridian — and each tile keeps corners in those terms while its
 * address wraps onto the one world.
 */
export function tilesCovering(nw: LatLon, se: LatLon, z: number): Tile[] {
  const n = 2 ** z
  const from = tileOf(nw, z)
  const to = tileOf(se, z)
  const rows = [Math.max(0, Math.floor(from.y)), Math.min(n - 1, Math.floor(to.y))] as const
  const columns = [Math.floor(from.x), Math.floor(to.x)] as const
  if ((rows[1] - rows[0] + 1) * (columns[1] - columns[0] + 1) > MAX_TILES) return []
  const tiles: Tile[] = []
  for (let y = rows[0]; y <= rows[1]; y++) {
    for (let x = columns[0]; x <= columns[1]; x++) {
      const column = ((x % n) + n) % n
      tiles.push({
        z,
        x: column,
        y,
        url: tileUrl(z, column, y),
        nw: cornerOf(x, y, z),
        se: cornerOf(x + 1, y + 1, z),
      })
    }
  }
  return tiles
}
