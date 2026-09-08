import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, PROFILE_UNSET, type AppSettings, type IdentityRecord } from '@/core/models/types'
import { KIND_CONTROL, PROTOCOL_VERSION, recipientTags } from '@/core/models/protocol'
import { bytesToHex, hexToBytes } from '@/core/util/bytes'
import { createRumor, giftWrap, RETRACTION_TTL_SEC, unwrapGift } from '@/core/crypto/giftwrap'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * What was deleted for everyone stays deleted when this identity is restored
 * from its twelve words onto a device with no history: real engines, on a fake
 * network that replays everything to a new subscriber at once, as a catch-up
 * does, and which may ignore deletion requests, as nothing obliges a relay not to.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }
const SECOND = 1000
const MINUTE = 60 * SECOND
const settle = (ms = 3 * SECOND) => vi.advanceTimersByTimeAsync(ms)
const RESTORED = { at: { name: PROFILE_UNSET, about: PROFILE_UNSET, avatar: PROFILE_UNSET } }

interface Device {
  pubkey: string
  secretKey: Uint8Array
  vault: TestVault
  messenger: Messenger
  pool: FakeRelayPool
}

describe('a cold restore', () => {
  let network: FakeRelayNetwork
  let laptop: Device
  let bob: Device
  const all: Device[] = []

  async function makeDevice(
    name: string,
    secretKeyHex = bytesToHex(createIdentity().identity.secretKey),
    prepare?: (vault: TestVault) => void,
    identity: Partial<IdentityRecord> = {},
  ) {
    const secretKey = hexToBytes(secretKeyHex)
    const vault = await makeVault(`${name}-pw`)
    prepare?.(vault)
    const pubkey = getPublicKey(secretKey)
    await vault.repo.putIdentity({
      pubkey,
      npub: '',
      secretKeyHex,
      name,
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: true,
      ...identity,
    })
    await vault.repo.upsertRelay('wss://fake.relay', { read: true, write: true })
    const pool = new FakeRelayPool(network)
    const messenger = new Messenger(vault.vault, vault.repo, settings, pool)
    await messenger.start(secretKeyHex, pubkey)
    const device: Device = { pubkey, secretKey, vault, messenger, pool }
    all.push(device)
    return device
  }
  /** The twelve words on a new device: nothing here yet, and it knows that. */
  const restore = () => makeDevice('Restored', bytesToHex(laptop.secretKey), undefined, RESTORED)
  const held = async (device: Device, peer: string) => {
    const id = device.vault.repo.conversationId(device.pubkey, peer)
    return (await device.vault.repo.listMessages(id, 100)).map((message) => message.body)
  }
  /** What a wrap held, for reordering a relay's replay. */
  const isRedact = (event: { kind: number; tags: string[][] }, device: Device) => {
    if (event.kind !== 1059 || !event.tags.some((t) => t[1] === device.pubkey)) return false
    try {
      return JSON.parse(unwrapGift(event as never, device.secretKey).content).t === 'redact'
    } catch {
      return false
    }
  }
  const redactFirst = (device: Device) =>
    network.events.sort((a, b) => Number(isRedact(b, device)) - Number(isRedact(a, device)))

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    laptop = await makeDevice('Laptop')
    bob = await makeDevice('Bob')
    await laptop.vault.repo.upsertContact(bob.pubkey, { accepted: true })
    await bob.vault.repo.upsertContact(laptop.pubkey, { accepted: true })
  })
  afterEach(async () => {
    for (const device of all.splice(0)) {
      device.messenger.stop()
      await device.vault.destroy()
    }
    vi.useRealTimers()
  })

  it('keeps out a message whose deletion is read while it is still being stored', async () => {
    // Relays give no order, and storing a message takes longer than a deletion
    // takes to find nothing there: its conversation and contact are written first.
    await bob.messenger.sendMessage(laptop.pubkey, 'theirs, then deleted by me')
    await settle()
    const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
    const [message] = await laptop.vault.repo.listMessages(id, 10)
    bob.messenger.stop()
    await laptop.messenger.redactMessage(bob.pubkey, message!.id)
    await settle()
    laptop.messenger.stop()
    // A relay without NIP-77 replays through the live subscription, which is not
    // awaited, as `primal` and `wellorder` do: everything is in flight at once.
    network.negentropy = false
    const restored = await makeDevice('Restored', bytesToHex(laptop.secretKey), (vault) => {
      const ensure = vault.repo.ensureConversation.bind(vault.repo)
      vi.spyOn(vault.repo, 'ensureConversation').mockImplementation(async (self, peer) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return ensure(self, peer)
      })
    })
    await settle(30 * SECOND)
    expect(await held(restored, bob.pubkey)).toEqual([])
  })

  it('keeps out a message whose deletion overtakes it on a device already running', async () => {
    // Parked just past its first check, with nothing yet to say it was deleted.
    // No hold here: this is what the order of the tombstone and the message is for.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    let parked = false
    const running = await makeDevice('Running', bytesToHex(laptop.secretKey), (vault) => {
      const ensure = vault.repo.ensureConversation.bind(vault.repo)
      vi.spyOn(vault.repo, 'ensureConversation').mockImplementation(async (self, peer) => {
        parked = true
        await gate
        return ensure(self, peer)
      })
    })
    await settle(30 * SECOND)
    expect(running.messenger.restoring).toBe(false)
    const told = vi.fn()
    running.messenger.events.on('message', told)

    const sent = await bob.messenger.sendMessage(laptop.pubkey, 'gone before it landed')
    await settle()
    expect(parked).toBe(true)
    await bob.messenger.redactMessage(laptop.pubkey, sent.id)
    await settle()
    expect(await running.vault.repo.isWithdrawn(sent.id, bob.pubkey)).toBe(true)
    expect(await held(running, bob.pubkey)).toEqual([])

    release()
    await settle()
    expect(await held(running, bob.pubkey)).toEqual([])
    expect(told).not.toHaveBeenCalled()
    const id = running.vault.repo.conversationId(running.pubkey, bob.pubkey)
    expect((await running.vault.repo.getConversation(id))?.unread).toBe(0)
  })

  it('keeps out a message stored just after its deletion looked and found nothing', async () => {
    // The other way round: the deletion has looked, and is parked before it can
    // act on that. Only a tombstone written before it looked can stop this copy.
    let releaseStore: () => void = () => undefined
    const storing = new Promise<void>((resolve) => (releaseStore = resolve))
    let releaseLook: () => void = () => undefined
    const looking = new Promise<void>((resolve) => (releaseLook = resolve))
    let target = ''
    const running = await makeDevice('Running', bytesToHex(laptop.secretKey), (vault) => {
      const ensure = vault.repo.ensureConversation.bind(vault.repo)
      vi.spyOn(vault.repo, 'ensureConversation').mockImplementation(async (self, peer) => {
        await storing
        return ensure(self, peer)
      })
      const get = vault.repo.getMessage.bind(vault.repo)
      vi.spyOn(vault.repo, 'getMessage').mockImplementation(async (id) => {
        const found = await get(id)
        if (id === target) {
          target = ''
          await looking
        }
        return found
      })
    })
    // Alone: another device would put the deletion in the record, which is a
    // second way out for this message, and not the one being looked at here.
    laptop.messenger.stop()
    await settle(2 * 60 * SECOND)
    const sent = await bob.messenger.sendMessage(laptop.pubkey, 'stored as the deletion looked away')
    await settle()
    target = sent.id
    await bob.messenger.redactMessage(laptop.pubkey, sent.id)
    await settle()
    expect(target).toBe('')

    releaseStore()
    await settle()
    releaseLook()
    await settle()
    expect(await held(running, bob.pubkey)).toEqual([])
  })

  it('does not take a deletion from a stranger for what someone else wrote', async () => {
    const stranger = await makeDevice('Stranger')
    await bob.messenger.sendMessage(laptop.pubkey, 'still here')
    await settle()
    const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
    const [message] = await laptop.vault.repo.listMessages(id, 10)
    laptop.messenger.stop()
    bob.messenger.stop()
    const rumor = createRumor(
      {
        kind: KIND_CONTROL,
        content: JSON.stringify({ v: PROTOCOL_VERSION, t: 'redact', refs: [message!.id] }),
        tags: recipientTags([laptop.pubkey]),
      },
      stranger.secretKey,
    )
    network.publish(giftWrap(rumor, stranger.secretKey, laptop.pubkey))
    redactFirst(laptop)
    const restored = await restore()
    await settle(30 * SECOND)
    expect(await held(restored, bob.pubkey)).toEqual(['still here'])
  })

  describe('when relays hold nothing that says so', () => {
    const framesGone = () => {
      for (let i = network.events.length - 1; i >= 0; i--) {
        if (isRedact(network.events[i] as never, laptop)) network.events.splice(i, 1)
      }
    }
    const sync = (device: Device) => {
      const frames = network.events.filter(
        (event) => event.kind === 1059 && event.tags.some((t) => t[1] === device.pubkey),
      )
      for (const event of frames) {
        try {
          const content = JSON.parse(unwrapGift(event as never, device.secretKey).content) as { t?: string }
          if (content.t === 'sync') network.events.splice(network.events.indexOf(event), 1)
        } catch {
          /* not ours to read */
        }
      }
    }

    it('reads the sealed record first, so a relay serving what was deleted changes nothing', async () => {
      network.ignoresDeletions = true
      await bob.messenger.sendMessage(laptop.pubkey, 'theirs, then deleted')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const [message] = await laptop.vault.repo.listMessages(id, 10)
      await laptop.messenger.redactMessage(bob.pubkey, message!.id)
      await settle(5 * SECOND)
      laptop.messenger.stop()
      bob.messenger.stop()
      framesGone()
      const before = network.events.length
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
      // It never got as far as being stored: no conversation, no request, no receipt for it.
      const here = restored.vault.repo.conversationId(restored.pubkey, bob.pubkey)
      expect(await restored.vault.repo.getConversation(here)).toBeNull()
      const receipts = network.events
        .slice(before)
        .filter((event) => event.tags.some((t) => t[1] === bob.pubkey))
      expect(receipts).toEqual([])
    })

    it('does the same for what was deleted on this identity alone', async () => {
      network.ignoresDeletions = true
      await bob.messenger.sendMessage(laptop.pubkey, 'theirs, then gone for me')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const [message] = await laptop.vault.repo.listMessages(id, 10)
      await laptop.messenger.deleteLocally(message!.id)
      await settle(5 * SECOND)
      laptop.messenger.stop()
      sync(laptop)
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })

    it('does the same for a whole conversation deleted', async () => {
      network.ignoresDeletions = true
      await bob.messenger.sendMessage(laptop.pubkey, 'a whole conversation, then deleted')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const conversation = await laptop.vault.repo.getConversation(id)
      laptop.messenger.noteConversationDeleted(conversation!)
      await laptop.vault.repo.deleteConversation(id)
      await settle(5 * SECOND)
      laptop.messenger.stop()
      sync(laptop)
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })

    it('takes it out of a device that had it before the record reached it', async () => {
      network.ignoresDeletions = true
      await bob.messenger.sendMessage(laptop.pubkey, 'here, until the record says otherwise')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const [message] = await laptop.vault.repo.listMessages(id, 10)
      const other = await makeDevice('Other', bytesToHex(laptop.secretKey))
      await settle(30 * SECOND)
      expect(await held(other, bob.pubkey)).toHaveLength(1)
      other.messenger.stop()
      await laptop.messenger.redactMessage(bob.pubkey, message!.id)
      await settle(5 * SECOND)
      laptop.messenger.stop()
      framesGone()
      // Its weekly read of the records, the first thing it hears of it.
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * MINUTE)
      const again = new Messenger(other.vault.vault, other.vault.repo, settings, other.pool)
      await again.start(bytesToHex(other.secretKey), other.pubkey)
      await settle(2 * MINUTE)
      again.stop()
      expect(await held(other, bob.pubkey)).toEqual([])
    })
  })

  describe('while a restore is catching up', () => {
    /** Keep the first read of the records unanswered, for as long as a test needs one. */
    const holdRecords = () => {
      const query = FakeRelayPool.prototype.query
      let release: () => void = () => undefined
      const released = new Promise<void>((resolve) => (release = resolve))
      const spy = vi.spyOn(FakeRelayPool.prototype, 'query').mockImplementation(async function (
        this: FakeRelayPool,
        filter,
        relays,
        opts,
      ) {
        if (filter.kinds?.includes(30078)) await released
        return query.call(this, filter, relays, opts)
      })
      return {
        release: () => {
          release()
          spy.mockRestore()
        },
      }
    }

    it('commits and shows nothing until it has read what deletes things', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'kept')
      await settle()
      laptop.messenger.stop()
      const records = holdRecords()
      const restored = await restore()
      const told = vi.fn()
      restored.messenger.events.on('message', told)
      await settle(5 * SECOND)
      expect(restored.messenger.restoring).toBe(true)
      expect(await held(restored, bob.pubkey)).toEqual([])
      expect(told).not.toHaveBeenCalled()
      records.release()
      await settle(5 * SECOND)
      expect(restored.messenger.restoring).toBe(false)
      expect(await held(restored, bob.pubkey)).toEqual(['kept'])
    })

    it('stops waiting on records that never come, and commits what it has', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'kept')
      await settle()
      laptop.messenger.stop()
      const records = holdRecords()
      const restored = await restore()
      await settle(25 * SECOND)
      expect(restored.messenger.restoring).toBe(false)
      expect(await held(restored, bob.pubkey)).toEqual(['kept'])
      records.release()
    })

    it('loses nothing if it is closed part way: what was held was never marked as read', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'kept')
      await settle()
      laptop.messenger.stop()
      const records = holdRecords()
      const restored = await restore()
      await settle(5 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
      restored.messenger.stop()
      records.release()
      const again = new Messenger(restored.vault.vault, restored.vault.repo, settings, restored.pool)
      await again.start(bytesToHex(restored.secretKey), restored.pubkey)
      await settle(30 * SECOND)
      again.stop()
      expect(await held(restored, bob.pubkey)).toEqual(['kept'])
    })

    it('goes on past a message it cannot store, and keeps the rest', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'first')
      await bob.messenger.sendMessage(laptop.pubkey, 'second')
      await settle()
      laptop.messenger.stop()
      let failed = false
      const restored = await makeDevice(
        'Restored',
        bytesToHex(laptop.secretKey),
        (vault) => {
          const ensure = vault.repo.ensureConversation.bind(vault.repo)
          vi.spyOn(vault.repo, 'ensureConversation').mockImplementation(async (self, peer) => {
            if (!failed) {
              failed = true
              throw new Error('storage hiccup')
            }
            return ensure(self, peer)
          })
        },
        RESTORED,
      )
      await settle(30 * SECOND)
      expect(failed).toBe(true)
      expect(await held(restored, bob.pubkey)).toHaveLength(1)
      expect(restored.messenger.restoring).toBe(false)
    })

    it('stops committing if it is stopped part way, and reads the rest again', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'first')
      await bob.messenger.sendMessage(laptop.pubkey, 'second')
      await settle()
      laptop.messenger.stop()
      let stopping: (() => void) | null = null
      const restored = await makeDevice(
        'Restored',
        bytesToHex(laptop.secretKey),
        (vault) => {
          const ensure = vault.repo.ensureConversation.bind(vault.repo)
          vi.spyOn(vault.repo, 'ensureConversation').mockImplementation(async (self, peer) => {
            stopping?.()
            stopping = null
            return ensure(self, peer)
          })
        },
        RESTORED,
      )
      stopping = () => restored.messenger.stop()
      await settle(30 * SECOND)
      expect(restored.messenger.isRunning).toBe(false)
      expect((await held(restored, bob.pubkey)).length).toBeLessThan(2)
      const again = new Messenger(
        restored.vault.vault,
        restored.vault.repo,
        settings,
        new FakeRelayPool(network),
      )
      await again.start(bytesToHex(restored.secretKey), restored.pubkey)
      await settle(30 * SECOND)
      again.stop()
      expect((await held(restored, bob.pubkey)).sort()).toEqual(['first', 'second'])
    })

    it('holds one copy of a message however many relays offer it, then finds its receipts', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, and read')
      await settle()
      laptop.messenger.stop()
      bob.messenger.stop()
      network.negentropy = false
      const restored = await restore()
      await settle(30 * SECOND)
      const message = await restored.vault.repo.getMessage(sent.id)
      expect(message?.body).toBe('mine, and read')
      expect(['delivered', 'read']).toContain(message?.status)
    })
  })

  describe('asking relays to delete', () => {
    const webOfTrust = 'blocked: Policy violated and pubkey is not in our web of trust.'

    it('asks again a relay that refuses for now, and it deletes it in the end', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, then deleted')
      await settle()
      const wrapsOf = () =>
        network.events.filter((event) => {
          if (event.kind !== 1059 || !event.tags.some((t) => t[1] === laptop.pubkey)) return false
          try {
            return unwrapGift(event as never, laptop.secretKey).id === sent.id
          } catch {
            return false
          }
        })
      expect(wrapsOf()).toHaveLength(1)
      const publish = laptop.pool.publish.bind(laptop.pool)
      let refused = 0
      const spy = vi.spyOn(laptop.pool, 'publish').mockImplementation(async (event, relays) => {
        if (event.kind === 5 && refused < 4) {
          refused += 1
          return [{ url: 'wss://fake.relay', ok: false, error: webOfTrust }]
        }
        return publish(event, relays)
      })
      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      await settle(10 * MINUTE)
      spy.mockRestore()
      expect(refused).toBe(4)
      expect(wrapsOf()).toEqual([])
    })

    it('goes on asking for as long as it means anything, and no longer', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, then deleted')
      await settle()
      const spy = vi
        .spyOn(laptop.pool, 'publish')
        .mockImplementation(async (event, relays) =>
          event.kind === 5
            ? [{ url: 'wss://fake.relay', ok: false, error: webOfTrust }]
            : (relays ?? []).map((url) => ({ url, ok: true as const, ms: 1 })),
        )
      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      const asked = () => spy.mock.calls.filter(([event]) => event.kind === 5).length
      await settle(90 * MINUTE)
      // The usual tries, for each of the two wraps, and nothing yet of the slower ones.
      const soFar = asked()
      expect(soFar).toBeGreaterThanOrEqual(2 * 12)
      await settle(MINUTE)
      expect(asked()).toBe(soFar)
      vi.setSystemTime(Date.now() + 7 * 60 * MINUTE)
      await settle(MINUTE)
      expect(asked()).toBeGreaterThan(soFar)
      // Past the point any wrap it names could still exist.
      vi.setSystemTime(Date.now() + RETRACTION_TTL_SEC * SECOND)
      await settle(MINUTE)
      const atEnd = asked()
      vi.setSystemTime(Date.now() + 24 * 60 * MINUTE)
      await settle(MINUTE)
      expect(asked()).toBe(atEnd)
      spy.mockRestore()
    }, 60_000)

    it('asks again for a small record, so a relay does not go on holding the one before', async () => {
      const publish = laptop.pool.publish.bind(laptop.pool)
      let refused = 0
      const spy = vi.spyOn(laptop.pool, 'publish').mockImplementation(async (event, relays) => {
        if (event.kind === 30078 && refused < 3) {
          refused += 1
          return (relays ?? []).map((url) => ({ url, ok: false as const, error: webOfTrust }))
        }
        return publish(event, relays)
      })
      await laptop.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
      laptop.messenger.noteContact(bob.pubkey, { on: true, name: true })
      await settle(10 * MINUTE)
      spy.mockRestore()
      expect(refused).toBe(3)
      expect(network.events.filter((event) => event.kind === 30078).length).toBeGreaterThan(0)
    })

    it('does not go on pressing a large record on a relay that refuses it', async () => {
      const spy = vi
        .spyOn(laptop.pool, 'publish')
        .mockImplementation(async (event, relays) =>
          event.kind === 30078
            ? (relays ?? []).map((url) => ({ url, ok: false as const, error: webOfTrust }))
            : (relays ?? []).map((url) => ({ url, ok: true as const, ms: 1 })),
        )
      const large = (event: { content: string }) => event.content.length > 6 * 1024
      for (let i = 0; i < 40; i++) {
        await laptop.vault.repo.upsertContact(getPublicKey(generateSecretKey()), {
          name: 'n'.repeat(64),
          remoteName: 'r'.repeat(128),
          accepted: true,
        })
      }
      laptop.messenger.noteContact(bob.pubkey, { on: true })
      await settle(30 * SECOND)
      const asked = () => spy.mock.calls.filter(([event]) => event.kind === 30078 && large(event)).length
      expect(asked()).toBe(1)
      await settle(30 * MINUTE)
      expect(asked()).toBe(1)
      spy.mockRestore()
    })

    it('asks again from a restored device, when a relay offers what we deleted', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, deleted by them')
      await settle()
      laptop.messenger.stop()
      await bob.messenger.redactMessage(laptop.pubkey, sent.id)
      await settle()
      bob.messenger.stop()
      const mine = () =>
        network.events.filter((event) => {
          if (event.kind !== 1059 || !event.tags.some((t) => t[1] === laptop.pubkey)) return false
          try {
            return unwrapGift(event as never, laptop.secretKey).id === sent.id
          } catch {
            return false
          }
        })
      expect(mine()).toHaveLength(1)
      redactFirst(laptop)
      await restore()
      await settle(30 * SECOND)
      expect(mine()).toEqual([])
    })

    it('sends the deletion to every relay of ours, wherever what it deletes may be', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, then deleted')
      await settle()
      laptop.pool.setRelays(
        ['wss://fake.relay', 'wss://standby.relay'],
        ['wss://fake.relay', 'wss://other.relay'],
      )
      const dispatch = vi.spyOn(laptop.pool, 'dispatch')
      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      await settle()
      const toSelf = dispatch.mock.calls.find(([event]) => event.tags.some((t) => t[1] === laptop.pubkey))
      expect(toSelf?.[1]).toEqual(
        expect.arrayContaining(['wss://fake.relay', 'wss://standby.relay', 'wss://other.relay']),
      )
    })
  })

  describe.each([
    ['relays that honour deletions', false],
    ['relays that ignore deletions', true],
  ])('with %s', (_label, ignoring) => {
    beforeEach(() => {
      network.ignoresDeletions = ignoring
    })

    it('keeps out what I wrote and deleted for everyone', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, then deleted')
      await settle()
      await laptop.messenger.redactMessage(bob.pubkey, sent.id)
      await settle()
      laptop.messenger.stop()
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })

    it('keeps out what they wrote and I deleted for everyone', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'theirs, then deleted by me')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const [message] = await laptop.vault.repo.listMessages(id, 10)
      bob.messenger.stop()
      await laptop.messenger.redactMessage(bob.pubkey, message!.id)
      await settle()
      laptop.messenger.stop()
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })

    it('keeps out what I wrote and they deleted for everyone, whichever arrives first', async () => {
      const sent = await laptop.messenger.sendMessage(bob.pubkey, 'mine, then deleted by them')
      await settle()
      laptop.messenger.stop()
      await bob.messenger.redactMessage(laptop.pubkey, sent.id)
      await settle()
      bob.messenger.stop()
      redactFirst(laptop)
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })

    it('keeps out what I deleted even if the copy of the deletion to my own inbox failed once', async () => {
      await bob.messenger.sendMessage(laptop.pubkey, 'theirs, then deleted by me')
      await settle()
      const id = laptop.vault.repo.conversationId(laptop.pubkey, bob.pubkey)
      const [message] = await laptop.vault.repo.listMessages(id, 10)
      bob.messenger.stop()
      const publish = laptop.pool.publish.bind(laptop.pool)
      let failed = 0
      const toSelf = (tags: string[][]) => tags.some((tag) => tag[0] === 'p' && tag[1] === laptop.pubkey)
      const spy = vi.spyOn(laptop.pool, 'publish').mockImplementation(async (event, relays) => {
        if (event.kind === 1059 && toSelf(event.tags) && failed === 0) {
          failed += 1
          return [{ url: 'wss://fake.relay', ok: false, error: 'no' }]
        }
        return publish(event, relays)
      })
      await laptop.messenger.redactMessage(bob.pubkey, message!.id)
      await settle(2 * 60 * SECOND)
      spy.mockRestore()
      expect(failed).toBe(1)
      laptop.messenger.stop()
      const restored = await restore()
      await settle(30 * SECOND)
      expect(await held(restored, bob.pubkey)).toEqual([])
    })
  })
})
