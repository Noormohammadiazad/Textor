import { describe, expect, it } from 'vitest'
import {
  cornerOf,
  MAX_TILE_ZOOM,
  MAX_TILES,
  TILE_ORIGIN,
  tileOf,
  tilesCovering,
  tileUrl,
  zoomFor,
} from '@/core/location/tiles'
import { ALLOWED_REMOTE, cspFailures, parseCsp } from '../scripts/cspPolicy.mjs'
import { DEFAULT_SETTINGS } from '@/core/models/types'
import { makeVault } from './helpers'

/**
 * Street maps (ADR-065): the Web Mercator arithmetic that finds OpenStreetMap's
 * tiles for a map, and the content policy that lets those images — and no
 * other remote resource — in. Reference values were computed independently.
 */

const TEHRAN = { lat: 35.6892, lon: 51.389 }

describe('finding a tile', () => {
  it('places a position in the grid of tiles', () => {
    const { x, y } = tileOf(TEHRAN, 15)
    expect(x).toBeCloseTo(21061.540978, 5)
    expect(y).toBeCloseTo(12902.425273, 5)
    expect(tileOf({ lat: 0, lon: 0 }, 1)).toEqual({ x: 1, y: 1 })
    const london = tileOf({ lat: 51.5007, lon: -0.1246 }, 12)
    expect(london.x).toBeCloseTo(2046.582329, 5)
    expect(london.y).toBeCloseTo(1362.147008, 5)
  })

  it('stops at the edge of the projection rather than running to infinity', () => {
    expect(tileOf({ lat: 90, lon: 0 }, 2).y).toBeCloseTo(0, 6)
    expect(tileOf({ lat: -90, lon: 0 }, 2).y).toBeCloseTo(4, 6)
  })

  it('finds a tile’s corner, and comes back to it', () => {
    const corner = cornerOf(21061, 12935, 15)
    expect(corner.lat).toBeCloseTo(35.398006, 5)
    expect(corner.lon).toBeCloseTo(51.383057, 5)
    expect(cornerOf(0, 0, 0).lat).toBeCloseTo(85.051129, 5)
    const back = tileOf(cornerOf(1234, 567, 11), 11)
    expect(back.x).toBeCloseTo(1234, 6)
    expect(back.y).toBeCloseTo(567, 6)
  })

  it('names the tile as the operator asks', () => {
    expect(tileUrl(15, 21061, 12902)).toBe('https://tile.openstreetmap.org/15/21061/12902.png')
  })
})

describe('choosing how fine a tile', () => {
  it('draws tiles nearest their own size, so streets read as lettered', () => {
    expect(zoomFor(1, TEHRAN.lat)).toBe(17)
    expect(zoomFor(2.4, 60)).toBe(15)
  })

  it('stays inside the zooms the tiles exist at', () => {
    expect(zoomFor(0.3, 0)).toBe(MAX_TILE_ZOOM)
    expect(zoomFor(0.001, 0)).toBe(MAX_TILE_ZOOM)
    expect(zoomFor(1e7, 0)).toBe(0)
    expect(Number.isFinite(zoomFor(1, 90))).toBe(true)
  })
})

describe('covering a map with tiles', () => {
  it('asks for exactly the tiles on screen, each with its corners', () => {
    const tiles = tilesCovering({ lat: 35.692, lon: 51.385 }, { lat: 35.686, lon: 51.393 }, 16)
    // Two columns by two rows of z16 tiles around that point.
    expect(tiles.map((tile) => `${tile.x}/${tile.y}`)).toEqual([
      '42122/25804',
      '42123/25804',
      '42122/25805',
      '42123/25805',
    ])
    for (const tile of tiles) {
      expect(tile.url).toBe(`${TILE_ORIGIN}/16/${tile.x}/${tile.y}.png`)
      expect(tile.nw.lat).toBeGreaterThan(tile.se.lat)
      expect(tile.nw.lon).toBeLessThan(tile.se.lon)
    }
    // Neighbours share their edges, so no seam opens between them.
    expect(tiles[0]!.se.lon).toBe(tiles[1]!.nw.lon)
    expect(tiles[0]!.se.lat).toBe(tiles[2]!.nw.lat)
  })

  it('wraps an address across the antimeridian, and keeps the corners continuous', () => {
    const tiles = tilesCovering({ lat: 1, lon: 179.9 }, { lat: -1, lon: 180.1 }, 8)
    expect(new Set(tiles.map((tile) => tile.x))).toEqual(new Set([255, 0]))
    const east = tiles.find((tile) => tile.x === 0)!
    expect(east.nw.lon).toBeCloseTo(180, 9)
    expect(east.se.lon).toBeGreaterThan(180)
  })

  it('asks for nothing past the poles, and nothing at all for more than a screenful', () => {
    expect(tilesCovering({ lat: 89, lon: -10 }, { lat: 84, lon: 10 }, 4).every((tile) => tile.y >= 0)).toBe(
      true,
    )
    expect(tilesCovering({ lat: 60, lon: -60 }, { lat: -60, lon: 60 }, 10)).toEqual([])
    expect(MAX_TILES).toBe(16)
  })
})

describe('the street-map setting', () => {
  it('is off by default, and off for a vault written before it existed', async () => {
    expect(DEFAULT_SETTINGS.streetMaps).toBe(false)
    const vault = await makeVault('streets-default')
    try {
      // A vault that never heard of the setting reads it as off.
      const { streetMaps: _never, ...older } = DEFAULT_SETTINGS
      await vault.repo.saveSettings(older)
      expect((await vault.repo.getSettings()).streetMaps).toBe(false)
    } finally {
      await vault.destroy()
    }
  })
})

describe('the content policy', () => {
  const policy = (imgSrc: string, extra = '') =>
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src ${imgSrc}`,
      "connect-src 'self' wss: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'upgrade-insecure-requests',
      extra,
    ].join('; ')

  it('lets in the tile server for images, and the relays for connections', () => {
    expect(cspFailures(policy(`'self' data: blob: ${TILE_ORIGIN}`))).toEqual([])
    expect(ALLOWED_REMOTE['img-src']).toEqual([TILE_ORIGIN])
    expect(parseCsp(policy("'self'")).get('upgrade-insecure-requests')).toEqual([])
  })

  it('refuses any other remote origin, anywhere', () => {
    expect(cspFailures(policy(`'self' https://evil.example`))).toEqual([
      'CSP img-src allows a remote origin it should not: https://evil.example',
    ])
    expect(cspFailures(policy(`'self' https:`))).toEqual(['CSP img-src allows any origin: https:'])
    expect(cspFailures(policy(`'self' *`))).toEqual(['CSP img-src allows any origin: *'])
    expect(cspFailures(policy(`'self' https://*.openstreetmap.org`))).toEqual([
      'CSP img-src allows any origin: https://*.openstreetmap.org',
    ])
    expect(cspFailures(policy("'self'", `connect-src ${TILE_ORIGIN}`))).toEqual([
      `CSP connect-src allows a remote origin it should not: ${TILE_ORIGIN}`,
    ])
    expect(cspFailures(policy("'self'", 'font-src cdn.example.com'))).toEqual([
      'CSP font-src allows a remote origin it should not: cdn.example.com',
    ])
  })

  it('still refuses what it always refused', () => {
    expect(cspFailures("script-src 'self' 'unsafe-eval'")).toEqual([
      "CSP is missing: default-src 'self'",
      "CSP is missing: object-src 'none'",
      "CSP is missing: base-uri 'none'",
      "CSP is missing: form-action 'none'",
      "CSP allows 'unsafe-inline' or 'unsafe-eval' for scripts",
    ])
  })
})
