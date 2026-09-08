import { create } from 'zustand'
import {
  NoVaultError,
  Vault,
  WrongPinError,
  WrongSecretError,
  type KeyslotSummary,
  type SlotEnrolment,
  type SlotSecret,
} from '../core/vault/vault'
import { VaultRepo } from '../core/vault/repo'
import { getDb, resetDb } from '../core/vault/db'
import { Messenger, type CallSignal, type SyncState } from '../core/engine/messenger'
import type { CallControl, CallManager, CallView } from '../core/calls/callManager'
import type { CallMedia } from '../core/models/call'
import { isOpeningOffer } from '../core/models/protocol'
import { supportsWebRtc } from '../core/transport/webrtc/directManager'
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
  isGroupAddress,
  type AppSettings,
  type ChatAddress,
  type Contact,
  type Conversation,
  type IdentityRecord,
  type Message,
  type Reaction,
  type RelayEntry,
  type Sticker,
  type StickerPack,
} from '../core/models/types'
import type { ChecklistSpec, InteractiveUpdate, PollSpec } from '../core/models/interactive'
import { detectLocale, translate, type TranslationKey } from '../i18n'
import { loadCallsChunk } from './callsChunk'
import { clearDisplayPrefs, loadDisplayPrefs, saveDisplayPrefs } from './displayPrefs'
import type { Attachment } from '../core/models/attachment'
import { blobRefKey } from '../core/crypto/blobCrypto'

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

/*
 * Reads of the database are asynchronous, and several can be in flight at once
 * — a message arriving, a conversation opening, and a refresh on a timer all
 * trigger one. They do not necessarily finish in the order they started, and
 * an older read landing last would put a stale snapshot on screen: an unread
 * badge that had already been cleared, or the previous conversation's
 * messages. Each read takes a ticket and is discarded if a newer one has
 * started in the meantime.
 */
