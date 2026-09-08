/**
 * Types for the precache policy, so the test suite can typecheck against it.
 * The implementation is plain ESM because it runs from the build, not the app.
 */

export declare const PRECACHE_BUDGET_BYTES: number
export declare const LAZY_PREFIX: string
export declare const LAZY_CACHE_NAME: string

export declare function normalizeUrl(url: string, base?: string): string
export declare function isLazyUrl(url: string): boolean
export declare function parsePrecacheManifest(serviceWorkerSource: string, base?: string): string[]

export interface BundleChunk {
  url: string
  source: string
}

export declare function findStaticLazyImports(chunks: readonly BundleChunk[]): { from: string; to: string }[]

export interface LazyOnlyMarker {
  feature: string
  marker: string
}

export declare const LAZY_ONLY_MARKERS: readonly LazyOnlyMarker[]

export declare function findShellLeaks(
  chunks: readonly BundleChunk[],
  markers?: readonly LazyOnlyMarker[],
): { url: string; feature: string; marker: string }[]

export interface PrecacheCheckInput {
  manifest: readonly string[]
  assetSizes: ReadonlyMap<string, number>
  indexHtml?: string
  chunks?: readonly BundleChunk[]
  serviceWorkerSource?: string
  budgetBytes?: number
}

export interface PrecacheCheckResult {
  failures: string[]
  totalBytes: number
  precachedCount: number
  lazyCount: number
}

export declare function checkPrecache(input: PrecacheCheckInput): PrecacheCheckResult
