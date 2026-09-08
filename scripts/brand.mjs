/**
 * Textor's mark and wordmark, and every image made from them, as one set of numbers.
 *
 * Each image is a list of layers painted in order, and each layer a fill and a
 * few analytic shapes: rectangles (optionally rounded), circles, convex
 * polygons and annular sectors. The same list is written out as SVG and
 * rasterized to PNG here, testing each sample point against the shape's own
 * equation, so the vector and the raster cannot disagree: there is nothing to
 * approximate on either side. `tests/brandAssets.test.ts` fails if a committed
 * file differs from what these numbers produce, so the files are never edited
 * by hand — change a number here and run `npm run icons`.
 *
 * Why the mark is this shape is ADR-026, and how it was refined, together with
 * the wordmark and the link preview, ADR-080.
 */
import { deflateSync } from 'node:zlib'

/* ---------------------------------------------------------------- colours -- */

/** From the ramps in src/styles/theme.css, so the brand is the app's own blue. */
export const COLOURS = {
  /** --blue-600: the badge, and the link knocked out of the bubble. */
  brand: '#1a56b8',
  /** --n-0: the bubble. */
  white: '#ffffff',
  /** --n-900: the wordmark on a light page. */
  ink: '#181c24',
  /** --n-50: the wordmark on a dark page. */
  paper: '#f4f6f8',
  /** --n-950: the link preview's ground. */
  night: '#0e1116',
  /** --blue-900: the network drawn faintly behind the link preview. */
  dusk: '#16283f',
}

/* ------------------------------------------------------------- primitives -- */

const rect = (x, y, w, h, r = 0) => ({ t: 'rect', x, y, w, h, r })
const circle = (cx, cy, r) => ({ t: 'circle', cx, cy, r })
const poly = (...pts) => ({ t: 'poly', pts })
/** The part of a ring between two angles, in degrees clockwise from east, a0 < a1. */
const arc = (cx, cy, R, r, a0, a1) => ({ t: 'arc', cx, cy, R, r, a0, a1 })

/** A straight stroke of thickness `th` between two points, square-ended. */
function bar(x0, y0, x1, y1, th) {
  const length = Math.hypot(x1 - x0, y1 - y0)
  const nx = (-(y1 - y0) / length) * (th / 2)
  const ny = ((x1 - x0) / length) * (th / 2)
  return poly([x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny])
}

/** Scale a shape by `k` about the origin, then move it by (dx, dy). */
function place(shape, dx, dy, k = 1) {
  switch (shape.t) {
    case 'rect':
      return {
        ...shape,
        x: shape.x * k + dx,
        y: shape.y * k + dy,
        w: shape.w * k,
        h: shape.h * k,
        r: shape.r * k,
      }
    case 'circle':
      return { ...shape, cx: shape.cx * k + dx, cy: shape.cy * k + dy, r: shape.r * k }
    case 'poly':
      return { ...shape, pts: shape.pts.map(([x, y]) => [x * k + dx, y * k + dy]) }
    default:
      return { ...shape, cx: shape.cx * k + dx, cy: shape.cy * k + dy, R: shape.R * k, r: shape.r * k }
  }
}

const placeAll = (shapes, dx, dy, k) => shapes.map((shape) => place(shape, dx, dy, k))

/* ------------------------------------------------------------------- mark -- */

/**
 * The mark, on a 64-unit grid: a badge, a message bubble, and in it a link
 * between two nodes — a message that goes from you to them, not through
 * anyone's server (ADR-026).
 *
 * The link climbs from lower left to upper right, so it reads as a direction
 * rather than as a dumbbell, and it is centred on the bubble (32, 28). The tail
 * continues the bubble's left edge straight down, so the silhouette has one
 * outline rather than a triangle stuck to a box. Bubble and tail together fill
 * 12..52 on both axes: a square, centred on the badge.
 */
