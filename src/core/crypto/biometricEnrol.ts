import { bytesToB64url, randomBytes } from '../util/bytes'
import {
  ceremony,
  confirmBiometric,
  GateCancelledError,
  GateRefusedError,
  hintsFor,
  TIMEOUT_MS,
  verified,
  webauthn,
  type GateAuthenticator,
  type GateCredential,
  type Presence,
  type WithHints,
} from './biometricGate'

/**
 * Setting a gate up as a way into the vault (ADR-058, ADR-059): whether it can
 * be done here, making the credential, and forgetting one no longer used.
 * Loaded only by the screens that set a device up; unlocking needs none of it.
 */

/** Which family of operating system, for what its own authenticator can do and what to say when it cannot. */
export type PlatformFamily = 'apple' | 'windows' | 'android' | 'chromeos' | 'linux' | 'other'

export function platformFamily(userAgent: string): PlatformFamily {
  // Android before Linux, ChromeOS before Linux, and iPadOS reports a Mac.
  if (/Android/.test(userAgent)) return 'android'
  if (/iPhone|iPad|Macintosh/.test(userAgent)) return 'apple'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/CrOS/.test(userAgent)) return 'chromeos'
  if (/Linux|X11/.test(userAgent)) return 'linux'
  return 'other'
}

/**
 * What can guard Textor here:
 *
 *   platform      this device's own authenticator:
 *                   yes           set up to verify the person
 *                   not-set-up    there, but nothing is enrolled to verify with
 *                   unsupported   none a browser can reach: Linux, or no WebAuthn
 *   securityKey   whether WebAuthn is here to ask a FIDO2 key; whether one is
 *                 plugged in, only trying can tell
 */
export interface BiometricSupport {
  platform: 'yes' | 'not-set-up' | 'unsupported'
  securityKey: boolean
  family: PlatformFamily
}

type CredentialStatics = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>
}

/**
 * What the platform says, asked the ways that have proved right:
 *
 * - `getClientCapabilities()` first. iOS 26.2 made
 *   `isUserVerifyingPlatformAuthenticatorAvailable()` answer false in every
 *   browser but Safari while passkeys worked there, and the capability stayed
 *   right. Either one saying yes is enough.
 * - Linux is never offered its own authenticator. Browsers there reach no
 *   fingerprint reader: Firefox has no platform authenticator, and Chrome's is
 *   Google Password Manager, a cloud account behind its own PIN. A security key
 *   is the way to hardware verification there.
 */
export async function biometricSupport(
  userAgent = globalThis.navigator?.userAgent ?? '',
): Promise<BiometricSupport> {
  const family = platformFamily(userAgent)
  const credential = (globalThis as { PublicKeyCredential?: CredentialStatics }).PublicKeyCredential
  // The key a gate guards is a WebCrypto key, so both are needed.
  if (
    !credential ||
    !globalThis.navigator?.credentials ||
    globalThis.isSecureContext === false ||
    typeof globalThis.crypto?.subtle?.generateKey !== 'function'
  ) {
    return { platform: 'unsupported', securityKey: false, family }
  }
  if (family === 'linux') return { platform: 'unsupported', securityKey: true, family }
  const capabilities =
    typeof credential.getClientCapabilities === 'function'
      ? await credential.getClientCapabilities().catch(() => undefined)
      : undefined
  const ready =
    capabilities?.userVerifyingPlatformAuthenticator === true ||
    (await credential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false))
  return { platform: ready ? 'yes' : 'not-set-up', securityKey: true, family }
}

/**
 * What each authenticator is asked for. Both are non-discoverable where the
 * authenticator lets them be — nothing needs to find the credential without
 * its id, and a security key has few slots for ones that do. Windows Hello and
 * Apple's passkeys make a discoverable one anyway, and list it as "Textor".
 */
const SELECTION: Record<GateAuthenticator, AuthenticatorSelectionCriteria> = {
  platform: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
  'security-key': {
    authenticatorAttachment: 'cross-platform',
    userVerification: 'required',
    residentKey: 'discouraged',
  },
}

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'])

/**
 * Make a credential on the chosen authenticator, then ask it once, exactly as
 * unlocking will.
 *
 * The second ask is what makes the gate dependable. It finds out now, while
 * every other way in still works, whether this authenticator answers a `get`
 * with the person verified: a synced Windows Hello passkey has been seen to
 * answer without the UV flag after a correct PIN, and such a credential would
 * refuse every unlock. Where a browser wants a tap for each WebAuthn call —
 * Safari before iOS 17.4 — this ask can be refused for want of one: that reads
 * as a dismissal, carrying the credential made, and the screen asks for one
 * more tap, which asks this credential rather than making another.
 *
 * The proof it returns is what seals the slot.
 */
export async function enrolBiometric(authenticator: GateAuthenticator = 'platform'): Promise<Presence> {
  const credentials = webauthn()
  const publicKey: WithHints<PublicKeyCredentialCreationOptions> = {
    rp: { name: 'Textor' },
    // A fixed, neutral name: some platforms list it with the person's passkeys.
    user: { id: randomBytes(16) as Uint8Array<ArrayBuffer>, name: 'Textor', displayName: 'Textor' },
    challenge: randomBytes(32) as Uint8Array<ArrayBuffer>,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: SELECTION[authenticator],
    hints: hintsFor(authenticator),
    timeout: TIMEOUT_MS,
    attestation: 'none',
  }
  const created = await ceremony(() => credentials.create({ publicKey }))
  const response = created.response as AuthenticatorAttestationResponse
  const said = typeof response.getTransports === 'function' ? response.getTransports() : []
  const transports = said.filter((transport) => TRANSPORTS.has(transport))
  const made: GateCredential = {
    credentialId: bytesToB64url(new Uint8Array(created.rawId)),
    authenticator,
    ...(transports.length ? { transports } : {}),
  }
  try {
    // Where the browser shows it, the new credential's own flags are checked
    // too; the ask below checks them everywhere.
    if (typeof response.getAuthenticatorData === 'function' && !verified(response.getAuthenticatorData())) {
      throw new GateRefusedError('unverified')
    }
    return await confirmBiometric(made)
  } catch (err) {
    if (err instanceof GateCancelledError) throw new GateCancelledError(made)
    forgetBiometric(made.credentialId)
    throw err
  }
}

/**
 * Tell the authenticator a credential is no longer used, so it can drop it from
 * the person's list. Only some browsers can; elsewhere it stays, harmless: it
 * guards nothing any more.
 */
export function forgetBiometric(credentialId: string): void {
  const statics = (globalThis as unknown as { PublicKeyCredential?: Record<string, unknown> })
    .PublicKeyCredential
  const signal = statics?.signalUnknownCredential
  if (typeof signal !== 'function') return
  ;(signal as (options: { rpId: string; credentialId: string }) => Promise<void>)
    .call(statics, { rpId: globalThis.location.hostname, credentialId })
    .catch(() => undefined)
}