let conversationsTicket = 0
let messagesTicket = 0

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
  /** The ways this vault opens, read before unlock: the lock screen is built from them. */
  keyslots: KeyslotSummary[]
  /**
   * Whether the lock screen may start the biometric prompt by itself. Only on
   * a cold start: after a lock the person may have walked away, and a prompt
   * appearing on its own at that moment would be a prompt to a passer-by.
   */
  autoPrompt: boolean
  /**
   * Session-only: this session was opened with the recovery phrase, so the
   * usual way in may be lost. The shell offers to set a new one.
   */
  openedWithRecovery: boolean
  /**
   * The vault recorded a passkey way in that this build no longer opens
   * (ADR-058). The lock screen says so, and once open the shell offers to
   * choose a new way.
   */
  passkeyRetired: boolean

  identity: IdentityRecord | null
  settings: AppSettings

  conversations: Conversation[]
  /**
   * Whether `conversations` has been read from the vault since it opened.
   * Until then an empty list means "not read yet", not "nothing there", and a
   * screen deciding that a group does not exist has to know which.
   */
  conversationsLoaded: boolean
  /** Conversation id -> the newest message, for the list preview. */
  previews: Map<string, Message>
  contacts: Map<string, Contact>
  relayStatuses: RelayStatus[]
  /**
   * The relays an invite should advertise, best first, space-separated. A
   * string so that screens re-render when the choice changes and not on every
   * relay status update.
   */
  inviteRelays: string
  relayEntries: RelayEntry[]
  syncState: SyncState

  /**
   * The conversation on screen: a person's public key, or a group's id (see
   * `ChatAddress`). Every action that writes to "the open conversation" reads
   * it from here, so a group and a direct conversation share every one of them.
   */
  activeChat: ChatAddress | null
  /** Reactions on the messages currently loaded, keyed by message id. */
  reactions: Map<string, Reaction[]>
  /** Votes and checklist changes on the messages currently loaded, keyed by message id. */
  updates: Map<string, InteractiveUpdate[]>
  /** Sticker packs held in this vault. */
  packs: StickerPack[]
  /** Whether the app is both visible and focused, i.e. actually being read. */
  windowFocused: boolean
  messages: Message[]
  /** How many messages the open conversation is currently showing. */
  messageLimit: number
  /** True when the conversation holds more history than is currently loaded. */
  hasEarlierMessages: boolean
  typingPeers: Set<string>
  directStates: Map<string, DirectState>

  /**
   * The call under way, ringing, or just ended; null when there is none.
   * Written by the calling subsystem, which is loaded only once a call is
   * placed or rings.
   */
  call: CallView | null

  toasts: Toast[]
  pendingInvite: Invite | null
  /**
   * Live transfer progress, keyed by copy (`blobRefKey`): two copies of one
   * file are two transfers.
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
  /** `protection` is the first way this device opens; the recovery phrase is always added too. */
  createVault: (args: { name: string; protection: SlotEnrolment; mnemonic?: string }) => Promise<string>
  unlock: (secret: SlotSecret) => Promise<void>
  /** Re-read the ways this vault opens, after one is added or removed. */
  refreshKeyslots: () => Promise<void>
  /** The lock screen has used its one unprompted biometric request. */
  consumeAutoPrompt: () => void
  dismissRecoveryNotice: () => void
  lock: () => void
  wipeDevice: () => Promise<void>

  refreshConversations: () => Promise<void>
  refreshContacts: () => Promise<void>
  refreshRelays: () => Promise<void>

  openConversation: (address: ChatAddress) => Promise<void>
  closeConversation: () => void
  /** The window became visible and focused, or stopped being either. */
  setWindowFocus: (focused: boolean) => void
  saveDraft: (address: ChatAddress, text: string) => Promise<void>
  loadMessages: (address: ChatAddress) => Promise<void>
  loadEarlierMessages: () => Promise<void>
  sendMessage: (text: string, replyTo?: string) => Promise<void>
  /** Send a file, picture, video, or voice note to the open conversation. */
  sendAttachment: (input: SendAttachmentInput, replyTo?: string) => Promise<void>
  /** Decrypt a stored payload and hand back an object URL for playback. */
  openAttachment: (attachment: Attachment) => Promise<string | null>
  /** Add a reaction, change it, or take it back by repeating it. */
  react: (messageId: string, emoji: string) => Promise<void>
  /** Start a group; resolves to its address, or null if it could not be made. */
  createGroup: (members: string[], subject: string) => Promise<ChatAddress | null>
  /**
   * Start a forward-secret group. Throws, for the screen to explain, rather
   * than toasting: the reasons need words only the groups chunk carries.
   */
  createSecureGroup: (members: string[], subject: string) => Promise<{ id: ChatAddress; missing: string[] }>
  /** Change a forward-secret group: add, remove, refresh keys, or leave. Throws likewise. */
  changeSecureGroup: (
    id: ChatAddress,
    change: { add?: string[]; remove?: string; rotate?: true; leave?: true },
  ) => Promise<{ missing: string[] }>
  /** Take a group someone outside the address book started. */
  acceptGroup: (id: string) => Promise<void>
  /** Remove a conversation and its history from this device. */
  deleteConversation: (id: string) => Promise<void>
  sendPoll: (poll: PollSpec) => Promise<boolean>
  sendChecklist: (checklist: ChecklistSpec) => Promise<boolean>
  vote: (pollId: string, choices: string[]) => Promise<void>
  checkItem: (listId: string, itemId: string, done: boolean) => Promise<void>
  addChecklistItem: (listId: string, label: string) => Promise<void>
  loadPacks: () => Promise<void>
  importStickerPack: (
    name: string,
    images: { bytes: Uint8Array; mime: string; width?: number; height?: number }[],
  ) => Promise<void>
  deleteStickerPack: (id: string) => Promise<void>
  sendSticker: (sticker: Sticker) => Promise<void>
  openSticker: (sticker: Sticker) => Promise<string | null>
  retryMessage: (messageId: string) => Promise<void>
  deleteMessageLocally: (messageId: string) => Promise<void>
  /** Delete here and ask the peer to delete their copy too. */
  deleteMessageForEveryone: (messageId: string) => Promise<void>
  setTyping: (active: boolean) => void

  /** Call someone in the address book. */
  startCall: (peer: string, media: CallMedia) => Promise<void>
  /** Answer, decline, hang up, mute and the rest, for the call on screen. */
  callControl: (action: CallControl) => void

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
  myInvite: (relays: string) => string | null
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
 * Deliberately does *not* test `crypto.subtle`: all primitives come from
 * @noble in pure JavaScript, and Dexie guards its own optional use of it. The
 * one exception is opening instantly, whose key is a non-extractable WebCrypto
 * key — and that is offered only where WebCrypto exists (ADR-054). Gating on
 * `subtle` would refuse to start in any non-secure context (a plain-http LAN
 * address during development, say) for a capability nothing else needs.
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
  keyslots: [],
  autoPrompt: true,
  openedWithRecovery: false,
  passkeyRetired: false,

  identity: null,
  // Seeded from the pre-unlock cache so the lock screen already speaks the
  // user's language; the encrypted record overwrites this on unlock.
  settings: { ...DEFAULT_SETTINGS, locale: detectLocale(), ...loadDisplayPrefs() },

  conversations: [],
  conversationsLoaded: false,
  previews: new Map(),
  contacts: new Map(),
  relayStatuses: [],
  inviteRelays: '',
  relayEntries: [],
  syncState: {
    online: true,
    connectedRelays: 0,
    totalRelays: 0,
    pendingOutbox: 0,
    lastSyncAt: 0,
    syncing: false,
  },

  activeChat: null,
  reactions: new Map(),
  updates: new Map(),
  packs: [],
  windowFocused: true,
  messages: [],
  messageLimit: DEFAULT_MESSAGE_PAGE,
  hasEarlierMessages: false,
  typingPeers: new Set(),
  directStates: new Map(),

  call: null,

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
      if (status === 'empty') {
        set({ phase: 'onboarding' })
      } else {
        // Before anything opens: drops what this build does not allow, among
        // it an instant slot beside a way in that asks for something.
        const { retired: passkeyRetired } = await vault.tidy()
        const keyslots = await vault.keyslots()
        set({ keyslots, passkeyRetired })
        // Open instantly, if that is what this device was set to do. Tried
        // before the lock screen is shown, so it never flashes past.
        if (!keyslots.some((slot) => slot.type === 'device') || !(await openWithDevice(get))) {
          set({ phase: 'locked' })
        }
      }
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
        set({
          phase: 'locked',
          identity: null,
          messages: [],
          activeChat: null,
          conversations: [],
          conversationsLoaded: false,
          call: null,
        })
      }
    })
    vault.events.on('autoLocked', () => set({ autoLocked: true }))
  },

  async createVault({ name, protection, mnemonic }) {
    const created = mnemonic ? { identity: identityFromMnemonic(mnemonic), mnemonic } : makeIdentity()

    // A vault left open without an identity — an attempt that stopped
    // part-way — gains the new way in rather than being made twice.
    if (vault.isUnlocked) await vault.addSlot(protection)
    else await vault.create(protection)
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

  async unlock(secret) {
    try {
      await vault.unlockWith(secret)
    } catch (err) {
      if (err instanceof NoVaultError) {
        // Storage was cleared out from under us. Start over rather than
        // stranding the user on a lock screen for a vault that is gone.
        set({ phase: 'onboarding', identity: null })
        return
      }
      if (!(err instanceof WrongSecretError)) log.error('unlock failed', err)
      // Too many wrong tries erased the PIN: the lock screen offers what is left.
      if (err instanceof WrongPinError && err.triesLeft === 0) set({ keyslots: await vault.keyslots() })
      throw err
    }
    set({ autoLocked: false, autoPrompt: false, openedWithRecovery: secret.type === 'recovery' })
    await startSession(set, get)
  },

  async refreshKeyslots() {
    set({ keyslots: await vault.keyslots() })
  },

  consumeAutoPrompt() {
    set({ autoPrompt: false })
  },

  dismissRecoveryNotice() {
    set({ openedWithRecovery: false, passkeyRetired: false })
  },

  lock() {
    revokeBlobUrls()
    teardownMessenger()
    vault.lock('manual')
    set({
      phase: 'locked',
      autoPrompt: false,
      openedWithRecovery: false,
      // Dropped by the unlock that came before this lock.
      passkeyRetired: false,
      identity: null,
      messages: [],
      activeChat: null,
      conversations: [],
      conversationsLoaded: false,
      reactions: new Map(),
      updates: new Map(),
      packs: [],
      call: null,
    })
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
    const ticket = ++conversationsTicket
    const conversations = await repo.listConversations()
    // One decryption per conversation, not per message: `listMessages` walks
    // the index backwards and stops at the first row.
    const previews = new Map<string, Message>()
    for (const conversation of conversations) {
      const [newest] = await repo.listMessages(conversation.id, 1)
      if (newest) previews.set(conversation.id, newest)
    }
    if (ticket !== conversationsTicket) return
    set({ conversations, previews, conversationsLoaded: true })
  },

  async refreshContacts() {
    if (!vault.isUnlocked) return
    const list = await repo.listContacts()
    set({ contacts: new Map(list.map((contact) => [contact.pubkey, contact])) })
  },

  async refreshRelays() {
    if (!vault.isUnlocked) return
    const entries = (await messenger?.reloadRelays()) ?? (await repo.listRelays())
    set({
      relayEntries: entries,
      relayStatuses: messenger?.pool.statuses() ?? [],
      inviteRelays: messenger?.pool.rankedReadRelays(4).join(' ') ?? '',
    })
  },

  async openConversation(address) {
    // Before anything is awaited: a message can arrive while the history is
    // still loading, and it belongs to a conversation that is already on
    // screen, so it must not be counted as unread.
    //
    // Always focused, whatever the window is believed to be doing: opening a
    // conversation is an act of reading it. A browser that never reports focus
    // — or reported a blur that was never followed by a focus — would
    // otherwise leave the badge on a conversation being read, which is the
    // defect this fixes rather than a version of it.
    messenger?.setActiveConversation(address, { focused: true })
    // Reset the window: opening a conversation should not inherit however far
    // back the previous one had been scrolled.
    set({ activeChat: address, messages: [], messageLimit: DEFAULT_MESSAGE_PAGE })
    await get().loadMessages(address)
    // Navigating away while the history loads abandons the rest: telling the
    // engine to watch a conversation that has since been closed would stop it
    // counting anything that arrives there afterwards.
    if (get().activeChat !== address) return
    await messenger?.openConversation(address)
    if (get().activeChat !== address) return
    await get().refreshConversations()
  },

  closeConversation() {
    messenger?.setActiveConversation(null)
    set({ activeChat: null, messages: [] })
    // The badge this conversation no longer has must be gone from the list
    // being navigated back to, rather than arriving a refresh later.
    void get().refreshConversations()
  },

  setWindowFocus(focused) {
    if (get().windowFocused === focused) return
    set({ windowFocused: focused })
    // Messages that arrived while the window was hidden or in the background
    // were counted; coming back is what marks them read.
    messenger?.setActiveConversation(get().activeChat, { focused })
  },

  async saveDraft(address, text) {
    if (!vault.isUnlocked || !messenger) return
    const draft = text.trim() ? text : undefined
    const convoId = messenger.conversationIdFor(address)
    let existing = await repo.getConversation(convoId)

    // A conversation row is normally created by the first message. Someone who
    // opens a brand-new contact and types without sending has no row yet, and
    // dropping the draft on the floor is exactly the case this feature exists
    // to prevent — so create it, but only when there is something to keep.
    if (!existing) {
      // A group always has a row; only a direct conversation can lack one.
      if (!draft || isGroupAddress(address)) return
      existing = await repo.ensureConversation(messenger.pubkey, address)
    }
    if (existing.draft === draft) return

    await repo.updateConversation(convoId, { draft })
    await get().refreshConversations()
  },

  async loadMessages(address) {
    if (!vault.isUnlocked || !messenger) return
    const ticket = ++messagesTicket
    const convoId = messenger.conversationIdFor(address)
    const limit = get().messageLimit
    const [messages, total] = await Promise.all([
      repo.listMessages(convoId, limit),
      repo.countMessages(convoId),
    ])
    // Only for the page on screen: a conversation with years of history would
    // otherwise decrypt every reaction it ever received to draw one screenful.
    const ids = messages.map((message) => message.id)
    const [reactions, updates] = await Promise.all([repo.listReactionsFor(ids), repo.listUpdatesFor(ids)])
    // Discarded if a newer load started, or if this is no longer the
    // conversation on screen — both happen when navigating quickly.
    if (ticket !== messagesTicket || get().activeChat !== address) return
    set({
      messages,
      // Only what was addressed to this conversation. A message id is not a
      // secret, and something sealed to a different set of people that names
      // one must not appear on it — the same rule the poll count applies.
      reactions: groupBy(
        reactions.filter((reaction) => reaction.convoId === convoId),
        (reaction) => reaction.messageId,
      ),
      updates: groupBy(
        updates.filter((update) => update.convoId === convoId),
        (update) => update.targetId,
      ),
      hasEarlierMessages: total > messages.length,
    })
  },

  async loadEarlierMessages() {
    const address = get().activeChat
    if (!address) return
    set({ messageLimit: get().messageLimit + DEFAULT_MESSAGE_PAGE })
    await get().loadMessages(address)
  },

  async sendMessage(text, replyTo) {
    const address = get().activeChat
    if (!address || !messenger) return
    try {
      await messenger.sendMessage(address, text, replyTo)
      await get().loadMessages(address)
      await get().refreshConversations()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  async sendAttachment(input, replyTo) {
    const address = get().activeChat
    if (!address || !messenger) return
    try {
      await messenger.sendAttachment(address, input, replyTo)
      await get().loadMessages(address)
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

  async react(messageId, emoji) {
    const address = get().activeChat
    if (!address || !messenger) return
    await messenger.react(address, messageId, emoji)
    await get().loadMessages(address)
  },

  async createGroup(members, subject) {
    if (!messenger) return null
    try {
      const group = await messenger.createGroup(members, subject)
      await get().refreshConversations()
      return group.id
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
      return null
    }
  },

  async createSecureGroup(members, subject) {
    if (!messenger) throw new Error('not running')
    const created = await messenger.createSecureGroup(members, subject)
    await get().refreshConversations()
    return created
  },

  async changeSecureGroup(id, change) {
    if (!messenger) throw new Error('not running')
    let missing: string[] = []
    if (change.add) missing = (await messenger.addGroupMembers(id, change.add)).missing
    if (change.remove) await messenger.removeGroupMember(id, change.remove)
    if (change.rotate) await messenger.rotateGroupKeys(id)
    if (change.leave) await messenger.leaveGroup(id)
    await get().refreshConversations()
    return { missing }
  },

  async acceptGroup(id) {
    await repo.updateConversation(id, { accepted: true })
    await get().refreshConversations()
  },

  async deleteConversation(id) {
    // A forward-secret group is left, not just forgotten: otherwise the others
    // keep encrypting to keys this device no longer holds.
    await messenger?.leaveGroup(id).catch(() => undefined)
    await repo.deleteConversation(id)
    await get().refreshConversations()
  },

  async sendPoll(poll) {
    return runInActive(get, async (address) => {
      await messenger?.sendPoll(address, poll)
    })
  },

  async sendChecklist(checklist) {
    return runInActive(get, async (address) => {
      await messenger?.sendChecklist(address, checklist)
    })
  },

  async vote(pollId, choices) {
    await runInActive(get, async (address) => {
      await messenger?.vote(address, pollId, choices)
    })
  },

  async checkItem(listId, itemId, done) {
    await runInActive(get, async (address) => {
      await messenger?.checkItem(address, listId, itemId, done)
    })
  },

  async addChecklistItem(listId, label) {
    await runInActive(get, async (address) => {
      await messenger?.addChecklistItem(address, listId, label)
    })
  },

  async loadPacks() {
    if (!vault.isUnlocked) return
    set({ packs: await repo.listPacks() })
  },

  async importStickerPack(name, images) {
    if (!messenger) return
    await messenger.importStickerPack(name, images)
    await get().loadPacks()
  },

  async deleteStickerPack(id) {
    if (!messenger) return
    await messenger.deleteStickerPack(id)
    await get().loadPacks()
  },

  async sendSticker(sticker) {
    await runInActive(get, async (address) => {
      await messenger?.sendSticker(address, sticker)
    })
  },

  async openSticker(sticker) {
    const cached = blobUrls.get(sticker.id)
    if (cached) return cached
    const bytes = await messenger?.readSticker(sticker)
    if (!bytes) return null
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: sticker.mime }))
    blobUrls.set(sticker.id, url)
    return url
  },

  async retryMessage(messageId) {
    await messenger?.retryMessage(messageId)
    const address = get().activeChat
    if (address) await get().loadMessages(address)
  },

  async deleteMessageForEveryone(messageId) {
    const address = get().activeChat
    if (!address || !messenger) return
    try {
      await messenger.redactMessage(address, messageId)
      await get().loadMessages(address)
      await get().refreshConversations()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  async deleteMessageLocally(messageId) {
    // Local delete takes the payload with it when nothing else refers to it,
    // so "delete" does not quietly leave megabytes on the device — and leaves
    // a tombstone, so a copy still on its way does not bring it back.
    if (messenger) await messenger.deleteLocally(messageId)
    else await repo.deleteMessageAndPayload(messageId)
    const address = get().activeChat
    if (address) await get().loadMessages(address)
    await get().refreshConversations()
  },

  setTyping(active) {
    const address = get().activeChat
    if (address) messenger?.setTyping(address, active)
  },

  async startCall(peer, media) {
    const refuse = (key: TranslationKey) => get().toast(translate(get().settings.locale, key), 'danger')
    if (!messenger) return
    if (!supportsWebRtc()) return refuse('calls.unsupported')
    if (isCallLive(get().call)) return refuse('calls.alreadyInCall')
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return refuse('calls.offline')
    if (!get().contacts.get(peer)?.accepted) return refuse('calls.acceptFirst')
    let manager: CallManager
    try {
      manager = await ensureCalls(set, get)
    } catch (err) {
      log.warn('calling could not load', err)
      return refuse('calls.loadFailed')
    }
    try {
      await manager.place(peer, media)
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'danger')
    }
  },

  callControl(action) {
    void calls?.control(action)
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

  myInvite(relays) {
    const identity = get().identity
    if (!identity || !messenger) return null
    const secretKey = hexToBytesSafe(identity.secretKeyHex)
    if (!secretKey) return null
    try {
      return createInvite(secretKey, {
        name: identity.name,
        // Best-ranked, not first-stored (see `inviteRelays`): whoever scans
        // this reaches us through these, and storage order once put two dead
        // relays in every invite.
        relays: relays ? relays.split(' ') : messenger.pool.rankedReadRelays(4),
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

/** Open a vault set to open instantly. False, having said why, if it did not. */
async function openWithDevice(get: Getter): Promise<boolean> {
  try {
    await get().unlock({ type: 'device' })
    return true
  } catch (err) {
    log.warn('this device could not open the vault by itself', err)
    return false
  }
}

/**
 * Let the recovery phrase open this vault, if it cannot yet. Every vault made
 * before keyslots gains the slot the first time it opens, and forgetting its
 * passphrase stops meaning losing its history (ADR-054).
 */
async function ensureRecoverySlot(identity: IdentityRecord): Promise<void> {
  if (!identity.mnemonic) return
  if ((await vault.keyslots()).some((slot) => slot.type === 'recovery')) return
  try {
    await vault.addSlot({ type: 'recovery', mnemonic: identity.mnemonic })
  } catch (err) {
    log.warn('the recovery phrase could not be set to open this vault', err)
  }
}

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
  await ensureRecoverySlot(identity)
  set({ keyslots: await vault.keyslots() })

  const pending = get().pendingDisplayPrefs
  const settings = pending ? await repo.saveSettings(pending) : await repo.getSettings()
  vault.configureAutoLock(settings.autoLockMinutes)

  teardownMessenger()
  messenger = new Messenger(vault, repo, settings)

  messenger.events.on('message', ({ message }) => {
    const state = get()
    const active = state.activeChat
    if (active && message.convoId === messenger?.conversationIdFor(active)) void state.loadMessages(active)
    void state.refreshConversations()
    // A call that was answered or declined here needs no telling about; a
    // missed one does, like a message.
    if (message.direction === 'in' && (!message.call || message.call.outcome === 'missed')) {
      notify(message, get)
    }
  })

  messenger.events.on('messageUpdated', (updated) => {
    set({
      messages: get().messages.map((message) => (message.id === updated.id ? updated : message)),
    })
  })

  // Reloaded even when the change is to a message not on screen: the check
  // would cost the same read the reload does.
  const reloadActive = () => {
    const address = get().activeChat
    if (address) void get().loadMessages(address)
  }
  messenger.events.on('reactionsChanged', reloadActive)
  messenger.events.on('updatesChanged', reloadActive)

  messenger.events.on('packsChanged', () => void get().loadPacks())

  messenger.events.on('conversationsChanged', () => void get().refreshConversations())
  messenger.events.on('contactsChanged', () => void get().refreshContacts())
  messenger.events.on('relayStatus', (relayStatuses) =>
    set({ relayStatuses, inviteRelays: messenger?.pool.rankedReadRelays(4).join(' ') ?? '' }),
  )
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

  messenger.events.on('blobProgress', ({ id, copy, received, total }) => {
    const blobProgress = new Map(get().blobProgress)
    blobProgress.set(blobRefKey({ id, copy }), { received, total })
    set({ blobProgress })
  })

  messenger.events.on('messagesRedacted', () => {
    reloadActive()
    void get().refreshConversations()
  })

  messenger.events.on('blobComplete', ({ id, copy }) => {
    const blobProgress = new Map(get().blobProgress)
    blobProgress.delete(blobRefKey({ id, copy }))
    set({ blobProgress })
    // The payload changed from "arriving" to "playable", and the bubble reads
    // that from the message list.
    reloadActive()
  })

  messenger.events.on('error', ({ message }) => log.warn(`engine: ${message}`))

  messenger.events.on('callSignal', (signal) => routeCallSignal(signal, set, get))

  await messenger.start(identity.secretKeyHex, identity.pubkey)

  set({ phase: 'ready', identity, settings, pendingDisplayPrefs: null })
  saveDisplayPrefs({ locale: settings.locale, theme: settings.theme })
  await Promise.all([
    get().refreshConversations(),
    get().refreshContacts(),
    get().refreshRelays(),
    get().loadPacks(),
  ])
}

function teardownMessenger(): void {
  // Hang up first, while the engine can still queue the goodbye.
  calls?.dispose()
  calls = null
  callsLoading = null
  callSignals = Promise.resolve()
  holdVaultOpen(false)
  if (!messenger) return
  void messenger.persistRelayHealth().catch(() => undefined)
  messenger.stop()
  messenger.events.clear()
  messenger = null
}

/*
 * Calls.
 *
 * The calling subsystem is a lazy chunk, fetched the first time a call is
 * placed or an offer rings (ADR-046). Until then this bridge is all of it that
 * exists: it hands signals over in order, loads the chunk when one needs it,
 * and keeps the vault open for as long as a call is live.
 */
let calls: CallManager | null = null
let callsLoading: Promise<CallManager> | null = null
/** Signals go over strictly in order: an answer must not overtake its offer. */
let callSignals: Promise<void> = Promise.resolve()
let vaultKeepAlive: ReturnType<typeof setInterval> | null = null

/** A call that is ringing, connecting or connected — anything but over. */
export const isCallLive = (call: CallView | null): boolean => call !== null && call.phase !== 'ended'

function ensureCalls(set: Setter, get: Getter): Promise<CallManager> {
  if (calls) return Promise.resolve(calls)
  callsLoading ??= loadCallsChunk()
    .then((chunk) => {
      const engine = messenger
      if (!engine) throw new Error('the vault is locked')
      const manager = chunk.createCallManager(engine)
      manager.events.on('changed', (call) => onCallChanged(call, set, get))
      calls = manager
      return manager
    })
    .finally(() => {
      callsLoading = null
    })
  return callsLoading
}

function routeCallSignal(signal: CallSignal, set: Setter, get: Getter): void {
  callSignals = callSignals
    .then(async () => {
      const { frame } = signal
      // With nothing loaded, only an offer can start anything: any other
      // signal belongs to a call this device is not in.
      if (!calls && !isOpeningOffer(frame)) return
      let manager: CallManager
      try {
        manager = await ensureCalls(set, get)
      } catch (err) {
        log.warn('calling could not load for an incoming call', err)
        if (!isOpeningOffer(frame)) return
        // A deployment replaced the chunk this build knows about. The call
        // cannot ring, but it must not vanish either.
        await messenger?.recordCall(
          signal.peerPubkey,
          signal.callId,
          'in',
          { media: frame.media, outcome: 'missed' },
          signal.at,
        )
        get().toast(
          translate(get().settings.locale, 'calls.missedLoad', { name: nameOf(signal.peerPubkey, get) }),
          'danger',
        )
        return
      }
      await manager.handleSignal(signal.peerPubkey, frame, signal.callId, signal.at)
    })
    .catch((err: unknown) => log.warn('a call signal could not be handled', err))
}

function onCallChanged(call: CallView | null, set: Setter, get: Getter): void {
  const wasLive = isCallLive(get().call)
  set({ call })
  const live = isCallLive(call)
  holdVaultOpen(live)
  // Lock-on-hide waited for the call, since sharing a screen or switching
  // tabs mid-call is ordinary. It is over now, so honour it.
  if (wasLive && !live && get().settings.lockOnHide && document.visibilityState === 'hidden') {
    setTimeout(() => get().lock(), 0)
  }
}

/**
 * A call is activity, even with nobody touching the screen: the idle timer
 * must not lock the vault — and with it hang up — in the middle of one.
 */
function holdVaultOpen(hold: boolean): void {
  if (hold && !vaultKeepAlive) {
    vault.touch()
    vaultKeepAlive = setInterval(() => vault.touch(), 30_000)
  } else if (!hold && vaultKeepAlive) {
    clearInterval(vaultKeepAlive)
    vaultKeepAlive = null
    vault.touch()
  }
}

function nameOf(pubkey: string, get: Getter): string {
  const contact = get().contacts.get(pubkey)
  return contact?.name || contact?.remoteName || shortNpub(toNpub(pubkey))
}

/**
 * Run an action against the conversation on screen, then show its result.
 * Resolves false, having said why, when the action was refused.
 */
async function runInActive(get: Getter, action: (address: ChatAddress) => Promise<void>): Promise<boolean> {
  const address = get().activeChat
  if (!address || !messenger) return false
  try {
    await action(address)
    await get().loadMessages(address)
    return true
  } catch (err) {
    get().toast(err instanceof Error ? err.message : String(err), 'danger')
    return false
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const list = out.get(key(item))
    if (list) list.push(item)
    else out.set(key(item), [item])
  }
  return out
}

/** Desktop notification for an incoming message while the tab is hidden. */
function notify(message: Message, get: Getter): void {
  const { settings, conversations } = get()
  if (!settings.notificationsEnabled) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return

  const author = nameOf(message.authorPubkey, get)
  // A group is named by the group, so the notification says where to look.
  const group = conversations.find(
    (conversation) => conversation.id === message.convoId && conversation.kind === 'group',
  )
  const title = group ? `${group.subject || author} · ${author}` : author
  try {
    // A message's text is deliberately left out: a notification banner is
    // readable by anyone glancing at the screen, and this is a private
    // messenger. A missed call carries only the words "missed call", which
    // reveal nothing the title does not.
    const body = message.call
      ? translate(settings.locale, message.call.media === 'video' ? 'calls.missedVideo' : 'calls.missedVoice')
      : undefined
    new Notification(title, { tag: message.convoId, silent: false, ...(body ? { body } : {}) })
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
