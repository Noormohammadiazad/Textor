import { useState } from 'react'
import { useApp } from '../../app/store'
import { useT } from '../../i18n'
import { WrongPassphraseError } from '../../core/vault/vault'
import { Banner, Field, Spinner } from '../components/primitives'
import { EntryLayout } from '../components/EntryLayout'
import { LockIcon } from '../components/Icons'

export function LockScreen() {
  const t = useT()
  const unlock = useApp((s) => s.unlock)
  const wipeDevice = useApp((s) => s.wipeDevice)
  const autoLocked = useApp((s) => s.autoLocked)

  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showRecovery, setShowRecovery] = useState(false)

  const submit = async () => {
    if (!passphrase || busy) return
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      await unlock(passphrase, setProgress)
      setPassphrase('')
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? t('lock.wrong') : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <EntryLayout>
      <div className="stack-sm center">
        <span className="lock-mark" aria-hidden="true">
          <LockIcon size={20} />
        </span>
        <h1 className="lock-title">{t('lock.title')}</h1>
        <p className="muted">{t('lock.body')}</p>
      </div>

      {autoLocked ? <Banner tone="accent">{t('lock.autoLocked')}</Banner> : null}

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field error={error ?? undefined}>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-label={t('onboarding.passphrase')}
            aria-invalid={error ? true : undefined}
            value={passphrase}
            disabled={busy}
            onChange={(event) => {
              setPassphrase(event.target.value)
              setError(null)
            }}
          />
        </Field>
        {/* Unlocking runs scrypt, which takes about a second on a phone. Without
            a progress bar that reads as the app having frozen. */}
        {busy ? (
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
        <button className="btn btn-primary btn-block" type="submit" disabled={!passphrase || busy}>
          {busy ? <Spinner label={t('lock.unlocking')} /> : t('lock.unlock')}
        </button>
      </form>

      <div className="center">
        <button
          className="btn btn-ghost small"
          aria-expanded={showRecovery}
          onClick={() => setShowRecovery((value) => !value)}
        >
          {t('lock.forgot')}
        </button>
      </div>

      {showRecovery ? (
        <div className="stack">
          <Banner tone="warning">{t('lock.forgotBody')}</Banner>
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
