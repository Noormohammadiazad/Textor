import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages: a project page is served from /<repo>/, a user/custom-domain
// page from /. BASE_PATH lets CI pick without editing source.
const base = process.env.BASE_PATH ?? '/'

/**
 * GitHub Pages cannot set response headers, so the Content-Security-Policy has
 * to ship as a meta tag. It is injected at build time rather than written into
 * index.html directly because the dev server needs a looser policy (HMR uses an
 * inline script and a websocket to localhost) and shipping the dev policy would
 * silently weaken production.
 *
 *   script-src 'self'   - no CDN, no eval; every byte is served from our origin
 *   connect-src wss:    - relay websockets, which the user chooses
 *   img-src data: blob: - avatars are inline data URIs; no remote image can be
 *                         used as a tracking pixel
 *   object/frame/base   - nothing to allow, so deny outright
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
  // `frame-ancestors` is deliberately absent: browsers ignore it in a <meta>
  // element, and including it only emits a console error on every page load.
  // Clickjacking is instead prevented by the frame guard in src/main.tsx, and
  // self-hosters serving behind a real web server should add the header
  // (see docs/THREAT-MODEL.md).
].join('; ')

/**
 * GitHub Pages serves `404.html` for any path it cannot find.
 *
 * Textor routes entirely in the URL fragment, so its own links never produce a
 * 404 — but a mistyped or truncated address otherwise lands on GitHub's generic
 * error page, which tells a user nothing about the app they were trying to
 * reach. A meta refresh (not a script, so it works under the strict CSP)
 * bounces them to the app root.
 */
