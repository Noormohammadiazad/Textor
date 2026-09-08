import { lazy } from 'react'
import type { ChunkLoader } from '../app/warmup'

/**
 * Every screen and component that is not on the path from a cold start to a
 * conversation, loaded on demand.
 *
 * Each `import()` below is a split point: the bundler names what it reaches
 * `lazy-*`, the service worker leaves it out of the precache, and
 * `scripts/check-bundle.mjs` fails the build if anything in the shell imports
 * one of these modules statically (ADR-040). The loaders live in one table so
 * that the idle warm-up in `src/app/warmup.ts` fetches exactly the chunks the
 * app can ask for — a loader added here is warmed without anyone remembering
 * to list it twice.
 *
 * What stays in the shell is what a returning user needs before they can read
 * and answer a message: the lock screen, the chat list, a conversation, and the
 * contact list. Everything here is reached from one of those — or, like
 * onboarding, is only ever seen by someone who has no messages yet.
 */
export const LAZY_CHUNKS = {
  settings: () => import('./chunks/settings'),
  verify: () => import('./chunks/verify'),
  qr: () => import('./chunks/qr'),
  backup: () => import('./chunks/backup'),
  access: () => import('./chunks/access'),
  people: () => import('./chunks/people'),
  emoji: () => import('./emoji/EmojiPicker'),
  groups: () => import('./chunks/groups'),
  interactive: () => import('./chunks/interactive'),
  /*
   * Backup export and import, loaded when the button is pressed. Both the
   * settings chunk and the access chunk use it; imported statically by both,
   * the bundler hoisted it into a shared chunk that was not named `lazy-` and
   * so went straight back into the precache.
   */
  vaultTransfer: () => import('../core/vault/exportImport'),
} satisfies Record<string, ChunkLoader>

export const SettingsHome = lazy(() => LAZY_CHUNKS.settings().then((m) => ({ default: m.SettingsHome })))
export const PrivacySettings = lazy(() =>
  LAZY_CHUNKS.settings().then((m) => ({ default: m.PrivacySettings })),
)
export const RelaySettings = lazy(() => LAZY_CHUNKS.settings().then((m) => ({ default: m.RelaySettings })))
export const SecuritySettings = lazy(() =>
  LAZY_CHUNKS.access().then((m) => ({ default: m.SecuritySettings })),
)
export const DataSettings = lazy(() => LAZY_CHUNKS.settings().then((m) => ({ default: m.DataSettings })))
export const CallSettings = lazy(() => LAZY_CHUNKS.settings().then((m) => ({ default: m.CallSettings })))
export const AboutScreen = lazy(() => LAZY_CHUNKS.settings().then((m) => ({ default: m.AboutScreen })))

export const VerifyScreen = lazy(() => LAZY_CHUNKS.verify().then((m) => ({ default: m.VerifyScreen })))

export const AddContact = lazy(() => LAZY_CHUNKS.people().then((m) => ({ default: m.AddContact })))
export const ContactDetail = lazy(() => LAZY_CHUNKS.people().then((m) => ({ default: m.ContactDetail })))
export const InviteScreen = lazy(() => LAZY_CHUNKS.people().then((m) => ({ default: m.InviteScreen })))

export const QrCode = lazy(() => LAZY_CHUNKS.qr().then((m) => ({ default: m.QrCode })))
export const QrScanner = lazy(() => LAZY_CHUNKS.qr().then((m) => ({ default: m.QrScanner })))

export const BackupCeremony = lazy(() => LAZY_CHUNKS.backup().then((m) => ({ default: m.BackupCeremony })))

/** First run, which a returning user never sees (ADR-054). */
export const Onboarding = lazy(() => LAZY_CHUNKS.access().then((m) => ({ default: m.Onboarding })))

export const EmojiPicker = lazy(LAZY_CHUNKS.emoji)

export const NewGroup = lazy(() => LAZY_CHUNKS.groups().then((m) => ({ default: m.NewGroup })))
export const GroupInfo = lazy(() => LAZY_CHUNKS.groups().then((m) => ({ default: m.GroupInfo })))

export const PollCard = lazy(() => LAZY_CHUNKS.interactive().then((m) => ({ default: m.PollCard })))
export const ChecklistCard = lazy(() => LAZY_CHUNKS.interactive().then((m) => ({ default: m.ChecklistCard })))
export const PollComposer = lazy(() => LAZY_CHUNKS.interactive().then((m) => ({ default: m.PollComposer })))
export const ChecklistComposer = lazy(() =>
  LAZY_CHUNKS.interactive().then((m) => ({ default: m.ChecklistComposer })),
)
