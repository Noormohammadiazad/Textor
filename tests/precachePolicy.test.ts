import { describe, expect, it } from 'vitest'
import {
  checkPrecache,
  findShellLeaks,
  findStaticLazyImports,
  LAZY_ONLY_MARKERS,
  isLazyUrl,
  normalizeUrl,
  parsePrecacheManifest,
  PRECACHE_BUDGET_BYTES,
} from '../scripts/precachePolicy.mjs'

/**
 * The precache policy decides what a cold start downloads before the app is
 * usable, and every failure it catches is one that would otherwise ship — a
 * blown install budget, or a feature that silently stops working offline.
 * Those are reachable here against synthetic bundles; in a real build they are
 * reachable only by breaking it on purpose.
 */

const KIB = 1024

/** A minimal bundle that satisfies the policy, for tests to bend one way at a time. */
function bundle(overrides: Partial<Parameters<typeof checkPrecache>[0]> = {}) {
  const assetSizes = new Map([
    ['index.html', 2 * KIB],
    ['assets/index-aaa.js', 300 * KIB],
    ['assets/index-aaa.css', 40 * KIB],
    ['assets/lazy-emoji-bbb.js', 120 * KIB],
  ])
  return checkPrecache({
    manifest: ['index.html', 'assets/index-aaa.js', 'assets/index-aaa.css'],
    assetSizes,
    indexHtml: '<script type="module" src="/assets/index-aaa.js"></script>',
    chunks: [
      { url: 'assets/index-aaa.js', source: 'const x=1;import("./lazy-emoji-bbb.js")' },
      { url: 'assets/lazy-emoji-bbb.js', source: 'export const picker=1' },
    ],
    serviceWorkerSource: 'precacheAndRoute([]);const c="textor-lazy"',
    ...overrides,
  })
}

describe('recognising a lazy chunk', () => {
  it('goes by the filename, not the path', () => {
    expect(isLazyUrl('assets/lazy-emoji-a1b2.js')).toBe(true)
    expect(isLazyUrl('./lazy-emoji-a1b2.js')).toBe(true)
    expect(isLazyUrl('assets/index-a1b2.js')).toBe(false)
    // A path that merely contains the word is not a lazy chunk.
    expect(isLazyUrl('assets/lazily-loaded-a1b2.js')).toBe(false)
    expect(isLazyUrl('lazy/index-a1b2.js')).toBe(false)
  })
})

describe('reading the manifest out of a built service worker', () => {
  it('takes the URLs workbox actually inlined', () => {
    const sw =
      'precacheAndRoute([{"revision":null,"url":"assets/index-a1.js"},{"revision":"x","url":"index.html"}],{})'
    expect(parsePrecacheManifest(sw)).toEqual(['assets/index-a1.js', 'index.html'])
  })

  it('strips a project-page base path so URLs match the build output', () => {
    const sw = 'precacheAndRoute([{"revision":null,"url":"/Textor/assets/index-a1.js"}])'
    expect(parsePrecacheManifest(sw, '/Textor/')).toEqual(['assets/index-a1.js'])
    expect(normalizeUrl('/assets/x.js')).toBe('assets/x.js')
  })
})

describe('static imports of lazy chunks', () => {
  it('accepts a dynamic import, which is the whole point of the split', () => {
    expect(
      findStaticLazyImports([{ url: 'assets/index-a.js', source: 'await import("./lazy-emoji-b.js")' }]),
    ).toEqual([])
  })

  it('catches a static import, which would load the chunk at startup', () => {
    // Minified output for `import './lazy-emoji-b.js'` and for a named import.
    expect(
      findStaticLazyImports([{ url: 'assets/index-a.js', source: 'import"./lazy-emoji-b.js";x()' }]),
    ).toEqual([{ from: 'assets/index-a.js', to: './lazy-emoji-b.js' }])
    expect(
      findStaticLazyImports([{ url: 'assets/index-a.js', source: 'import{p}from"./lazy-emoji-b.js"' }]),
    ).toEqual([{ from: 'assets/index-a.js', to: './lazy-emoji-b.js' }])
  })

  it('ignores imports between lazy chunks, which are loaded together anyway', () => {
    expect(
      findStaticLazyImports([{ url: 'assets/lazy-emoji-a.js', source: 'import"./lazy-shared-b.js"' }]),
    ).toEqual([])
  })
})

