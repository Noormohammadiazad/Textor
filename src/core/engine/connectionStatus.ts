import type { RelayStatus } from '../transport/relayPool'
import { verdictFor } from '../transport/relayHealth'
import type { SyncState } from './messenger'

/**
 * What the app tells the user about its connection.
 *
 * Ordered by urgency, not by how the values arrive: the first condition that
 * holds wins. A messenger with no server has no single "the service is up"
 * signal, so this collapses several independent facts — the browser's own
 * online flag, how many relay sockets are open, whether any of them is actually
 * trustworthy, and whether work is in flight — into one thing a person can act
 * on.
 */
export type ConnectionKind =
  /** The browser says there is no network. Nothing will go out. */
  | 'offline'
  /** Online, but not a single relay socket is open yet. */
  | 'connecting'
  /**
   * Sockets are open, but no relay is both readable and writable. Messages may
   * appear to send and never arrive — the failure this app is most likely to
   * hide, so it outranks any transient sync activity.
   */
  | 'degraded'
  /** Messages are queued and being pushed out. */
  | 'sending'
  /** Catching up on the inbox. */
  | 'syncing'
  /** Connected, nothing outstanding. */
  | 'connected'

export interface ConnectionStatus {
  kind: ConnectionKind
  /** Relay sockets currently open. */
  connected: number
  /** Relays configured for reading. */
  total: number
  /** Open sockets that are also known-good for both reads and publishes. */
  healthy: number
  /** Messages waiting in the outbox. */
  pending: number
  /** Work is in flight — drives the indeterminate progress line. */
  busy: boolean
  /** Nothing to report; the indicator can stay out of the way. */
  settled: boolean
}

export function connectionStatus(sync: SyncState, relays: readonly RelayStatus[]): ConnectionStatus {
  const connected = sync.connectedRelays
  // `totalRelays` is what the pool is configured to read from. Never report
  // fewer than are demonstrably connected, which a stale status list can imply.
  const total = Math.max(sync.totalRelays, connected)
  const healthy = relays.filter((relay) => verdictFor(relay) === 'healthy').length
  const pending = sync.pendingOutbox

  const kind = ((): ConnectionKind => {
    if (!sync.online) return 'offline'
    if (connected === 0) return 'connecting'
    // Only claim degradation once at least one relay has been used enough to
    // have a verdict; a freshly opened socket is 'unused', not unhealthy.
    if (healthy === 0 && relays.some((relay) => verdictFor(relay) !== 'unused')) return 'degraded'
    if (pending > 0) return 'sending'
    if (sync.syncing) return 'syncing'
    return 'connected'
  })()

  return {
    kind,
    connected,
    total,
    healthy,
    pending,
    busy: kind === 'connecting' || kind === 'sending' || kind === 'syncing',
    settled: kind === 'connected',
  }
}

/** Tone for the indicator, so the palette choice lives with the state machine. */
export function connectionTone(kind: ConnectionKind): 'neutral' | 'warning' | 'success' {
  switch (kind) {
    case 'offline':
    case 'degraded':
      return 'warning'
    case 'connected':
      return 'success'
    default:
      return 'neutral'
  }
}
