/** Serialises async sections. Used to keep vault writes and sync passes ordered. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn)
    // Swallow rejection on the chain so one failure does not poison the queue.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Collapses concurrent calls into one in-flight run, then re-runs if asked again. */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let queued = false
  const start = async (): Promise<void> => {
    do {
      queued = false
      await fn()
    } while (queued)
    running = null
  }
  return () => {
    if (running) {
      queued = true
      return running
    }
    running = start()
    return running
  }
}
