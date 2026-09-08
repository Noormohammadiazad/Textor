import { useApp } from '../../app/store'
import { useI18n, LOCALE_NAMES } from '../../i18n'
import { goBack, useNavigate } from '../../app/router'
import { Avatar, Banner, Field, Toggle } from '../components/primitives'
import {
  BackIcon,
  ChevronIcon,
  GlobeIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  ShieldIcon,
  SunIcon,
  DownloadIcon,
} from '../components/Icons'
import { SegmentedControl } from '../components/SegmentedControl'
import type { LocaleCode, ThemePreference } from '../../core/models/types'
import { APP_VERSION, SOURCE_URL } from '../../app/meta'

export function SettingsHome() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const identity = useApp((s) => s.identity)
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const updateProfile = useApp((s) => s.updateProfile)
  const lock = useApp((s) => s.lock)
  const toast = useApp((s) => s.toast)

  if (!identity) return null

  const pickAvatar = async (file: File) => {
    if (file.size > 1024 * 1024) {
      toast(t('settings.avatarTooLarge'), 'danger')
      return
    }
    const dataUri = await downscaleToDataUri(file, 192)
    if (!dataUri) {
      toast(t('errors.generic'), 'danger')
      return
    }
    await updateProfile({ avatar: dataUri })
  }

  return (
    <div className="screen">
      <header className="app-header">
        <h1 className="grow">{t('settings.title')}</h1>
      </header>

      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '34rem' }}>
          <span className="section-title">{t('settings.profile')}</span>
          <div className="card stack">
            <div className="row">
              <Avatar name={identity.name} seed={identity.pubkey} src={identity.avatar} size="lg" />
              <div className="grow stack-sm">
                <span style={{ fontWeight: 600 }}>{identity.name}</span>
                <code className="mono faint" style={{ wordBreak: 'break-all' }}>
                  {identity.npub}
                </code>
              </div>
            </div>
            <p className="hint">{t('settings.profileBody')}</p>

            {/*
              Uncontrolled and keyed by the stored value: the vault is the
              source of truth, edits commit on blur, and a profile update from
              anywhere else re-seeds the field by remounting it. Mirroring the
              identity into component state instead would mean a setState in an
              effect and a render cascade on every keystroke elsewhere.
            */}
            <Field label={t('settings.displayName')}>
              <input
                key={`name:${identity.name}`}
                className="input"
                defaultValue={identity.name}
                maxLength={64}
                onBlur={(event) => {
                  const next = event.target.value.trim()
                  if (next && next !== identity.name) void updateProfile({ name: next })
                }}
              />
            </Field>

            <Field label={t('settings.about')}>
              <input
                key={`about:${identity.about}`}
                className="input"
                defaultValue={identity.about}
                maxLength={200}
                onBlur={(event) => {
                  if (event.target.value !== identity.about) void updateProfile({ about: event.target.value })
                }}
              />
            </Field>

            <div className="row">
              <label className="btn btn-outline grow">
                {t('settings.avatarChoose')}
                <input
                  type="file"
                  accept="image/*"
                  className="visually-hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void pickAvatar(file)
                  }}
                />
              </label>
              {identity.avatar ? (
                <button className="btn btn-ghost" onClick={() => void updateProfile({ avatar: undefined })}>
                  {t('settings.avatarRemove')}
                </button>
              ) : null}
            </div>
          </div>

          <span className="section-title">{t('settings.appearance')}</span>
          <div className="card-section">
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <Field label={t('settings.language')}>
                <select
                  className="input select"
                  value={settings.locale}
                  onChange={(event) => void saveSettings({ locale: event.target.value as LocaleCode })}
                >
                  {(Object.keys(LOCALE_NAMES) as LocaleCode[]).map((code) => (
                    <option key={code} value={code}>
                      {LOCALE_NAMES[code]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              {/* The same control as on the entry screens, so the theme switch
                  looks and behaves identically wherever it is met. */}
              <Field label={t('settings.theme')}>
                <SegmentedControl
                  label={t('settings.theme')}
                  value={settings.theme}
                  options={[
                    { value: 'system', label: t('settings.themeSystem'), icon: <MonitorIcon size={15} /> },
                    { value: 'light', label: t('settings.themeLight'), icon: <SunIcon size={15} /> },
                    { value: 'dark', label: t('settings.themeDark'), icon: <MoonIcon size={15} /> },
                  ]}
                  onChange={(theme: ThemePreference) => void saveSettings({ theme })}
                />
              </Field>
            </div>
            <Toggle
              label={t('settings.enterToSend')}
              checked={settings.enterToSend}
              onChange={(enterToSend) => void saveSettings({ enterToSend })}
            />
          </div>

          <div className="card-section">
            <NavRow
              icon={<GlobeIcon size={18} />}
              label={t('settings.relays')}
              onClick={() => navigate({ name: 'settings-relays' })}
            />
            <NavRow
              icon={<ShieldIcon size={18} />}
              label={t('settings.privacy')}
              onClick={() => navigate({ name: 'settings-privacy' })}
            />
            <NavRow
              icon={<LockIcon size={18} />}
              label={t('settings.security')}
              onClick={() => navigate({ name: 'settings-security' })}
            />
            <NavRow
              icon={<DownloadIcon size={18} />}
              label={t('settings.data')}
              onClick={() => navigate({ name: 'settings-data' })}
            />
          </div>

          <span className="section-title">{t('settings.aboutSection')}</span>
          <div className="card-section">
            <NavRow label={t('settings.whatLeaves')} onClick={() => navigate({ name: 'about' })} />
            <a className="list-row" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
              <span className="grow">{t('settings.sourceCode')}</span>
              <ChevronIcon size={16} />
            </a>
            <div className="list-row" style={{ cursor: 'default' }}>
              <span className="grow muted">{t('settings.version')}</span>
              <code className="mono small">{APP_VERSION}</code>
            </div>
          </div>

          <button className="btn btn-outline btn-block" onClick={() => lock()}>
            <LockIcon size={16} />
            {t('settings.lockNow')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function NavRow({
  icon,
  label,
  onClick,
}: {
  icon?: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button className="list-row" onClick={onClick}>
      {icon ? <span style={{ color: 'var(--text-muted)' }}>{icon}</span> : null}
      <span className="grow">{label}</span>
      <ChevronIcon size={16} style={{ color: 'var(--text-faint)' }} />
    </button>
  )
}

export function SettingsPage({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="screen">
      <header className="app-header">
        <button
          className="btn btn-icon"
          aria-label={t('common.back')}
          onClick={() => goBack({ name: 'settings' })}
        >
          <BackIcon />
        </button>
        <h1 className="grow">{title}</h1>
      </header>
      <div className="screen-scroll">
        <div className="container stack" style={{ maxWidth: '34rem' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function PrivacySettings() {
  const { t } = useI18n()
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)

  const notificationsBlocked = typeof Notification === 'undefined' || Notification.permission === 'denied'

  /**
   * Ask for permission at the moment the user turns the toggle on, never on
   * page load. A permission prompt that appears unprompted is the fastest way
   * to get permanently denied.
   */
  const setNotifications = async (enabled: boolean) => {
    if (!enabled) {
      await saveSettings({ notificationsEnabled: false })
      return
    }
    if (typeof Notification === 'undefined') return
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (permission !== 'granted') {
      toast(t('settings.notificationsDenied'), 'danger')
      return
    }
    await saveSettings({ notificationsEnabled: true })
  }

  return (
    <SettingsPage title={t('settings.privacy')}>
      <div className="card-section">
        <Toggle
          label={t('settings.notifications')}
          description={t('settings.notificationsBody')}
          checked={settings.notificationsEnabled && !notificationsBlocked}
          disabled={notificationsBlocked}
          onChange={(enabled) => void setNotifications(enabled)}
        />
        <Toggle
          label={t('settings.readReceipts')}
          checked={settings.sendReadReceipts}
          onChange={(sendReadReceipts) => void saveSettings({ sendReadReceipts })}
        />
        <Toggle
          label={t('settings.typingIndicators')}
          checked={settings.sendTypingIndicators}
          onChange={(sendTypingIndicators) => void saveSettings({ sendTypingIndicators })}
        />
        <Toggle
          label={t('settings.directConnection')}
          description={t('settings.directConnectionBody')}
          checked={settings.enableDirectConnection}
          onChange={(enableDirectConnection) => void saveSettings({ enableDirectConnection })}
        />
        <Toggle
          label={t('settings.publicProfile')}
          description={t('settings.publicProfileBody')}
          checked={settings.publishPublicProfile}
          onChange={(publishPublicProfile) => void saveSettings({ publishPublicProfile })}
        />
      </div>

      <div className="card stack-sm">
        <Field label={t('settings.retention')}>
          <select
            className="input select"
            value={settings.retention}
            onChange={(event) =>
              void saveSettings({ retention: event.target.value as typeof settings.retention })
            }
          >
            <option value="forever">{t('settings.retentionForever')}</option>
            <option value="90d">{t('settings.retentionDays', { n: 90 })}</option>
            <option value="30d">{t('settings.retentionDays', { n: 30 })}</option>
            <option value="7d">{t('settings.retentionDays', { n: 7 })}</option>
          </select>
        </Field>
      </div>

      <div className="card stack-sm">
        <Field label={t('settings.messageExpiry')} hint={t('settings.messageExpiryBody')}>
          <select
            className="input select"
            value={String(settings.messageExpirationDays)}
            onChange={(event) => void saveSettings({ messageExpirationDays: Number(event.target.value) })}
          >
            {[7, 30, 90, 365].map((days) => (
              <option key={days} value={days}>
                {t('settings.retentionDays', { n: days })}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Banner tone="accent">
        <span className="small">{t('privacy.limitsForwardSecrecy')}</span>
      </Banner>
    </SettingsPage>
  )
}

/**
 * Re-encode an avatar to a small square JPEG data URI.
 *
 * Two reasons this is not just `FileReader.readAsDataURL`: the original may be
 * megabytes (and gets sent to every contact), and re-encoding through a canvas
 * strips EXIF, which routinely carries GPS coordinates.
 */
async function downscaleToDataUri(file: File, size: number): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    )
    bitmap.close()
    const dataUri = canvas.toDataURL('image/jpeg', 0.82)
    return dataUri.length <= 64 * 1024 ? dataUri : canvas.toDataURL('image/jpeg', 0.6)
  } catch {
    return null
  }
}
