import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../app/store'
import { useNavigate } from '../../app/router'
import { useT, type TranslateFn } from '../../i18n'
import { connectionStatus, connectionTone, type ConnectionStatus } from '../../core/engine/connectionStatus'

/**
 * How long a problem must persist before the app mentions it.
 *
 * Relay sockets flap. Reporting every blip would put a banner on screen several
 * times a minute and train people to ignore it, which is worse than saying
 * nothing. Losing the network is exempt: that is not a blip, and someone
 * halfway through typing needs to know immediately.
 */
const SETTLE_MS = 700

/**
 * How long "Connected" stays up after a problem clears.
 *
 * Without it the bar just vanishes, and the user is left unsure whether it
 * recovered or they imagined it. With it, every episode gets an ending.
 */
const CONFIRM_MS = 1800

export function useConnection(): ConnectionStatus {
  const sync = useApp((s) => s.syncState)
  const relays = useApp((s) => s.relayStatuses)
  return useMemo(() => connectionStatus(sync, relays), [sync, relays])
}

/**
 * Whether the status bar should currently be on screen.
 *
 * The bar is deliberately absent when everything is fine — an indicator that is
 * always visible is decoration, not information. Three phases, and every state
 * change is made from a timer callback rather than synchronously inside the
 * effect, so a transient blip costs no render at all:
 *
 *   idle     nothing shown; a problem must survive SETTLE_MS to get out of here
 *   showing  a problem is on screen, or has just cleared and is being confirmed
 *   (back to idle once the confirmation has had its moment)
 */
function useConnectionEpisode(status: ConnectionStatus): boolean {
  const [phase, setPhase] = useState<'idle' | 'showing'>('idle')

  useEffect(() => {
    if (phase === 'idle' && !status.settled) {
      // Losing the network is not a blip, so it skips the settling delay. The
      // bar is already on screen for this frame via the check below; this only
      // arms the episode so recovery gets its confirmation.
      const delay = status.kind === 'offline' ? 0 : SETTLE_MS
      const timer = setTimeout(() => setPhase('showing'), delay)
      return () => clearTimeout(timer)
    }
    if (phase === 'showing' && status.settled) {
      const timer = setTimeout(() => setPhase('idle'), CONFIRM_MS)
      return () => clearTimeout(timer)
    }
    return
  }, [phase, status.settled, status.kind])

  return status.kind === 'offline' || phase !== 'idle'
}

function detailFor(status: ConnectionStatus, t: TranslateFn): string {
  switch (status.kind) {
    case 'offline':
      return t('connection.offlineDetail')
    case 'connecting':
      return t('connection.connectingDetail')
    case 'degraded':
      return t('connection.degradedDetail')
    case 'sending':
      return t('connection.sendingDetail', { n: status.pending })
    case 'syncing':
      return t('connection.syncingDetail')
    case 'connected':
      return t('connection.connected')
  }
}

function shortFor(status: ConnectionStatus, t: TranslateFn): string {
  switch (status.kind) {
    case 'offline':
      return t('connection.offline')
    case 'connecting':
      return t('connection.connecting')
    case 'degraded':
      return t('connection.degraded')
    case 'sending':
      return t('connection.sending', { n: status.pending })
    case 'syncing':
      return t('connection.syncing')
    case 'connected':
      return t('connection.relays', { n: status.connected, total: status.total })
  }
}

/**
 * A thin strip below the app chrome, shown only while there is something to
 * report and on every screen — including an open conversation, where knowing
 * you are offline matters most.
 *
 * Modelled on the way a good messenger handles this: no permanent widget, no
 * modal, just a line that appears, says what is happening, and leaves.
 */
export function ConnectionBar() {
  const t = useT()
  const navigate = useNavigate()
  const status = useConnection()
  const visible = useConnectionEpisode(status)

  if (!visible) return null

  return (
    <div className="connection-bar" data-tone={connectionTone(status.kind)} data-busy={status.busy}>
      <button
        type="button"
        className="connection-bar-body"
        onClick={() => navigate({ name: 'settings-relays' })}
        aria-label={t('connection.openRelays')}
      >
        <span className="connection-dot" aria-hidden="true" />
        {/* Announced on change rather than on every re-render, so a screen
            reader hears "Connecting", then "Connected" — not a stream. */}
        <span role="status" aria-live="polite">
          {detailFor(status, t)}
        </span>
      </button>
      {status.busy ? <span className="connection-progress" aria-hidden="true" /> : null}
    </div>
  )
}

/**
 * The always-present form, in the conversation-list header.
 *
 * Where the bar answers "is something wrong right now?", this answers "how well
 * am I connected?" — the question specific to a messenger with no server, where
 * relay count is the only honest measure of reach.
 */
export function ConnectionBadge() {
  const t = useT()
  const navigate = useNavigate()
  const status = useConnection()
  const tone = connectionTone(status.kind)

  return (
    <button
      type="button"
      className="connection-badge"
      data-tone={tone}
      data-busy={status.busy}
      onClick={() => navigate({ name: 'settings-relays' })}
      title={detailFor(status, t)}
    >
      <span className="connection-dot" aria-hidden="true" />
      <span className="truncate">{shortFor(status, t)}</span>
    </button>
  )
}
