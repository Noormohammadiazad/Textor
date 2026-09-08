import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { goBack } from '../../app/router'
import { BackIcon } from '../components/Icons'

/**
 * The frame every settings screen sits in: a back button and a title. Its own
 * module because the settings screens live in two chunks — Security travels
 * with the rest of the unlock setup (ADR-054) — and both need it.
 */
export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
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
