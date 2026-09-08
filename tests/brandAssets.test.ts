import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { brandFiles, COLOURS, iconArt, MASKABLE_SCALE, rasterize } from '../scripts/brand.mjs'

/**
 * The mark, the wordmark and every image of them come from one set of numbers
 * in scripts/brand.mjs (ADR-026, ADR-080). What breaks if these go: an SVG
 * edited by hand while its PNGs keep the old shape, a PNG left stale after the
 * numbers moved, or an icon whose mark a launcher crops off.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`)

/** The PNGs brand.mjs writes: 8-bit RGBA, every row unfiltered. */
function decodePng(png: Buffer) {
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([data[8], data[9]]).toEqual([8, 6])
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

const rgba = (pixels: Uint8Array, size: number, x: number, y: number) =>
  Array.from(pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4))

const opaque = (hex: string) => [...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), 255]

describe('brand files', () => {
  const files = brandFiles()

  it.each(files.filter((file) => file.svg !== undefined).map((file) => [file.path, file.svg] as const))(
    '%s is exactly what the numbers draw',
    (path, svg) => {
      expect(read(path).toString('utf8'), `${path} has drifted: run npm run icons`).toBe(svg)
    },
  )

  it.each(files.flatMap((file) => (file.svg === undefined ? [[file.path, file] as const] : [])))(
    '%s is the numbers, pixel for pixel',
    (path, file) => {
      const png = decodePng(read(path))
      expect([png.width, png.height]).toEqual([file.width, file.height])
      const drawn = Buffer.from(rasterize(file.art, file.width, file.height))
      expect(png.pixels.equals(drawn), `${path} has drifted: run npm run icons`).toBe(true)
    },
  )

  it('the favicon names itself, and stays small, as every byte of it is precached', () => {
    const favicon = files.find((file) => file.path === 'public/favicon.svg')?.svg ?? ''
    expect(favicon).toContain('aria-label="Textor"')
    expect(favicon).not.toContain('<!--')
    expect(favicon.length).toBeLessThan(600)
  })
})

describe('icon forms', () => {
  const size = 128

  it('a maskable icon keeps the mark inside the circle a launcher may crop to', () => {
    // A maskable icon must survive a crop to a circle of 80% of its width.
    const pixels = rasterize(iconArt('maskable'), size, size)
    const safe = 0.4 * size
    let markInside = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
        const pixel = rgba(pixels, size, x, y)
        if (distance > safe) expect(pixel, `(${x}, ${y})`).toEqual(opaque(COLOURS.brand))
        else if (pixel.join() === opaque(COLOURS.white).join()) markInside++
      }
    }
    expect(markInside).toBeGreaterThan(size * size * MASKABLE_SCALE * 0.1)
  })

  it('a rounded icon is transparent at its corners, and a bleed icon is colour to every edge', () => {
    const rounded = rasterize(iconArt('rounded'), size, size)
    const bleed = rasterize(iconArt('bleed'), size, size)
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ] as const) {
      expect(rgba(rounded, size, x, y)[3]).toBe(0)
      expect(rgba(bleed, size, x, y)).toEqual(opaque(COLOURS.brand))
    }
  })
})
