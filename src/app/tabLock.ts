/**
 * One engine per browser (ADR-073).
 *
 * Two tabs share one database and, without this, each runs an engine over it:
 * both take the same outbox rows, both publish them, and both keep sockets open
 * to the same relays. Whoever holds the lock runs the engine. A tab that asks
 * while another holds it waits its turn, and gets it when that tab closes or
 * locks — or takes it, if the person says to use this one.
 *
 * A browser without Web Locks goes on as it always did, unguarded.
 */
const ENGINE_LOCK = 'textor-engine'

export interface EngineClaim {
  /** True once this tab holds the lock; false if the claim was given up first. */
  held: Promise<boolean>
  /** Let the lock go, or stop waiting for it. */
  release: () => void
}

export interface ClaimOptions {
  /** Take it from the tab holding it, rather than waiting. */
  steal?: boolean
  /** Another tab holds it, and this one is now waiting. */
  onWaiting: () => void
  /** Another tab has taken it from this one. */
  onTaken: () => void
  locks?: Pick<LockManager, 'request'> | undefined
}

export function claimEngine(opts: ClaimOptions): EngineClaim {
  const locks = 'locks' in opts ? opts.locks : (globalThis.navigator as Navigator | undefined)?.locks
  if (!locks?.request) return { held: Promise.resolve(true), release: () => undefined }

  const abort = new AbortController()
  let letGo: (() => void) | null = null
  let settle!: (held: boolean) => void
  const held = new Promise<boolean>((resolve) => (settle = resolve))

  const hold = (): Promise<void> =>
    new Promise<void>((done) => {
      letGo = done
      settle(true)
    })
  // Rejected in two cases: this tab stopped waiting, and nothing more is to be
  // done; or it held the lock and another tab took it.
  const onLost = (): void => {
    if (letGo) opts.onTaken()
    settle(false)
  }

  if (opts.steal) {
    locks.request(ENGINE_LOCK, { steal: true }, hold).catch(onLost)
  } else {
    locks
      .request(ENGINE_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock) return hold()
        opts.onWaiting()
        // Queued outside this callback, which holds nothing and returns at once.
        locks.request(ENGINE_LOCK, { signal: abort.signal }, hold).catch(onLost)
        return undefined
      })
      .catch(onLost)
  }

  return {
    held,
    release: () => {
      if (letGo) letGo()
      else abort.abort()
    },
  }
}
