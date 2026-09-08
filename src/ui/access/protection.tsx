import { useEffect, useRef, useState } from 'react'
import { useT, type TranslateFn } from '../../i18n'
import { Field, Spinner } from '../components/primitives'
import { PatternPad } from '../components/PatternPad'
import { capitalize, gateName, unlockError } from '../biometric'
import { useAccessText, type AccessTextFn } from './accessText'
import {
  confirmBiometric,
  GateCancelledError,
  GateRefusedError,
  type GateAuthenticator,
  type GateCredential,
} from '../../core/crypto/biometricGate'
import {
  biometricSupport,
  enrolBiometric,
  forgetBiometric,
  type BiometricSupport,
} from '../../core/crypto/biometricEnrol'
import { canOpenInstantly, isValidPin, normalizePin } from '../../core/vault/keyslots'
import type { SlotEnrolment } from '../../core/vault/vault'
import './access.css'

export const MIN_PASSPHRASE = 10

/**
 * Rough passphrase strength.
 *
 * Deliberately not a full entropy estimator (zxcvbn is ~400 KB): the goal is to
 * steer people away from a single short word, which this does, and to be honest
 * that the meter is advice rather than a guarantee.
 */
export function passphraseStrength(value: string): 0 | 1 | 2 | 3 {
  const length = value.length
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^\w\s]/.test(value)) +
    Number(/\s/.test(value))
  if (length < MIN_PASSPHRASE) return 0
  if (length >= 20 || (length >= 16 && classes >= 3)) return 3
  if (length >= 14 || classes >= 3) return 2
  return 1
}

/** Why a new passphrase cannot be used, or null if it can. */
export function passphraseProblem(passphrase: string, confirm: string, text: AccessTextFn): string | null {
  if (passphrase.length < MIN_PASSPHRASE) return text('passphraseTooShort')
  if (passphrase !== confirm) return text('passphraseMismatch')
  return null
}

/** A new passphrase, typed twice, with an honest strength meter. */
export function PassphraseFields({
  value,
  confirm,
  error,
  onChange,
  onConfirmChange,
  onSubmit,
}: {
  value: string
  confirm: string
  error: string | null
  onChange: (value: string) => void
  onConfirmChange: (value: string) => void
  onSubmit: () => void
}) {
  const text = useAccessText()
  const score = passphraseStrength(value)
  const label = [text('strengthWeak'), text('strengthFair'), text('strengthGood'), text('strengthStrong')][
    score
  ] as string
  return (
    <>
      <Field label={text('passphrase')} hint={text('passphraseHint')}>
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      {value ? <StrengthMeter score={score} label={label} caption={text('passphraseStrength')} /> : null}
      <Field label={text('passphraseConfirm')} error={error ?? undefined}>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => onConfirmChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit()
          }}
        />
      </Field>
    </>
  )
}

/**
 * Four discrete bars rather than one filling bar.
 *
 * A continuous bar invites the reading "78% secure", which is not a claim this
 * heuristic can support. Discrete steps say what the estimate actually is: one
 * of four buckets.
 */
function StrengthMeter({ score, label, caption }: { score: 0 | 1 | 2 | 3; label: string; caption: string }) {
  const tone = score >= 2 ? 'good' : score === 1 ? 'fair' : 'weak'
  return (
    <div className="stack-sm">
      <div className="strength-meter" data-tone={tone} aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} data-filled={index <= score ? 'true' : 'false'} />
        ))}
      </div>
      <span className="hint">
        {caption}: <strong className={`strength-label strength-${tone}`}>{label}</strong>
      </span>
    </div>
  )
}

/** Whether biometrics can guard Textor here. Resolves once, after mount. */
export function useBiometricSupport(): BiometricSupport | null {
  const [support, setSupport] = useState<BiometricSupport | null>(null)
  useEffect(() => {
    let live = true
    void biometricSupport().then((result) => {
      if (live) setSupport(result)
    })
    return () => {
      live = false
    }
  }, [])
  return support
}

/**
 * Set a gate up: make a credential on the chosen authenticator, and confirm it
 * once, as unlocking will. If the confirming prompt is dismissed — or refused
 * for want of a tap — trying again asks the credential already made rather
 * than making another, which would leave a stray one in the person's list.
 */
export function useBiometricEnrolment(): (
  authenticator: GateAuthenticator,
) => Promise<Extract<SlotEnrolment, { type: 'biometric' }>> {
  const pending = useRef<GateCredential | null>(null)
  return async (authenticator) => {
    const waiting = pending.current
    // Asked for somewhere else instead: the half-made one is not wanted.
    if (waiting && waiting.authenticator !== authenticator) forgetBiometric(waiting.credentialId)
    const made = waiting?.authenticator === authenticator ? waiting : null
    pending.current = null
    try {
      const presence = made ? await confirmBiometric(made) : await enrolBiometric(authenticator)
      return { type: 'biometric', presence }
    } catch (err) {
      if (err instanceof GateCancelledError) pending.current = err.made ?? made
      else if (made) forgetBiometric(made.credentialId)
      throw err
    }
  }
}

