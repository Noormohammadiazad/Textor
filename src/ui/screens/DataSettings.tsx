import { useEffect, useState } from 'react'
import { getRepo, useApp } from '../../app/store'
import { estimateStorage, type StorageEstimate } from '../../app/storagePersistence'
import { useT } from '../../i18n'
import { Banner, Field, Spinner, Toggle } from '../components/primitives'
import { DownloadIcon, TrashIcon, UploadIcon } from '../components/Icons'
import { SettingsPage } from './Settings'
import {
  decryptExport,
  exportFilename,
  exportVault,
  importVault,
  parseEnvelope,
} from '../../core/vault/exportImport'

/** Compact byte sizes; the exact figure matters less than the order of magnitude. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return '<1 MB'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function DataSettings() {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const wipeDevice = useApp((s) => s.wipeDevice)
  const refreshContacts = useApp((s) => s.refreshContacts)
  const refreshConversations = useApp((s) => s.refreshConversations)

  const [stats, setStats] = useState<{ messages: number; contacts: number } | null>(null)
  const [storage, setStorage] = useState<StorageEstimate | null>(null)
  const persisted = useApp((s) => s.storagePersisted)
  const [exportPassphrase, setExportPassphrase] = useState('')
  const [includeMessages, setIncludeMessages] = useState(true)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPassphrase, setImportPassphrase] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')

  useEffect(() => {
    void getRepo().stats().then(setStats)
    void estimateStorage().then(setStorage)
  }, [])

  const runExport = async () => {
    setError(null)
    setBusy('export')
    try {
      const envelope = await exportVault(getRepo(), exportPassphrase, { includeMessages })
      // A Blob download keeps the backup on the device: no upload, no service.
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exportFilename()
      anchor.click()
      URL.revokeObjectURL(url)
      setExportPassphrase('')
      toast(t('settings.exportReady'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    if (!importFile) return
    setError(null)
    setBusy('import')
    try {
      const envelope = parseEnvelope(await importFile.text())
      const payload = await decryptExport(envelope, importPassphrase)
      const summary = await importVault(getRepo(), payload)
      await Promise.all([refreshContacts(), refreshConversations()])
      setStats(await getRepo().stats())
      setImportFile(null)
      setImportPassphrase('')
      toast(t('settings.importDone', { messages: summary.messages, contacts: summary.contacts }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage title={t('settings.data')}>
      {stats ? (
        <p className="muted">
          {t('settings.storageUsed', { messages: stats.messages, contacts: stats.contacts })}
          {storage ? (
            <>
              {' · '}
              {t('settings.storageUsage', {
                used: formatBytes(storage.usageBytes),
                quota: formatBytes(storage.quotaBytes),
              })}
            </>
          ) : null}
        </p>
      ) : null}

      {/*
        Whether the browser will keep this data is the single most consequential
        fact on this screen — there is no server copy — so it is stated plainly
        rather than assumed.
      */}
      {persisted === 'persisted' ? (
        <Banner tone="accent">{t('settings.storagePersisted')}</Banner>
      ) : (
        <Banner tone="warning">
          <span className="stack-sm">
            <strong>{t('settings.storageNotPersisted')}</strong>
            <span>{t('settings.storageNotPersistedBody')}</span>
          </span>
        </Banner>
      )}

      <div className="card stack">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{t('settings.exportBackup')}</h3>
        <p className="muted small">{t('settings.exportBackupBody')}</p>
        <Field label={t('settings.exportPassphrase')} hint={t('onboarding.passphraseHint')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={exportPassphrase}
            onChange={(event) => setExportPassphrase(event.target.value)}
          />
        </Field>
        <Toggle
          label={t('settings.exportIncludeMessages')}
          checked={includeMessages}
          onChange={setIncludeMessages}
        />
        <button
          className="btn btn-primary btn-block"
          disabled={exportPassphrase.length < 10 || busy !== null}
          onClick={() => void runExport()}
        >
          {busy === 'export' ? (
            <Spinner label={t('common.working')} />
          ) : (
            <>
              <DownloadIcon size={16} />
              {t('settings.exportCreate')}
            </>
          )}
        </button>
      </div>

      <div className="card stack">
        <h3 style={{ fontSize: 'var(--step-0)' }}>{t('settings.importBackup')}</h3>
        <Field label={t('settings.importChoose')}>
          <input
            className="input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t('settings.exportPassphrase')} error={error ?? undefined}>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={importPassphrase}
            onChange={(event) => setImportPassphrase(event.target.value)}
          />
        </Field>
        <button
          className="btn btn-outline btn-block"
          disabled={!importFile || !importPassphrase || busy !== null}
          onClick={() => void runImport()}
        >
          {busy === 'import' ? (
            <Spinner label={t('common.working')} />
          ) : (
            <>
              <UploadIcon size={16} />
              {t('settings.importBackup')}
            </>
          )}
        </button>
      </div>

      <div className="card stack">
        <h3 style={{ fontSize: 'var(--step-0)', color: 'var(--danger)' }}>
          {t('settings.deleteEverything')}
        </h3>
        <p className="muted small">{t('settings.deleteEverythingBody')}</p>
        <Banner tone="danger">
          <span className="small">{t('lock.startOverConfirm')}</span>
        </Banner>
        <Field label={t('settings.deleteEverythingConfirm')}>
          <input
            className="input"
            dir="ltr"
            value={deleteConfirm}
            onChange={(event) => setDeleteConfirm(event.target.value)}
          />
        </Field>
        <button
          className="btn btn-danger btn-block"
          disabled={deleteConfirm !== 'DELETE'}
          onClick={() => void wipeDevice()}
        >
          <TrashIcon size={16} />
          {t('settings.deleteEverything')}
        </button>
      </div>
    </SettingsPage>
  )
}
