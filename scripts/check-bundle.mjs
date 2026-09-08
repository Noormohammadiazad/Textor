#!/usr/bin/env node
/**
 * Guard the "no third-party code, no third-party requests" claim.
 *
 * The Content-Security-Policy enforces this in the browser, but a CSP is only
 * as good as its policy string and policy strings are easy to loosen by
 * accident. This inspects the built output so a regression fails CI instead of
 * shipping quietly.
 *
 * Deliberately *not* checked: bare URL strings inside JavaScript. Libraries
 * embed documentation links in their error messages (Dexie points at tinyurl,
 * React at react.dev) and XML namespace constants look like URLs but are never
 * fetched. Flagging those produces noise that trains people to ignore the
 * check. What matters is whether anything is positioned to actually load from
 * a remote origin.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error('dist/ not found — run `npm run build` first')
  process.exit(1)
}

const rel = (path) => relative(DIST, path)
const failures = []
const read = (path) => readFileSync(path, 'utf8')

const html = files.filter((f) => f.endsWith('.html'))
const css = files.filter((f) => f.endsWith('.css'))
const scripts = files.filter((f) => f.endsWith('.js') && !f.endsWith('.map'))

// --- 1. The production CSP must be present and must not have been loosened ---
const index = read(join(DIST, 'index.html'))
const csp = index.match(/content="([^"]*default-src[^"]*)"/)?.[1]
if (!csp) {
  failures.push('index.html has no Content-Security-Policy meta tag')
} else {
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    if (!csp.includes(directive)) failures.push(`CSP is missing: ${directive}`)
  }
  if (/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)) {
    failures.push("CSP allows 'unsafe-inline' or 'unsafe-eval' for scripts")
  }
  // connect-src must permit relay websockets and nothing else remote.
  if (/connect-src[^;]*https:/.test(csp)) {
    failures.push('CSP connect-src allows arbitrary https origins')
  }
}

// --- 2. No inline <script> blocks (they would require loosening script-src) ---
for (const file of html) {
  for (const tag of read(file).match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
    if (tag.replace(/<script\b[^>]*>|<\/script>/g, '').trim().length > 0) {
      failures.push(`${rel(file)} contains an inline script`)
    }
  }
}

// --- 3. No subresource loads from a remote origin ---
// These are the positions a browser actually fetches from.
const REMOTE = 'https?://(?!localhost|127\\.0\\.0\\.1)'
for (const file of html) {
  const source = read(file)
  for (const attr of source.match(new RegExp(`(src|href)\\s*=\\s*"${REMOTE}[^"]*"`, 'gi')) ?? []) {
    // Documentation links the user clicks are fine; they are not loads.
    if (/rel\s*=\s*"(noreferrer|noopener)/.test(attr)) continue
    failures.push(`${rel(file)} loads a remote subresource: ${attr}`)
  }
}
for (const file of css) {
  const source = read(file)
  for (const url of source.match(new RegExp(`url\\(\\s*['"]?${REMOTE}[^)]*\\)`, 'gi')) ?? []) {
    failures.push(`${rel(file)} loads a remote asset: ${url}`)
  }
  for (const imported of source.match(new RegExp(`@import[^;]*${REMOTE}`, 'gi')) ?? []) {
    failures.push(`${rel(file)} imports remote CSS: ${imported}`)
  }
}

// --- 4. No literal remote endpoints in fetch/XHR/WebSocket positions ---
// Relay URLs are user data entered at runtime, so nothing should match.
for (const file of scripts) {
  const source = read(file)
  const calls = [
    [/fetch\(\s*["'`]https?:\/\//g, 'fetch() to a hard-coded remote URL'],
    [/\.open\(\s*["'][A-Z]+["']\s*,\s*["'`]https?:\/\//g, 'XMLHttpRequest to a hard-coded remote URL'],
    [/new\s+WebSocket\(\s*["'`]wss?:\/\/(?!localhost)/g, 'WebSocket to a hard-coded remote URL'],
    [/importScripts\(\s*["'`]https?:\/\//g, 'importScripts() from a remote origin'],
    [/\beval\s*\(/g, 'eval()'],
    [/new\s+Function\s*\(/g, 'new Function()'],
  ]
  for (const [pattern, label] of calls) {
    if (pattern.test(source)) failures.push(`${rel(file)} uses ${label}`)
  }
}

// --- 5. The PWA manifest must agree with the deployed base path ---
// A project page serves from /<repo>/. If `scope`, `start_url`, `id`, or the
// asset URLs in index.html disagree, the app either fails to install, installs
// as a *second* app identity, or 404s its own assets — all of which only show
// up after deployment.
const manifestFile = files.find((f) => f.endsWith('.webmanifest'))
if (!manifestFile) {
  failures.push('no web app manifest was emitted')
} else {
  const manifest = JSON.parse(read(manifestFile))
  // Whatever base the assets were built with is the base the manifest must use.
  const assetBase = index.match(/(?:src|href)="((?:\/[^"]*?)?\/)assets\//)?.[1] ?? '/'
  for (const field of ['scope', 'start_url', 'id']) {
    const value = manifest[field]
    if (value !== assetBase) {
      failures.push(`manifest ${field} is "${value}" but assets are served from "${assetBase}"`)
    }
  }
  for (const icon of manifest.icons ?? []) {
    if (icon.src.startsWith('/') || /^https?:/.test(icon.src)) {
      failures.push(`manifest icon "${icon.src}" is not relative, so it breaks under a base path`)
    }
  }
}

// --- 6. Nothing accidental may ship ---
// `public/` is copied wholesale into the deployed site, so anything that lands
// there gets published. macOS drops .DS_Store into directories constantly.
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|\.env(\..*)?|.*\.pem|.*\.key)$/i
for (const file of files) {
  if (JUNK.test(rel(file))) failures.push(`unexpected file would be published: ${rel(file)}`)
}

// --- 7. The frame guard must survive minification ---
// `frame-ancestors` is inert in a meta tag, so this is the only clickjacking
// defence a static host has. Losing it to a refactor would be silent.
if (
  !scripts.some((file) => /window\.top\s*!==\s*window\.self|top!==self|top!==window\.self/.test(read(file)))
) {
  failures.push('the frame guard from src/main.tsx is missing from the bundle')
}

// --- 8. The service worker must precache only local assets ---
const serviceWorker = files.find((f) => f.endsWith('sw.js'))
if (serviceWorker) {
  const source = read(serviceWorker)
  for (const entry of source.match(new RegExp(`["']url["']\\s*:\\s*["']${REMOTE}[^"']*`, 'g')) ?? []) {
    failures.push(`service worker precaches a remote URL: ${entry}`)
  }
}

if (failures.length > 0) {
  console.error('Bundle check failed:\n')
  for (const failure of [...new Set(failures)]) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log(
  `Bundle check passed: ${files.length} files (${scripts.length} scripts, ${css.length} stylesheets).\n` +
    '  - CSP present and strict\n' +
    '  - no inline scripts\n' +
    '  - no remote subresources\n' +
    '  - no hard-coded remote endpoints, no eval\n' +
    '  - manifest scope/start_url/id match the asset base path\n' +
    '  - no unexpected files (.DS_Store, keys, env) would be published\n' +
    '  - service worker precaches local assets only',
)