export const MARK = {
  badge: rect(0, 0, 64, 64, 14),
  bubble: [rect(12, 12, 40, 32, 14), poly([12, 30], [26, 42], [12, 52])],
  link: [bar(24.5, 32, 39.5, 24, 3.2), circle(24.5, 32, 4), circle(39.5, 24, 4)],
}

/**
 * How far the mark shrinks inside a maskable icon. A launcher may crop to a
 * circle of 80% of the width, radius 25.6 units; the mark's farthest point, the
 * tail's tip, is 22.6 units from the centre at this scale, which clears it.
 */
export const MASKABLE_SCALE = 0.8

function markLayers(dx = 0, dy = 0, k = 1, badge = MARK.badge) {
  return [
    { fill: COLOURS.brand, shapes: [place(badge, dx, dy, k)] },
    { fill: COLOURS.white, shapes: placeAll(MARK.bubble, dx, dy, k) },
    { fill: COLOURS.brand, shapes: placeAll(MARK.link, dx, dy, k) },
  ]
}

/**
 * The icon in each of the forms its touchpoints need (ADR-026):
 *
 *   rounded   the badge rounds its own corners, the rest is transparent: the
 *             favicon, and PWA icons of purpose "any"
 *   bleed     colour to every edge: apple-touch-icon, because iOS applies its
 *             own mask and a pre-rounded icon shows black in the corners
 *   maskable  colour to every edge and the mark shrunk into the safe zone, for
 *             launchers that crop to a shape of their own
 */
export function iconArt(form) {
  const square = rect(0, 0, 64, 64)
  if (form === 'rounded') return { viewBox: [0, 0, 64, 64], layers: markLayers() }
  if (form === 'bleed') return { viewBox: [0, 0, 64, 64], layers: markLayers(0, 0, 1, square) }
  const offset = 32 * (1 - MASKABLE_SCALE)
  const [, ...mark] = markLayers(offset, offset, MASKABLE_SCALE)
  return { viewBox: [0, 0, 64, 64], layers: [{ fill: COLOURS.brand, shapes: [square] }, ...mark] }
}

/**
 * Safari's pinned-tab glyph: the bubble's silhouette alone, in black, which
 * Safari recolours. At about 16 points the link would be sub-pixel, and a glyph
 * that turns to noise is worse than one that is merely simple. The viewBox is
 * the silhouette's own bounds, so it fills the slot.
 */
export function pinnedTabArt() {
  return { viewBox: [11, 11, 42, 42], layers: [{ fill: null, shapes: MARK.bubble }] }
}

/* --------------------------------------------------------------- wordmark -- */

/**
 * "textor", in lower case, drawn from the same primitives as the mark, so the
 * name needs no font: not in a README, where an SVG image cannot load one, and
 * not in the link preview, which is rasterized here.
 *
 * A geometric sans: an x-height of 24 units, one stroke weight throughout, round
 * letters overshooting the x-height a little as drawn type does, and the t's
 * stem rising above it. Units are the mark's; the baseline is y = 0.
 */
