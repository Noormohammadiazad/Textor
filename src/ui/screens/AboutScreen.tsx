import { useI18n } from '../../i18n'
import { SettingsPage } from './Settings'
import { APP_VERSION, BUILD_TIME, SOURCE_URL } from '../../app/meta'
import { useApp } from '../../app/store'
import { relayLabel } from '../../core/transport/relayUrl'

/**
 * "What leaves your device".
 *
 * A privacy claim nobody can check is just marketing. This page states, in
 * plain language, every network destination the app talks to and what each one
 * can observe — including the parts that are uncomfortable, like the IP address
 * a direct connection reveals and the absence of forward secrecy.
 */
export function AboutScreen() {
  const { t } = useI18n()
  const relays = useApp((s) => s.relayEntries.filter((entry) => entry.enabled))

  const sections: { title: string; body: string; extra?: string[] }[] = [
    {
      title: t('privacy.relaysTitle'),
      body: t('privacy.relaysBody'),
      extra: [t('privacy.relaysSee'), t('privacy.relaysCannot')],
    },
    { title: t('privacy.hostTitle'), body: t('privacy.hostBody') },
    { title: t('privacy.directTitle'), body: t('privacy.directBody') },
    { title: t('privacy.stunTitle'), body: t('privacy.stunBody') },
    { title: t('privacy.deviceTitle'), body: t('privacy.deviceBody') },
  ]

  return (
    <SettingsPage title={t('privacy.title')}>
      <p className="muted">{t('privacy.intro')}</p>

      {sections.map((section) => (
        <div key={section.title} className="card stack-sm">
          <h3 style={{ fontSize: 'var(--step-0)' }}>{section.title}</h3>
          <p className="muted small">{section.body}</p>
          {section.extra?.map((line) => (
            <p key={line} className="hint">
              {line}
            </p>
          ))}
        </div>
      ))}

      {relays.length > 0 ? (
        <div className="card stack-sm">
          <h3 style={{ fontSize: 'var(--step-0)' }}>{t('settings.relays')}</h3>
          <p className="hint" dir="ltr" lang="en">
            {relays.map((entry) => relayLabel(entry.url)).join(' · ')}
          </p>
        </div>
      ) : null}

      <div className="card stack-sm">
        <h3 style={{ fontSize: 'var(--step-0)', color: 'var(--warning)' }}>{t('privacy.limitsTitle')}</h3>
        <ul className="stack-sm muted small" style={{ paddingInlineStart: '1.1rem' }}>
          <li>{t('privacy.limitsForwardSecrecy')}</li>
          <li>{t('privacy.limitsMetadata')}</li>
          <li>{t('privacy.limitsNoPush')}</li>
          <li>{t('privacy.limitsXss')}</li>
        </ul>
      </div>

      <div className="card stack-sm">
        <div className="row-between">
          <span className="muted">{t('settings.version')}</span>
          <code className="mono small">{APP_VERSION}</code>
        </div>
        <div className="row-between">
          <span className="muted">{t('settings.sourceCode')}</span>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
            github
          </a>
        </div>
        <div className="row-between">
          <span className="muted">{t('settings.licence')}</span>
          <span className="mono small">AGPL-3.0-or-later</span>
        </div>
        <p className="hint" dir="ltr" lang="en">
          {BUILD_TIME}
        </p>
      </div>
    </SettingsPage>
  )
}
