import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { type KeyslotType, type SlotSecret } from '../../core/vault/vault'
import { isGuarded, isValidPin } from '../../core/vault/keyslots'
import { confirmBiometric, GateCancelledError } from '../../core/crypto/biometricGate'
import { Banner, Field, Spinner } from '../components/primitives'
import { EntryLayout } from '../components/EntryLayout'
import { LockIcon } from '../components/Icons'
import { PatternPad } from '../components/PatternPad'
import { gateName, unlockError } from '../biometric'

/** The ways in, most convenient first: the first one the vault has is offered first. */
const WAYS: KeyslotType[] = ['device', 'biometric', 'pin', 'passphrase', 'recovery']

/** Digits in any script the PIN field accepts; everything else is dropped as typed. */
const NOT_A_DIGIT = /[^\d۰-۹٠-٩]/g

/**
 * Opens the vault with whichever of its keyslots the person has (ADR-054,
 * ADR-058, ADR-059).
 *
 * The first way offered is the most convenient one enrolled: open instantly,
 * then biometrics or a security key, then a PIN or pattern, then the
 * passphrase. The recovery phrase is always one tap away, because it is what
 * makes a forgotten PIN, a lockout or a replaced fingerprint survivable.
 */
export function LockScreen() {
  const t = useT()
  const unlock = useApp((s) => s.unlock)
  const wipeDevice = useApp((s) => s.wipeDevice)
  const autoLocked = useApp((s) => s.autoLocked)
  const keyslots = useApp((s) => s.keyslots)
  const autoPrompt = useApp((s) => s.autoPrompt)
  const consumeAutoPrompt = useApp((s) => s.consumeAutoPrompt)
  const passkeyRetired = useApp((s) => s.passkeyRetired)

  // Opening instantly never stands beside a way that asks for something; the
  // vault refuses it there, so it is not offered either (ADR-059).
  const guarded = keyslots.some(isGuarded)
  const available = WAYS.filter(
    (type) => keyslots.some((slot) => slot.type === type) && (type !== 'device' || !guarded),
  )
  const biometric = keyslots.find((slot) => slot.type === 'biometric')
  const pin = keyslots.find((slot) => slot.type === 'pin')
  const style = pin?.style ?? 'digits'
  const method = gateName(biometric?.authenticator, t)

  const [chosen, setChosen] = useState<KeyslotType | null>(null)
  // A way that has gone — a PIN erased after too many tries — gives way to the next.
  const way: KeyslotType = chosen && available.includes(chosen) ? chosen : (available[0] ?? 'passphrase')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showForgot, setShowForgot] = useState(false)

  /** `quiet`: nobody asked, so a prompt that did not happen is not an error to show. */
  const attempt = async (make: () => Promise<SlotSecret>, quiet = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      await unlock(await make())
      setSecret('')
    } catch (err) {
      if (!(quiet && err instanceof GateCancelledError)) setError(unlockError(err, t, { style, method }))
      setSecret('')
    } finally {
      setBusy(false)
    }
  }

  // Called in the tap's own task: Safari before iOS 17.4 refuses WebAuthn
  // that is not.
  const withBiometric = (quiet = false) => {
    if (!biometric?.credentialId) return
    const { credentialId, authenticator, transports } = biometric
    void attempt(
      async () => ({
        type: 'biometric',
        presence: await confirmBiometric({ credentialId, authenticator, transports }),
      }),
      quiet,
    )
  }

  const withPin = (code: string) => void attempt(async () => ({ type: 'pin', code, onProgress: setProgress }))

  // One unprompted request, on a cold start, once the page is in view and has
  // focus — Chrome refuses WebAuthn to a page without it, and a tab opened in
  // the background gets its prompt when it is looked at, not never. Browsers
  // that want a tap first refuse it, silently, and the button is right there.
  const wayNow = useRef(way)
  useEffect(() => {
    wayNow.current = way
  })
  const prompted = useRef(false)
  useEffect(() => {
    if (!autoPrompt || way !== 'biometric') return
    const stop = () => {
      document.removeEventListener('visibilitychange', ask)
      globalThis.removeEventListener('focus', ask)
    }
    function ask() {
      if (prompted.current || wayNow.current !== 'biometric') return stop()
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      prompted.current = true
      stop()
      consumeAutoPrompt()
      // After the effect, not inside it: it sets state as it runs. There is
      // no tap to keep alive, so the delay costs nothing.
      queueMicrotask(() => withBiometric(true))
    }
    document.addEventListener('visibilitychange', ask)
    globalThis.addEventListener('focus', ask)
    ask()
    return stop
    // Deliberately once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = () => {
    if (!secret.trim()) return
    const value = secret
    if (way === 'pin') return withPin(value)
    void attempt(async () =>
      way === 'recovery'
        ? { type: 'recovery', mnemonic: value }
        : { type: 'passphrase', passphrase: value, onProgress: setProgress },
    )
  }

  const choose = (next: KeyslotType) => {
    setChosen(next)
    setSecret('')
    setError(null)
  }

  const labels: Record<KeyslotType, string> = {
    device: t('lock.open'),
    biometric: t('lock.withBiometric', { method }),
    pin: t('lock.useCode', { what: t(style === 'pattern' ? 'lock.pattern' : 'lock.pin') }),
    passphrase: t('lock.usePassphrase'),
    recovery: t('lock.useRecovery'),
  }

  const typed = way === 'passphrase' || way === 'recovery' || (way === 'pin' && style === 'digits')
  const ready = way === 'pin' ? isValidPin('digits', secret) : secret.trim().length > 0

  return (
    <EntryLayout>
      <div className="stack-sm center">
        <span className="lock-mark" aria-hidden="true">
          <LockIcon size={20} />
        </span>
        <h1 className="lock-title">{t('lock.title')}</h1>
        <p className="muted">{way === 'device' ? t('lock.openBody') : t('lock.body')}</p>
      </div>

      {autoLocked ? <Banner tone="accent">{t('lock.autoLocked')}</Banner> : null}
      {passkeyRetired ? <Banner tone="warning">{t('lock.passkeyRetired')}</Banner> : null}

      {way === 'device' || way === 'biometric' ? (
        <>
          <button
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={
              way === 'device' ? () => void attempt(async () => ({ type: 'device' })) : () => withBiometric()
            }
          >
            {busy ? <Spinner label={t('lock.unlocking')} /> : labels[way]}
          </button>
          {error ? (
            <p className="error-text center" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}

      {way === 'pin' && style === 'pattern' ? (
        <div className="stack-sm">
          <PatternPad label={t('lock.drawPattern')} disabled={busy} onDone={withPin} />
          {busy ? (
            <div className="progress">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          ) : null}
          {error ? (
            <p className="error-text center" role="alert">
              {error}
            </p>
          ) : (
            <p className="hint center">{t('lock.drawPattern')}</p>
          )}
        </div>
      ) : null}

      {typed ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field label={way === 'recovery' ? t('lock.recoveryPhrase') : undefined} error={error ?? undefined}>
            {way === 'recovery' ? (
              <textarea
                className="textarea mono"
                dir="ltr"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                value={secret}
                disabled={busy}
                onChange={(event) => {
                  setSecret(event.target.value)
                  setError(null)
                }}
              />
            ) : (
              <input
                className={way === 'pin' ? 'input pin-input' : 'input'}
                type="password"
                dir={way === 'pin' ? 'ltr' : undefined}
                inputMode={way === 'pin' ? 'numeric' : undefined}
                maxLength={way === 'pin' ? 16 : undefined}
                autoFocus
                autoComplete={way === 'pin' ? 'off' : 'current-password'}
                aria-label={way === 'pin' ? t('lock.pin') : t('lock.passphrase')}
                aria-invalid={error ? true : undefined}
                value={secret}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value
                  setSecret(way === 'pin' ? value.replace(NOT_A_DIGIT, '') : value)
                  setError(null)
                }}
              />
            )}
          </Field>
          {/* A passphrase or a PIN runs scrypt, which takes a second or more on a
              phone. Without a progress bar that reads as the app having frozen. */}
          {busy && way !== 'recovery' ? (
            <div className="progress">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          ) : null}
          <button className="btn btn-primary btn-block" type="submit" disabled={!ready || busy}>
            {busy ? <Spinner label={t('lock.unlocking')} /> : t('lock.unlock')}
          </button>
        </form>
      ) : null}

      <div className="stack-sm center">
        {available
          .filter((other) => other !== way)
          .map((other) => (
            <button key={other} className="btn btn-ghost small" onClick={() => choose(other)}>
              {labels[other]}
            </button>
          ))}
        <button
          className="btn btn-ghost small"
          aria-expanded={showForgot}
          onClick={() => setShowForgot((value) => !value)}
        >
          {t('lock.forgot')}
        </button>
      </div>

      {showForgot ? (
        <div className="stack">
          <Banner tone="warning">
            {available.includes('recovery') ? t('lock.forgotBodyRecovery') : t('lock.forgotBody')}
          </Banner>
          <button
            className="btn btn-danger-soft btn-block"
            onClick={() => {
              if (confirm(t('lock.startOverConfirm'))) void wipeDevice()
            }}
          >
            {t('lock.startOver')}
          </button>
        </div>
      ) : null}
    </EntryLayout>
  )
}
