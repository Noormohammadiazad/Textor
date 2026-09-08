import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { deriveKek } from '@/core/crypto/kdf'
import { seal } from '@/core/crypto/vaultCrypto'
import { bytesToB64, bytesToHex, randomBytes, utf8ToBytes } from '@/core/util/bytes'
import {
  decryptExport,
  exportFilename,
  exportVault,
  ImportError,
  importVault,
  opensWithRecovery,
  parseEnvelope,
  type ExportEnvelope,
} from '@/core/vault/exportImport'
import type { IdentityRecord } from '@/core/models/types'
import { makeVault, TEST_KDF, type TestVault } from './helpers'

const PEER = 'b'.repeat(64)

async function seed(
  t: TestVault,
  opts: { withMnemonic?: boolean } = {},
): Promise<{ identity: IdentityRecord; convoId: string; mnemonic: string }> {
  const { identity: keys, mnemonic } = createIdentity()
  const identity: IdentityRecord = {
    pubkey: keys.publicKey,
    npub: keys.npub,
    secretKeyHex: bytesToHex(keys.secretKey),
    name: 'Sara',
    about: 'test account',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
    ...(opts.withMnemonic ? { mnemonic } : {}),
  }
  await t.repo.putIdentity(identity)
  await t.repo.upsertContact(PEER, {
    name: 'Bob',
    source: 'invite',
    accepted: true,
    relays: ['wss://nos.lol'],
  })
  const convo = await t.repo.ensureConversation(identity.pubkey, PEER)
  for (let i = 0; i < 5; i++) {
    await t.repo.putMessage({
      id: `${i}`.repeat(64),
      convoId: convo.id,
      direction: i % 2 === 0 ? 'out' : 'in',
      status: 'sent',
      ts: Date.now() - (5 - i) * 1000,
      tsCoarse: 0,
      body: `message ${i}`,
      authorPubkey: i % 2 === 0 ? identity.pubkey : PEER,
    })
  }
  await t.repo.upsertRelay('wss://nos.lol', { read: true, write: true })
  return { identity, convoId: convo.id, mnemonic }
}

/** Exports use the real KDF defaults; override for test speed. */
const fastExport = (t: TestVault, passphrase: string) =>
  exportVault(t.repo, passphrase).then((envelope) => envelope)

