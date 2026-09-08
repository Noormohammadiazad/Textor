import { b64urlToBytes, bytesToB64url, randomBytes } from '../util/bytes'

/**
 * The device's own biometrics — Touch ID, Face ID, Windows Hello, an Android or
 * ChromeOS fingerprint or screen lock — or a FIDO2 security key, as a gate in
 * front of a key kept on this device (ADR-058, ADR-059).
 *
 * WebAuthn is used for one thing: user verification. A credential is made on
 * the authenticator, and each time Textor opens it must answer a fresh
 * challenge with the person verified. No key comes out of it — no PRF, nothing
 * that depends on which authenticator answers or where it keeps its passkeys —
 * so wherever the platform keeps the credential, syncing it included, nothing
 * of Textor's goes with it. The vault key is sealed under a non-extractable
 * WebCrypto key kept beside the vault (`keyslots.ts`), and the vault opens that
 * slot only with a `Presence` made here.
 *
 * Verification is whatever the platform does for `userVerification:
 * "required"`: a fingerprint or a face where one is enrolled, and otherwise the
 * device's own PIN, password or pattern. No WebAuthn option asks for a
 * biometric alone, on any system.
 *
 * This module is what unlocking needs, so it is in the shell. Setting a
 * credential up is in `biometricEnrol.ts`, which only the access chunk loads.
 *
 * That makes it a gate, not a lock. It stops someone who picks up this device.
 * It does not stop someone who copies the browser's data or runs code in this
 * page: they can use the local key without asking anyone. The signature is not
 * checked for the same reason — the only thing that could forge an answer is
 * code already in the page, which could skip the check.
 */

/** What stands at the gate: this device's own authenticator, or a FIDO2 security key. */
export type GateAuthenticator = 'platform' | 'security-key'

/** A gate credential, and how to reach it again. */
export interface GateCredential {
  readonly credentialId: string
  /** Absent on a slot from before security keys could guard one: this device's own. */
  readonly authenticator?: GateAuthenticator
  /** How the authenticator said it is reached (`internal`, `usb`, `nfc`, …). */
  readonly transports?: readonly string[]
}

/** The prompt was dismissed, timed out, or refused for want of a tap. */
export class GateCancelledError extends Error {
  constructor(
    /** Made, but not yet confirmed: trying again asks this one rather than making another. */
    readonly made?: GateCredential,
  ) {
    super('the biometric prompt was cancelled')
    this.name = 'GateCancelledError'
  }
}

/**
 * The authenticator did not answer as it must:
 *
 *   unavailable   nothing to ask, or the browser refused the request
 *   unverified    it answered without verifying the person
 *   other         a different credential answered
 */
export class GateRefusedError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'unverified' | 'other',
    options?: ErrorOptions,
  ) {
    super(`the authenticator did not confirm the person (${reason})`, options)
    this.name = 'GateRefusedError'
  }
}

/**
 * Proof that the authenticator holding this credential verified the person
 * just now. It carries how to reach the credential, so a slot made from it asks
 * the same way.
 */
export type Presence = GateCredential & { readonly authenticator: GateAuthenticator }

/** How long a proof stays good: it is meant to be spent at once. */
export const PRESENCE_TTL_MS = 60_000
export const TIMEOUT_MS = 60_000

/** Every proof this module made, and when. Nothing else can add one. */
const issued = new WeakMap<Presence, number>()

function issue(credential: GateCredential): Presence {
  const presence: Presence = Object.freeze({
    credentialId: credential.credentialId,
    authenticator: credential.authenticator ?? 'platform',
    ...(credential.transports?.length ? { transports: Object.freeze([...credential.transports]) } : {}),
  })
  issued.set(presence, Date.now())
  return presence
}

/**
 * Use a proof up: true once, for a proof made here, for this credential, while
 * it is fresh. The vault calls this before it opens a biometric slot.
 */
export function spendPresence(presence: Presence, credentialId: string, now = Date.now()): boolean {
  const at = issued.get(presence)
  issued.delete(presence)
  return at !== undefined && presence.credentialId === credentialId && now - at < PRESENCE_TTL_MS
}

/** `hints` (WebAuthn Level 3) is newer than this TypeScript's DOM types. */
export type WithHints<T> = T & { hints?: ('client-device' | 'security-key')[] }

/** Which prompt the browser should open first, for the authenticator the gate uses. */
export const hintsFor = (authenticator: GateAuthenticator | undefined): WithHints<object>['hints'] =>
  authenticator === 'security-key' ? ['security-key'] : ['client-device']

/**
 * Ask the authenticator holding a credential to verify the person — by the
 * prompt and the transports it was made with, so the browser goes straight to
 * it rather than offering a phone or a key it does not need.
 */
export async function confirmBiometric(credential: GateCredential): Promise<Presence> {
  const credentials = webauthn()
  const { credentialId, authenticator, transports } = credential
  const allowed: PublicKeyCredentialDescriptor = {
    type: 'public-key',
    id: b64urlToBytes(credentialId) as Uint8Array<ArrayBuffer>,
    ...(transports?.length ? { transports: [...transports] as AuthenticatorTransport[] } : {}),
  }
  const publicKey: WithHints<PublicKeyCredentialRequestOptions> = {
    challenge: randomBytes(32) as Uint8Array<ArrayBuffer>,
    allowCredentials: [allowed],
    userVerification: 'required',
    hints: hintsFor(authenticator),
    timeout: TIMEOUT_MS,
  }
  const answer = await ceremony(() => credentials.get({ publicKey }))
  if (bytesToB64url(new Uint8Array(answer.rawId)) !== credentialId) throw new GateRefusedError('other')
  const data = (answer.response as Partial<AuthenticatorAssertionResponse>).authenticatorData
  if (!verified(data)) throw new GateRefusedError('unverified')
  return issue(credential)
}

/**
 * Whether authenticator data carries the UV flag: rpIdHash (32) ‖ flags (1),
 * UV being 0x04. Asking for verification is not enough on its own: an
 * extension answering in the browser's place, or an authenticator with a
 * fault, can answer without it, and say so here.
 */
export function verified(data: ArrayBuffer | undefined): boolean {
  const flags = data ? (new Uint8Array(data)[32] ?? 0) : 0
  return (flags & 0x04) !== 0
}

export function webauthn(): CredentialsContainer {
  const credentials = globalThis.navigator?.credentials
  if (!credentials) throw new GateRefusedError('unavailable')
  return credentials
}

export async function ceremony(run: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  let result: Credential | null
  try {
    result = await run()
  } catch (err) {
    // Dismissed, timed out, or refused for want of a tap: all worth offering
    // again, none worth an error message about hardware.
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      throw new GateCancelledError()
    }
    throw new GateRefusedError('unavailable', { cause: err })
  }
  if (!result) throw new GateCancelledError()
  return result as PublicKeyCredential
}
