import { useEffect, useMemo } from 'react'
import { useApp, getMessenger, getVault } from './store'
import { applyDisplayPrefs } from './displayPrefs'
import { useRoute, useNavigate, type Route } from './router'
import { I18nContext, LOCALE_DIRECTION, translate, type I18nContextValue } from '../i18n'
import { ChatList } from '../ui/screens/ChatList'
import { ChatView } from '../ui/screens/ChatView'
import { ContactDetail, ContactsList } from '../ui/screens/Contacts'
import { AddContact } from '../ui/screens/AddContact'
import { InviteScreen } from '../ui/screens/InviteScreen'
import { VerifyScreen } from '../ui/screens/VerifyScreen'
import { SettingsHome, PrivacySettings } from '../ui/screens/Settings'
import { RelaySettings } from '../ui/screens/RelaySettings'
import { SecuritySettings } from '../ui/screens/SecuritySettings'
import { DataSettings } from '../ui/screens/DataSettings'
import { AboutScreen } from '../ui/screens/AboutScreen'
import { Onboarding } from '../ui/screens/Onboarding'
import { LockScreen } from '../ui/screens/LockScreen'
import { BackupCeremony } from '../ui/screens/BackupCeremony'
import { ChatIcon, ContactsIcon, SettingsIcon } from '../ui/components/Icons'
import { Banner, Spinner } from '../ui/components/primitives'
import { EntryLayout } from '../ui/components/EntryLayout'
import { ConnectionBar } from '../ui/components/ConnectionStatus'
import { UpdatePrompt } from './UpdatePrompt'

export function App() {
  const phase = useApp((s) => s.phase)
  const settings = useApp((s) => s.settings)
  const boot = useApp((s) => s.boot)

  const i18n = useMemo<I18nContextValue>(
    () => ({
      locale: settings.locale,
      dir: LOCALE_DIRECTION[settings.locale],
      t: (key, values) => translate(settings.locale, key, values),
    }),
    [settings.locale],
  )

  useEffect(() => {
    void boot()
  }, [boot])

  // main.tsx has already done this once from the cache; this keeps <html> in
  // step with every later change, including the one that arrives when an
  // unlocked vault restores a preference the cache did not have.
  useEffect(() => {
    applyDisplayPrefs({ locale: settings.locale, theme: settings.theme })
  }, [settings.locale, settings.theme])

  return (
    <I18nContext.Provider value={i18n}>
      <Shell phase={phase} />
      <ToastRegion />
      <UpdatePrompt />
    </I18nContext.Provider>
  )
}

function Shell({ phase }: { phase: ReturnType<typeof useApp.getState>['phase'] }) {
  const route = useRoute()
  const t = useTranslate()
  const bootError = useApp((s) => s.bootError)

  useLifecycleEffects()

  if (phase === 'boot') {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner label={t('common.loading')} />
      </div>
    )
  }

  // Nothing here works, but the language switch still does — which is the
  // difference between a dead end and a message the reader can understand.
  if (phase === 'unsupported') {
    return (
      <div className="app-shell">
        <EntryLayout>
          <Banner tone="danger">{t('errors.unsupported')}</Banner>
          <p className="muted">{t('errors.storageBlocked')}</p>
          {bootError ? (
            <p className="hint mono" dir="ltr">
              {bootError}
            </p>
          ) : null}
        </EntryLayout>
      </div>
    )
  }

  if (phase === 'onboarding') {
    return (
      <div className="app-shell">
        <Onboarding />
      </div>
    )
  }

  if (phase === 'locked') {
    return (
      <div className="app-shell">
        <LockScreen />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <ConnectionBar />
      <BackupReminder />
      <BackupGate />
      <RouteView route={route} />
      <TabBar route={route} />
    </div>
  )
}

/**
 * A fresh identity is worthless without its recovery phrase, so the ceremony
 * takes over the whole screen until it is done or explicitly deferred. Once
 * deferred it degrades to a dismissible reminder rather than nagging on every
 * screen.
 */
function BackupGate() {
  const identity = useApp((s) => s.identity)
  const deferred = useApp((s) => s.backupDeferred)
  if (!identity || identity.mnemonicBackedUp || !identity.mnemonic) return null
  if (deferred) return null
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 50, overflow: 'auto' }}>
      <BackupCeremony mnemonic={identity.mnemonic} />
    </div>
  )
}

