import { useCallback, useState } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { Field, Spinner } from '../components/primitives'
import { EntryLayout } from '../components/EntryLayout'
import { ShieldCheckIcon, LockIcon, GlobeIcon } from '../components/Icons'
import { isValidMnemonic, normalizeMnemonic } from '../../core/identity/keys'
import { RestoreBackup } from './RestoreBackup'

type Step = 'welcome' | 'restore' | 'restore-file' | 'name' | 'passphrase' | 'creating'

const MIN_PASSPHRASE = 10

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

export function Onboarding() {
  const t = useT()
  const createVault = useApp((s) => s.createVault)

  const [step, setStep] = useState<Step>('welcome')
  const [name, setName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [restorePhrase, setRestorePhrase] = useState('')

  const strength = passphraseStrength(passphrase)
  const strengthLabel = [
    t('onboarding.strengthWeak'),
    t('onboarding.strengthFair'),
    t('onboarding.strengthGood'),
    t('onboarding.strengthStrong'),
  ][strength] as string

  const create = useCallback(async () => {
    setError(null)
    if (passphrase.length < MIN_PASSPHRASE) {
      setError(t('onboarding.passphraseTooShort'))
      return
    }
    if (passphrase !== confirm) {
      setError(t('onboarding.passphraseMismatch'))
      return
    }
    setStep('creating')
    try {
      await createVault({
        name,
        passphrase,
        mnemonic: restorePhrase ? normalizeMnemonic(restorePhrase) : undefined,
        onProgress: setProgress,
      })
      // Clear the passphrase from component state as soon as the vault exists.
      setPassphrase('')
      setConfirm('')
      // The shell takes over from here: it shows the recovery-phrase ceremony
      // whenever the stored identity is not yet marked as backed up.
    } catch (err) {
      setStep('passphrase')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [confirm, createVault, name, passphrase, restorePhrase, t])

  if (step === 'restore-file') {
    return <RestoreBackup onCancel={() => setStep('welcome')} />
  }

  return (
    <EntryLayout>
      {step === 'welcome' ? (
        <>
          <div className="stack-sm">
            <span className="entry-eyebrow">{t('onboarding.eyebrow')}</span>
            <h1>{t('onboarding.welcomeTitle')}</h1>
            <p className="muted">{t('onboarding.welcomeBody')}</p>
          </div>

          <ul className="feature-list">
            {[
              [<ShieldCheckIcon key="i" size={15} />, t('onboarding.point1')],
              [<LockIcon key="i" size={15} />, t('onboarding.point2')],
              [<GlobeIcon key="i" size={15} />, t('onboarding.point3')],
            ].map(([icon, text], index) => (
              <li key={index}>
                <span className="feature-icon" aria-hidden="true">
                  {icon}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>

          <div className="stack-sm">
            <button className="btn btn-primary btn-block" onClick={() => setStep('name')}>
              {t('onboarding.createIdentity')}
            </button>
            <button className="btn btn-outline btn-block" onClick={() => setStep('restore')}>
              {t('onboarding.restoreIdentity')}
            </button>
          </div>

          <p className="hint center">{t('privacy.intro')}</p>
        </>
      ) : null}

      {step === 'restore' ? (
        <>
          <div className="stack-sm">
            <h1>{t('onboarding.restoreTitle')}</h1>
            <p className="muted">{t('onboarding.restoreBody')}</p>
          </div>
          <Field label={t('onboarding.restorePhrase')} error={error ?? undefined}>
            <textarea
              className="textarea mono"
              dir="ltr"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('onboarding.restorePhrasePlaceholder')}
              value={restorePhrase}
              onChange={(event) => {
                setRestorePhrase(event.target.value)
                setError(null)
              }}
            />
          </Field>
          <div className="stack-sm">
            <button
              className="btn btn-primary btn-block"
              onClick={() => {
                if (!isValidMnemonic(restorePhrase)) {
                  setError(t('onboarding.restoreInvalid'))
                  return
                }
                setError(null)
                setStep('name')
              }}
            >
              {t('common.next')}
            </button>
            <button className="btn btn-outline btn-block" onClick={() => setStep('restore-file')}>
              {t('onboarding.restoreFromFile')}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setStep('welcome')}>
              {t('common.back')}
            </button>
          </div>
        </>
      ) : null}

      {step === 'name' ? (
        <>
          <div className="stack-sm">
            <h1>{t('onboarding.nameTitle')}</h1>
            <p className="muted">{t('onboarding.nameBody')}</p>
          </div>
          <Field>
            <input
              className="input"
              autoFocus
              maxLength={64}
              placeholder={t('onboarding.namePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) setStep('passphrase')
              }}
            />
          </Field>
          <div className="stack-sm">
            <button
              className="btn btn-primary btn-block"
              disabled={!name.trim()}
              onClick={() => setStep('passphrase')}
            >
              {t('common.next')}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setStep('welcome')}>
              {t('common.back')}
            </button>
          </div>
        </>
      ) : null}

      {step === 'passphrase' ? (
        <>
          <div className="stack-sm">
            <h1>{t('onboarding.passphraseTitle')}</h1>
            <p className="muted">{t('onboarding.passphraseBody')}</p>
          </div>
          <Field label={t('onboarding.passphrase')} hint={t('onboarding.passphraseHint')}>
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          {passphrase ? (
            <StrengthMeter
              score={strength}
              label={strengthLabel}
              caption={t('onboarding.passphraseStrength')}
            />
          ) : null}
          <Field label={t('onboarding.passphraseConfirm')} error={error ?? undefined}>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
          </Field>
          <div className="stack-sm">
            <button
              className="btn btn-primary btn-block"
              disabled={passphrase.length < MIN_PASSPHRASE || !confirm}
              onClick={() => void create()}
            >
              {t('common.next')}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setStep('name')}>
              {t('common.back')}
            </button>
          </div>
        </>
      ) : null}

      {step === 'creating' ? (
        <div className="stack center" style={{ paddingBlock: 'var(--space-7)' }}>
          <Spinner />
          <p className="muted">{t('onboarding.creating')}…</p>
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      ) : null}
    </EntryLayout>
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
