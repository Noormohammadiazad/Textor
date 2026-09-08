import { useEffect, useState } from 'react'
import { getRepo, useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { useCallSettingsText, type CallSettingsTextFn, type CallSettingsTextKey } from './callSettingsText'
import { Banner, Field, Toggle } from '../components/primitives'
import { GlobeIcon, PlusIcon, RefreshIcon, TrashIcon } from '../components/Icons'
import { SettingsPage } from './SettingsPage'
import { hasTurnServer } from '../../core/models/call'
import { alreadyListed, parseIceServer, serverUrls } from '../../core/calls/iceServers'
import { probeIce, type IceProbeResult, type IceVerdict } from '../../core/calls/iceProbe'
import type * as Turn from '../../core/calls/turn'
import { DEFAULT_ICE_SERVERS } from '../../core/transport/defaultRelays'
import { supportsWebRtc } from '../../core/transport/webrtc/rtc'

/** TURN ranking and credentials, shared with the call chunk and kept out of this one (ADR-068). */
const turnModule = () => import('../../core/calls/turn')

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
 * Calls need no setup, and Textor ships no relay (ADR-072). A TURN server here
 * is an optional, personal thing, for someone who already runs one: it can carry
 * a call two networks cannot, and keep an IP address from the person called.
 * All of that is said plainly, and the test shows what this network can do, and
 * how each TURN server is doing.
 */
export function CallSettings() {
  const { t } = useI18n()
  const st = useCallSettingsText()
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)

  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [credential, setCredential] = useState('')
  const [secret, setSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<'idle' | 'running' | IceProbeResult>('idle')
  const [health, setHealth] = useState<Turn.TurnHealthMap>({})
  const [turn, setTurn] = useState<typeof Turn | null>(null)

  const servers = settings.iceServers
  const turnConfigured = hasTurnServer(servers)
  const canCall = supportsWebRtc()
  // Without a TCP or TLS address, a network that blocks UDP blocks every relay.
  const udpOnly =
    turnConfigured &&
    !servers.some((server) => serverUrls(server).some((u) => /^turns:|\?transport=tcp$/i.test(u)))

  useEffect(() => {
    if (!turnConfigured) return
    void turnModule().then(async (loaded) => {
      setHealth(await loaded.loadTurnHealth(getRepo()))
      setTurn(loaded)
    })
  }, [turnConfigured])

  const add = async () => {
    const parsed = parseIceServer({ url, username, credential, secret })
    if ('error' in parsed) {
      setError(
        st(parsed.error === 'invalid' ? 'iceInvalid' : secret ? 'iceNeedsSecret' : 'iceNeedsCredentials'),
      )
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
    setSecret(false)
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

  /**
   * Gather candidates as a call would, and keep what each TURN server did —
   * the call manager ranks servers by it, so one found dead here is not
   * asked on the next call.
   */
  const test = async () => {
    setProbe('running')
    try {
      const loaded = await turnModule()
      const now = Date.now()
      const result = await probeIce([...DEFAULT_ICE_SERVERS, ...(await loaded.withCredentials(servers, now))])
      const map = await loaded.loadTurnHealth(getRepo())
      for (const outcome of loaded.outcomesFor(servers, result.relays, true))
        loaded.recordTurn(map, outcome, now)
      await getRepo().putState(loaded.TURN_HEALTH, map)
      setHealth({ ...map })
      setTurn(loaded)
      setProbe(result)
    } catch {
      setProbe({
        verdict: 'none',
        stun: false,
        turn: turnConfigured ? false : null,
        symmetric: false,
        ipv6: false,
        relays: [],
      })
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
      <p className="hint">{st('iceNoPublicTurn')}</p>

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
                {server.username || server.secret ? (
                  <span className="faint small truncate">
                    {server.secret ? (
                      <>
                        {st('iceSecretTag')}
                        {server.username ? ' · ' : null}
                      </>
                    ) : null}
                    {server.username ? (
                      <bdi dir="ltr" lang="en">
                        {server.username}
                      </bdi>
                    ) : null}
                  </span>
                ) : null}
                <TurnStatus health={turn ? health[turn.serverKey(server)] : undefined} turn={turn} st={st} />
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
        <Toggle
          label={st('iceSecret')}
          description={secret ? st('iceSecretBody') : undefined}
          checked={secret}
          onChange={(next) => {
            setSecret(next)
            setError(null)
          }}
        />
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: '10rem' }}>
            <Field label={st(secret ? 'iceSecretName' : 'iceUsername')}>
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
            <Field label={st(secret ? 'iceSecretLabel' : 'icePassword')}>
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

      {udpOnly ? <p className="hint">{st('turnUdpOnly')}</p> : null}

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
            <div className="row-between small">
              <span>{st('iceIpv6')}</span>
              <span className={probe.ipv6 ? 'badge badge-success' : 'badge'}>
                {st(probe.ipv6 ? 'iceIpv6Yes' : 'iceIpv6No')}
              </span>
            </div>
            {probe.ipv6 ? <p className="hint">{st('iceIpv6Body')}</p> : null}
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

const TURN_ERRORS: Record<number, CallSettingsTextKey> = {
  0: 'turnNoAnswer',
  401: 'turnAuth',
  486: 'turnFull',
  508: 'turnFull',
}

/** How a TURN server has been doing: its relay time and round trip, or why it last failed. */
function TurnStatus({
  health,
  turn,
  st,
}: {
  health: Turn.TurnHealth | undefined
  turn: typeof Turn | null
  st: CallSettingsTextFn
}) {
  // A call measures its relay's round trip before the relay itself is
  // counted, so a record can exist with nothing judged yet.
  if (!health || !turn || !(health.lastOkAt || health.lastFailAt)) return null
  if (health.lastOkAt >= health.lastFailAt) {
    const parts = [st('turnRelayIn', { ms: health.allocMs })]
    if (health.rttMs) parts.push(st('turnRoundTrip', { ms: health.rttMs }))
    if (turn.throttled(health)) parts.push(st('turnNarrow'))
    return (
      <span className="small" style={{ color: 'var(--success)' }}>
        {parts.join(' · ')}
      </span>
    )
  }
  const reason = TURN_ERRORS[health.error]
  const parts = [reason ? st(reason) : st('turnRefused', { code: health.error })]
  if (health.streak >= 2) parts.push(st('turnResting', { count: health.streak }))
  return (
    <span className="small" style={{ color: 'var(--danger)' }}>
      {parts.join(' · ')}
    </span>
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
