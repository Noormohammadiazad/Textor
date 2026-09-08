import { describe, expect, it } from 'vitest'
import { createIdentity } from '@/core/identity/keys'
import { bytesToHex } from '@/core/util/bytes'
import {
  decryptExport,
  exportFilename,
  exportVault,
  ImportError,
  importVault,
  parseEnvelope,
} from '@/core/vault/exportImport'
import type { IdentityRecord } from '@/core/models/types'
import { makeVault, TEST_KDF, type TestVault } from './helpers'

const PEER = 'b'.repeat(64)

async function seed(t: TestVault): Promise<{ identity: IdentityRecord; convoId: string }> {
  const { identity: keys } = createIdentity()
  const identity: IdentityRecord = {
    pubkey: keys.publicKey,
    npub: keys.npub,
    secretKeyHex: bytesToHex(keys.secretKey),
    name: 'Sara',
    about: 'test account',
    createdAt: Date.now(),
    mnemonicBackedUp: true,
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
  return { identity, convoId: convo.id }
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
