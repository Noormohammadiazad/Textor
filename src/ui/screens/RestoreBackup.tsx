import { useState } from 'react'
import { useT } from '../../i18n'
import { Banner, Field, Spinner } from '../components/primitives'
import { EntryLayout } from '../components/EntryLayout'
import { decryptExport, importVault, parseEnvelope } from '../../core/vault/exportImport'
import { getRepo, getVault, useApp } from '../../app/store'
import { DEFAULT_KDF_PARAMS } from '../../core/crypto/kdf'

/**
 * Restore a vault from an encrypted backup file, before any identity exists.
 *
 * This creates a fresh local vault (with a new device passphrase) and then
 * merges the backup into it. Two passphrases are involved on purpose: the
 * backup's, which travelled with the file, and the device's, which never
 * leaves this browser.
 */
export function RestoreBackup({ onCancel }: { onCancel: () => void }) {
  const t = useT()
  const toast = useApp((s) => s.toast)

  const [file, setFile] = useState<File | null>(null)
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [devicePassphrase, setDevicePassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      const envelope = parseEnvelope(await file.text())
      const payload = await decryptExport(envelope, backupPassphrase)

      const vault = getVault()
      if (!(await vault.exists())) {
        await vault.create(devicePassphrase, { params: DEFAULT_KDF_PARAMS })
      } else {
        await vault.unlock(devicePassphrase)
      }

      const summary = await importVault(getRepo(), payload, { adoptIdentity: true })
      toast(t('settings.importDone', { messages: summary.messages, contacts: summary.contacts }))
      // A reload is the simplest way to get the store to re-run its boot path
      // against the vault that now has an identity.
      location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = file && backupPassphrase && devicePassphrase.length >= 10 && !busy

  return (
    <EntryLayout>
      <>
        <div className="stack-sm">
          <h1>{t('settings.importBackup')}</h1>
          <p className="muted">{t('settings.exportBackupBody')}</p>
        </div>

        <Field label={t('settings.importChoose')}>
          <input
            className="input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>

        <Field label={t('onboarding.restoreFilePassphrase')}>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={backupPassphrase}
            onChange={(event) => setBackupPassphrase(event.target.value)}
          />
        </Field>

        <Field
          label={t('onboarding.passphrase')}
          hint={t('onboarding.passphraseHint')}
          error={error ?? undefined}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={devicePassphrase}
            onChange={(event) => setDevicePassphrase(event.target.value)}
          />
        </Field>

        <Banner tone="accent">
          <span className="small">{t('onboarding.passphraseBody')}</span>
        </Banner>

        <button className="btn btn-primary btn-block" disabled={!ready} onClick={() => void run()}>
          {busy ? <Spinner label={t('common.working')} /> : t('settings.importBackup')}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
      </>
    </EntryLayout>
  )
}
