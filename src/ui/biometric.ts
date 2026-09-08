import type { TranslateFn, TranslationKey } from '../i18n'
import { WrongPassphraseError, WrongPinError, WrongSecretError, type PinStyle } from '../core/vault/vault'
import { GateCancelledError, GateRefusedError, type GateAuthenticator } from '../core/crypto/biometricGate'

/**
 * What the platform authenticator is called here, for "Unlock with …".
 *
 * A guess from the user agent, and only ever used as a label: the prompt that
 * appears is the operating system's own, and names itself. iPadOS reports a
 * Mac, which is still the right family.
 */
export function biometricName(userAgent = globalThis.navigator?.userAgent ?? ''): TranslationKey {
  if (/iPhone|iPad|Macintosh/.test(userAgent)) return 'lock.bioApple'
  if (/Windows/.test(userAgent)) return 'lock.bioWindows'
  if (/Android/.test(userAgent)) return 'lock.bioAndroid'
  // Linux has no platform authenticator to name (ADR-059): say what is missing.
  if (!/CrOS/.test(userAgent) && /Linux|X11/.test(userAgent)) return 'lock.bioLinux'
  return 'lock.bioOther'
}

/** What stands at the gate, as a sentence names it: the platform's own, or a security key. */
export const gateName = (authenticator: GateAuthenticator | undefined, t: TranslateFn): string =>
  authenticator === 'security-key' ? t('lock.securityKey') : t(biometricName())

/** A sentence that may open with a name written in lower case: "your security key did not…". */
export const capitalize = (sentence: string): string => sentence.charAt(0).toUpperCase() + sentence.slice(1)

/** Tries left at or below which a wrong PIN says how many remain. */
const WARN_AT = 5

/**
 * What went wrong opening or confirming with a way in, in terms of what to do
 * next. `style` says whether a wrong PIN was digits or a pattern, and `method`
 * names the gate that answered.
 */
export function unlockError(
  err: unknown,
  t: TranslateFn,
  { style = 'digits', method = t(biometricName()) }: { style?: PinStyle; method?: string } = {},
): string {
  if (err instanceof WrongPinError) {
    const what = t(style === 'pattern' ? 'lock.pattern' : 'lock.pin')
    if (err.triesLeft === 0) return t('lock.codeErased', { what })
    if (err.triesLeft !== null && err.triesLeft <= WARN_AT)
      return t('lock.codeWrongLeft', { what, n: err.triesLeft })
    return t('lock.codeWrong', { what })
  }
  if (err instanceof WrongPassphraseError) return t('lock.wrong')
  if (err instanceof WrongSecretError && err.slot === 'recovery') return t('lock.recoveryWrong')
  if (err instanceof GateCancelledError) return t('lock.bioCancelled')
  if (err instanceof GateRefusedError && err.reason === 'unverified') {
    return capitalize(t('lock.bioUnverified', { method }))
  }
  if (err instanceof WrongSecretError || err instanceof GateRefusedError) return t('lock.failed')
  return t('errors.generic')
}