/** Why this device's own authenticator cannot guard Textor here, before anyone is asked — or null if it can. */
export function biometricBlocked(
  support: BiometricSupport | null,
  text: AccessTextFn,
  method: string,
): string | null {
  if (support?.platform === 'unsupported') return support.family === 'linux' ? text('bioLinux') : null
  if (support?.platform !== 'not-set-up') return null
  const reason =
    support.family === 'apple'
      ? text('bioNotSetUpApple', { method })
      : support.family === 'windows'
        ? text('bioNotSetUpWindows')
        : support.family === 'android'
          ? text('bioNotSetUpAndroid')
          : text('bioNotSetUp', { method })
  return `${reason} ${text('bioPrivate')}`
}

/** What went wrong setting a gate up, in terms of what to do next. */
export function explainBiometric(err: unknown, text: AccessTextFn, t: TranslateFn, method: string): string {
  // Made, and only the confirming ask did not happen: one more tap finishes.
  if (err instanceof GateCancelledError && err.made) return capitalize(text('bioFinish', { method }))
  if (err instanceof GateRefusedError) {
    return capitalize(text(err.reason === 'unverified' ? 'bioUnverifiedSetup' : 'bioFailed', { method }))
  }
  return unlockError(err, t, { method })
}

/** Only digits, in whichever script they were typed; everything else is dropped. */
export const digitsOnly = (value: string): string => value.replace(/[^\d\u06F0-\u06F9\u0660-\u0669]/g, '')

/** Why a new PIN cannot be used, or null if it can. */
export function pinProblem(pin: string, confirm: string, text: AccessTextFn): string | null {
  if (!isValidPin('digits', pin)) return text('pinTooShort')
  if (normalizePin(pin) !== normalizePin(confirm)) return text('pinMismatch')
  return null
}

