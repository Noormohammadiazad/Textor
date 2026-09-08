import { createLogger } from '../core/util/log'

const log = createLogger('storage')

/**
 * Ask the browser to keep the vault.
 *
 * By default, IndexedDB is "best-effort" storage: browsers evict it under disk
 * pressure, and Safari's Intelligent Tracking Prevention deletes all script-
 * writable storage after seven days without user interaction with the site.
 *
 * For an ordinary web app that means a lost cache. For Textor it means the
 * user's identity, contacts, and entire message history are gone — with no
 * server-side copy to restore from, because there is no server. Requesting
 * persistence is therefore not an optimisation; it is the difference between
 * "your data is safe here" being true and being false.
 *
 * Granting is at the browser's discretion. Chromium grants it based on
 * engagement signals or an installed PWA; Firefox prompts; Safari grants it
 * once the site is added to the home screen. Where it is refused, the app still
 * works — the user just needs a backup, which the UI then tells them.
 */
export type PersistenceState = 'persisted' | 'not-persisted' | 'unsupported'

export async function ensurePersistentStorage(): Promise<PersistenceState> {
  const storage = navigator.storage
  if (!storage?.persist || !storage.persisted) return 'unsupported'
  try {
    if (await storage.persisted()) return 'persisted'
    const granted = await storage.persist()
    log.info(`persistent storage ${granted ? 'granted' : 'refused'}`)
    return granted ? 'persisted' : 'not-persisted'
  } catch (err) {
    log.warn('could not query storage persistence', err)
    return 'unsupported'
  }
}

export interface StorageEstimate {
  usageBytes: number
  quotaBytes: number
  /** Fraction of quota used, 0-1. `null` when the browser will not say. */
  ratio: number | null
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usageBytes: usage, quotaBytes: quota, ratio: quota > 0 ? usage / quota : null }
  } catch {
    return null
  }
}

/**
 * True when a write failed because the origin is out of room.
 *
 * Worth distinguishing from any other write failure: the user can act on it by
 * shortening their retention window or exporting and clearing history, and the
 * alternative is a silently dropped message.
 */
export function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota/i.test(error.message)
  )
}
