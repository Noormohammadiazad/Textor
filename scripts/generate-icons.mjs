#!/usr/bin/env node
/**
 * Write every brand file — the favicon, the pinned-tab glyph, the PWA icons,
 * the link preview and the README's logo — from the numbers in brand.mjs.
 *
 * Committed PNGs would be opaque binaries in a project whose whole pitch is
 * auditability, so they are produced here, with no image-processing
 * dependency, and `tests/brandAssets.test.ts` fails if any file in the
 * repository differs from what this would write.
 *
 * Run: npm run icons
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandFiles, encodePng, rasterize } from './brand.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const file of brandFiles()) {
  const target = `${root}${file.path}`
  mkdirSync(dirname(target), { recursive: true })
  const bytes = file.svg ?? encodePng(rasterize(file.art, file.width, file.height), file.width, file.height)
  writeFileSync(target, bytes)
  const size = file.svg ? '' : ` (${file.width}x${file.height})`
  console.log(`wrote ${file.path}${size}, ${bytes.length} bytes`)
}
