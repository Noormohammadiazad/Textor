import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger, type SyncState } from '@/core/engine/messenger'
// Loaded ahead: the engine imports this as it starts, which the first time takes longer than these tests wait.
import '@/core/engine/deviceSync'
import { DEFAULT_SETTINGS, emptyHealth, type AppSettings, type RelayHealth } from '@/core/models/types'
import type { RelayStatus } from '@/core/transport/relayPool'
import { KIND_DM_RELAY_LIST } from '@/core/transport/nostrTransport'
import { bytesToHex } from '@/core/util/bytes'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * The engine looking after its relays (ADR-067): saying where the inbox is
 * read when that changes, and replacing a relay that died — through the lazy
 * relay scout, which it loads only then.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const MINUTE = 60_000
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** A pool whose relays in use, and whose health, the test decides. */
class TendedPool extends FakeRelayPool {
  inbox = ['wss://fake.relay']
  dead = false

  override rankedReadRelays(): string[] {
    return [...this.inbox]
  }

  override statuses(): RelayStatus[] {
    const health: RelayHealth = { ...emptyHealth(), connectStreak: 3, connectFail: 9 }
    return super.statuses().map((status) => (this.dead ? { ...status, health } : status))
  }
}

describe('looking after the relays', () => {
  let network: FakeRelayNetwork
  let pool: TendedPool
  let vault: TestVault
  let messenger: Messenger
  const announcements = () => network.query({ kinds: [KIND_DM_RELAY_LIST] })

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    pool = new TendedPool(network)
    vault = await makeVault('tending')
    const { identity } = createIdentity()
    const secretKeyHex = bytesToHex(identity.secretKey)
    await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
    await vault.repo.putIdentity({
      pubkey: identity.publicKey,
      npub: identity.npub,
      secretKeyHex,
      name: 'Tender',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
    })
    messenger = new Messenger(vault.vault, vault.repo, settings, pool)
    await messenger.start(secretKeyHex, identity.publicKey)
    await advance(100)
  })

  afterEach(async () => {
    messenger.stop()
    await vault.destroy()
    vi.useRealTimers()
  })

  it('announces where the inbox is read when that changes, at most every ten minutes', async () => {
    expect(announcements()).toHaveLength(1)
    pool.inbox = ['wss://elsewhere.relay']
    await advance(2 * MINUTE)
    expect(announcements()).toHaveLength(1)
    await advance(9 * MINUTE)
    expect(announcements()).toHaveLength(2)
    const latest = announcements().sort((a, b) => b.created_at - a.created_at)[0]!
    // One this device has merely stopped using stays: another may read it (ADR-073).
    expect(latest.tags).toEqual([
      ['relay', 'wss://elsewhere.relay'],
      ['relay', 'wss://fake.relay'],
    ])
    // Unchanged since: nothing more to say.
    await advance(11 * MINUTE)
    expect(announcements()).toHaveLength(2)
  })

  it('replaces a relay that died, at most every half hour, and only when allowed to', async () => {
    const repair = vi
      .spyOn(messenger, 'repairRelays')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(null)
    await advance(2 * MINUTE)
    expect(repair).not.toHaveBeenCalled()

    pool.dead = true
    await advance(2 * MINUTE)
    expect(repair).toHaveBeenCalledTimes(1)
    await advance(10 * MINUTE)
    expect(repair).toHaveBeenCalledTimes(1)
    await advance(25 * MINUTE)
    expect(repair).toHaveBeenCalledTimes(2)

    await messenger.applySettings({ ...settings, autoRelays: false })
    await advance(40 * MINUTE)
    expect(repair).toHaveBeenCalledTimes(2)
  })

  it('loads the relay scout to repair, which finds nothing to do while every relay works', async () => {
    expect(await messenger.repairRelays()).toBeNull()
  })

  it('puts a repaired list into effect: the pool, the announcement, and the settings screen', async () => {
    let changed = 0
    messenger.events.on('relaysChanged', () => (changed += 1))
    pool.inbox = ['wss://elsewhere.relay']
    const host = messenger.scoutHost
    expect(host.repo).toBe(vault.repo)
    expect(host.pool).toBe(pool)
    await host.apply()
    await advance(100)
    expect(changed).toBe(1)
    expect(announcements()).toHaveLength(2)
  })

  it('counts the relays the inbox is read from, not every one configured', async () => {
    const states: SyncState[] = []
    messenger.events.on('syncState', (state) => states.push(state))
    pool.inbox = ['wss://a.relay', 'wss://b.relay']
    messenger.refreshSyncState()
    await advance(100)
    expect(states.at(-1)?.totalRelays).toBe(2)
  })
})
