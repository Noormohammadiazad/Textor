import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/vazirmatn'
import './styles/app.css'
import './styles/chat.css'
import { App } from './app/App'
import { ErrorBoundary } from './app/ErrorBoundary'
import { applyDisplayPrefs, loadDisplayPrefs } from './app/displayPrefs'
import { detectLocale } from './i18n'

/**
 * Frame guard.
 *
 * A messenger inside a hostile iframe is a clickjacking target: an attacker
 * could overlay their own UI and trick someone into revealing a recovery phrase
 * or sending a message. The usual defence is CSP `frame-ancestors`, but
 * browsers ignore that directive when it arrives in a <meta> element — and a
 * static host cannot set response headers. So the check is done here instead.
 *
 * Self-hosting behind a web server you control? Send `frame-ancestors 'none'`
 * as a real header as well; this is a backstop, not a replacement.
 */
if (window.top !== window.self) {
  document.documentElement.textContent = 'Textor refuses to run inside a frame. Open it in its own tab.'
  throw new Error('refusing to run framed')
}

/*
 * Theme and direction go on <html> before the first React render, not in an
 * effect after it. The stylesheet has already been parsed by this point, so an
 * effect-based approach paints one frame of light-theme, left-to-right layout
 * before correcting itself — most visible exactly where it matters least
 * forgivingly, on the lock screen a returning user sees several times a day.
 */
const stored = loadDisplayPrefs()
applyDisplayPrefs({ locale: stored.locale ?? detectLocale(), theme: stored.theme ?? 'system' })

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
