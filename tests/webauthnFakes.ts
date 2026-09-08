import { vi, type Mock } from 'vitest'
import { randomBytes } from '@/core/util/bytes'

/**
 * A browser's WebAuthn, as the page sees it, for the gate's tests (ADR-058,
 * ADR-059). `create` makes a credential with a random id, verified, reachable
 * `internal`ly; `get` answers for whatever credential it was asked about, with
 * the UV flag set — unless a test says otherwise.
 */

/** Authenticator data with this flags byte: rpIdHash (32) ‖ flags ‖ signCount (4). */
export function authData(flags: number): Uint8Array {
  const data = new Uint8Array(37)
  data[32] = flags
  return data
}

/** Verified (UV) and present (UP). */
export const VERIFIED = 0x05

/** What `get` resolves to: an assertion, with this flags byte or no authenticator data. */
export function credential(rawId: Uint8Array, flags?: number) {
  return {
    rawId: rawId.slice().buffer,
    response: flags === undefined ? {} : { authenticatorData: authData(flags).slice().buffer },
  }
}

/** What `create` resolves to: flags where the browser shows them, and the transports it says. */
export function created(rawId: Uint8Array, opts: { flags?: number; transports?: string[] } = {}) {
  const response: Record<string, unknown> = {}
  if (opts.flags !== undefined) {
    const data = authData(opts.flags)
    response.getAuthenticatorData = () => data.slice().buffer
  }
  if (opts.transports) {
    const transports = opts.transports
    response.getTransports = () => transports
  }
  return { rawId: rawId.slice().buffer, response }
}

export interface FakeWebAuthn {
  create: Mock
  get: Mock
  signal: Mock
  /** The id of the last credential `create` made. */
  lastId: () => Uint8Array | undefined
}

export function webauthn(
  opts: {
    platform?: boolean | 'throws'
    statics?: Record<string, unknown> | null
  } = {},
): FakeWebAuthn {
  let last: Uint8Array | undefined
  const fake: FakeWebAuthn = {
    create: vi.fn(async () => {
      last = randomBytes(16)
      return created(last, { flags: VERIFIED | 0x40, transports: ['internal'] })
    }),
    get: vi.fn(async (options: CredentialRequestOptions) => {
      const id = options.publicKey?.allowCredentials?.[0]?.id as Uint8Array
      return credential(new Uint8Array(id), VERIFIED)
    }),
    signal: vi.fn(async () => undefined),
    lastId: () => last,
  }
  vi.stubGlobal('navigator', { credentials: { create: fake.create, get: fake.get }, userAgent: 'Macintosh' })
  vi.stubGlobal(
    'PublicKeyCredential',
    opts.statics === null
      ? undefined
      : {
          isUserVerifyingPlatformAuthenticatorAvailable: async () => {
            if (opts.platform === 'throws') throw new Error('no answer')
            return opts.platform ?? true
          },
          signalUnknownCredential: fake.signal,
          ...opts.statics,
        },
  )
  vi.stubGlobal('location', { hostname: 'textor.test' })
  return fake
}
