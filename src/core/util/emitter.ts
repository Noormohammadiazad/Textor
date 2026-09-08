/** Minimal typed event emitter — no dependency, no `any`, unsubscribes cleanly. */
export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(fn as (p: never) => void)
    return () => {
      set?.delete(fn as (p: never) => void)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as (p: Events[K]) => void)(payload)
      } catch (err) {
        console.error('[textor:emitter] listener threw', err)
      }
    }
  }

  clear(): void {
    this.#listeners.clear()
  }
}