/** A new PIN, typed twice. */
export function PinFields({
  value,
  confirm,
  error,
  onChange,
  onConfirmChange,
  onSubmit,
}: {
  value: string
  confirm: string
  error: string | null
  onChange: (value: string) => void
  onConfirmChange: (value: string) => void
  onSubmit: () => void
}) {
  const text = useAccessText()
  const input = {
    className: 'input pin-input',
    type: 'password',
    dir: 'ltr',
    inputMode: 'numeric',
    maxLength: 16,
    autoComplete: 'off',
  } as const
  return (
    <>
      <Field label={text('pin')} hint={text('pinHint')}>
        <input
          {...input}
          autoFocus
          value={value}
          onChange={(event) => onChange(digitsOnly(event.target.value))}
        />
      </Field>
      <Field label={text('pinConfirm')} error={error ?? undefined}>
        <input
          {...input}
          value={confirm}
          onChange={(event) => onConfirmChange(digitsOnly(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit()
          }}
        />
      </Field>
    </>
  )
}

/**
 * A new pattern, drawn twice. The second drawing must match the first, and a
 * mismatch starts again from the beginning, as phones do.
 */
export function PatternSetup({
  onComplete,
  disabled,
}: {
  onComplete: (code: string) => void
  disabled?: boolean
}) {
  const text = useAccessText()
  const [first, setFirst] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const prompt = first ? text('patternAgain') : text('patternDraw')
  return (
    <div className="stack-sm">
      <p className="small muted center">{prompt}</p>
      <PatternPad
        label={prompt}
        disabled={disabled}
        onDone={(code) => {
          if (!first) {
            if (!isValidPin('pattern', code)) return setError(text('patternTooShort'))
            setError(null)
            return setFirst(code)
          }
          if (code !== first) {
            setFirst(null)
            return setError(text('patternMismatch'))
          }
          setError(null)
          onComplete(code)
        }}
      />
      {error ? (
        <p className="error-text center" role="alert">
          {error}
        </p>
      ) : null}
      {first ? (
        <button
          type="button"
          className="btn btn-ghost small"
          onClick={() => {
            setFirst(null)
            setError(null)
          }}
        >
          {text('patternRestart')}
        </button>
      ) : null}
    </div>
  )
}

type Choice = 'biometric' | 'security-key' | 'pin' | 'pattern' | 'passphrase' | 'instant'

/**
 * "How should this device open Textor?", asked in outcomes rather than
 * mechanisms (ADR-054, ADR-058, ADR-059): the device's biometrics, a PIN, a
 * pattern, a passphrase, or opening instantly — and, where the device has no
 * authenticator of its own to use, a security key. Each says plainly what it
 * stops and what it does not. Biometrics are chosen by default where they are
 * set up; a PIN otherwise. A PIN or pattern is offered only where the recovery
 * phrase will open the device too, since too many wrong tries erase it.
 */
export function ProtectionChooser({
  onChoose,
  recoveryNote,
}: {
  onChoose: (enrolment: SlotEnrolment) => Promise<void>
  recoveryNote: boolean
}) {
  const t = useT()
  const text = useAccessText()
  const support = useBiometricSupport()
  const enrolBiometricSlot = useBiometricEnrolment()

  const [picked, setPicked] = useState<Choice | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  // Nothing is chosen until it is known whether biometrics are here.
  const choice: Choice | null =
    picked ??
    (support === null ? null : support.platform === 'yes' ? 'biometric' : recoveryNote ? 'pin' : 'passphrase')
  const gate: GateAuthenticator = choice === 'security-key' ? 'security-key' : 'platform'
  const method = gateName(gate, t)

  const pick = (next: Choice) => {
    setPicked(next)
    setError(null)
  }

  const go = async (pattern?: string) => {
    if (busy || !choice) return
    setError(null)
    const problem =
      choice === 'passphrase'
        ? passphraseProblem(passphrase, confirm, text)
        : choice === 'pin'
          ? pinProblem(pin, pinConfirm, text)
          : null
    if (problem) return setError(problem)
    setBusy(true)
    setProgress(0)
    try {
      const enrolment: SlotEnrolment =
        choice === 'biometric' || choice === 'security-key'
          ? await enrolBiometricSlot(gate)
          : choice === 'instant'
            ? { type: 'device' }
            : choice === 'passphrase'
              ? { type: 'passphrase', passphrase, onProgress: setProgress }
              : {
                  type: 'pin',
                  style: choice === 'pin' ? 'digits' : 'pattern',
                  code: choice === 'pin' ? pin : (pattern as string),
                  onProgress: setProgress,
                }
      await onChoose(enrolment)
    } catch (err) {
      setError(
        choice === 'biometric' || choice === 'security-key'
          ? explainBiometric(err, text, t, method)
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  const platform = gateName('platform', t)
  const blocked = biometricBlocked(support, text, platform)
  const options: { value: Choice; title: string; body: string; disabled?: boolean }[] = []
  if (support?.platform === 'yes' || blocked) {
    options.push({
      value: 'biometric',
      title: capitalize(platform),
      body: blocked ?? text('choiceBiometricBody', { method: platform }),
      disabled: Boolean(blocked),
    })
  }
  // Where the device's own cannot guard it, a security key can.
  if (support?.securityKey && support.platform !== 'yes') {
    options.push({ value: 'security-key', title: text('choiceKey'), body: text('choiceKeyBody') })
  }
  if (recoveryNote) {
    options.push(
      { value: 'pin', title: text('choicePin'), body: text('choicePinBody') },
      { value: 'pattern', title: text('choicePattern'), body: text('choicePatternBody') },
    )
  }
  options.push({ value: 'passphrase', title: text('choicePassphrase'), body: text('choicePassphraseBody') })
  if (canOpenInstantly()) {
    options.push({ value: 'instant', title: text('choiceInstant'), body: text('choiceInstantBody') })
  }

  const errorLine = error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null

  const heading = (
    <div className="stack-sm">
      <h1>{text('protectTitle')}</h1>
      <p className="muted">{text('protectBody')}</p>
    </div>
  )

  // Held until it is known whether biometrics are here: the card would
  // otherwise arrive above the others and move them under a finger.
  if (!choice) {
    return (
      <>
        {heading}
        <Spinner label={t('common.loading')} />
      </>
    )
  }

  return (
    <>
      {heading}

      <div className="choice-list" role="radiogroup" aria-label={text('protectTitle')}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="choice"
            aria-checked={choice === option.value}
            disabled={busy || option.disabled}
            onClick={() => pick(option.value)}
          >
            <span className="choice-title">{option.title}</span>
            <span className="small muted">{option.body}</span>
          </button>
        ))}
      </div>

      {choice === 'passphrase' ? (
        <PassphraseFields
          value={passphrase}
          confirm={confirm}
          error={error}
          onChange={setPassphrase}
          onConfirmChange={setConfirm}
          onSubmit={() => void go()}
        />
      ) : choice === 'pin' ? (
        <PinFields
          value={pin}
          confirm={pinConfirm}
          error={error}
          onChange={setPin}
          onConfirmChange={setPinConfirm}
          onSubmit={() => void go()}
        />
      ) : choice === 'pattern' ? (
        <>
          <PatternSetup disabled={busy} onComplete={(code) => void go(code)} />
          {errorLine}
        </>
      ) : (
        errorLine
      )}

      {busy && choice !== 'biometric' && choice !== 'instant' ? (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}

      {choice === 'biometric' || choice === 'security-key' ? (
        <p className="hint">{capitalize(text('twoPrompts', { method }))}</p>
      ) : null}

      {recoveryNote ? <p className="hint">{text('recoveryNote')}</p> : null}

      {choice === 'pattern' ? null : (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void go()}>
          {busy ? <Spinner label={t('common.working')} /> : t('common.next')}
        </button>
      )}
    </>
  )
}