describe('encrypted backup', () => {
  it('round-trips a full vault into a fresh one', async () => {
    const source = await makeVault('source vault')
    const { identity } = await seed(source)
    const envelope = await fastExport(source, 'backup passphrase')

    const target = await makeVault('target vault')
    const payload = await decryptExport(parseEnvelope(JSON.stringify(envelope)), 'backup passphrase')
    const summary = await importVault(target.repo, payload)

    expect(summary.messages).toBe(5)
    expect(summary.contacts).toBe(1)
    expect(summary.identityReplaced).toBe(true)
    expect((await target.repo.getIdentity())?.pubkey).toBe(identity.pubkey)

    const convoId = target.repo.conversationId(identity.pubkey, PEER)
    const messages = await target.repo.listMessages(convoId)
    expect(messages.map((m) => m.body)).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ])

    await source.destroy()
    await target.destroy()
  }, 60_000)

  it('re-blinds conversation ids under the importing vault key', async () => {
    const source = await makeVault('source')
    const { identity, convoId: sourceConvoId } = await seed(source)
    const envelope = await fastExport(source, 'pw')

    const target = await makeVault('target')
    await importVault(target.repo, await decryptExport(envelope, 'pw'))

    const targetConvoId = target.repo.conversationId(identity.pubkey, PEER)
    // Same conversation, different vault key, so the stored handle must differ.
    expect(targetConvoId).not.toBe(sourceConvoId)
    expect(await target.repo.getConversation(targetConvoId)).not.toBeNull()

    await source.destroy()
    await target.destroy()
  }, 60_000)

  it('brings a forward-secret group back read-only, unless this device is still in it', async () => {
    const source = await makeVault('source')
    const { identity } = await seed(source)
    const mls = { group: 'ef'.repeat(32), admins: [identity.pubkey], epoch: 3, code: 'abcd', refreshedAt: 1 }
    const other = { ...mls, group: '12'.repeat(32) }
    const named = source.repo.mlsConversationId(mls.group)
    await source.repo.upsertMlsConversation(named, { members: [PEER], subject: 'Plans', mls, accepted: true })
    await source.repo.putMessage({
      id: 'e'.repeat(64),
      convoId: named,
      direction: 'in',
      status: 'delivered',
      ts: Date.now(),
      tsCoarse: 0,
      body: 'said in the group',
      authorPubkey: PEER,
    })
    await source.repo.upsertMlsConversation(source.repo.mlsConversationId(other.group), {
      members: [PEER],
      subject: '',
      mls: other,
    })
    const payload = await decryptExport(await fastExport(source, 'pw'), 'pw')

    const target = await makeVault('target')
    // This device is still in the second group: its own state wins over the file's.
    const liveId = target.repo.mlsConversationId(other.group)
    await target.repo.putMlsGroup(liveId, { record: {}, hwm: {} })
    await target.repo.upsertMlsConversation(liveId, {
      members: [PEER],
      subject: '',
      mls: { ...other, epoch: 9 },
    })
    await importVault(target.repo, payload)

    const restored = await target.repo.getConversation(target.repo.mlsConversationId(mls.group))
    expect(restored).toMatchObject({ subject: 'Plans', members: [PEER], mls: { ...mls, left: true } })
    expect((await target.repo.listMessages(restored!.id)).map((m) => m.body)).toEqual(['said in the group'])
    const live = await target.repo.getConversation(liveId)
    expect(live?.mls).toEqual({ ...other, epoch: 9 })
    expect(live?.subject).toBeUndefined()

    await source.destroy()
    await target.destroy()
  }, 60_000)

  it('rejects the wrong backup passphrase', async () => {
    const t = await makeVault()
    await seed(t)
    const envelope = await fastExport(t, 'right')
    await expect(decryptExport(envelope, 'wrong')).rejects.toThrow(ImportError)
    await t.destroy()
  }, 60_000)

  it('never puts plaintext in the backup file', async () => {
    const t = await makeVault()
    await seed(t)
    const envelope = await fastExport(t, 'pw')
    const text = JSON.stringify(envelope)

    expect(text).not.toContain('message 0')
    expect(text).not.toContain('Sara')
    expect(text).not.toContain(PEER)
    await t.destroy()
  }, 60_000)

  it('is idempotent: importing twice does not duplicate history', async () => {
    const source = await makeVault('a')
    await seed(source)
    const envelope = await fastExport(source, 'pw')
    const payload = await decryptExport(envelope, 'pw')

    const target = await makeVault('b')
    const first = await importVault(target.repo, payload)
    const second = await importVault(target.repo, payload)

    expect(first.messages).toBe(5)
    expect(second.messages).toBe(0)
    expect((await target.repo.stats()).messages).toBe(5)

    await source.destroy()
    await target.destroy()
  }, 90_000)

  it('keeps call records, and leaves behind one this build could not draw', async () => {
    const source = await makeVault('calls source')
    const { identity, convoId } = await seed(source)
    await source.repo.putMessage({
      id: 'c'.repeat(64),
      convoId,
      direction: 'in',
      status: 'delivered',
      ts: Date.now(),
      tsCoarse: 0,
      body: '',
      authorPubkey: PEER,
      call: { media: 'video', outcome: 'missed' },
    })
    const payload = await decryptExport(await fastExport(source, 'pw'), 'pw')
    payload.messages.push({
      ...(payload.messages.find((m) => m.call) as (typeof payload.messages)[number]),
      id: 'd'.repeat(64),
      call: { media: 'hologram', outcome: 'missed' } as never,
    })

    const target = await makeVault('calls target')
    const summary = await importVault(target.repo, payload)
    expect(summary.messages).toBe(6)
    const imported = await target.repo.getMessage('c'.repeat(64))
    expect(imported?.call).toEqual({ media: 'video', outcome: 'missed' })
    expect(imported?.convoId).toBe(target.repo.conversationId(identity.pubkey, PEER))
    expect(await target.repo.hasMessage('d'.repeat(64))).toBe(false)

    await source.destroy()
    await target.destroy()
  }, 60_000)

  it('refuses to merge a backup from a different identity', async () => {
    const source = await makeVault('a')
    await seed(source)
    const payload = await decryptExport(await fastExport(source, 'pw'), 'pw')

    const target = await makeVault('b')
    await seed(target)
    await expect(importVault(target.repo, payload)).rejects.toThrow(/different identity/)

    await source.destroy()
    await target.destroy()
  }, 90_000)

  it('can omit message history for a smaller identity-only backup', async () => {
    const t = await makeVault()
    await seed(t)
    const envelope = await exportVault(t.repo, 'pw', { includeMessages: false })
    const payload = await decryptExport(envelope, 'pw')

    expect(payload.messages).toHaveLength(0)
    expect(payload.contacts).toHaveLength(1)
    expect(payload.identity).not.toBeNull()
    await t.destroy()
  }, 60_000)
})

