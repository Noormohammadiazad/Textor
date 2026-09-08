/**
 * The precache policy, as pure functions.
 *
 * Textor ships as an offline-first PWA, so everything the app needs to start
 * has to be in the service worker's precache manifest — and everything in that
 * manifest is downloaded before the app is usable at all. Those two facts pull
 * in opposite directions, and the budget is where they meet.
 *
 * The rule this enforces: the *shell* is precached, and a heavy subsystem that
 * only some sessions ever open is not. Such a subsystem is split into a chunk
 * named `lazy-*`, kept out of the manifest, and served by a runtime cache
 * instead — so it costs nothing at install and still works offline once used.
 *
 * Splitting alone does not achieve that. Workbox globs `**\/*.js`, so a
 * dynamically imported chunk lands in the manifest exactly like the shell
 * unless it is excluded by name. This module is what makes the convention
 * enforceable rather than aspirational.
 *
 * Kept separate from `check-bundle.mjs` so the decisions can be unit-tested
 * against synthetic bundles, including the failures — which are otherwise only
 * reachable by deliberately breaking a real build.
 */

/** Install-time budget. A cold start on a slow link downloads all of this. */
export const PRECACHE_BUDGET_BYTES = 800 * 1024

/** Chunks whose filename starts with this are excluded from the manifest. */
export const LAZY_PREFIX = 'lazy-'

/** The runtime cache that serves lazy chunks once they have been fetched once. */
export const LAZY_CACHE_NAME = 'textor-lazy'

/** Strip a deployment base path so manifest URLs compare against dist paths. */
export function normalizeUrl(url, base = '/') {
  let path = url
  if (base !== '/' && path.startsWith(base)) path = path.slice(base.length)
  return path.replace(/^\.?\//, '')
}

/** True for an asset that must stay out of the precache manifest. */
export function isLazyUrl(url) {
  const name = url.slice(url.lastIndexOf('/') + 1)
  return name.startsWith(LAZY_PREFIX)
}

/**
 * Pull the precached URLs out of a generated service worker.
 *
 * Workbox inlines the manifest as an array of `{revision, url}` objects, so
 * the URLs are read back from the artifact that will actually ship rather than
 * from the config that was meant to produce it.
 */
export function parsePrecacheManifest(serviceWorkerSource, base = '/') {
  const urls = []
  // The key is quoted in the unminified manifest and bare in the shipped one,
  // so both spellings are accepted. Matching only the quoted form silently
  // returns nothing, which reads as "nothing is precached" rather than as a
  // broken parser — the way the remote-URL guard beside this one used to fail.
  for (const match of serviceWorkerSource.matchAll(/(?:"url"|\burl)\s*:\s*"([^"]+)"/g)) {
    urls.push(normalizeUrl(match[1], base))
  }
  return urls
}

/**
 * Chunks that import a lazy chunk statically.
 *
 * A static import defeats the split entirely: the browser loads the chunk
 * during startup, but it was excluded from the manifest, so the app breaks
 * offline in exactly the case the precache exists to cover. Minifiers emit
 * static imports as `import"./x.js"` or `from"./x.js"`, and dynamic ones as
 * `import("./x.js")` — the parenthesis is the whole difference.
 */
export function findStaticLazyImports(chunks) {
  const violations = []
  for (const chunk of chunks) {
    if (isLazyUrl(chunk.url)) continue
    for (const match of chunk.source.matchAll(/(?:^|[^.\w])(?:import|from)\s*["']([^"']+)["']/g)) {
      const target = match[1]
      if (isLazyUrl(target)) violations.push({ from: chunk.url, to: target })
    }
  }
  return violations
}

/**
 * Subsystems that must never reach the shell, each named by a string only its
 * own code contains.
 *
 * Being split into a lazy chunk is a promise that the shell does not carry a
 * feature at all — calling, above all, which is defined as loading only when a
 * call is placed or rings (ADR-046). A careless static import can break that
 * promise while every other rule here still passes: the bundler simply hoists
 * the module into a shell chunk, precaches it, and nothing is "lazy" any more
 * to be checked. So the code itself is looked for.
 */
