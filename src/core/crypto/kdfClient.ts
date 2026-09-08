import { deriveKek, type KdfParams } from './kdf'
import type { KdfRequest, KdfResponse } from './kdf.worker'

/**
 * Runs the passphrase KDF off the main thread. Falls back to inline derivation
 * where workers are unavailable (some embedded webviews, and Node under test),
 * which is slower to paint but never wrong.
 */
let worker: Worker | null = null
let nextId = 1
let workerBroken = false

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('error', () => {
      workerBroken = true
      worker?.terminate()
      worker = null
    })
    return worker
  } catch {
    workerBroken = true
    return null
  }
}

export function deriveKekOffThread(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const w = getWorker()
  if (!w) return deriveKek(passphrase, salt, params, onProgress ? { onProgress } : {})

  const id = nextId++
  return new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<KdfResponse>) => {
      const msg = ev.data
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction)
        return
      }
      cleanup()
      if (msg.type === 'done') resolve(new Uint8Array(msg.key))
      else reject(new Error(msg.message))
    }
    const onError = () => {
      cleanup()
      // The worker died; retry inline rather than leaving the user stuck.
      deriveKek(passphrase, salt, params, onProgress ? { onProgress } : {}).then(resolve, reject)
    }
    const cleanup = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    const req: KdfRequest = { id, passphrase, salt, params }
    w.postMessage(req)
  })
}

/** Release the worker (called on lock, so a paused tab holds nothing). */
export function disposeKdfWorker(): void {
  worker?.terminate()
  worker = null
}