describe('a backup the recovery phrase opens', () => {
  it('opens with the twelve words alone, on a device that has nothing else', async () => {
    const source = await makeVault('source vault')
    const { identity, mnemonic } = await seed(source, { withMnemonic: true })
    const envelope = parseEnvelope(JSON.stringify(await fastExport(source, 'backup passphrase')))
    expect(envelope.version).toBe(2)
    expect(opensWithRecovery(envelope)).toBe(true)

    // Typed on a phone: capitals and stray spaces.
    const typed = ` ${mnemonic.toUpperCase()} `
    const byPhrase = await decryptExport(envelope, { mnemonic: typed })
    const byPassphrase = await decryptExport(envelope, 'backup passphrase')
    expect(byPhrase).toEqual(byPassphrase)
    expect(byPhrase.identity?.pubkey).toBe(identity.pubkey)
    expect(byPhrase.messages).toHaveLength(5)

    // And the words are not in the file.
    expect(JSON.stringify(envelope)).not.toContain(mnemonic.split(' ')[0] + ' ' + mnemonic.split(' ')[1])
    await source.destroy()
  }, 60_000)

  it('refuses someone else’s words, and words that are not a phrase', async () => {
    const source = await makeVault()
    await seed(source, { withMnemonic: true })
    const envelope = await fastExport(source, 'backup passphrase')
    await expect(decryptExport(envelope, { mnemonic: createIdentity().mnemonic })).rejects.toThrow(
      /does not open this backup/,
    )
    await expect(decryptExport(envelope, { mnemonic: 'twelve words please' })).rejects.toThrow(
      /not a valid recovery phrase/,
    )
    await source.destroy()
  }, 60_000)

  it('opens only with its passphrase when the identity has no phrase', async () => {
    const source = await makeVault()
    await seed(source)
    const envelope = await fastExport(source, 'backup passphrase')
    expect(opensWithRecovery(envelope)).toBe(false)
    await expect(decryptExport(envelope, { mnemonic: createIdentity().mnemonic })).rejects.toThrow(
      /use its passphrase/,
    )
    await source.destroy()
  }, 60_000)

  it('says so when a file opens only with a recovery phrase', async () => {
    const source = await makeVault()
    await seed(source, { withMnemonic: true })
    const envelope = await fastExport(source, 'backup passphrase')
    const recoveryOnly = { ...envelope, slots: envelope.slots?.filter((slot) => slot.type === 'recovery') }
    await expect(decryptExport(recoveryOnly, 'backup passphrase')).rejects.toThrow(
      /only with a recovery phrase/,
    )
    await source.destroy()
  }, 60_000)

  it('reports a damaged payload even when the key opens', async () => {
    const source = await makeVault()
    const { mnemonic } = await seed(source, { withMnemonic: true })
    const envelope = await fastExport(source, 'backup passphrase')
    const damaged = { ...envelope, payload: bytesToB64(randomBytes(64)) }
    await expect(decryptExport(damaged, { mnemonic })).rejects.toThrow(/damaged/)
    await source.destroy()
  }, 60_000)
})

