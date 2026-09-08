import { scryptAsync } from '@noble/hashes/scrypt.js'

/**
 * Passphrase stretching for the vault.
 *
 * scrypt is chosen over PBKDF2 (memory-hard, so GPU/ASIC cracking is far more
 * expensive) and over Argon2 (scrypt has a mature, audited pure-JS
 * implementation in @noble/hashes; no WASM, which keeps the CSP tight and the
 * static bundle self-contained).
 *
 * Parameters are stored per-vault so they can be raised later without breaking
 * existing vaults. Where more work is wanted, raising `p` costs no extra peak
 * memory (the passes run sequentially, so peak stays at N*r*128 bytes) whereas
 * raising `N` doubles it — and a 256 MB peak is a real out-of-memory risk on
 * mobile Safari.
 */
export interface KdfParams {
  readonly algo: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
}

/**
 * Measured, not guessed. Browser engines run this workload roughly 8x slower
 * than Node, so parameters were chosen against a real browser:
 *
 *   N=2^16 p=1  ~0.9 s   (desktop Chrome)   ~3-4 s on a mid-range phone
 *   N=2^17 p=1  ~1.8 s                      ~7-8 s
 *   N=2^16 p=4  ~3.5 s                      ~15 s
 *
 * Unlock happens on every auto-lock timeout, so anything past a couple of
 * seconds pushes people towards disabling auto-lock entirely - a net loss for
 * security. N=2^16, r=8, p=1 keeps peak memory at 64 MB (safe on mobile Safari)
 * and stays well inside the interactive budget.
 *
 * Parameters are stored per-vault, so this can be raised for new vaults without
 * breaking existing ones, and a passphrase change re-derives under the current
 * default.
 */
export const DEFAULT_KDF_PARAMS: KdfParams = { algo: 'scrypt', N: 2 ** 16, r: 8, p: 1 }

/** Refuse absurd parameters from a tampered or corrupted vault header. */
export function assertKdfParams(params: KdfParams): void {
  if (params.algo !== 'scrypt') throw new Error(`unsupported KDF: ${String(params.algo)}`)
  const { N, r, p } = params
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0
  if (!powerOfTwo || N < 2 ** 12 || N > 2 ** 20) throw new Error('KDF N out of range')
  if (!Number.isInteger(r) || r < 1 || r > 16) throw new Error('KDF r out of range')
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new Error('KDF p out of range')
}

export interface DeriveOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Derive the key-encryption key from a passphrase. Runs on whatever thread
 * calls it; the app calls this through `kdfClient` so it lands in a worker and
 * the UI keeps painting.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
  opts: DeriveOptions = {},
): Promise<Uint8Array> {
  assertKdfParams(params)
  if (salt.length < 16) throw new Error('KDF salt must be at least 16 bytes')
  // NFKC keeps a passphrase typed with a Persian keyboard (or any composed
  // script) hashing identically across platforms and input methods.
  const normalized = passphrase.normalize('NFKC')
  const key = await scryptAsync(normalized, salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: 32,
    // Guard rail matching scrypt's own accounting, so a tampered header
    // cannot make us try to allocate gigabytes.
    maxmem: 128 * params.r * (params.N + params.p) + 1024 * 1024,
    onProgress: opts.onProgress
      ? (n: number) => {
          opts.signal?.throwIfAborted()
          opts.onProgress?.(n)
        }
      : undefined,
  })
  return key
}
