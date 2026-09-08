import { getMessenger, getRepo, useApp } from '../../app/store'
import { LiveSharer, type LiveShare } from '../../core/location/sharer'
import { browserPositions } from '../../core/location/position'
import { LIVE_SHARES } from '../../core/models/location'
import { locationText } from './locationText'

let sharer: LiveSharer | null = null

/**
 * The one live sharer, wired to the engine, the vault and the screen: made the
 * first time something is shared, or when the vault opens with shares going
 * (ADR-064). It outlives a lock — the store pauses it, and the next unlock
 * takes it up again — because it holds nothing but what the vault remembers.
 */
export function liveSharer(): LiveSharer {
  if (sharer) return sharer
  const made = new LiveSharer({
    positions: browserPositions(),
    move: async (id, fix) => {
      const messenger = getMessenger()
      // Not "gone": locked, and paused in a moment.
      if (!messenger) throw new Error('the vault is locked')
      return (await messenger.moveLiveLocation(id, fix)) !== null
    },
    load: async () => (await getRepo().getState<LiveShare[]>(LIVE_SHARES)) ?? [],
    save: (shares) => getRepo().putState(LIVE_SHARES, shares),
    visible: () => document.visibilityState === 'visible',
    changed: (liveShares) => useApp.setState({ liveShares }),
    failed: (failure) => {
      const { settings, toast } = useApp.getState()
      toast(locationText(settings.locale, failure), failure === 'unavailable' ? 'info' : 'danger')
    },
  })
  document.addEventListener('visibilitychange', () => made.retune())
  sharer = made
  return made
}
