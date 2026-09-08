import { assertKdfParams, DEFAULT_KDF_PARAMS, type KdfParams } from '../crypto/kdf'
import { deriveKekOffThread } from '../crypto/kdfClient'
import { open as openSealed, seal } from '../crypto/vaultCrypto'
import {
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  wipe,
} from '../util/bytes'
import { createLogger } from '../util/log'
import type { AppSettings, Contact, Conversation, IdentityRecord, Message, RelayEntry } from '../models/types'
import type { VaultRepo } from './repo'

const log = createLogger('export')

export const EXPORT_FORMAT = 'textor-vault-export'
export const EXPORT_VERSION = 1

const AAD_EXPORT = 'textor/export/v1'

/**
 * Portable, encrypted backup — the whole multi-device and device-migration
 * story for v1.
 *
 * The file is encrypted under its own passphrase, independent of the vault's.
 * That matters: a backup travels (cloud drive, USB stick, email to yourself)
 * and should not inherit the threat model of a passphrase typed daily on one
 * device. The KDF parameters travel with the file so it can still be opened
 * years later by a build with different defaults.
 */
export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT
  version: number
  createdAt: number
  kdf: KdfParams & { salt: string }
  compression: 'gzip' | 'none'
  /** base64 of version(1) || nonce(24) || ciphertext+tag */
  payload: string
}

export interface ExportPayload {
  identity: IdentityRecord | null
  contacts: Contact[]
  conversations: Conversation[]
  messages: Message[]
  relays: RelayEntry[]
  settings: AppSettings
}

export interface ImportSummary {
  contacts: number
  conversations: number
  messages: number
  relays: number
  identityReplaced: boolean
}

async function gzip(bytes: Uint8Array): Promise<{ data: Uint8Array; compression: 'gzip' | 'none' }> {
  if (typeof CompressionStream !== 'function') return { data: bytes, compression: 'none' }
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
    return { data: new Uint8Array(await new Response(stream).arrayBuffer()), compression: 'gzip' }
  } catch {
    return { data: bytes, compression: 'none' }
  }
}

async function gunzip(bytes: Uint8Array, compression: 'gzip' | 'none'): Promise<Uint8Array> {
  if (compression === 'none') return bytes
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot read compressed backups')
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function exportVault(
  repo: VaultRepo,
  passphrase: string,
  opts: { includeMessages?: boolean; onProgress?: (fraction: number) => void } = {},
): Promise<ExportEnvelope> {
  const includeMessages = opts.includeMessages ?? true
  const [identity, contacts, conversations, relays, settings] = await Promise.all([
    repo.getIdentity(),
    repo.listContacts(),
    repo.listConversations(),
    repo.listRelays(),
    repo.getSettings(),
  ])

  const messages: Message[] = []
  if (includeMessages) {
    for (const conversation of conversations) {
      // A backup that silently truncates history is worse than no backup.
      messages.push(...(await repo.allMessages(conversation.id)))
    }
  }

  const payload: ExportPayload = { identity, contacts, conversations, messages, relays, settings }
  const { data, compression } = await gzip(utf8ToBytes(JSON.stringify(payload)))

  const salt = randomBytes(32)
  const params = DEFAULT_KDF_PARAMS
  const kek = await deriveKekOffThread(passphrase, salt, params, opts.onProgress)
  try {
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      createdAt: Date.now(),
      kdf: { ...params, salt: bytesToHex(salt) },
      compression,
      payload: bytesToB64(seal(kek, data, AAD_EXPORT)),
    }
  } finally {
    wipe(kek)
  }
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

export function parseEnvelope(text: string): ExportEnvelope {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ImportError('this file is not a Textor backup')
  }
  if (typeof value !== 'object' || value === null) throw new ImportError('this file is not a Textor backup')
  const envelope = value as Partial<ExportEnvelope>
  if (envelope.format !== EXPORT_FORMAT) throw new ImportError('this file is not a Textor backup')
  if (envelope.version !== EXPORT_VERSION) {
    throw new ImportError(`backup version ${String(envelope.version)} is not supported by this build`)
  }
  if (!envelope.kdf || typeof envelope.kdf.salt !== 'string' || typeof envelope.payload !== 'string') {
    throw new ImportError('backup is missing required fields')
  }
  assertKdfParams(envelope.kdf)
  if (envelope.compression !== 'gzip' && envelope.compression !== 'none') {
    throw new ImportError('unknown backup compression')
  }
  return envelope as ExportEnvelope
}

