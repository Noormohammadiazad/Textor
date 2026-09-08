import { useApp } from '../../app/store'
import { LOCALE_CODES, LOCALE_NAMES, LOCALE_SHORT_NAMES, useT } from '../../i18n'
import type { LocaleCode, ThemePreference } from '../../core/models/types'
import { SegmentedControl, type Segment } from './SegmentedControl'
import { MonitorIcon, MoonIcon, SunIcon } from './Icons'

/**
 * Language and theme switches for the screens shown before the vault opens.
 *
 * These two settings also live in the encrypted settings record, but they have
 * to be reachable from the welcome, onboarding, and lock screens as well:
 * someone who cannot read English should not have to guess their way through
 * an unfamiliar unlock form to find the language menu, and a user who prefers a
 * light interface should not be shown a dark one every time the app locks.
 *
 * Both write through {@link useApp.setDisplayPreference}, which persists to the
 * vault when it is open and to the small unencrypted display cache when it is
 * not.
 */
export function DisplayControls() {
  const t = useT()
  const locale = useApp((s) => s.settings.locale)
  const theme = useApp((s) => s.settings.theme)
  const setDisplayPreference = useApp((s) => s.setDisplayPreference)

  const themes: Segment<ThemePreference>[] = [
    { value: 'system', label: t('settings.themeSystem'), icon: <MonitorIcon size={15} /> },
    { value: 'light', label: t('settings.themeLight'), icon: <SunIcon size={15} /> },
    { value: 'dark', label: t('settings.themeDark'), icon: <MoonIcon size={15} /> },
  ]

  return (
    <div className="entry-controls" role="group" aria-label={t('settings.displayControls')}>
      <LanguageSwitch value={locale} onChange={(next) => void setDisplayPreference({ locale: next })} />
      <SegmentedControl
        compact
        label={t('settings.theme')}
        value={theme}
        options={themes}
        onChange={(next) => void setDisplayPreference({ theme: next })}
      />
    </div>
  )
}

/**
 * Segmented while the list is short enough to read at a glance, a select once
 * it is not. The threshold is what fits beside the theme switch on a 320px
 * screen; adding a fourth locale changes the control, not this component's
 * callers.
 */
const SEGMENT_LIMIT = 3

function LanguageSwitch({ value, onChange }: { value: LocaleCode; onChange: (next: LocaleCode) => void }) {
  const t = useT()

  if (LOCALE_CODES.length > SEGMENT_LIMIT) {
    return (
      <select
        className="select select-compact"
        aria-label={t('settings.language')}
        value={value}
        onChange={(event) => onChange(event.target.value as LocaleCode)}
      >
        {LOCALE_CODES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    )
  }

  return (
    <SegmentedControl
      label={t('settings.language')}
      value={value}
      options={LOCALE_CODES.map((code) => ({
        value: code,
        // The short form is drawn; the full endonym is what gets announced.
        label: LOCALE_SHORT_NAMES[code],
        title: LOCALE_NAMES[code],
      }))}
      onChange={onChange}
    />
  )
}
