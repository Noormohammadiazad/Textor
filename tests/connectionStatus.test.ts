import { describe, expect, it } from 'vitest'
import { connectionStatus, connectionTone } from '@/core/engine/connectionStatus'
import type { SyncState } from '@/core/engine/messenger'
import type { RelayStatus } from '@/core/transport/relayPool'
import { emptyHealth } from '@/core/models/types'

const sync = (patch: Partial<SyncState> = {}): SyncState => ({
  online: true,
  connectedRelays: 3,
  totalRelays: 6,
  pendingOutbox: 0,
  lastSyncAt: 0,
  syncing: false,
  ...patch,
})

/** A relay the pool has used successfully — verdict 'healthy'. */
const healthy = (url: string): RelayStatus => ({
  url,
  state: 'online',
  health: { ...emptyHealth(), connectOk: 1, publishOk: 3 },
})

/** Connects and accepts publishes, but refuses to serve our inbox. */
const readRefusing = (url: string): RelayStatus => ({
  url,
  state: 'online',
  health: { ...emptyHealth(), connectOk: 1, publishOk: 3, readFail: 1 },
})

/** Connected a moment ago and not yet used for anything — verdict 'unused'. */
const fresh = (url: string): RelayStatus => ({ url, state: 'online', health: emptyHealth() })

describe('connection status', () => {
  it('reports offline whatever the relay counters say', () => {
    // The browser knowing there is no network outranks stale socket counts.
    const status = connectionStatus(sync({ online: false, syncing: true, pendingOutbox: 2 }), [
      healthy('wss://a'),
    ])
    expect(status.kind).toBe('offline')
    expect(status.busy).toBe(false)
    expect(status.settled).toBe(false)
  })

  it('reports connecting while no socket is open', () => {
    const status = connectionStatus(sync({ connectedRelays: 0 }), [])
    expect(status.kind).toBe('connecting')
    expect(status.busy).toBe(true)
  })

  it('reports degraded when sockets are open but nothing is trustworthy', () => {
    // Relays that accept everything you publish while refusing your inbox look
    // perfectly healthy from write stats alone. This is the case worth shouting
    // about, so it outranks sending and syncing.
    const status = connectionStatus(sync({ pendingOutbox: 4, syncing: true }), [
      readRefusing('wss://a'),
      readRefusing('wss://b'),
    ])
    expect(status.kind).toBe('degraded')
    expect(status.healthy).toBe(0)
  })

  it('does not call a freshly opened socket degraded', () => {
    // 'unused' is not 'unhealthy'. Without this, every cold start would flash a
    // warning in the moment between connecting and the first successful read.
    const status = connectionStatus(sync(), [fresh('wss://a'), fresh('wss://b')])
    expect(status.kind).toBe('connected')
  })

  it('prefers sending over syncing when messages are queued', () => {
    const status = connectionStatus(sync({ pendingOutbox: 2, syncing: true }), [healthy('wss://a')])
    expect(status.kind).toBe('sending')
    expect(status.pending).toBe(2)
  })

  it('reports syncing only when nothing is queued', () => {
    const status = connectionStatus(sync({ syncing: true }), [healthy('wss://a')])
    expect(status.kind).toBe('syncing')
  })

  it('settles once connected with nothing outstanding', () => {
    const status = connectionStatus(sync(), [healthy('wss://a')])
    expect(status.kind).toBe('connected')
    expect(status.settled).toBe(true)
    expect(status.busy).toBe(false)
  })

  it('survives one healthy relay among broken ones', () => {
    const status = connectionStatus(sync(), [readRefusing('wss://a'), healthy('wss://b')])
    expect(status.kind).toBe('connected')
    expect(status.healthy).toBe(1)
  })

  it('never reports fewer relays than are demonstrably connected', () => {
    // A stale status list must not produce "4 of 2 relays".
    const status = connectionStatus(sync({ connectedRelays: 4, totalRelays: 2 }), [healthy('wss://a')])
    expect(status.total).toBe(4)
    expect(status.connected).toBe(4)
  })

  it('maps each state to a tone', () => {
    expect(connectionTone('offline')).toBe('warning')
    expect(connectionTone('degraded')).toBe('warning')
    expect(connectionTone('connected')).toBe('success')
    expect(connectionTone('connecting')).toBe('neutral')
    expect(connectionTone('sending')).toBe('neutral')
    expect(connectionTone('syncing')).toBe('neutral')
  })
})
