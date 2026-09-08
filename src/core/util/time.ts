export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Unix seconds — the unit Nostr events use everywhere. */
export const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Timestamps are indexed at hour granularity so that a device attacker who can
 * read IndexedDB's index structures (but not the record ciphertexts) learns
 * only roughly when a conversation was active. Exact times live inside the
 * encrypted body.
 */
export const coarsenMs = (ms: number): number => Math.floor(ms / HOUR) * HOUR

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, base = 2 * SECOND, cap = 5 * MINUTE): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt))
  return Math.floor(Math.random() * exp)
}