export const WORDMARK = (() => {
  const S = 5 // stroke
  const X = 24 // x-height
  const A = 31 // the t's ascender
  const R = X / 2 + 0.4 // radius of the round letters
  const TRACK = 3 // between letters, before kerning
  const glyphs = {
    t: { advance: 14, shapes: [rect(4.2, -A, S, A), rect(0, -X, 14, S * 0.92)] },
    e: {
      advance: 2 * R,
      // A ring open from east to 42° below it, and a bar across the middle.
      shapes: [
        arc(R, -X / 2, R, R - S, 42, 360),
        rect(S * 0.6, -X / 2 - S * 0.46, 2 * R - S * 0.6, S * 0.92),
      ],
    },
    x: {
      advance: 22,
      // Each stroke is cut flat at the baseline and the x-height.
      shapes: [
        poly([0, -X], [S * 1.18, -X], [22, 0], [22 - S * 1.18, 0]),
        poly([22 - S * 1.18, -X], [22, -X], [S * 1.18, 0], [0, 0]),
      ],
    },
    o: { advance: 2 * R, shapes: [arc(R, -X / 2, R, R - S, 0, 360)] },
    r: {
      advance: 17.5,
      // The shoulder is a quarter-and-a-bit of a ring whose inner edge meets the stem's.
      shapes: [rect(0, -X, S, X), arc(12, -X + 12, 12, 12 - S, 180, 305)],
    },
  }
  const kern = { te: -0.6, ex: -0.4, xt: -0.6, to: -0.6, or: 0.2 }
  const shapes = []
  let x = 0
  let previous = ''
  for (const letter of 'textor') {
    if (previous) x += TRACK + (kern[previous + letter] ?? 0)
    shapes.push(...placeAll(glyphs[letter].shapes, x, 0, 1))
    x += glyphs[letter].advance
    previous = letter
  }
  return { shapes, width: x, xHeight: X, ascent: A }
})()

/**
 * Mark and wordmark side by side, the wordmark's x-height centred on the mark.
 * The wordmark is 1.125 times its own units, which makes its x-height 0.42 of
 * the badge: big enough to read as the name, small enough to leave the mark
 * leading.
 */
const LOCKUP = { gap: 19, wordScale: 1.125 }

function lockupLayers(ink, dx = 0, dy = 0, k = 1) {
  const word = placeAll(
    WORDMARK.shapes,
    64 + LOCKUP.gap,
    32 + (WORDMARK.xHeight * LOCKUP.wordScale) / 2,
    LOCKUP.wordScale,
  )
  return [...markLayers(dx, dy, k), { fill: ink, shapes: placeAll(word, dx, dy, k) }]
}

/** Width of the lockup in mark units. */
export const LOCKUP_WIDTH = 64 + LOCKUP.gap + WORDMARK.width * LOCKUP.wordScale

/** The lockup for a README, on a page that is light (`ink`) or dark (`paper`). */
export function lockupArt(ink) {
  return { viewBox: [0, 0, round(LOCKUP_WIDTH), 64], layers: lockupLayers(ink) }
}

/* ----------------------------------------------------------- link preview -- */

/**
 * The image a link to Textor unfurls to, and the repository's social preview:
 * 1280 by 640, the 2:1 that both GitHub and large link cards use. The lockup is
 * centred on the night ground, with a faint network of nodes and links either
 * side — relays and the people they carry for — kept out of the middle, where a
 * card cropped to 1.91:1 or a rounded corner cannot reach it.
 */
export const PREVIEW = { width: 1280, height: 640, scale: 2.5 }

const NETWORK = {
  nodes: [
    [104, 136, 9],
    [236, 88, 7],
    [176, 304, 13],
    [300, 440, 8],
    [112, 524, 10],
    [1176, 116, 8],
    [1044, 200, 12],
    [1168, 356, 9],
    [1004, 476, 7],
    [1128, 552, 13],
  ],
  links: [
    [0, 2],
    [1, 2],
    [2, 3],
    [2, 4],
    [5, 6],
    [6, 7],
    [7, 8],
    [7, 9],
  ],
}

export function previewArt() {
  const { width, height, scale } = PREVIEW
  const dx = (width - LOCKUP_WIDTH * scale) / 2
  const dy = (height - 64 * scale) / 2
  const { nodes, links } = NETWORK
  const network = [
    ...links.map(([a, b]) => bar(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], 4)),
    ...nodes.map(([cx, cy, r]) => circle(cx, cy, r)),
  ]
  return {
    viewBox: [0, 0, width, height],
    layers: [
      { fill: COLOURS.night, shapes: [rect(0, 0, width, height)] },
      { fill: COLOURS.dusk, shapes: network },
      ...lockupLayers(COLOURS.paper, dx, dy, scale),
    ],
  }
}

