import { create } from 'zustand'
import { NoVaultError, Vault, WrongPassphraseError } from '../core/vault/vault'
import { VaultRepo } from '../core/vault/repo'
import { getDb, resetDb } from '../core/vault/db'
import { Messenger, type SyncState } from '../core/engine/messenger'
import type { RelayStatus } from '../core/transport/relayPool'
import type { DirectState } from '../core/transport/webrtc/directSession'
import {
  createIdentity as makeIdentity,
  identityFromMnemonic,
  shortNpub,
  toNpub,
} from '../core/identity/keys'
import { createInvite, decodeInvite, type Invite } from '../core/identity/invite'
import { bytesToHex, wipe } from '../core/util/bytes'
import { createLogger } from '../core/util/log'
import { DEFAULT_DM_RELAYS } from '../core/transport/defaultRelays'
import { normalizeRelayList } from '../core/transport/relayUrl'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Contact,
  type Conversation,
  type IdentityRecord,
  type Message,
  type RelayEntry,
} from '../core/models/types'
import { detectLocale } from '../i18n'
import { clearDisplayPrefs, loadDisplayPrefs, saveDisplayPrefs } from './displayPrefs'
import type { Attachment } from '../core/models/attachment'

/** What a screen hands the store to send as an attachment. */
export interface SendAttachmentInput {
  bytes: Uint8Array
  kind: Attachment['kind']
  mime: string
  caption: string
  name?: string
  durationMs?: number
  waveform?: number[]
  width?: number
  height?: number
  preview?: string
}

/**
 * Object URLs handed out for playback, kept so the same payload is decrypted
 * once per session rather than once per render. Revoked on lock and on wipe,
 * where every other decrypted trace is dropped too.
 */
const blobUrls = new Map<string, string>()

function revokeBlobUrls(): void {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url)
  blobUrls.clear()
}
import { ensurePersistentStorage, type PersistenceState } from './storagePersistence'

const log = createLogger('store')

export type Phase = 'boot' | 'onboarding' | 'locked' | 'ready' | 'unsupported'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'danger'
}

/**
 * Singletons.
 *
 * The vault holds live key material, so exactly one must exist per tab. The
 * messenger is created on unlock and destroyed on lock, which is also what
 * closes every relay socket and peer connection — locking the app really does
 * stop it talking to the network.
 */
const vault = new Vault(getDb())
const repo = new VaultRepo(vault)
let messenger: Messenger | null = null

export const getVault = (): Vault => vault
export const getRepo = (): VaultRepo => repo
export const getMessenger = (): Messenger | null => messenger

interface AppState {
  phase: Phase
  bootError: string | null
  autoLocked: boolean
  /** Whether the browser has promised not to evict the vault. */
  storagePersisted: PersistenceState
  /** Session-only: the user chose "skip for now" on the recovery-phrase screen. */
  backupDeferred: boolean

  identity: IdentityRecord | null
  settings: AppSettings

  conversations: Conversation[]
  /** Conversation id -> the newest message, for the list preview. */
  previews: Map<string, Message>
  contacts: Map<string, Contact>
  relayStatuses: RelayStatus[]
  relayEntries: RelayEntry[]
  syncState: SyncState

  activePeer: string | null
  messages: Message[]
  /** How many messages the open conversation is currently showing. */
  messageLimit: number
  /** True when the conversation holds more history than is currently loaded. */
  hasEarlierMessages: boolean
  typingPeers: Set<string>
  directStates: Map<string, DirectState>

  toasts: Toast[]
  pendingInvite: Invite | null
  /**
   * Live transfer progress, keyed by blob id.
   *
   * Session-only: the durable state is the chunks on disk, and a reload
   * recomputes what is missing from those rather than trusting a counter.
   */
  blobProgress: Map<string, { received: number; total: number }>
  /**
   * Language or theme the user changed on an entry screen, before there was a
   * vault to write it to. Carried into the vault the moment one opens, then
   * cleared. Session-only: a reload replays it from the display cache instead.
   */
  pendingDisplayPrefs: Partial<Pick<AppSettings, 'locale' | 'theme'>> | null

