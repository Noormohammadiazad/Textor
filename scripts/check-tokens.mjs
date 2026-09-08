/**
 * Gate for the design-token layer. Two checks, both of them things a comment
 * cannot enforce and a reviewer will not reliably catch.
 *
 *  1. Contrast. Resolves every semantic role to a concrete colour in all three
 *     theme resolutions — light, explicit dark, system dark — and checks the
 *     pairs the interface actually renders against WCAG 2.1 minimums. A token
 *     file drifts: someone darkens one ramp step to fix a border and pushes
 *     secondary text under 4.5:1 in one theme only.
 *
 *  2. References. Every `var(--x)` across the stylesheets, components, and
 *     index.html must name a token that exists. An undefined custom property
 *     resolves to nothing, so a renamed token does not throw — it silently
 *     renders invisible text or a collapsed border.
 *
 * Run: node scripts/check-tokens.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/styles/theme.css'), 'utf8')

/* ------------------------------------------------------------------ parse -- */

/** Declarations inside the first block whose selector list matches `pattern`. */
function block(pattern) {
  // Selector, then a balanced-enough body: theme.css has no nested braces
  // inside the role blocks, which keeps this honest and dependency-free.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (!pattern.test(selector)) continue
    const declarations = {}
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations[decl[1]] = decl[2].trim()
    }
    return declarations
  }
  throw new Error(`no block matching ${pattern}`)
}

// `:root` appears several times; the ramps and the light role map are the two
// that carry colours, and later declarations win, so merge in source order.
const rootBlocks = []
{
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (!/^:root(,\s*:root\[data-theme='light'\])?$/.test(selector)) continue
    const declarations = {}
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations[decl[1]] = decl[2].trim()
    }
    rootBlocks.push(declarations)
  }
}

const light = Object.assign({}, ...rootBlocks)
const dark = { ...light, ...block(/^:root\[data-theme='dark'\]$/) }
const darkMedia = { ...light, ...block(/^:root:not\(\[data-theme='light'\]\)$/) }

/* --------------------------------------------------------------- resolve -- */

function resolve(map, name, seen = new Set()) {
  const raw = map[name]
  if (raw === undefined) throw new Error(`unknown token ${name}`)
  if (seen.has(name)) throw new Error(`circular token ${name}`)
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  if (!ref) return raw
  return resolve(map, ref[1], new Set([...seen, name]))
}

function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)/.exec(value.trim())
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  throw new Error(`cannot read colour: ${value}`)
}

function luminance(value) {
  const channels = rgb(value).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(map, a, b) {
  const [x, y] = [luminance(resolve(map, a)), luminance(resolve(map, b))]
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

/* ----------------------------------------------------------------- rules -- */

/*
 * `min` follows WCAG 2.1:
 *   7.0  AAA body text
 *   4.5  AA text, and AA large text is 3.0 — used only where the token is
 *        genuinely never rendered below ~19px
 *   3.0  AA non-text: focus rings, control boundaries, chart-like marks
 */
const RULES = [
  ['text', 'bg', 7, 'body text on the page canvas'],
  ['text', 'surface', 7, 'body text on a card'],
  ['text', 'surface-2', 7, 'body text on a raised row'],
  ['text', 'surface-3', 7, 'body text on the deepest surface'],
  ['text-muted', 'bg', 4.5, 'secondary text on the canvas'],
  ['text-muted', 'surface', 4.5, 'secondary text on a card'],
  ['text-muted', 'surface-2', 4.5, 'secondary text on a raised row'],
  ['text-faint', 'surface', 4.5, 'tertiary labels on a card'],
  ['text-faint', 'bg', 4.5, 'tertiary labels on the canvas'],

  ['accent-fg', 'accent', 4.5, 'label on a primary button'],
  ['accent-fg', 'accent-hover', 4.5, 'label on a hovered primary button'],
  ['accent-fg', 'accent-active', 4.5, 'label on a pressed primary button'],
  ['accent-text', 'surface', 4.5, 'link text on a card'],
  ['accent-text', 'bg', 4.5, 'link text on the canvas'],
  ['accent-text', 'accent-soft', 4.5, 'text inside an accent banner'],

  ['success', 'success-soft', 4.5, 'text inside a success badge'],
  ['success', 'surface', 4.5, 'success text on a card'],
  ['warning', 'warning-soft', 4.5, 'text inside a warning banner'],
  ['warning', 'surface', 4.5, 'warning text on a card'],
  ['danger', 'danger-soft', 4.5, 'text inside a danger banner'],
  ['danger', 'surface', 4.5, 'error text on a card'],
  ['danger-fg', 'danger', 4.5, 'label on a destructive button'],
  ['danger-fg', 'danger-hover', 4.5, 'label on a hovered destructive button'],

  ['bubble-out-text', 'bubble-out', 4.5, 'text in an outgoing message'],
  ['bubble-in-text', 'bubble-in', 7, 'text in an incoming message'],

  ['ring', 'bg', 3, 'focus ring against the canvas'],
  ['ring', 'surface', 3, 'focus ring against a card'],
  ['border-strong', 'surface', 3, 'input border against its own fill'],
  ['accent', 'surface', 3, 'primary button against a card'],
]

/* ------------------------------------------------------------------- run -- */

const THEMES = [
  ['light', light],
  ['dark (explicit)', dark],
  ['dark (system)', darkMedia],
]

let failures = 0
let checks = 0

for (const [themeName, map] of THEMES) {
  for (const [fg, bg, min, what] of RULES) {
    checks++
    const ratio = contrast(map, `--${fg}`, `--${bg}`)
    if (ratio + 0.005 >= min) continue
    failures++
    console.error(
      `  FAIL  ${themeName.padEnd(15)} ${what}\n` +
        `        --${fg} on --${bg}: ${ratio.toFixed(2)}:1, need ${min}:1`,
    )
  }
}

// The two dark maps must stay byte-identical in effect; they are written twice
// only because CSS cannot share a block across an at-rule boundary.
const roles = new Set([...RULES.flatMap(([a, b]) => [`--${a}`, `--${b}`])])
for (const role of roles) {
  checks++
  const explicit = resolve(dark, role)
  const system = resolve(darkMedia, role)
  if (explicit === system) continue
  failures++
  console.error(
    `  FAIL  dark maps disagree on ${role}: ` +
      `[data-theme="dark"] = ${explicit}, prefers-color-scheme = ${system}`,
  )
}

/* ------------------------------------------------------ token references -- */

const STYLES = ['theme', 'app', 'chat'].map((name) =>
  readFileSync(join(root, `src/styles/${name}.css`), 'utf8'),
)

// Tokens may be declared in any of the stylesheets, not only theme.css.
const declared = new Set(
  STYLES.flatMap((sheet) => [...sheet.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1])),
)

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(full)
    else if (/\.(css|tsx?|html)$/.test(entry.name)) yield full
  }
}

let references = 0
for (const file of [...sources(join(root, 'src')), join(root, 'index.html')]) {
  const source = readFileSync(file, 'utf8')
  for (const use of source.matchAll(/var\((--[\w-]+)/g)) {
    references++
    if (declared.has(use[1])) continue
    failures++
    console.error(`  FAIL  undefined token ${use[1]} used in ${relative(root, file)}`)
  }
}

/* ------------------------------------------------------------------ done -- */

if (failures > 0) {
  console.error(`\ntokens: ${failures} check(s) failed`)
  process.exit(1)
}
console.log(
  `tokens: ${checks} contrast checks passed across ${THEMES.length} themes; ` +
    `${references} var() references resolve against ${declared.size} tokens`,
)