/* -------------------------------------------------------------------- SVG -- */

/** Three decimals at most, no trailing zeros, and never "-0". */
function round(n) {
  const value = Math.round(n * 1000) / 1000
  return Object.is(value, -0) ? 0 : value
}

function point(cx, cy, r, degrees) {
  const radians = (degrees * Math.PI) / 180
  return `${round(cx + r * Math.cos(radians))} ${round(cy + r * Math.sin(radians))}`
}

function shapeSvg(shape) {
  switch (shape.t) {
    case 'rect': {
      const corner = shape.r ? ` rx="${round(shape.r)}"` : ''
      return `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}"${corner}/>`
    }
    case 'circle':
      return `<circle cx="${round(shape.cx)}" cy="${round(shape.cy)}" r="${round(shape.r)}"/>`
    case 'poly':
      return `<polygon points="${shape.pts.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')}"/>`
    default: {
      const { cx, cy, R, r, a0, a1 } = shape
      if (a1 - a0 >= 360) {
        // A whole ring: two circles, the inner one wound the other way.
        const circlePath = (radius, sweep) =>
          `M${round(cx - radius)} ${round(cy)}a${round(radius)} ${round(radius)} 0 1 ${sweep} ${round(2 * radius)} 0` +
          `a${round(radius)} ${round(radius)} 0 1 ${sweep} ${round(-2 * radius)} 0Z`
        return `<path d="${circlePath(R, 1)}${circlePath(r, 0)}"/>`
      }
      const large = a1 - a0 > 180 ? 1 : 0
      return (
        `<path d="M${point(cx, cy, R, a0)}A${round(R)} ${round(R)} 0 ${large} 1 ${point(cx, cy, R, a1)}` +
        `L${point(cx, cy, r, a1)}A${round(r)} ${round(r)} 0 ${large} 0 ${point(cx, cy, r, a0)}Z"/>`
      )
    }
  }
}

