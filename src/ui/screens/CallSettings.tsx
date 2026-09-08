import { useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useCallSettingsText, type CallSettingsTextFn, type CallSettingsTextKey } from './callSettingsText'
import { Banner, Field, Toggle } from '../components/primitives'
import { GlobeIcon, PlusIcon, RefreshIcon, TrashIcon } from '../components/Icons'
import { SettingsPage } from './SettingsPage'
import { hasTurnServer } from '../../core/models/call'
import { alreadyListed, parseIceServer, serverUrls } from '../../core/calls/iceServers'
import { probeIce, type IceProbeResult, type IceVerdict } from '../../core/calls/iceProbe'
import { DEFAULT_ICE_SERVERS } from '../../core/transport/defaultRelays'
import { supportsWebRtc } from '../../core/transport/webrtc/directManager'

const VERDICT: Record<IceVerdict, CallSettingsTextKey> = {
  good: 'iceVerdictGood',
  stun: 'iceVerdictStun',
  symmetric: 'iceVerdictSymmetric',
  none: 'iceVerdictNone',
  'turn-failed': 'iceVerdictTurnFailed',
}

/**
 * Calls: the servers a call may use, and whether it must be relayed.
 *
 * Textor runs no TURN server (ADR-008), so the one a user adds here is the
 * only thing that gets a call through symmetric NAT or a strict firewall —
 * and the only thing that can keep their IP address from the person they
 * call. Both are said plainly, and the test shows which of them this network
 * actually needs.
 */
export function CallSettings() {
  const { t } = useI18n()
  const st = useCallSettingsText()
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)

  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<'idle' | 'running' | IceProbeResult>('idle')

  const servers = settings.iceServers
  const turnConfigured = hasTurnServer(servers)
  const canCall = supportsWebRtc()

  const add = async () => {
    const parsed = parseIceServer({ url, username, credential })
    if ('error' in parsed) {
      setError(st(parsed.error === 'credentials' ? 'iceNeedsCredentials' : 'iceInvalid'))
      return
    }
    if (alreadyListed(servers, parsed.server)) {
      setError(st('iceExists'))
      return
    }
    await saveSettings({ iceServers: [...servers, parsed.server] })
    setUrl('')
    setUsername('')
    setCredential('')
    setError(null)
    setProbe('idle')
  }

  const remove = async (index: number) => {
    const next = servers.filter((_, i) => i !== index)
    // "Always relay" with nothing to relay through would fail every call; it
    // goes off with the last TURN server rather than lingering as a trap.
    await saveSettings({
      iceServers: next,
      ...(hasTurnServer(next) ? {} : { callRelayOnly: false }),
    })
    setProbe('idle')
  }

  const test = async () => {
    setProbe('running')
    try {
      setProbe(await probeIce([...DEFAULT_ICE_SERVERS, ...servers]))
    } catch {
      setProbe({ verdict: 'none', stun: false, turn: turnConfigured ? false : null, symmetric: false })
    }
  }

  return (
    <SettingsPage title={t('settings.calls')}>
      <p className="muted">{st('callsBody')}</p>
      {!canCall ? <Banner tone="warning">{st('iceUnsupported')}</Banner> : null}

      <div className="card-section">
        <Toggle
          label={st('relayCalls')}
          description={turnConfigured ? st('relayCallsBody') : st('relayCallsNeedsTurn')}
          checked={settings.callRelayOnly && turnConfigured}
          disabled={!turnConfigured}
          onChange={(callRelayOnly) => void saveSettings({ callRelayOnly })}
        />
      </div>

      <span className="section-title">{st('iceServers')}</span>
      <p className="hint">{st('iceServersBody')}</p>

      <div className="card-section">
        <div className="list-row" style={{ cursor: 'default' }}>
          <GlobeIcon size={16} style={{ color: 'var(--text-muted)' }} />
          <span className="grow small muted">{st('iceBuiltIn')}</span>
        </div>
        {servers.length === 0 ? (
          <div className="list-row" style={{ cursor: 'default' }}>
            <span className="grow small faint">{st('iceNone')}</span>
          </div>
        ) : (
          servers.map((server, index) => (
            <div key={serverUrls(server).join(' ')} className="list-row" style={{ cursor: 'default' }}>
              <span className="grow stack-sm" style={{ minWidth: 0 }}>
                <code className="mono small truncate" dir="ltr" lang="en">
                  {serverUrls(server).join(' ')}
                </code>
                {server.username ? (
                  <span className="faint small truncate" dir="ltr" lang="en">
                    {server.username}
                  </span>
                ) : null}
              </span>
              <button
                className="btn btn-icon"
                aria-label={st('iceRemove')}
                title={st('iceRemove')}
                onClick={() => void remove(index)}
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ))
        )}
      </div>

      <form
        className="card stack-sm"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <Field label={st('iceUrl')} error={error ?? undefined}>
          <input
            className="input"
            dir="ltr"
            lang="en"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={st('iceUrlPlaceholder')}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setError(null)
            }}
          />
        </Field>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: '10rem' }}>
            <Field label={st('iceUsername')}>
              <input
                className="input"
                dir="ltr"
                lang="en"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
          </div>
          <div className="grow" style={{ minWidth: '10rem' }}>
            <Field label={st('icePassword')}>
              <input
                className="input"
                dir="ltr"
                lang="en"
                type="password"
                autoComplete="new-password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            </Field>
          </div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={!url.trim()}>
          <PlusIcon size={16} />
          {st('iceAdd')}
        </button>
      </form>

      <div className="card stack-sm">
        <button
          className="btn btn-outline"
          disabled={!canCall || probe === 'running'}
          onClick={() => void test()}
          aria-busy={probe === 'running'}
        >
          <RefreshIcon size={16} />
          {probe === 'running' ? st('iceTesting') : st('iceTest')}
        </button>
        {typeof probe === 'object' ? (
          <div className="stack-sm" aria-live="polite">
            <ProbeRow label={st('iceStun')} ok={probe.stun} st={st} />
            {probe.symmetric ? (
              <div className="row-between small">
                <span className="muted">{st('iceSymmetric')}</span>
              </div>
            ) : null}
            <ProbeRow label={st('iceTurn')} ok={probe.turn} st={st} />
            <Banner
              tone={probe.verdict === 'good' ? 'info' : probe.verdict === 'stun' ? 'accent' : 'warning'}
            >
              <span className="small">{st(VERDICT[probe.verdict])}</span>
            </Banner>
          </div>
        ) : null}
      </div>
    </SettingsPage>
  )
}

function ProbeRow({ label, ok, st }: { label: string; ok: boolean | null; st: CallSettingsTextFn }) {
  const badge = ok === null ? 'badge' : ok ? 'badge badge-success' : 'badge badge-danger'
  const text = st(ok === null ? 'iceNotSet' : ok ? 'iceWorking' : 'iceNotReachable')
  return (
    <div className="row-between small">
      <span>{label}</span>
      <span className={badge}>{text}</span>
    </div>
  )
}
