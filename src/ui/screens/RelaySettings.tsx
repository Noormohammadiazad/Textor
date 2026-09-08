import { useMemo, useState } from 'react'
import { getRepo, useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { Banner, Field } from '../components/primitives'
import { PlusIcon, RefreshIcon, TrashIcon } from '../components/Icons'
import { SettingsPage } from './Settings'
import { normalizeRelayUrl, relayLabel } from '../../core/transport/relayUrl'
import { DEFAULT_DM_RELAYS, SUGGESTED_RELAYS } from '../../core/transport/defaultRelays'
import type { RelayEntry } from '../../core/models/types'
import { verdictFor } from '../../core/transport/relayHealth'

export function RelaySettings() {
  const { t, locale } = useI18n()
  const entries = useApp((s) => s.relayEntries)
  const statuses = useApp((s) => s.relayStatuses)
  const refreshRelays = useApp((s) => s.refreshRelays)
  const toast = useApp((s) => s.toast)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const statusByUrl = useMemo(() => new Map(statuses.map((status) => [status.url, status])), [statuses])

  const activeCount = entries.filter((entry) => entry.enabled && entry.write).length

  const addRelay = async (raw: string) => {
    const url = normalizeRelayUrl(raw)
    if (!url) {
      setError(t('settings.relayInvalid'))
      return
    }
    if (entries.some((entry) => entry.url === url)) {
      setError(t('settings.relayExists'))
      return
    }
    await getRepo().upsertRelay(url, { read: true, write: true, enabled: true })
    await refreshRelays()
    setInput('')
    setError(null)
  }

  const update = async (entry: RelayEntry, patch: Partial<RelayEntry>) => {
    await getRepo().upsertRelay(entry.url, patch)
    await refreshRelays()
  }

  const remove = async (entry: RelayEntry) => {
    await getRepo().removeRelay(entry.url)
    await refreshRelays()
  }

  const restoreDefaults = async () => {
    for (const url of DEFAULT_DM_RELAYS) {
      await getRepo().upsertRelay(url, { read: true, write: true, enabled: true })
    }
    await refreshRelays()
    toast(t('common.done'))
  }

  const unusedSuggestions = SUGGESTED_RELAYS.filter((url) => !entries.some((entry) => entry.url === url))

  return (
    <SettingsPage title={t('settings.relays')}>
      <p className="muted">{t('settings.relaysBody')}</p>

      {activeCount === 0 ? <Banner tone="danger">{t('settings.noRelaysWarning')}</Banner> : null}

      <div className="card-section">
        {entries.map((entry) => {
          const status = statusByUrl.get(entry.url)
          const verdict = verdictFor(status)
          const badgeClass =
            verdict === 'healthy'
              ? 'badge badge-success'
              : verdict === 'degraded'
                ? 'badge badge-warning'
                : verdict === 'offline'
                  ? 'badge badge-danger'
                  : 'badge'
          const badgeLabel =
            verdict === 'healthy'
              ? t('settings.relayHealthy')
              : verdict === 'degraded'
                ? t('settings.relayDegraded')
                : verdict === 'offline'
                  ? t('settings.relayOffline')
                  : t('settings.relayNever')

          return (
            <div key={entry.id} className="stack-sm" style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <div className="row-between">
                <span className="grow truncate" style={{ fontWeight: 550 }}>
                  {relayLabel(entry.url)}
                </span>
                <span className={badgeClass}>{badgeLabel}</span>
                <button
                  className="btn btn-icon"
                  aria-label={t('settings.relayRemove')}
                  onClick={() => void remove(entry)}
                >
                  <TrashIcon size={16} />
                </button>
              </div>

              <div className="row faint" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                <label className="row" style={{ gap: '0.35rem' }}>
                  <input
                    className="checkbox checkbox-sm"
                    type="checkbox"
                    checked={entry.read}
                    onChange={(event) => void update(entry, { read: event.target.checked })}
                  />
                  {t('settings.relayRead')}
                </label>
                <label className="row" style={{ gap: '0.35rem' }}>
                  <input
                    className="checkbox checkbox-sm"
                    type="checkbox"
                    checked={entry.write}
                    onChange={(event) => void update(entry, { write: event.target.checked })}
                  />
                  {t('settings.relayWrite')}
                </label>
                {status && status.health.latencyMs > 0 ? (
                  <span>{t('settings.relayLatency', { n: status.health.latencyMs })}</span>
                ) : null}
                {status && status.health.publishOk + status.health.publishFail > 0 ? (
                  <span>
                    {t('settings.relayStats', {
                      ok: status.health.publishOk,
                      fail: status.health.publishFail,
                    })}
                  </span>
                ) : null}
              </div>

              {/*
                A relay that refuses our subscription is the failure mode most
                likely to go unnoticed: it connects, accepts publishes, and
                simply never delivers. Say so in words, not just an error code.
              */}
              {status && status.health.readFail > 0 ? (
                <span className="small" style={{ color: 'var(--warning)' }}>
                  {t('settings.relayCannotRead')}
                </span>
              ) : null}

              {status?.health.lastError ? (
                <span className="faint truncate" title={status.health.lastError}>
                  {status.health.lastError}
                </span>
              ) : null}

              <code className="mono faint" style={{ wordBreak: 'break-all' }} lang="en" dir="ltr">
                {entry.url}
              </code>
            </div>
          )
        })}
      </div>

      <div className="card stack-sm">
        <Field label={t('settings.relayAdd')} error={error ?? undefined}>
          <div className="row">
            <input
              className="input grow"
              dir="ltr"
              lang="en"
              placeholder={t('settings.relayPlaceholder')}
              value={input}
              onChange={(event) => {
                setInput(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addRelay(input)
              }}
            />
            <button className="btn btn-primary" disabled={!input.trim()} onClick={() => void addRelay(input)}>
              <PlusIcon size={16} />
            </button>
          </div>
        </Field>
      </div>

      {unusedSuggestions.length > 0 ? (
        <div className="card stack-sm">
          <span className="section-title">{t('settings.relaySuggested')}</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {unusedSuggestions.map((url) => (
              <button key={url} className="btn btn-outline small" onClick={() => void addRelay(url)}>
                <PlusIcon size={13} />
                {relayLabel(url)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <button className="btn btn-outline btn-block" onClick={() => void restoreDefaults()}>
        <RefreshIcon size={16} />
        {t('settings.relayResetDefaults')}
      </button>

      <p className="hint" lang={locale}>
        {t('privacy.relaysSee')}
      </p>
    </SettingsPage>
  )
}
