// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import { RelayPool } from '@/core/transport/relayPool'
import { TextorDatabase, setDbForTesting } from '@/core/vault/db'
import { Vault } from '@/core/vault/vault'
import { VaultRepo } from '@/core/vault/repo'
import { bytesToHex } from '@/core/util/bytes'
import { FakeSocketNetwork, type FakeWebSocket } from './fakeWebSocket'
import { TEST_KDF } from './helpers'
// Type-only: the module itself is imported at run time, once its database has
// been installed.
import type * as StoreModule from '@/app/store'

/**
 * The reported defect, reproduced through the pieces it actually involved: the
 * real store, the real engine, and real sockets.
 *
 * The engine tests cover the counting rules. This covers the flow a person
 * performs — read a conversation as a message lands, go back to the list — and
 * the store wiring that has to be in the right order for those rules to apply
 * at all.
 */

const RELAY = 'wss://relay.test'
const PASSPHRASE = 'store test vault'

const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms)

let network: FakeSocketNetwork
let store: typeof StoreModule
let aliceDb: TextorDatabase
let bobDb: TextorDatabase
let bob: { pubkey: string; messenger: Messenger; vault: Vault }
let alicePubkey: string

/** A peer to send from, over the same fake relay the store's engine reads. */
async function makeBob(): Promise<typeof bob> {
  const { identity } = createIdentity()
  bobDb = new TextorDatabase(`unread-bob-${Math.random().toString(36).slice(2)}`)
  const vault = new Vault(bobDb)
  await vault.create('bob passphrase', { params: TEST_KDF })
  vault.configureAutoLock(0)
  const repo = new VaultRepo(vault)
  await repo.putIdentity({
    pubkey: identity.publicKey,
    npub: identity.npub,
    secretKeyHex: bytesToHex(identity.secretKey),
    name: 'Bob',
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })
  await repo.upsertRelay(RELAY, { read: true, write: true })
  const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
  const messenger = new Messenger(
    vault,
    repo,
    settings,
    new RelayPool({ socket: { isOffline: () => false } }),
  )
  await messenger.start(bytesToHex(identity.secretKey), identity.publicKey)
  return { pubkey: identity.publicKey, messenger, vault }
}

/** Bob's conversation row in Alice's vault, read straight from the database. */
async function storedUnread(): Promise<number | undefined> {
  const state = store.useApp.getState()
  const conversation = state.conversations.find((c) => c.peerPubkey === bob.pubkey)
  return conversation?.unread
}