export const LAZY_ONLY_MARKERS = [
  // Screen sharing is the call screen's alone.
  { feature: 'calling', marker: 'getDisplayMedia' },
  // The label of the data channel every call opens beside its media.
  { feature: 'calling', marker: 'call-state' },
  // MLS's wire version, which only ts-mls spells out.
  { feature: 'forward-secret groups', marker: 'mls10' },
  // AES-GCM, the cipher of MLS's ciphersuite and nothing else in the app.
  { feature: 'forward-secret groups', marker: 'aes/gcm' },
  // Marmot's exporter context for group messages.
  { feature: 'forward-secret groups', marker: 'group-event' },
]

/** Shell chunks that contain code belonging to a lazy-only subsystem. */
export function findShellLeaks(chunks, markers = LAZY_ONLY_MARKERS) {
  const leaks = []
  for (const chunk of chunks) {
    if (isLazyUrl(chunk.url)) continue
    for (const { feature, marker } of markers) {
      if (chunk.source.includes(marker)) leaks.push({ url: chunk.url, feature, marker })
    }
  }
  return leaks
}

/**
 * Evaluate the whole policy against a built bundle.
 *
 * Returns failures rather than throwing, so the caller can report every
 * problem in one run instead of one per build.
 */
export function checkPrecache({
  manifest,
  assetSizes,
  indexHtml = '',
  chunks = [],
  serviceWorkerSource = '',
  budgetBytes = PRECACHE_BUDGET_BYTES,
}) {
  const failures = []
  const precached = new Set(manifest)

  // 1. Nothing lazy may be precached: that is the whole point of the split.
  for (const url of manifest) {
    if (isLazyUrl(url)) failures.push(`lazy chunk is precached: ${url}`)
  }

  // 2. Everything the shell needs must be precached, or the app breaks offline.
  for (const [url] of assetSizes) {
    if (!/^assets\/.+\.(js|css)$/.test(url) || isLazyUrl(url)) continue
    if (!precached.has(url)) failures.push(`shell asset is missing from the precache: ${url}`)
  }

  // 3. The install budget.
  let totalBytes = 0
  for (const url of manifest) {
    const size = assetSizes.get(url)
    if (size === undefined) {
      failures.push(`precached file does not exist in the build: ${url}`)
      continue
    }
    totalBytes += size
  }
  if (totalBytes > budgetBytes) {
    failures.push(
      `precache is ${(totalBytes / 1024).toFixed(1)} KiB, over the ${(budgetBytes / 1024).toFixed(0)} KiB budget`,
    )
  }

  // 4. A lazy chunk reached by a static import is loaded at startup anyway.
  for (const { from, to } of findStaticLazyImports(chunks)) {
    failures.push(`${from} statically imports ${to}, which is excluded from the precache`)
  }

  // 5. …and the same applies to one the entry document preloads or scripts.
  for (const match of indexHtml.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    if (isLazyUrl(match[1])) failures.push(`index.html references a lazy chunk: ${match[1]}`)
  }

  // 6. Code that belongs only in a lazy chunk has not leaked into the shell.
  for (const { url, feature, marker } of findShellLeaks(chunks)) {
    failures.push(`${url} carries ${feature} code (${marker}), which must load only on demand`)
  }

  // 7. Excluded from the precache but with no runtime rule, a lazy chunk is
  //    simply unavailable offline — worse than having been precached.
  if (serviceWorkerSource && !serviceWorkerSource.includes(LAZY_CACHE_NAME)) {
    failures.push(`the service worker has no "${LAZY_CACHE_NAME}" runtime cache for lazy chunks`)
  }

  return {
    failures,
    totalBytes,
    precachedCount: manifest.length,
    lazyCount: [...assetSizes.keys()].filter((url) => isLazyUrl(url) && url.endsWith('.js')).length,
  }
}