export async function decryptExport(
  envelope: ExportEnvelope,
  passphrase: string,
  onProgress?: (fraction: number) => void,
): Promise<ExportPayload> {
  const { salt, ...params } = envelope.kdf
  const kek = await deriveKekOffThread(passphrase, hexToBytes(salt), params, onProgress)
  try {
    let plaintext: Uint8Array
    try {
      plaintext = openSealed(kek, b64ToBytes(envelope.payload), AAD_EXPORT)
    } catch {
      throw new ImportError('wrong passphrase, or the backup file is damaged')
    }
    return JSON.parse(bytesToUtf8(await gunzip(plaintext, envelope.compression))) as ExportPayload
  } finally {
    wipe(kek)
  }
}

/**
 * Merge a backup into the current vault.
 *
 * Merge rather than replace: importing on a device that already has history
 * should never destroy it. Messages are keyed by rumor id, so re-importing the
 * same backup twice is a no-op — which is exactly the behaviour someone
 * recovering from a mistake needs.
 *
 * The identity is only adopted when the vault has none. Overwriting a live
 * identity would silently orphan every conversation already on the device.
 */
export async function importVault(
  repo: VaultRepo,
  payload: ExportPayload,
  opts: { adoptIdentity?: boolean } = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    contacts: 0,
    conversations: 0,
    messages: 0,
    relays: 0,
    identityReplaced: false,
  }

  const existingIdentity = await repo.getIdentity()
  if (payload.identity && (!existingIdentity || opts.adoptIdentity)) {
    await repo.putIdentity(payload.identity)
    summary.identityReplaced = true
  } else if (payload.identity && existingIdentity && existingIdentity.pubkey !== payload.identity.pubkey) {
    throw new ImportError('this backup belongs to a different identity; import it into a fresh vault instead')
  }

  for (const contact of payload.contacts) {
    await repo.upsertContact(contact.pubkey, {
      name: contact.name,
      remoteName: contact.remoteName,
      about: contact.about,
      avatar: contact.avatar,
      relays: contact.relays,
      verification: contact.verification,
      source: contact.source,
      accepted: contact.accepted,
      note: contact.note,
      lastSeenAt: contact.lastSeenAt,
      blocked: contact.blocked,
    })
    summary.contacts += 1
  }

  const identityPubkey = payload.identity?.pubkey ?? existingIdentity?.pubkey
  if (identityPubkey) {
    for (const conversation of payload.conversations) {
      // Conversation ids are blinded with this vault's index key, so they are
      // recomputed rather than trusted from the file.
      await repo.ensureConversation(identityPubkey, conversation.peerPubkey)
      const id = repo.conversationId(identityPubkey, conversation.peerPubkey)
      await repo.updateConversation(id, {
        lastActivity: conversation.lastActivity,
        pinned: conversation.pinned,
      })
      summary.conversations += 1
    }

    const peerByOldId = new Map(payload.conversations.map((c) => [c.id, c.peerPubkey]))
    for (const message of payload.messages) {
      const peer = peerByOldId.get(message.convoId)
      if (!peer) continue
      if (await repo.hasMessage(message.id)) continue
      await repo.putMessage({ ...message, convoId: repo.conversationId(identityPubkey, peer) })
      summary.messages += 1
    }
  }

  for (const relay of payload.relays) {
    await repo.upsertRelay(relay.url, {
      read: relay.read,
      write: relay.write,
      enabled: relay.enabled,
      discovered: relay.discovered,
    })
    summary.relays += 1
  }

  await repo.saveSettings(payload.settings)
  log.info(`import merged ${summary.messages} messages across ${summary.conversations} conversations`)
  return summary
}

/** Suggested filename; the date makes successive backups sort naturally. */
export const exportFilename = (date = new Date()): string =>
  `textor-backup-${date.toISOString().slice(0, 10)}.textor.json`