const notFoundPlugin = {
  name: 'textor-404',
  generateBundle() {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta http-equiv="refresh" content="0; url=${base}" />
    <title>Textor</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem">
    <p>That page does not exist. <a href="${base}">Open Textor</a>.</p>
  </body>
</html>
`
    // `this` is the Rollup plugin context at generateBundle time.
    ;(this as unknown as { emitFile: (f: Record<string, string>) => void }).emitFile({
      type: 'asset',
      fileName: '404.html',
      source: html,
    })
  },
}

const cspPlugin = {
  name: 'textor-csp',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html.replace('<!--CSP-->', '')
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
      )
    },
  },
}

/** Cryptography the shell itself uses: grouped into one long-lived vendor chunk. */
const SHELL_CRYPTO = /node_modules[\\/](@noble|@scure)[\\/]/
/** …except the curves and cipher only MLS's ciphersuite needs (src/core/mls/suite.ts). */
const MLS_ONLY_CRYPTO =
  /[\\/]@noble[\\/](?:curves[\\/](?:ed25519|ed448|abstract[\\/](?:edwards|montgomery))|ciphers[\\/](?:aes|_polyval))\.js$/

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/**
 * Build timestamp, pinned to the commit in CI so the bundle is reproducible
 * from a given tag.
 *
 * `SOURCE_DATE_EPOCH` is conventionally Unix seconds, but the CI expression
 * feeding it can just as easily yield an ISO 8601 string — and
 * `new Date(NaN).toISOString()` throws a RangeError, which failed the whole
 * build rather than degrading. Accept either form, and fall back to now.
 */
function buildTimestamp(): string {
  const raw = process.env.SOURCE_DATE_EPOCH?.trim()
  if (raw) {
    const seconds = Number(raw)
    const parsed = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(raw)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTimestamp()),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Every byte is served from our own origin: no CDN, no dynamic imports of
    // remote code. Keep the graph simple so the CSP can stay strict.
    rollupOptions: {
      output: {
        // Split the rarely-changing vendor layers so a UI-only release does not
        // invalidate the crypto bundle in every user's service-worker cache.
        /*
         * Anything reached only through `import()` is named `lazy-*`.
         *
         * The prefix is load-bearing, not cosmetic: the service worker
         * excludes `lazy-*` from its precache manifest and serves those chunks
         * from a runtime cache instead, and `scripts/check-bundle.mjs` fails
         * the build if one is precached or pulled in by a static import.
         *
         * Naming rather than grouping, deliberately. An `advancedChunks` group
         * claims a module *and its dependency subtree*, so pointing one at the
         * picker dragged the store and half the engine into the lazy chunk and
         * left the shell statically importing it — which the bundle check
         * caught. Letting the bundler split on the dynamic import boundary
         * puts exactly the picker-only modules in the chunk.
         */
        chunkFileNames: (chunk) =>
          chunk.isDynamicEntry ? 'assets/lazy-[name]-[hash].js' : 'assets/[name]-[hash].js',
        /*
         * A stylesheet a lazy chunk imports is split out beside it, named
         * after the chunk — and without this it would be named like a shell
         * asset and precached, which is how the call screen's styles first
         * shipped. The shell's own styles are all imported by the entry, so
         * they are the only stylesheet named `index`; every other one belongs
         * to a lazy chunk. Should a statically imported module ever pull in a
         * stylesheet of its own, `index.html` would link it and
         * `scripts/check-bundle.mjs` fails the build.
         */
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? ''
          return name.endsWith('.css') && name !== 'index.css'
            ? 'assets/lazy-[name]-[hash][extname]'
            : 'assets/[name]-[hash][extname]'
        },
        advancedChunks: {
          groups: [
            /*
             * The shell's primitives, minus what only forward-secret groups
             * use. A group claims every module its test matches, wherever it
             * is imported from, so Ed25519, X25519 and AES-GCM — MLS's
             * ciphersuite, reached only through the lazy runtime — landed in
             * this precached chunk and pushed the install past its budget.
             * Left out of the group, they are bundled with the one chunk that
             * imports them. `scripts/check-bundle.mjs` looks for them in the
             * shell (LAZY_ONLY_MARKERS).
             */
            { name: 'crypto', test: (id: string) => SHELL_CRYPTO.test(id) && !MLS_ONLY_CRYPTO.test(id) },
            { name: 'nostr', test: /node_modules[\\/]nostr-tools[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  worker: { format: 'es' },
  plugins: [
    react(),
    cspPlugin,
    notFoundPlugin,
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // we register manually from src/app/pwa.ts
      /*
       * The plugin adds every icon named in the manifest to the precache,
       * *after* `globIgnores` has been applied — so excluding them there did
       * nothing and three PNGs plus a second copy of the favicon were being
       * downloaded before the app could start. They are install-time assets:
       * the operating system fetches them when the app is added to a home
       * screen, which by definition happens online, and the running app never
       * requests them. The manifest itself stays precached.
       */
      includeManifestIcons: false,
      manifest: {
        // `id` must match the deployed scope. Leaving it at '/' made a project
        // page at /<repo>/ advertise a different app identity than its own
        // start_url, which browsers treat as a separate installable app.
        id: base,
        name: 'Textor',
        short_name: 'Textor',
        description: 'Private, end-to-end-encrypted messaging that runs entirely in your browser.',
        lang: 'en',
        // The brand blue, not a surface colour: this paints the task-switcher
        // and title bar, where the app should read as itself rather than as a
        // sheet of background. The splash keeps the light canvas.
        theme_color: '#1a56b8',
        background_color: '#f4f6f8',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: base,
        scope: base,
        categories: ['social', 'communication', 'productivity'],
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Fonts ship as unicode-range subsets, so a browser downloads only the
        // script it actually renders. Precaching all of them would defeat that
        // and push 314 KB onto every first load. Precache just the two subsets
        // the interface itself needs (Latin for English, Arabic for Persian);
        // everything else — a Cyrillic or Greek contact name — is fetched on
        // demand and cached by the runtime rule below.
        globPatterns: [
          '**/*.{js,css,html,svg,png,ico}',
          '**/inter-latin-wght-*.woff2',
          '**/vazirmatn-arabic-wght-*.woff2',
        ],
        // Install-time assets: the operating system fetches these when the app
        // is added to a home screen, which by definition happens online. The
        // running app never requests them, so precaching them spends the
        // offline budget on files no offline session can use. What stays is
        // what index.html actually references — favicon.svg, icon-32 and
        // mask-icon.
        globIgnores: [
          '**/icon-192.png',
          '**/icon-512.png',
          '**/icon-maskable-512.png',
          '**/apple-touch-icon.png',
          // Lazy subsystems: downloaded the first time they are opened, then
          // served from the runtime cache below. Precaching them would spend
          // the install budget on features most sessions never touch — and
          // the budget is what keeps a cold start on a slow link usable.
          '**/lazy-*.js',
          '**/lazy-*.css',
        ],
        runtimeCaching: [
          {
            // Content-hashed, so a cached entry can never be stale: a rebuilt
            // chunk arrives under a new name. CacheFirst therefore costs one
            // download per version and works offline ever after.
            urlPattern: /\/lazy-[^/]+\.(?:js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'textor-lazy',
              expiration: { maxEntries: 32, maxAgeSeconds: 90 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\.woff2$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'textor-fonts',
              // Content-hashed filenames, so a cached entry is never stale.
              expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        /*
         * Claim the page on first install, so the first visit is already
         * served through the worker. Without it the idle warm-up of lazy
         * chunks ran on an uncontrolled page, bypassed the runtime cache, and
         * the app was only complete offline from the second visit on
         * (ADR-043). It changes nothing about updates: a new worker still
         * waits for the user to accept the prompt, and a page already under
         * the old worker is only handed over when they do.
         */
        clientsClaim: true,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
})
