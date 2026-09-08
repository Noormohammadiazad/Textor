import { useState } from 'react'
import { useApp } from '../../app/store'
import { useLocationText } from './locationText'

/**
 * Street maps, asked for where they are wanted (ADR-065).
 *
 * Off until the person turns them on. The layers button on a map turns them
 * off at once, and on only once they have read what that tells OpenStreetMap
 * — in place, under the map they were looking at, not in a dialog stacked over
 * the sheet. Settings → Privacy holds the same switch.
 */
export function useStreets(): {
  on: boolean
  asking: boolean
  toggle: () => void
  answer: (yes: boolean) => void
} {
  const on = useApp((s) => s.settings.streetMaps)
  const saveSettings = useApp((s) => s.saveSettings)
  const [asking, setAsking] = useState(false)
  return {
    on,
    asking: asking && !on,
    toggle: () => {
      if (on) void saveSettings({ streetMaps: false })
      else setAsking((was) => !was)
    },
    answer: (yes) => {
      setAsking(false)
      if (yes) void saveSettings({ streetMaps: true })
    },
  }
}

export function StreetsConsent({ onAnswer }: { onAnswer: (yes: boolean) => void }) {
  const text = useLocationText()
  return (
    <div className="streets-consent" role="group" aria-labelledby="streets-consent-title">
      <strong id="streets-consent-title">{text('streetsTitle')}</strong>
      <p className="hint">{text('streetsBody')}</p>
      <div className="row">
        <button type="button" className="btn btn-primary small" onClick={() => onAnswer(true)}>
          {text('streetsYes')}
        </button>
        <button type="button" className="btn btn-ghost small" onClick={() => onAnswer(false)}>
          {text('streetsNo')}
        </button>
      </div>
    </div>
  )
}
