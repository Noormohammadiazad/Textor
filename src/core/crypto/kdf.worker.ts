/// <reference lib="webworker" />
import { deriveKek, type KdfParams } from './kdf'

export interface KdfRequest {
  id: number
  passphrase: string
  salt: Uint8Array
  params: KdfParams
}

export type KdfResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'done'; key: Uint8Array }
  | { id: number; type: 'error'; message: string }

const post = (msg: KdfResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)

self.onmessage = async (ev: MessageEvent<KdfRequest>) => {
  const { id, passphrase, salt, params } = ev.data
  let lastReported = 0
  try {
    const key = await deriveKek(passphrase, salt, params, {
      onProgress: (fraction) => {
        // Throttle: scrypt calls back thousands of times.
        if (fraction - lastReported < 0.02 && fraction < 1) return
        lastReported = fraction
        post({ id, type: 'progress', fraction })
      },
    })
    post({ id, type: 'done', key })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
