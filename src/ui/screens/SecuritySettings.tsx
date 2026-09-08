import { useState } from 'react'
import { getRepo, getVault, useApp } from '../../app/store'
import { useT } from '../../i18n'
import { Banner, Field, Modal, Spinner, Toggle } from '../components/primitives'
import { SettingsPage } from './Settings'
import { WrongPassphraseError } from '../../core/vault/vault'
import { passphraseStrength } from './Onboarding'

const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60]

export function SecuritySettings() {
  const t = useT()
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)

  const [changing, setChanging] = useState(false)
  const [phrase, setPhrase] = useState<string[] | null>(null)
  const [phraseError, setPhraseError] = useState<string | null>(null)
  const [phrasePassphrase, setPhrasePassphrase] = useState('')
  const [askingPhrase, setAskingPhrase] = useState(false)

  const revealPhrase = async () => {
    setPhraseError(null)
    try {
      // Re-derive from the passphrase rather than reading the unlocked vault:
      // showing a recovery phrase is the single most damaging thing this UI can
      // do, so it should not be one tap away from an unattended unlocked device.
      await getVault().unlock(phrasePassphrase)
      const identity = await getRepo().getIdentity()
      if (!identity?.mnemonic) {
        setPhraseError(t('errors.generic'))
        return
      }
      setPhrase(identity.mnemonic.split(' '))
      setPhrasePassphrase('')
      setAskingPhrase(false)
    } catch (err) {
      setPhraseError(err instanceof WrongPassphraseError ? t('lock.wrong') : t('errors.generic'))
    }
  }

  return (
    <SettingsPage title={t('settings.security')}>
      <div className="card stack-sm">
        <Field label={t('settings.autoLock')}>
          <select
            className="input select"
            value={String(settings.autoLockMinutes)}
            onChange={(event) => void saveSettings({ autoLockMinutes: Number(event.target.value) })}
          >
            {AUTO_LOCK_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0 ? t('settings.autoLockNever') : t('settings.autoLockMinutes', { n: minutes })}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="card-section">
        <Toggle
          label={t('settings.lockOnHide')}
          checked={settings.lockOnHide}
          onChange={(lockOnHide) => void saveSettings({ lockOnHide })}
        />
      </div>

      <button className="btn btn-outline btn-block" onClick={() => setChanging(true)}>
        {t('settings.changePassphrase')}
      </button>

      <div className="card stack-sm">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{t('settings.recoveryPhrase')}</h3>
        <p className="muted small">{t('settings.recoveryPhraseBody')}</p>
        {phrase ? (
          <>
            <div className="mnemonic-grid">
              {phrase.map((word, index) => (
                <div key={index} className="mnemonic-word">
                  <span>{index + 1}</span>
                  {word}
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-block" onClick={() => setPhrase(null)}>
              {t('common.hide')}
            </button>
          </>
        ) : (
          <button className="btn btn-outline btn-block" onClick={() => setAskingPhrase(true)}>
            {t('common.show')}
          </button>
        )}
      </div>

      <Banner tone="accent">
        <span className="small">{t('privacy.deviceBody')}</span>
      </Banner>

      {askingPhrase ? (
        <Modal title={t('settings.recoveryPhrase')} onClose={() => setAskingPhrase(false)}>
          <div className="stack">
            <Field label={t('settings.currentPassphrase')} error={phraseError ?? undefined}>
              <input
                className="input"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={phrasePassphrase}
                onChange={(event) => {
                  setPhrasePassphrase(event.target.value)
                  setPhraseError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void revealPhrase()
                }}
              />
            </Field>
            <button className="btn btn-primary btn-block" onClick={() => void revealPhrase()}>
              {t('common.show')}
            </button>
          </div>
        </Modal>
      ) : null}

      {changing ? (
        <ChangePassphraseModal
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false)
            toast(t('settings.passphraseChanged'))
          }}
        />
      ) : null}
    </SettingsPage>
  )
}

function ChangePassphraseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (next.length < 10) {
      setError(t('onboarding.passphraseTooShort'))
      return
    }
    if (next !== confirm) {
      setError(t('onboarding.passphraseMismatch'))
      return
    }
    setBusy(true)
    try {
      await getVault().changePassphrase(current, next, { onProgress: setProgress })
      onDone()
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? t('lock.wrong') : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('settings.changePassphrase')} onClose={onClose}>
      <div className="stack">
        <Field label={t('settings.currentPassphrase')}>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <Field label={t('settings.newPassphrase')} hint={t('onboarding.passphraseHint')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>
        <Field label={t('onboarding.passphraseConfirm')} error={error ?? undefined}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {busy ? (
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
        <button
          className="btn btn-primary btn-block"
          disabled={busy || !current || passphraseStrength(next) === 0}
          onClick={() => void submit()}
        >
          {busy ? <Spinner label={t('common.working')} /> : t('common.save')}
        </button>
      </div>
    </Modal>
  )
}
