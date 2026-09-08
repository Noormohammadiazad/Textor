import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { Messenger } from '@/core/engine/messenger'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/models/types'
import { bytesToHex } from '@/core/util/bytes'
import { blobRef } from '@/core/crypto/blobCrypto'
import { FakeRelayNetwork, FakeRelayPool } from './fakeRelay'
import { makeVault, type TestVault } from './helpers'

/**
 * Packs are vault-local: the images are sealed and chunked by the same code
 * that carries an attachment, so what needs proving is that they round-trip,
 * that shared bytes are not deleted out from under another pack, and that
 * sending one produces an ordinary attachment the recipient needs no pack to
 * read.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, enableDirectConnection: false }

interface Peer {
  pubkey: string
  vault: TestVault
  messenger: Messenger
}

async function makePeer(network: FakeRelayNetwork, name: string): Promise<Peer> {
  const { identity } = createIdentity()
  const vault = await makeVault(`${name}-pw`)
  const secretKeyHex = bytesToHex(identity.secretKey)
  await vault.repo.putIdentity({
    pubkey: identity.publicKey,
    npub: identity.npub,
    secretKeyHex,
    name,
    about: '',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
  })
  const messenger = new Messenger(vault.vault, vault.repo, settings, new FakeRelayPool(network))
  await messenger.start(secretKeyHex, identity.publicKey)
  return { pubkey: identity.publicKey, vault, messenger }
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms)

/** Deterministic bytes that stand in for a small PNG. */
const image = (seed: number, size = 4000): Uint8Array =>
  new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251)

describe('sticker packs', () => {
  let network: FakeRelayNetwork
  let alice: Peer
  let bob: Peer

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    network = new FakeRelayNetwork()
    alice = await makePeer(network, 'Alice')
    bob = await makePeer(network, 'Bob')
    await alice.vault.repo.upsertContact(bob.pubkey, { name: 'Bob', accepted: true })
    await bob.vault.repo.upsertContact(alice.pubkey, { name: 'Alice', accepted: true })
  })

  afterEach(async () => {
    alice.messenger.stop()
    bob.messenger.stop()
    await alice.vault.destroy()
    await bob.vault.destroy()
    vi.useRealTimers()
  })

  it('stores a pack and reads its stickers back byte for byte', async () => {
    const first = image(1)
    const pack = await alice.messenger.importStickerPack('Cats', [
      { bytes: first, mime: 'image/webp', width: 128, height: 128 },
      { bytes: image(2), mime: 'image/webp' },
    ])

    expect(pack.stickers).toHaveLength(2)
    const stored = await alice.vault.repo.listPacks()
    expect(stored.map((p) => p.name)).toEqual(['Cats'])

    const read = await alice.messenger.readSticker(pack.stickers[0]!)
    expect(read).toEqual(first)
    expect(pack.stickers[0]?.width).toBe(128)
  })

  it('refuses an empty pack', async () => {
    await expect(alice.messenger.importStickerPack('Nothing', [])).rejects.toThrow('at least one sticker')
  })

  it('sends a sticker as an attachment the other side can open without the pack', async () => {
    const bytes = image(3)
    const pack = await alice.messenger.importStickerPack('Cats', [{ bytes, mime: 'image/webp' }])
    await alice.messenger.sendSticker(bob.pubkey, pack.stickers[0]!)
    await settle(8000)

    const convoId = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    const received = await bob.vault.repo.listMessages(convoId)
    expect(received).toHaveLength(1)
    const attachment = received[0]?.attachment
    expect(attachment?.kind).toBe('image')
    expect(attachment?.size).toBe(bytes.length)

    // Bob holds no packs at all, and still gets the picture.
    expect(await bob.vault.repo.listPacks()).toEqual([])
    expect(await bob.messenger.readAttachment(attachment!)).toEqual(bytes)
  })

  it('keeps an image that another pack still uses', async () => {
    // Blob ids are content hashes, so the same picture in two packs is stored
    // once. Deleting one pack must not blank the sticker in the other.
    const shared = image(4)
    const keep = await alice.messenger.importStickerPack('Keep', [{ bytes: shared, mime: 'image/webp' }])
    const drop = await alice.messenger.importStickerPack('Drop', [
      { bytes: shared, mime: 'image/webp' },
      { bytes: image(5), mime: 'image/webp' },
    ])
    const onlyInDropped = drop.stickers[1]!

    await alice.messenger.deleteStickerPack(drop.id)

    expect((await alice.vault.repo.listPacks()).map((p) => p.name)).toEqual(['Keep'])
    expect(await alice.messenger.readSticker(keep.stickers[0]!)).toEqual(shared)
    // …while the one nothing else referenced is gone.
    expect(await alice.messenger.readSticker(onlyInDropped)).toBeNull()
  })

  it('keeps both packs readable when the same image is imported twice', async () => {
    // Blobs are keyed by the hash of their content but sealed with a fresh key
    // each time, so storing the same picture again under a new key would leave
    // the first pack holding a key that no longer opens the chunks.
    const same = image(9)
    const first = await alice.messenger.importStickerPack('First', [{ bytes: same, mime: 'image/webp' }])
    const second = await alice.messenger.importStickerPack('Second', [{ bytes: same, mime: 'image/webp' }])

    expect(second.stickers[0]?.id).toBe(first.stickers[0]?.id)
    expect(await alice.messenger.readSticker(first.stickers[0]!)).toEqual(same)
    expect(await alice.messenger.readSticker(second.stickers[0]!)).toEqual(same)
  })

  it('still shows a sticker after sending it, and sending it again stores nothing new', async () => {
    const bytes = image(7)
    const pack = await alice.messenger.importStickerPack('Cats', [{ bytes, mime: 'image/webp' }])
    const sticker = pack.stickers[0]!
    await alice.messenger.sendSticker(bob.pubkey, sticker)
    await alice.messenger.sendSticker(bob.pubkey, sticker)
    await settle(8000)

    expect(await alice.messenger.readSticker(sticker)).toEqual(bytes)
    const convoId = bob.vault.repo.conversationId(bob.pubkey, alice.pubkey)
    for (const message of await bob.vault.repo.listMessages(convoId)) {
      expect(await bob.messenger.readAttachment(message.attachment!)).toEqual(bytes)
    }
    // One copy of the picture on the sender's device, however often it is sent.
    expect((await alice.vault.repo.stats()).blobs).toBe(1)

    // Deleting what was sent keeps the pack's picture: they are the same copy.
    const sentConvo = alice.vault.repo.conversationId(alice.pubkey, bob.pubkey)
    for (const message of await alice.vault.repo.listMessages(sentConvo)) {
      expect(await alice.vault.repo.deleteMessageAndPayload(message.id)).toEqual({ blobDeleted: false })
    }
    await alice.vault.repo.deleteConversation(sentConvo)
    expect(await alice.messenger.readSticker(sticker)).toEqual(bytes)
  })

  it('reports a sticker whose bytes are not on this device', async () => {
    const pack = await alice.messenger.importStickerPack('Cats', [{ bytes: image(6), mime: 'image/webp' }])
    await alice.vault.repo.deleteBlob(blobRef(pack.stickers[0]!))
    await expect(alice.messenger.sendSticker(bob.pubkey, pack.stickers[0]!)).rejects.toThrow(
      'not on this device',
    )
  })
})
