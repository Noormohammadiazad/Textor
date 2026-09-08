import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createLogger } from '../core/util/log'
import { SOURCE_LABEL } from './meta'

const log = createLogger('boundary')

/**
 * Last line of defence against a blank page.
 *
 * Without this, an exception during render unmounts the whole tree and leaves
 * the user staring at nothing — with no way to reach Settings and export the
 * backup that is their only copy of the identity. The fallback is deliberately
 * plain, self-contained, and free of app state, because app state is the most
 * likely thing to have caused the crash.
 *
 * The message is shown, not swallowed: someone whose messenger just broke is
 * owed the detail needed to report it.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('unhandled render error', { message: error.message, componentStack: info.componentStack })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="container stack" style={{ maxWidth: '34rem', paddingBlock: 'var(--space-7)' }}>
        <h1 style={{ fontSize: 'var(--step-2)' }}>Textor hit an unexpected error</h1>
        <p className="muted">
          Your messages and keys are untouched — they are encrypted in this browser&apos;s storage and this
          screen does not change them. Reloading usually clears it.
        </p>

        <pre
          className="mono small"
          style={{
            padding: 'var(--space-3)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message || String(error)}
        </pre>

        <button className="btn btn-primary btn-block" onClick={() => location.reload()}>
          Reload
        </button>
        <button
          className="btn btn-outline btn-block"
          onClick={() => {
            // Route straight to the backup screen: if the crash is reproducible,
            // getting the vault out matters more than getting back to the chat.
            location.hash = '#/settings/data'
            location.reload()
          }}
        >
          Open backup settings
        </button>

        <p className="hint">
          If this keeps happening, please report it with the message above at {SOURCE_LABEL}. Do not include
          your recovery phrase.
        </p>
      </div>
    )
  }
}