  boot: () => Promise<void>
  createVault: (args: {
    name: string
    passphrase: string
    mnemonic?: string
    onProgress?: (fraction: number) => void
  }) => Promise<string>
  unlock: (passphrase: string, onProgress?: (fraction: number) => void) => Promise<void>
  lock: () => void
  wipeDevice: () => Promise<void>

  refreshConversations: () => Promise<void>
  refreshContacts: () => Promise<void>
  refreshRelays: () => Promise<void>

  openConversation: (peerPubkey: string) => Promise<void>
  closeConversation: () => void
  saveDraft: (peerPubkey: string, text: string) => Promise<void>
  loadMessages: (peerPubkey: string) => Promise<void>
  loadEarlierMessages: () => Promise<void>
  sendMessage: (text: string, replyTo?: string) => Promise<void>
  /** Send a file, picture, video, or voice note to the open conversation. */
  sendAttachment: (input: SendAttachmentInput, replyTo?: string) => Promise<void>
  /** Decrypt a stored payload and hand back an object URL for playback. */
  openAttachment: (attachment: Attachment) => Promise<string | null>
  retryMessage: (messageId: string) => Promise<void>
  deleteMessageLocally: (messageId: string) => Promise<void>
  /** Delete here and ask the peer to delete their copy too. */
  deleteMessageForEveryone: (messageId: string) => Promise<void>
  setTyping: (active: boolean) => void

  addContact: (input: {
    pubkey: string
    name?: string
    relays?: string[]
    source?: Contact['source']
  }) => Promise<Contact>
  updateContact: (pubkey: string, patch: Partial<Contact>) => Promise<void>
  removeContact: (pubkey: string) => Promise<void>

  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  /**
   * Change language or theme from a screen that may not have a vault behind it
   * yet — welcome, onboarding, or the lock screen.
   */
  setDisplayPreference: (patch: Partial<Pick<AppSettings, 'locale' | 'theme'>>) => Promise<void>
  updateProfile: (patch: Partial<IdentityRecord>) => Promise<void>
  myInvite: () => string | null
  setPendingInvite: (invite: Invite | null) => void

  deferBackup: () => void
  resumeBackup: () => void

  toast: (message: string, tone?: Toast['tone']) => void
  dismissToast: (id: number) => void
}

let toastId = 0

/**
 * Messages loaded when a conversation opens.
 *
 * Each one is an individual decryption, so a conversation with years of
 * history should not pay for all of it to show the last screenful.
 */
const DEFAULT_MESSAGE_PAGE = 60

/**
 * Hard requirements, and only hard requirements.
 *
 * Deliberately does *not* test `crypto.subtle`: nothing here uses WebCrypto —
 * all primitives come from @noble in pure JavaScript, and Dexie guards its own
 * optional use of it. Gating on `subtle` would refuse to start in any
 * non-secure context (a plain-http LAN address during development, say) for a
 * capability the app never reaches for.
 *
 * Everything else the app touches — WebRTC, notifications, the camera,
 * compression, storage persistence — is progressive and guarded at its call
 * site, so it degrades rather than blocking startup.
 */
function missingCapabilities(): string[] {
  const missing: string[] = []
  if (!globalThis.indexedDB) missing.push('IndexedDB')
  if (typeof globalThis.crypto?.getRandomValues !== 'function') missing.push('crypto.getRandomValues')
  if (typeof globalThis.WebSocket !== 'function') missing.push('WebSocket')
  if (typeof globalThis.TextEncoder !== 'function') missing.push('TextEncoder')
  return missing
}