function BackupReminder() {
  const t = useTranslate()
  const identity = useApp((s) => s.identity)
  const deferred = useApp((s) => s.backupDeferred)
  const resumeBackup = useApp((s) => s.resumeBackup)
  if (!identity || identity.mnemonicBackedUp || !identity.mnemonic || !deferred) return null
  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) 0' }}>
      <Banner tone="warning">
        <span className="grow">{t('onboarding.backupTitle')}</span>
        <button className="btn btn-ghost small" onClick={() => resumeBackup()}>
          {t('common.show')}
        </button>
      </Banner>
    </div>
  )
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'chats':
      return <ChatList />
    case 'chat':
      // Keyed by peer so switching conversations remounts: composer draft,
      // scroll position, and reply state all reset cleanly.
      return <ChatView key={route.peer} peer={route.peer} />
    case 'contacts':
      return <ContactsList />
    case 'contact':
      return <ContactDetail peer={route.peer} />
    case 'add-contact':
      return <AddContact />
    case 'invite':
      return <InviteScreen payload={route.payload} />
    case 'verify':
      return <VerifyScreen peer={route.peer} />
    case 'settings':
      return <SettingsHome />
    case 'settings-relays':
      return <RelaySettings />
    case 'settings-privacy':
      return <PrivacySettings />
    case 'settings-security':
      return <SecuritySettings />
    case 'settings-data':
      return <DataSettings />
    case 'about':
      return <AboutScreen />
  }
}

/** The tab bar is hidden inside a conversation, where the header owns the back action. */
function TabBar({ route }: { route: Route }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const conversations = useApp((s) => s.conversations)
  const unread = conversations.reduce((total, conversation) => total + conversation.unread, 0)

  const immersive =
    route.name === 'chat' ||
    route.name === 'invite' ||
    route.name === 'verify' ||
    route.name === 'add-contact'
  if (immersive) return null

  const tabs: { route: Route; label: string; icon: React.ReactNode; badge?: number }[] = [
    { route: { name: 'chats' }, label: t('nav.chats'), icon: <ChatIcon size={21} />, badge: unread },
    { route: { name: 'contacts' }, label: t('nav.contacts'), icon: <ContactsIcon size={21} /> },
    { route: { name: 'settings' }, label: t('nav.settings'), icon: <SettingsIcon size={21} /> },
  ]

  // Sub-pages highlight their parent tab. Conversation and invite routes are
  // immersive and never reach here.
  const active = (name: Route['name']): boolean =>
    name === route.name ||
    (name === 'contacts' && route.name === 'contact') ||
    (name === 'settings' && (route.name.startsWith('settings') || route.name === 'about'))

  return (
    <nav className="tabbar" aria-label={t('nav.chats')}>
      {tabs.map((tab) => (
        <button
          key={tab.route.name}
          aria-current={active(tab.route.name) ? 'page' : undefined}
          onClick={() => navigate(tab.route)}
        >
          {tab.icon}
          <span>{tab.label}</span>
          {tab.badge && tab.badge > 0 ? (
            <span className="tab-badge">{tab.badge > 99 ? '99+' : tab.badge}</span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

function ToastRegion() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone === 'danger' ? 'toast-danger' : ''}`}>
          <span className="grow">{toast.message}</span>
          <button className="btn btn-ghost small" onClick={() => dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Cross-cutting browser lifecycle wiring:
 *  - user activity resets the auto-lock countdown
 *  - regaining focus or connectivity triggers a catch-up sync, since without
 *    push notifications that is the only moment new messages can arrive
 *  - hiding the tab optionally locks the vault
 */
function useLifecycleEffects(): void {
  const settings = useApp((s) => s.settings)
  const lock = useApp((s) => s.lock)
  const phase = useApp((s) => s.phase)

  useEffect(() => {
    if (phase !== 'ready') return
    const vault = getVault()
    const touch = () => vault.touch()
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'focus']
    for (const event of events) addEventListener(event, touch, { passive: true })
    return () => {
      for (const event of events) removeEventListener(event, touch)
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'ready') return

    const resync = () => void getMessenger()?.resync()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resync()
      else if (settings.lockOnHide) lock()
    }

    // Losing the network produces no relay event until sockets time out, so
    // take the browser's word for it and republish the state immediately.
    const onOffline = () => getMessenger()?.refreshSyncState()

    addEventListener('online', resync)
    addEventListener('offline', onOffline)
    addEventListener('focus', resync)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      removeEventListener('online', resync)
      removeEventListener('offline', onOffline)
      removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [phase, settings.lockOnHide, lock])

  // Persist relay health on the way out so ranking survives a restart.
  useEffect(() => {
    const onHide = () => void getMessenger()?.persistRelayHealth()
    addEventListener('pagehide', onHide)
    return () => removeEventListener('pagehide', onHide)
  }, [])
}

/** Small helper so components in this file can translate without prop drilling. */
function useTranslate() {
  const locale = useApp((s) => s.settings.locale)
  return useMemo(
    () => (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
      translate(locale, key, values),
    [locale],
  )
}