/** The artwork as a compact SVG document. */
export function toSvg(art, label) {
  const [x, y, w, h] = art.viewBox
  const name = label ? ` role="img" aria-label="${label}"` : ''
  const body = art.layers
    .map((layer) => {
      const shapes = layer.shapes.map(shapeSvg).join('')
      return layer.fill ? `<g fill="${layer.fill}">${shapes}</g>` : shapes
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"${name}>${body}</svg>\n`
}

/* ------------------------------------------------------------- rasterizer -- */

function inRoundedRect(x, y, { x: x0, y: y0, w, h, r }) {
  const x1 = x0 + w
  const y1 = y0 + h
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  if (!r) return true
  const nearLeft = x < x0 + r
  const nearRight = x > x1 - r
  const nearTop = y < y0 + r
  const nearBottom = y > y1 - r
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true
  const cx = nearLeft ? x0 + r : x1 - r
  const cy = nearTop ? y0 + r : y1 - r
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Inside a convex polygon of either winding: on the same side of every edge. */
function inConvex(x, y, pts) {
  let sign = 0
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (cross === 0) continue
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return true
}

function inArc(x, y, { cx, cy, R, r, a0, a1 }) {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2
  if (d2 > R * R || d2 < r * r) return false
  if (a1 - a0 >= 360) return true
  const degrees = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
  return (((degrees - a0) % 360) + 360) % 360 <= a1 - a0
}

function contains(shape, x, y) {
  switch (shape.t) {
    case 'rect':
      return inRoundedRect(x, y, shape)
    case 'circle':
      return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2
    case 'poly':
      return inConvex(x, y, shape.pts)
    default:
      return inArc(x, y, shape)
  }
}

function bounds(shape) {
  switch (shape.t) {
    case 'rect':
      return [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
    case 'circle':
      return [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r]
    case 'poly': {
      const xs = shape.pts.map(([x]) => x)
      const ys = shape.pts.map(([, y]) => y)
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    default:
      return [shape.cx - shape.R, shape.cy - shape.R, shape.cx + shape.R, shape.cy + shape.R]
  }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/**
 * Samples per pixel per axis. Sixteen samples a pixel is what makes the
 * badge's corners and the bubble read as drawn rather than stepped (ADR-026).
 */
export const SAMPLES = 4

/**
 * Render to RGBA. Each sample takes the colour of the topmost layer covering
 * it; a pixel averages the samples that something covered, and is as opaque as
 * the share that were, so an edge keeps the shape's colour at reduced alpha
 * rather than being pulled towards black.
 */
export function rasterize(art, width, height) {
  const [vx, vy, vw, vh] = art.viewBox
  const layers = art.layers
    .map((layer) => ({
      colour: rgb(layer.fill ?? '#000000'),
      shapes: layer.shapes.map((shape) => ({ shape, box: bounds(shape) })),
    }))
    .reverse()
  const pixels = new Uint8Array(width * height * 4)
  const total = SAMPLES * SAMPLES
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        const y = vy + ((py + (sy + 0.5) / SAMPLES) * vh) / height
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = vx + ((px + (sx + 0.5) / SAMPLES) * vw) / width
          const layer = layers.find((candidate) =>
            candidate.shapes.some(
              ({ shape, box }) =>
                x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && contains(shape, x, y),
            ),
          )
          if (!layer) continue
          r += layer.colour[0]
          g += layer.colour[1]
          b += layer.colour[2]
          covered++
        }
      }
      if (covered === 0) continue
      const offset = (py * width + px) * 4
      pixels[offset] = Math.round(r / covered)
      pixels[offset + 1] = Math.round(g / covered)
      pixels[offset + 2] = Math.round(b / covered)
      pixels[offset + 3] = Math.round((covered / total) * 255)
    }
  }
  return pixels
}

/* -------------------------------------------------------------------- PNG -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

/**
 * A minimal RGBA PNG: one IDAT, no ancillary chunks, and no filtering, which
 * flat artwork does not need and which keeps the file readable back by
 * stripping one byte per row. An image-processing dependency for this would
 * be a dependency in a project whose pitch is having few.
 */
export function encodePng(pixels, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ files -- */

/**
 * Every brand file in the repository, by path. An SVG entry carries its text;
 * a PNG entry the artwork and size to rasterize it at, so a test can compare
 * pixels without depending on how one zlib or another compresses them.
 *
 * Only what is under `public/` is deployed. Of that, the precache takes the
 * favicon, `icon-32` and the pinned-tab glyph, which `index.html` names; the
 * other icons and the link preview are fetched by an operating system or a
 * link unfurler, never by the running app, and vite.config.ts leaves them out.
 */
export function brandFiles() {
  return [
    { path: 'public/favicon.svg', svg: toSvg(iconArt('rounded'), 'Textor') },
    { path: 'public/icons/mask-icon.svg', svg: toSvg(pinnedTabArt()) },
    // 32 is the classic favicon for browsers that ignore the SVG one.
    { path: 'public/icons/icon-32.png', art: iconArt('rounded'), width: 32, height: 32 },
    { path: 'public/icons/icon-192.png', art: iconArt('rounded'), width: 192, height: 192 },
    { path: 'public/icons/icon-512.png', art: iconArt('rounded'), width: 512, height: 512 },
    { path: 'public/icons/icon-maskable-512.png', art: iconArt('maskable'), width: 512, height: 512 },
    { path: 'public/icons/apple-touch-icon.png', art: iconArt('bleed'), width: 180, height: 180 },
    { path: 'public/social-card.png', art: previewArt(), width: PREVIEW.width, height: PREVIEW.height },
    { path: 'docs/assets/logo-light.svg', svg: toSvg(lockupArt(COLOURS.ink), 'Textor') },
    { path: 'docs/assets/logo-dark.svg', svg: toSvg(lockupArt(COLOURS.paper), 'Textor') },
  ]
}