describe('merging what a backup holds', () => {
  it('brings groups back under their own members, and drops what belongs to nothing', async () => {
    const source = await makeVault()
    const { identity } = await seed(source)
    const [carol, dave, erin, frank] = ['c', 'd', 'e', 'f'].map((ch) => ch.repeat(64)) as [
      string,
      string,
      string,
      string,
    ]
    const trip = await source.repo.ensureGroupConversation(identity.pubkey, [PEER, carol], {
      subject: 'Trip',
      at: 1000,
      accepted: true,
    })
    await source.repo.putMessage({
      id: '9'.repeat(64),
      convoId: trip.id,
      direction: 'in',
      status: 'sent',
      ts: Date.now(),
      tsCoarse: 0,
      body: 'in the group',
      authorPubkey: carol,
    })
    const payload = await decryptExport(await fastExport(source, 'pw'), 'pw')

    // A group written without a subject, one conversation from before
    // members were stored, and a message whose conversation is not there.
    const oneToOne = payload.conversations.find((conversation) => conversation.kind !== 'group')
    payload.conversations.push({
      ...trip,
      id: 'unnamed',
      members: [dave, erin],
      subject: undefined,
      subjectAt: undefined,
    })
    // Files from before groups have no `members` at all, whatever the type says now.
    payload.conversations.push({
      ...oneToOne!,
      id: 'old',
      peerPubkey: frank,
      members: undefined as unknown as string[],
    })
    payload.messages.push({ ...payload.messages[0]!, id: '8'.repeat(64), convoId: 'nowhere' })

    const target = await makeVault()
    const summary = await importVault(target.repo, payload)
    expect(summary.conversations).toBe(4)
    expect(summary.messages).toBe(6)

    const restored = await target.repo.getConversation(
      target.repo.conversationIdOf(identity.pubkey, [PEER, carol]),
    )
    expect(restored).toMatchObject({ kind: 'group', subject: 'Trip' })
    expect((await target.repo.listMessages(restored!.id)).map((message) => message.body)).toEqual([
      'in the group',
    ])
    const unnamed = await target.repo.getConversation(
      target.repo.conversationIdOf(identity.pubkey, [dave, erin]),
    )
    expect(unnamed).toMatchObject({ kind: 'group' })
    expect(
      await target.repo.getConversation(target.repo.conversationId(identity.pubkey, frank)),
    ).not.toBeNull()

    await source.destroy()
    await target.destroy()
  }, 60_000)

  it('merges a backup without an identity into the one already here', async () => {
    const source = await makeVault()
    const { identity } = await seed(source)
    const payload = await decryptExport(await fastExport(source, 'pw'), 'pw')

    const target = await makeVault()
    await target.repo.putIdentity(identity)
    const summary = await importVault(target.repo, { ...payload, identity: null })
    expect(summary.identityReplaced).toBe(false)
    expect(summary.messages).toBe(5)
    await source.destroy()
    await target.destroy()
  }, 60_000)
})

describe('compression', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes the file uncompressed where the browser cannot compress', async () => {
    const t = await makeVault()
    await seed(t)
    vi.stubGlobal('CompressionStream', undefined)
    const plain = await fastExport(t, 'backup passphrase')
    expect(plain.compression).toBe('none')
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new Error('gzip is switched off')
        }
      },
    )
    const failed = await fastExport(t, 'backup passphrase')
    expect(failed.compression).toBe('none')
    vi.unstubAllGlobals()
    expect((await decryptExport(failed, 'backup passphrase')).messages).toHaveLength(5)
    await t.destroy()
  }, 60_000)

  it('says so, rather than failing oddly, where it cannot decompress', async () => {
    const t = await makeVault()
    await seed(t)
    const envelope = await fastExport(t, 'backup passphrase')
    expect(envelope.compression).toBe('gzip')
    vi.stubGlobal('DecompressionStream', undefined)
    await expect(decryptExport(envelope, 'backup passphrase')).rejects.toThrow(/cannot read compressed/)
    await t.destroy()
  }, 60_000)
})