describe('subsystems that must never reach the shell', () => {
  it('finds call code hoisted into a shell chunk', () => {
    expect(
      findShellLeaks([
        { url: 'assets/store-a.js', source: 'navigator.mediaDevices.getDisplayMedia({video:!0})' },
        { url: 'assets/index-b.js', source: 'pc.createDataChannel("call-state",{negotiated:!0})' },
      ]),
    ).toEqual([
      { url: 'assets/store-a.js', feature: 'calling', marker: 'getDisplayMedia' },
      { url: 'assets/index-b.js', feature: 'calling', marker: 'call-state' },
    ])
  })

  it('leaves the same code alone where it belongs', () => {
    expect(
      findShellLeaks([{ url: 'assets/lazy-calls-c.js', source: 'getDisplayMedia();"call-state"' }]),
    ).toEqual([])
  })

  it('names calling among them', () => {
    expect(LAZY_ONLY_MARKERS.map(({ feature }) => feature)).toContain('calling')
  })

  it('fails the build over one', () => {
    const result = bundle({
      chunks: [{ url: 'assets/index-aaa.js', source: 'x.getDisplayMedia()' }],
    })
    expect(result.failures).toContain(
      'assets/index-aaa.js carries calling code (getDisplayMedia), which must load only on demand',
    )
  })
})

describe('the policy as a whole', () => {
  it('passes a bundle that splits correctly', () => {
    const result = bundle()
    expect(result.failures).toEqual([])
    expect(result.totalBytes).toBe(342 * KIB)
    expect(result.lazyCount).toBe(1)
  })

  it('fails when a lazy chunk is precached', () => {
    const result = bundle({
      manifest: ['index.html', 'assets/index-aaa.js', 'assets/index-aaa.css', 'assets/lazy-emoji-bbb.js'],
    })
    expect(result.failures).toContain('lazy chunk is precached: assets/lazy-emoji-bbb.js')
  })

  it('fails when a shell asset is left out, because the app would not start offline', () => {
    const result = bundle({ manifest: ['index.html', 'assets/index-aaa.js'] })
    expect(result.failures).toContain('shell asset is missing from the precache: assets/index-aaa.css')
  })

  it('fails when the install budget is exceeded', () => {
    const assetSizes = new Map([
      ['index.html', 2 * KIB],
      ['assets/index-aaa.js', 799 * KIB],
      ['assets/index-aaa.css', 40 * KIB],
    ])
    const result = bundle({
      assetSizes,
      manifest: ['index.html', 'assets/index-aaa.js', 'assets/index-aaa.css'],
      chunks: [],
    })
    expect(result.failures.some((f) => f.includes('over the 800 KiB budget'))).toBe(true)
  })

  it('fails when a lazy chunk is pulled in by a static import', () => {
    const result = bundle({
      chunks: [{ url: 'assets/index-aaa.js', source: 'import"./lazy-emoji-bbb.js"' }],
    })
    expect(result.failures).toContain(
      'assets/index-aaa.js statically imports ./lazy-emoji-bbb.js, which is excluded from the precache',
    )
  })

  it('fails when the entry document preloads a lazy chunk', () => {
    const result = bundle({
      indexHtml: '<link rel="modulepreload" href="/assets/lazy-emoji-bbb.js">',
    })
    expect(result.failures).toContain('index.html references a lazy chunk: /assets/lazy-emoji-bbb.js')
  })

  it('fails when nothing would serve a lazy chunk offline', () => {
    // Excluded from the precache and with no runtime rule, the feature simply
    // breaks offline — a worse outcome than having spent the budget on it.
    const result = bundle({ serviceWorkerSource: 'precacheAndRoute([])' })
    expect(result.failures).toContain('the service worker has no "textor-lazy" runtime cache for lazy chunks')
  })

  it('fails when the manifest names a file the build did not emit', () => {
    const result = bundle({
      manifest: ['index.html', 'assets/index-aaa.js', 'assets/index-aaa.css', 'assets/ghost-ccc.js'],
    })
    expect(result.failures).toContain('precached file does not exist in the build: assets/ghost-ccc.js')
  })

  it('keeps the budget where the project documents it', () => {
    expect(PRECACHE_BUDGET_BYTES).toBe(800 * 1024)
  })
})
