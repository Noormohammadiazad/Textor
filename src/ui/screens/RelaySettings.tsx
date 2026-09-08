import { useEffect, useMemo, useState } from 'react'
import { getMessenger, getRepo, useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { Banner, Field, Toggle } from '../components/primitives'
import { PlusIcon, RefreshIcon, TrashIcon } from '../components/Icons'
import { SettingsPage } from './SettingsPage'
import { normalizeRelayUrl, relayLabel } from '../../core/transport/relayUrl'
import { DEFAULT_DM_RELAYS } from '../../core/transport/defaultRelays'
import { DOWN_AFTER } from '../../core/transport/relayScore'
import { verdictFor } from '../../core/transport/relayHealth'
import type { RelayStatus } from '../../core/transport/relayPool'
import type { Candidate, Probe, Repair } from '../../core/transport/relayScout'
import type { RelayEntry } from '../../core/models/types'
import { useAboutText } from './aboutText'
import { useRelayText, type RelayTextKey } from './relayText'

type Standing = 'inUse' | 'standby' | 'down' | 'refuses' | 'unreliable' | 'off'

/** Where a relay stands, in the words someone deciding whether to keep it needs. */
function standingOf(entry: RelayEntry, status: RelayStatus | undefined): Standing {
  const health = status?.health ?? entry.health
  if (!entry.enabled) return 'off'
  if (health.readFail > 0) return 'refuses'
  if (health.connectStreak >= DOWN_AFTER) return 'down'
  if (status && verdictFor(status) === 'degraded') return 'unreliable'
  return status?.active ? 'inUse' : 'standby'
}

const ORDER: Standing[] = ['inUse', 'unreliable', 'standby', 'down', 'refuses', 'off']

const BADGE: Record<Standing, string> = {
  inUse: 'badge badge-success',
  standby: 'badge',
  down: 'badge badge-danger',
  refuses: 'badge badge-warning',
  unreliable: 'badge badge-warning',
  off: 'badge',
}

interface Scan {
  candidates: Candidate[]
  /** Best first. */
  probes: Probe[]
  running: boolean
}

/**
 * The relay scout, loaded on demand. Imported here the way the engine imports
 * it, so it stays a lazy chunk of its own rather than one the precache must
 * carry because two chunks share it.
 */
const scout = () => import('../../core/transport/relayScout')

/**
 * The relay list, as the pool sees it (ADR-067): which relays are in use,
 * which stand by, which are down or refuse the inbox, and what each measures.
 * Finding new relays — testing them from this device — lives here too, with
 * the relay scout behind it, so none of it is downloaded until this opens.
 */
export function RelaySettings() {
  const { t, locale } = useI18n()
  const text = useRelayText()
  const about = useAboutText()
  const entries = useApp((s) => s.relayEntries)
  const statuses = useApp((s) => s.relayStatuses)
  const autoRelays = useApp((s) => s.settings.autoRelays)
  const saveSettings = useApp((s) => s.saveSettings)
  const refreshRelays = useApp((s) => s.refreshRelays)
  const toast = useApp((s) => s.toast)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [repairLog, setRepairLog] = useState<Repair[]>([])
  const [monitors, setMonitors] = useState(false)
  const [scan, setScan] = useState<Scan | null>(null)

  useEffect(() => {
    void scout()
      .then(({ repairs }) => repairs(getRepo()))
      .then(setRepairLog)
  }, [entries])

  const statusByUrl = useMemo(() => new Map(statuses.map((status) => [status.url, status])), [statuses])
  const rows = useMemo(
    () =>
      entries
        .map((entry) => ({ entry, status: statusByUrl.get(entry.url) }))
        .map((row) => ({ ...row, standing: standingOf(row.entry, row.status) }))
        .sort((a, b) => ORDER.indexOf(a.standing) - ORDER.indexOf(b.standing)),
    [entries, statusByUrl],
  )
  const enabled = entries.filter((entry) => entry.enabled)
  const inUse = rows.filter((row) => row.status?.active && row.entry.read).length
  const readers = enabled.filter((entry) => entry.read).length

  const addRelay = async (raw: string, probe?: Probe) => {
    const url = normalizeRelayUrl(raw)
    if (!url) {
      setError(text('invalid'))
      return
    }
    if (entries.some((entry) => entry.url === url)) {
      setError(text('exists'))
      return
    }
    const { healthFromProbe } = await scout()
    await getRepo().upsertRelay(url, {
      read: true,
      write: true,
      enabled: true,
      ...(probe ? { health: healthFromProbe(probe) } : {}),
    })
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
    // Removed on purpose: never suggested, or added back by a repair.
    await (await scout()).declineRelay(getRepo(), entry.url)
    await refreshRelays()
  }

  const restoreDefaults = async () => {
    for (const url of DEFAULT_DM_RELAYS) {
      await getRepo().upsertRelay(url, { read: true, write: true, enabled: true })
    }
    await refreshRelays()
    toast(t('common.done'))
  }

  const dismissRepairs = async () => {
    await (await scout()).clearRepairs(getRepo())
    setRepairLog([])
  }

  const findRelays = async () => {
    const messenger = getMessenger()
    if (!messenger) return
    setScan({ candidates: [], probes: [], running: true })
    const { findCandidates, probeRelays, rankProbes } = await scout()
    const candidates = (await findCandidates(messenger.scoutHost, { monitors })).slice(0, 24)
    setScan({ candidates, probes: [], running: true })
    await probeRelays(
      messenger.scoutHost.pool,
      candidates.map((candidate) => candidate.url),
      {
        onProbe: (probe) =>
          setScan((was) => was && { ...was, probes: rankProbes([...was.probes, probe], Date.now()) }),
      },
    )
    setScan((was) => was && { ...was, running: false })
  }

  const measures = (status: RelayStatus | undefined): string[] => {
    if (!status) return []
    const { health } = status
    const lines: string[] = []
    if (health.connectMs > 0) lines.push(text('connects', { n: health.connectMs }))
    if (health.eoseMs > 0) lines.push(text('inbox', { n: health.eoseMs }))
    if (health.latencyMs > 0) lines.push(text('acks', { n: health.latencyMs }))
    if (health.publishOk + health.publishFail > 0) {
      lines.push(text('stats', { ok: health.publishOk, fail: health.publishFail }))
    }
    if (health.drops > 0) lines.push(text('drops', { n: health.drops }))
    return lines
  }

  return (
    <SettingsPage title={t('settings.relays')}>
      <p className="muted">{text('body')}</p>

      {enabled.some((entry) => entry.write) ? null : <Banner tone="danger">{text('none')}</Banner>}

      {repairLog.length > 0 ? (
        <Banner tone="info">
          <span className="stack-sm">
            {repairLog.slice(0, 3).map((repair) => (
              <span key={repair.at} style={{ display: 'block' }}>
                {repair.off.length > 0
                  ? text('repairedOff', { names: repair.off.map(relayLabel).join(', ') })
                  : null}{' '}
                {repair.added.length > 0
                  ? text('repairedAdded', { names: repair.added.map(relayLabel).join(', ') })
                  : null}
              </span>
            ))}
            <button className="btn btn-ghost small" onClick={() => void dismissRepairs()}>
              {text('dismiss')}
            </button>
          </span>
        </Banner>
      ) : null}

      {readers > inUse && inUse > 0 ? (
        <p className="hint">{text('summary', { n: inUse, total: readers })}</p>
      ) : null}

      <div className="card-section">
        {rows.map(({ entry, status, standing }) => (
          <div key={entry.id} className="stack-sm" style={{ padding: 'var(--space-3) var(--space-4)' }}>
            <div className="row-between">
              <span className="grow truncate" style={{ fontWeight: 550 }}>
                {relayLabel(entry.url)}
              </span>
              <span className={BADGE[standing]}>{text(standing)}</span>
              <button className="btn btn-icon" aria-label={text('remove')} onClick={() => void remove(entry)}>
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
                {text('read')}
              </label>
              <label className="row" style={{ gap: '0.35rem' }}>
                <input
                  className="checkbox checkbox-sm"
                  type="checkbox"
                  checked={entry.write}
                  onChange={(event) => void update(entry, { write: event.target.checked })}
                />
                {text('write')}
              </label>
              {measures(status).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>

            {/*
              A relay that refuses our subscription is the failure mode most
              likely to go unnoticed: it connects, accepts publishes, and
              simply never delivers. Say so in words, not just an error code.
            */}
            {standing === 'refuses' || standing === 'down' || standing === 'off' ? (
              <span className="small" style={{ color: standing === 'off' ? undefined : 'var(--warning)' }}>
                {text(`${standing}Detail` as RelayTextKey)}
              </span>
            ) : null}
            {standing === 'off' ? (
              <button
                className="btn btn-outline small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void update(entry, { enabled: true })}
              >
                {text('turnOn')}
              </button>
            ) : null}

            {status?.health.lastError && standing !== 'inUse' && standing !== 'standby' ? (
              <span className="faint truncate" title={status.health.lastError} lang="en" dir="ltr">
                {status.health.lastError}
              </span>
            ) : null}

            <code className="mono faint" style={{ wordBreak: 'break-all' }} lang="en" dir="ltr">
              {entry.url}
            </code>
          </div>
        ))}
      </div>

      <div className="card">
        <Toggle
          checked={autoRelays}
          onChange={(next) => void saveSettings({ autoRelays: next })}
          label={text('autoTitle')}
          description={text('autoBody')}
        />
      </div>

      <div className="card stack-sm">
        <span className="section-title">{text('findTitle')}</span>
        <p className="hint">{text('findBody')}</p>
        <Toggle
          checked={monitors}
          onChange={setMonitors}
          label={text('monitors')}
          description={text('monitorsBody')}
          disabled={scan?.running}
        />
        <button
          className="btn btn-outline btn-block"
          disabled={scan?.running}
          onClick={() => void findRelays()}
        >
          <RefreshIcon size={16} />
          {scan?.running && scan.candidates.length > 0
            ? text('testing', { n: scan.probes.length, total: scan.candidates.length })
            : text('test')}
        </button>
        {scan && !scan.running && scan.candidates.length === 0 ? (
          <p className="hint">{text('nothing')}</p>
        ) : null}
        {scan
          ? scan.probes.map((probe) => (
              <ProbeRow
                key={probe.url}
                probe={probe}
                candidate={scan.candidates.find((candidate) => candidate.url === probe.url)}
                added={entries.some((entry) => entry.url === probe.url)}
                onAdd={() => void addRelay(probe.url, probe)}
              />
            ))
          : null}
      </div>

      <div className="card stack-sm">
        <Field label={text('add')} error={error ?? undefined}>
          <div className="row">
            <input
              className="input grow"
              dir="ltr"
              lang="en"
              placeholder={text('placeholder')}
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

      <button className="btn btn-outline btn-block" onClick={() => void restoreDefaults()}>
        <RefreshIcon size={16} />
        {text('restore')}
      </button>

      <p className="hint" lang={locale}>
        {about('relaysSee')}
      </p>
    </SettingsPage>
  )
}

function ProbeRow({
  probe,
  candidate,
  added,
  onAdd,
}: {
  probe: Probe
  candidate: Candidate | undefined
  added: boolean
  onAdd: () => void
}) {
  const text = useRelayText()
  const source =
    candidate?.source === 'contacts'
      ? text('fromContacts', { n: candidate.count })
      : candidate?.source === 'monitors'
        ? text('fromMonitors', { n: candidate.count })
        : text('fromTextor')
  const measured = [
    probe.connectMs !== undefined ? text('connects', { n: probe.connectMs }) : null,
    probe.eoseMs !== undefined ? text('inbox', { n: probe.eoseMs }) : null,
    probe.okMs !== undefined ? text('acks', { n: probe.okMs }) : null,
  ].filter((line) => line !== null)
  return (
    <div className="stack-sm" style={{ paddingBlock: 'var(--space-2)' }}>
      <div className="row-between">
        <span className="grow truncate" style={{ fontWeight: 550 }}>
          {relayLabel(probe.url)}
        </span>
        {probe.ok ? (
          <button className="btn btn-outline small" disabled={added} onClick={onAdd}>
            <PlusIcon size={13} />
            {text('addThis')}
          </button>
        ) : null}
      </div>
      <span className="row faint small" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <span>{source}</span>
        {probe.ok ? measured.map((line) => <span key={line}>{line}</span>) : null}
      </span>
      {probe.ok ? null : (
        <span className="small" style={{ color: 'var(--warning)' }}>
          {text('failed', { reason: probe.reason ?? '' })}
        </span>
      )}
    </div>
  )
}
