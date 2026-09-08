/**
 * Fetch the lazy chunks in the background once the app is idle.
 *
 * Lazy chunks are kept out of the service worker's precache so they cost
 * nothing at install (ADR-040). On its own that would trade offline resilience
 * for it: a screen never opened while online — Settings, safety-number
 * verification, restoring a backup — would simply be missing the first time it
 * was needed offline, which for "restore a backup" or "export before wiping"
 * is exactly when it matters.
 *
 * So they are fetched after start-up, when nothing is waiting on the network,
 * and the runtime cache keeps them from then on. Install cost stays small,
 * first paint does not compete with them, and after one online session the app
 * is as complete offline as if everything had been precached. Every chunk is
 * content-hashed, so a warmed entry can never be stale.
 *
 * Skipped when the browser reports Save-Data: someone who has asked for less
 * traffic gets the chunks they actually open and nothing else.
 */

export type ChunkLoader = () => Promise<unknown>

export interface WarmupEnvironment {
  /** Runs `task` when the page is idle. */
  schedule: (task: () => void) => void
  /** Whether the user has asked the browser to save data. */
  saveData: boolean
  /**
   * Resolves once fetches from this page go through the service worker.
   *
   * A chunk fetched before then goes around the worker's runtime cache and is
   * not there offline — which on a first visit was every chunk, because the
   * worker is still installing when the page goes idle.
   */
  whenControlled: () => Promise<void>
}

/** How long to wait for a worker to take control before warming anyway. */
const CONTROL_TIMEOUT_MS = 20_000

export function browserWarmupEnvironment(opts: { serviceWorker?: boolean } = {}): WarmupEnvironment {
  const nav = globalThis.navigator as
    { connection?: { saveData?: boolean }; serviceWorker?: ServiceWorkerContainer } | undefined
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback
  // Only where a worker is actually registered — the production build. The
  // dev server has none, and would otherwise wait out the timeout every time.
  const container = opts.serviceWorker ? nav?.serviceWorker : undefined
  return {
    saveData: nav?.connection?.saveData === true,
    // A generous timeout: the point is to stay out of start-up's way, not to
    // wait indefinitely on a page that is never idle.
    schedule: idle ? (task) => idle(task, { timeout: 10_000 }) : (task) => setTimeout(task, 3000),
    whenControlled: () =>
      !container || container.controller
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            container.addEventListener('controllerchange', () => resolve(), { once: true })
            // A worker that never takes control — registration failed, or
            // storage is blocked — must not hold the chunks back for ever.
            setTimeout(resolve, CONTROL_TIMEOUT_MS)
          }),
  }
}

/**
 * Returns how many chunks it set off, which is what the tests observe. Loads
 * run one after another rather than all at once: nothing is waiting for them,
 * and a burst of parallel fetches is what a slow link handles worst.
 */
export function warmLazyChunks(
  loaders: readonly ChunkLoader[],
  environment: WarmupEnvironment = browserWarmupEnvironment(),
): Promise<number> {
  if (environment.saveData || loaders.length === 0) return Promise.resolve(0)
  return environment.whenControlled().then(
    () =>
      new Promise<number>((resolve) => {
        environment.schedule(() => {
          void (async () => {
            let started = 0
            for (const load of loaders) {
              started += 1
              // A chunk that fails to load now — offline, say — is fetched on
              // first use instead, which is how it would have behaved anyway.
              await load().catch(() => undefined)
            }
            resolve(started)
          })()
        })
      }),
  )
}