describe('the unread badge through the store', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeSocketNetwork()
    network.relay(RELAY)
    // Both sides' pools reach the fake relay through the global the browser
    // would provide.
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          return network.factory(url) as unknown as FakeWebSocket
        }
      },
    )

    // The store captures the database at import, so it is installed first.
    aliceDb = new TextorDatabase(`unread-alice-${Math.random().toString(36).slice(2)}`)
    setDbForTesting(aliceDb)

    const { identity } = createIdentity()
    alicePubkey = identity.publicKey
    const vault = new Vault(aliceDb)
    await vault.create(PASSPHRASE, { params: TEST_KDF })
    const repo = new VaultRepo(vault)
    await repo.putIdentity({
      pubkey: identity.publicKey,
      npub: identity.npub,
      secretKeyHex: bytesToHex(identity.secretKey),
      name: 'Alice',
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
    })
    await repo.upsertRelay(RELAY, { read: true, write: true })

    bob = await makeBob()
    await repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    // Written; the store opens the same database through its own vault.
    vault.lock('manual')

    store = await import('@/app/store')
    await store.useApp.getState().unlock({ type: 'passphrase', passphrase: PASSPHRASE })
    await settle(500)
    expect(store.useApp.getState().phase).toBe('ready')
  }, 30_000)

  afterAll(async () => {
    store?.useApp.getState().lock()
    bob?.messenger.stop()
    bob?.vault.lock('manual')
    await aliceDb?.delete()
    await bobDb?.delete()
    setDbForTesting(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('leaves no badge when a message arrives in the conversation being read', async () => {
    const app = store.useApp.getState()
    await app.openConversation(bob.pubkey)

    await bob.messenger.sendMessage(alicePubkey, 'arrives while you are reading it')
    await settle(3000)

    expect(store.useApp.getState().messages.map((m) => m.body)).toContain('arrives while you are reading it')
    expect(await storedUnread()).toBe(0)

    // Navigating back to the list is where the badge used to appear.
    store.useApp.getState().closeConversation()
    await settle(200)
    expect(store.useApp.getState().activeChat).toBeNull()
    expect(await storedUnread()).toBe(0)
  })

  it('counts a message that arrives while the list is on screen', async () => {
    await bob.messenger.sendMessage(alicePubkey, 'nobody is reading this one')
    await settle(3000)
    expect(await storedUnread()).toBe(1)
  })

  it('clears the badge when that conversation is opened, and it stays clear', async () => {
    await store.useApp.getState().openConversation(bob.pubkey)
    await settle(500)
    expect(await storedUnread()).toBe(0)

    await bob.messenger.sendMessage(alicePubkey, 'and another while it is open')
    await settle(3000)
    expect(await storedUnread()).toBe(0)

    store.useApp.getState().closeConversation()
    await settle(500)
    expect(await storedUnread()).toBe(0)
  })

  it('counts messages that arrive while the window is in the background', async () => {
    await store.useApp.getState().openConversation(bob.pubkey)
    await settle(300)

    // The tab goes to the background with the conversation still open.
    store.useApp.getState().setWindowFocus(false)
    await bob.messenger.sendMessage(alicePubkey, 'while you were away')
    await settle(3000)
    expect(await storedUnread()).toBe(1)

    // Coming back is what marks it read.
    store.useApp.getState().setWindowFocus(true)
    await settle(500)
    expect(await storedUnread()).toBe(0)

    store.useApp.getState().closeConversation()
    await settle(300)
    expect(await storedUnread()).toBe(0)
  })

  it('survives opening and closing the conversation faster than the database answers', async () => {
    // Fast navigation: in and straight back out, with a message landing in the
    // middle of it.
    const opening = store.useApp.getState().openConversation(bob.pubkey)
    void bob.messenger.sendMessage(alicePubkey, 'during the navigation')
    store.useApp.getState().closeConversation()
    await opening
    await settle(3000)

    const state = store.useApp.getState()
    if (state.activeChat === null) expect(state.messages).toHaveLength(0)

    // Whatever the race produced, what is on screen is what the database says:
    // a further refresh changes nothing.
    const shown = await storedUnread()
    await store.useApp.getState().refreshConversations()
    expect(await storedUnread()).toBe(shown)

    // And the conversation really is closed: the engine must not have been
    // left watching it by the open that finished after the close.
    await bob.messenger.sendMessage(alicePubkey, 'after the navigation')
    await settle(3000)
    expect(await storedUnread()).toBeGreaterThan(0)
  })

  it('does not count a message that lands while the conversation is still opening', async () => {
    await store.useApp.getState().openConversation(bob.pubkey)
    await settle(300)
    store.useApp.getState().closeConversation()
    await settle(300)
    expect(await storedUnread()).toBe(0)

    // Loading the history is asynchronous, and a message can arrive during it.
    // The conversation is on screen from the moment it is opened, not from the
    // moment its history finishes loading.
    const read = VaultRepo.prototype.listMessages
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(VaultRepo.prototype, 'listMessages').mockImplementationOnce(async function (
      this: VaultRepo,
      convoId: string,
      limit?: number,
    ) {
      await gate
      return read.call(this, convoId, limit)
    })

    const bump = vi.spyOn(VaultRepo.prototype, 'bumpConversation')
    const opening = store.useApp.getState().openConversation(bob.pubkey)
    await bob.messenger.sendMessage(alicePubkey, 'arrives mid-load')
    await settle(2000)

    release()
    await opening
    await settle(500)
    expect(spy).toHaveBeenCalled()
    expect(await storedUnread()).toBe(0)
    // Counted and then cleared would end at zero too, but would put a badge on
    // screen in between. It is never counted at all.
    expect(bump.mock.calls.some(([, , increment]) => increment === true)).toBe(false)
    bump.mockRestore()
    spy.mockRestore()
    store.useApp.getState().closeConversation()
    await settle(300)
  })

  it('discards a slow refresh that would put a cleared badge back on screen', async () => {
    // From a cleared badge, so the count below is this test's own.
    await store.useApp.getState().openConversation(bob.pubkey)
    await settle(300)
    store.useApp.getState().closeConversation()
    await settle(300)
    expect(await storedUnread()).toBe(0)

    await bob.messenger.sendMessage(alicePubkey, 'unread for now')
    await settle(3000)
    expect(await storedUnread()).toBe(1)

    // A refresh that reads the database while the badge is still there, but
    // does not finish until after it has been cleared.
    const read = VaultRepo.prototype.listConversations
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(VaultRepo.prototype, 'listConversations').mockImplementationOnce(async function (
      this: VaultRepo,
    ) {
      const rows = await read.call(this)
      await gate
      return rows
    })
    const slow = store.useApp.getState().refreshConversations()

    // Meanwhile the conversation is opened and read.
    await store.useApp.getState().openConversation(bob.pubkey)
    await settle(300)
    expect(await storedUnread()).toBe(0)

    release()
    await slow
    // The stale snapshot is dropped rather than restoring a badge for the
    // conversation that is open.
    expect(await storedUnread()).toBe(0)
    spy.mockRestore()
    store.useApp.getState().closeConversation()
    await settle(300)
  })
  it('clears the badge on opening even if the window never reported focus', async () => {
    // A browser that reports a blur and no matching focus — or none at all —
    // must not be able to strand a badge on the conversation being read.
    store.useApp.getState().setWindowFocus(false)
    await bob.messenger.sendMessage(alicePubkey, 'unread while blurred')
    await settle(3000)
    expect(await storedUnread()).toBe(1)

    // Opened while the window is still believed to be blurred, with the
    // history slow to load and a message landing during it.
    const read = VaultRepo.prototype.listMessages
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slowLoad = vi.spyOn(VaultRepo.prototype, 'listMessages').mockImplementationOnce(async function (
      this: VaultRepo,
      convoId: string,
      limit?: number,
    ) {
      await gate
      return read.call(this, convoId, limit)
    })
    const bump = vi.spyOn(VaultRepo.prototype, 'bumpConversation')

    const opening = store.useApp.getState().openConversation(bob.pubkey)
    await bob.messenger.sendMessage(alicePubkey, 'during a blurred open')
    await settle(2000)
    release()
    await opening
    await settle(500)

    expect(await storedUnread()).toBe(0)
    // The one that arrived while it was opening was never counted either.
    expect(bump.mock.calls.some(([, , increment]) => increment === true)).toBe(false)
    bump.mockRestore()
    slowLoad.mockRestore()

    store.useApp.getState().closeConversation()
    store.useApp.getState().setWindowFocus(true)
    await settle(300)
  })
})