export const useApp = create<AppState>((set, get) => ({
  phase: 'boot',
  bootError: null,
  autoLocked: false,
  storagePersisted: 'unsupported',
  backupDeferred: false,

  identity: null,
  // Seeded from the pre-unlock cache so the lock screen already speaks the
  // user's language; the encrypted record overwrites this on unlock.
  settings: { ...DEFAULT_SETTINGS, locale: detectLocale(), ...loadDisplayPrefs() },

  conversations: [],
  previews: new Map(),
  contacts: new Map(),
  relayStatuses: [],
  relayEntries: [],
  syncState: {
    online: true,
    connectedRelays: 0,
    totalRelays: 0,
    pendingOutbox: 0,
    lastSyncAt: 0,
    syncing: false,
  },

  activePeer: null,
  messages: [],
  messageLimit: DEFAULT_MESSAGE_PAGE,
  hasEarlierMessages: false,
  typingPeers: new Set(),
  directStates: new Map(),

  toasts: [],
  pendingInvite: null,
  blobProgress: new Map(),
  pendingDisplayPrefs: null,

  async boot() {
    const missing = missingCapabilities()
    if (missing.length > 0) {
      log.error(`unsupported browser, missing: ${missing.join(', ')}`)
      set({ phase: 'unsupported', bootError: missing.join(', ') })
      return
    }
    try {
      const status = await vault.refreshStatus()
      set({ phase: status === 'empty' ? 'onboarding' : 'locked' })
    } catch (err) {
      log.error('boot failed', err)
      set({ phase: 'unsupported', bootError: err instanceof Error ? err.message : String(err) })
    }

    // Ask early: browsers weigh engagement, and a vault that gets evicted
    // before the user makes a backup is unrecoverable.
    void ensurePersistentStorage().then((storagePersisted) => set({ storagePersisted }))

    vault.events.on('statusChanged', (status) => {
      if (status === 'locked' && get().phase === 'ready') {
        revokeBlobUrls()
        teardownMessenger()
        set({ phase: 'locked', identity: null, messages: [], activePeer: null, conversations: [] })
      }
    })
    vault.events.on('autoLocked', () => set({ autoLocked: true }))
  },

  async createVault({ name, passphrase, mnemonic, onProgress }) {
    const created = mnemonic ? { identity: identityFromMnemonic(mnemonic), mnemonic } : makeIdentity()

    await vault.create(passphrase, { onProgress })
    // Re-ask now that the user has demonstrably engaged: Chromium in
    // particular is far more likely to grant persistence at this point than on
    // a cold first paint.
    void ensurePersistentStorage().then((storagePersisted) => set({ storagePersisted }))

    const secretKeyHex = bytesToHex(created.identity.secretKey)
    const record: IdentityRecord = {
      pubkey: created.identity.publicKey,
      npub: created.identity.npub,
      secretKeyHex,
      name: name.trim() || shortNpub(created.identity.npub),
      about: '',
      createdAt: Date.now(),
      mnemonicBackedUp: false,
      mnemonic: created.mnemonic,
    }
    await repo.putIdentity(record)
    for (const url of DEFAULT_DM_RELAYS) await repo.upsertRelay(url, { read: true, write: true })

    wipe(created.identity.secretKey)
    await startSession(set, get)
    return created.mnemonic
  },

  async unlock(passphrase, onProgress) {
    try {
      await vault.unlock(passphrase, onProgress)
    } catch (err) {
      if (err instanceof NoVaultError) {
        // Storage was cleared out from under us. Start over rather than
        // stranding the user on a lock screen for a vault that is gone.
        set({ phase: 'onboarding', identity: null })
        return
      }
      if (err instanceof WrongPassphraseError) throw err
      log.error('unlock failed', err)
      throw err
    }
    set({ autoLocked: false })
    await startSession(set, get)
  },

  lock() {
    revokeBlobUrls()
    teardownMessenger()
    vault.lock('manual')
    set({ phase: 'locked', identity: null, messages: [], activePeer: null, conversations: [] })
  },

  async wipeDevice() {
    revokeBlobUrls()
    teardownMessenger()
    vault.lock('manual')
    clearDisplayPrefs()
    await resetDb()
    // A full reload guarantees no decrypted state survives in memory.
    location.reload()
  },

  async refreshConversations() {
    if (!vault.isUnlocked) return
    const conversations = await repo.listConversations()
    // One decryption per conversation, not per message: `listMessages` walks
    // the index backwards and stops at the first row.
    const previews = new Map<string, Message>()
    for (const conversation of conversations) {
      const [newest] = await repo.listMessages(conversation.id, 1)
      if (newest) previews.set(conversation.id, newest)
    }
    set({ conversations, previews })
  },

  async refreshContacts() {
    if (!vault.isUnlocked) return
    const list = await repo.listContacts()
    set({ contacts: new Map(list.map((contact) => [contact.pubkey, contact])) })
  },

  async refreshRelays() {
    if (!vault.isUnlocked) return
    const entries = (await messenger?.reloadRelays()) ?? (await repo.listRelays())
    set({ relayEntries: entries, relayStatuses: messenger?.pool.statuses() ?? [] })
  },

  async openConversation(peerPubkey) {
    // Reset the window: opening a conversation should not inherit however far
    // back the previous one had been scrolled.
    set({ activePeer: peerPubkey, messages: [], messageLimit: DEFAULT_MESSAGE_PAGE })
    await get().loadMessages(peerPubkey)
    await messenger?.openConversation(peerPubkey)
    await get().refreshConversations()
  },

  closeConversation() {
    set({ activePeer: null, messages: [] })
  },

  async saveDraft(peerPubkey, text) {
    if (!vault.isUnlocked || !messenger) return
    const draft = text.trim() ? text : undefined
    const convoId = repo.conversationId(messenger.pubkey, peerPubkey)
    let existing = await repo.getConversation(convoId)

    // A conversation row is normally created by the first message. Someone who
    // opens a brand-new contact and types without sending has no row yet, and
    // dropping the draft on the floor is exactly the case this feature exists
    // to prevent — so create it, but only when there is something to keep.
    if (!existing) {
      if (!draft) return
      existing = await repo.ensureConversation(messenger.pubkey, peerPubkey)
    }
    if (existing.draft === draft) return

    await repo.updateConversation(convoId, { draft })
    await get().refreshConversations()
  },

  async loadMessages(peerPubkey) {
    if (!vault.isUnlocked || !messenger) return
    const convoId = repo.conversationId(messenger.pubkey, peerPubkey)
    const limit = get().messageLimit
    const [messages, total] = await Promise.all([
      repo.listMessages(convoId, limit),
      repo.countMessages(convoId),
    ])
    set({ messages, hasEarlierMessages: total > messages.length })
  },

  async loadEarlierMessages() {
    const peer = get().activePeer
    if (!peer) return
    set({ messageLimit: get().messageLimit + DEFAULT_MESSAGE_PAGE })
    await get().loadMessages(peer)
  },

  async sendMessage(text, replyTo) {
    const peer = get().activePeer
    if (!peer || !messenger) return
    try {
      await messenger.sendMessage(peer, text, replyTo)
      await get().loadMessages(peer)
      await get().refreshConversations()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  async sendAttachment(input, replyTo) {
    const peer = get().activePeer
    if (!peer || !messenger) return
    try {
      await messenger.sendAttachment(peer, input, replyTo)
      await get().loadMessages(peer)
      await get().refreshConversations()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  async openAttachment(attachment) {
    const cached = blobUrls.get(attachment.id)
    if (cached) return cached
    // A rejection here means the stored bytes will not open; `null` means they
    // are not all here yet. The caller renders those very differently.
    const bytes = await messenger?.readAttachment(attachment)
    if (!bytes) return null
    // A copy, because the underlying buffer is reused by the decryptor.
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: attachment.mime }))
    blobUrls.set(attachment.id, url)
    return url
  },

  async retryMessage(messageId) {
    await messenger?.retryMessage(messageId)
    const peer = get().activePeer
    if (peer) await get().loadMessages(peer)
  },

  async deleteMessageForEveryone(messageId) {
    const peer = get().activePeer
    if (!peer || !messenger) return
    try {
      await messenger.redactMessage(peer, messageId)
      await get().loadMessages(peer)
      await get().refreshConversations()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  async deleteMessageLocally(messageId) {
    // Local delete takes the payload with it when nothing else refers to it,
    // so "delete" does not quietly leave megabytes on the device.
    await repo.deleteMessageAndPayload(messageId)
    const peer = get().activePeer
    if (peer) await get().loadMessages(peer)
  },

  setTyping(active) {
    const peer = get().activePeer
    if (peer) messenger?.setTyping(peer, active)
  },

  async addContact({ pubkey, name, relays, source = 'manual' }) {
    const contact = await repo.upsertContact(pubkey, {
      name: name ?? '',
      relays: normalizeRelayList(relays ?? [], 8),
      source,
      accepted: true,
    })
    await get().refreshContacts()
    // Learn where they read mail, and tell them who we are, in the background.
    void messenger?.refreshPeerRelays(pubkey).catch(() => undefined)
    void messenger?.sendProfileTo(pubkey).catch(() => undefined)
    return contact
  },

  async updateContact(pubkey, patch) {
    await repo.upsertContact(pubkey, patch)
    await get().refreshContacts()
  },

  async removeContact(pubkey) {
    await repo.deleteContact(pubkey)
    await get().refreshContacts()
  },

  async saveSettings(patch) {
    const next = await repo.saveSettings(patch)
    set({ settings: next })
    saveDisplayPrefs({ locale: next.locale, theme: next.theme })
    vault.configureAutoLock(next.autoLockMinutes)
    await messenger?.applySettings(next)
  },

  async setDisplayPreference(patch) {
    // Once the vault is open the encrypted settings record is the authority,
    // and saveSettings mirrors the change into the display cache on its way
    // through. Before that there is nothing to write to, so the cache is the
    // only home the choice has — which is exactly why it exists.
    if (get().phase === 'ready') {
      await get().saveSettings(patch)
      return
    }
    const next = { ...get().settings, ...patch }
    set({ settings: next, pendingDisplayPrefs: { ...get().pendingDisplayPrefs, ...patch } })
    saveDisplayPrefs({ locale: next.locale, theme: next.theme })
  },

  async updateProfile(patch) {
    const identity = await repo.updateIdentity(patch)
    set({ identity })
    // Push the new profile to contacts so they see the change.
    for (const contact of get().contacts.values()) {
      if (!contact.blocked && contact.accepted) {
        void messenger?.sendProfileTo(contact.pubkey).catch(() => undefined)
      }
    }
    // And update the public profile, but only if the user opted into one.
    if (get().settings.publishPublicProfile) {
      void messenger?.publishPublicProfile().catch(() => undefined)
    }
  },

  myInvite() {
    const identity = get().identity
    if (!identity || !messenger) return null
    const secretKey = hexToBytesSafe(identity.secretKeyHex)
    if (!secretKey) return null
    try {
      return createInvite(secretKey, {
        name: identity.name,
        relays: messenger.pool.readRelays.slice(0, 4),
      })
    } finally {
      wipe(secretKey)
    }
  },

  setPendingInvite(invite) {
    set({ pendingInvite: invite })
  },

  deferBackup() {
    set({ backupDeferred: true })
  },

  resumeBackup() {
    set({ backupDeferred: false })
  },

  toast(message, tone = 'info') {
    const id = ++toastId
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismissToast(id), tone === 'danger' ? 6000 : 3500)
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
}))

type Setter = (partial: Partial<AppState>) => void
type Getter = () => AppState

/** Bring the messenger up and subscribe the UI to its events. */
async function startSession(set: Setter, get: Getter): Promise<void> {
  const identity = await repo.getIdentity()
  if (!identity) {
    set({ phase: 'onboarding' })
    return
  }

  /*
   * A language or theme picked on the welcome or lock screen is a deliberate
   * choice, so it wins over whatever the vault happens to remember and is
   * written through as the vault opens. Without this, choosing Persian on the
   * welcome screen and then creating an identity drops you back into English
   * one second later — the setting appears to have been ignored.
   */
  const pending = get().pendingDisplayPrefs
  const settings = pending ? await repo.saveSettings(pending) : await repo.getSettings()
  vault.configureAutoLock(settings.autoLockMinutes)

  teardownMessenger()
  messenger = new Messenger(vault, repo, settings)

  messenger.events.on('message', ({ message }) => {
    const state = get()
    if (state.activePeer) {
      const activeConvoId = repo.conversationId(identity.pubkey, state.activePeer)
      if (message.convoId === activeConvoId) void state.loadMessages(state.activePeer)
    }
    void state.refreshConversations()
    if (message.direction === 'in') notify(message, get)
  })

  messenger.events.on('messageUpdated', (updated) => {
    set({
      messages: get().messages.map((message) => (message.id === updated.id ? updated : message)),
    })
  })

  messenger.events.on('conversationsChanged', () => void get().refreshConversations())
  messenger.events.on('contactsChanged', () => void get().refreshContacts())
  messenger.events.on('relayStatus', (relayStatuses) => set({ relayStatuses }))
  messenger.events.on('syncState', (syncState) => set({ syncState }))

  messenger.events.on('typing', ({ peerPubkey, active }) => {
    const typingPeers = new Set(get().typingPeers)
    if (active) typingPeers.add(peerPubkey)
    else typingPeers.delete(peerPubkey)
    set({ typingPeers })
  })

  messenger.events.on('directState', ({ peerPubkey, state }) => {
    const directStates = new Map(get().directStates)
    directStates.set(peerPubkey, state)
    set({ directStates })
  })

  messenger.events.on('blobProgress', ({ id, received, total }) => {
    const blobProgress = new Map(get().blobProgress)
    blobProgress.set(id, { received, total })
    set({ blobProgress })
  })

  messenger.events.on('messagesRedacted', () => {
    const peer = get().activePeer
    if (peer) void get().loadMessages(peer)
    void get().refreshConversations()
  })

  messenger.events.on('blobComplete', ({ id }) => {
    const blobProgress = new Map(get().blobProgress)
    blobProgress.delete(id)
    set({ blobProgress })
    // The payload changed from "arriving" to "playable", and the bubble reads
    // that from the message list.
    const peer = get().activePeer
    if (peer) void get().loadMessages(peer)
  })

  messenger.events.on('error', ({ message }) => log.warn(`engine: ${message}`))

  await messenger.start(identity.secretKeyHex, identity.pubkey)

  set({ phase: 'ready', identity, settings, pendingDisplayPrefs: null })
  saveDisplayPrefs({ locale: settings.locale, theme: settings.theme })
  await Promise.all([get().refreshConversations(), get().refreshContacts(), get().refreshRelays()])
}

function teardownMessenger(): void {
  if (!messenger) return
  void messenger.persistRelayHealth().catch(() => undefined)
  messenger.stop()
  messenger.events.clear()
  messenger = null
}

/** Desktop notification for an incoming message while the tab is hidden. */
function notify(message: Message, get: Getter): void {
  const { settings, contacts } = get()
  if (!settings.notificationsEnabled) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return

  const contact = contacts.get(message.authorPubkey)
  const title = contact?.name || contact?.remoteName || shortNpub(toNpub(message.authorPubkey))
  try {
    // The body is deliberately omitted: a notification banner is readable by
    // anyone glancing at the screen, and this is a private messenger.
    new Notification(title, { tag: message.convoId, silent: false })
  } catch {
    /* some browsers require a service-worker registration; skip silently */
  }
}

function hexToBytesSafe(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export { decodeInvite }