describe('a backup made before version 2', () => {
  /** Sealed straight under the passphrase, the way every earlier build wrote it. */
  async function versionOne(passphrase: string, payload: unknown): Promise<ExportEnvelope> {
    const salt = randomBytes(32)
    const kek = await deriveKek(passphrase, salt, TEST_KDF)
    return {
      format: 'textor-vault-export',
      version: 1,
      createdAt: Date.now(),
      kdf: { ...TEST_KDF, salt: bytesToHex(salt) },
      compression: 'none',
      payload: bytesToB64(seal(kek, utf8ToBytes(JSON.stringify(payload)), 'textor/export/v1')),
    }
  }

  it('still opens with its passphrase', async () => {
    const envelope = parseEnvelope(JSON.stringify(await versionOne('old backup', { messages: [] })))
    expect(opensWithRecovery(envelope)).toBe(false)
    expect(await decryptExport(envelope, 'old backup')).toEqual({ messages: [] })
    await expect(decryptExport(envelope, 'not it')).rejects.toThrow(ImportError)
  })

  it('explains why the recovery phrase does not open it', async () => {
    const envelope = await versionOne('old backup', {})
    await expect(decryptExport(envelope, { mnemonic: createIdentity().mnemonic })).rejects.toThrow(
      /made before recovery phrases could open one/,
    )
  })
})

describe('backup envelope validation', () => {
  it('rejects files that are not Textor backups', () => {
    expect(() => parseEnvelope('not json')).toThrow(ImportError)
    expect(() => parseEnvelope('{"format":"something-else"}')).toThrow(ImportError)
    expect(() => parseEnvelope('{"format":"textor-vault-export","version":99}')).toThrow(/version/)
  })

  it('rejects a tampered KDF block that would exhaust memory on open', () => {
    const envelope = {
      format: 'textor-vault-export',
      version: 1,
      createdAt: Date.now(),
      kdf: { algo: 'scrypt', N: 2 ** 30, r: 16, p: 16, salt: 'aa'.repeat(16) },
      compression: 'none',
      payload: 'AAAA',
    }
    expect(() => parseEnvelope(JSON.stringify(envelope))).toThrow(/out of range/)
  })

  it('checks every way a version 2 file says it opens', () => {
    const base = {
      format: 'textor-vault-export',
      version: 2,
      createdAt: Date.now(),
      compression: 'none',
      payload: 'AAAA',
    }
    const parse = (extra: object) => () => parseEnvelope(JSON.stringify({ ...base, ...extra }))
    const kdf = { ...TEST_KDF, salt: 'aa'.repeat(16) }
    expect(parse({ slots: [{ type: 'passphrase', kdf, key: 'AAAA' }] })()).toMatchObject({ version: 2 })
    expect(parse({ slots: [{ type: 'recovery', salt: 'bb'.repeat(32), key: 'AAAA' }] })()).toMatchObject({
      version: 2,
    })
    for (const bad of [
      {},
      { slots: [] },
      { slots: 'passphrase' },
      { slots: [null] },
      { slots: [{ type: 'passphrase', kdf, key: 7 }] },
      { slots: [{ type: 'passphrase', key: 'AAAA' }] },
      { slots: [{ type: 'passphrase', kdf: { ...kdf, salt: 'zz' }, key: 'AAAA' }] },
      { slots: [{ type: 'recovery', salt: 'not hex', key: 'AAAA' }] },
      { slots: [{ type: 'fingerprint', key: 'AAAA' }] },
    ]) {
      expect(parse(bad)).toThrow(/missing required fields/)
    }
    expect(parse({ slots: [{ type: 'passphrase', kdf: { ...kdf, N: 2 ** 30 }, key: 'AAAA' }] })).toThrow(
      /out of range/,
    )
    expect(parse({ payload: 7, slots: [{ type: 'passphrase', kdf, key: 'AAAA' }] })).toThrow(/missing/)
    expect(parse({ compression: 'zip', slots: [{ type: 'passphrase', kdf, key: 'AAAA' }] })).toThrow(
      /compression/,
    )
    expect(() => parseEnvelope(JSON.stringify({ ...base, version: 1, kdf: { ...TEST_KDF } }))).toThrow(
      /missing required fields/,
    )
    expect(() => parseEnvelope('null')).toThrow(/not a Textor backup/)
  })

  it('names backups so successive files sort by date', () => {
    expect(exportFilename(new Date('2026-08-29T12:00:00Z'))).toBe('textor-backup-2026-08-29.textor.json')
  })
})

/** Keep the fast KDF from leaking into assertions about real defaults. */
describe('test scaffolding', () => {
  it('uses deliberately weak KDF parameters', () => {
    expect(TEST_KDF.N).toBeLessThan(2 ** 16)
  })
})
