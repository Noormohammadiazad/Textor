/**
 * Locations, as a lazy chunk (ADR-064): the map, the card in a conversation,
 * the sheet it opens, the picker, the sharing bar, and the sharer that moves a
 * live location on. Until the chunk arrives a location renders as its plain
 * content — a `geo:` URI, exactly what a client without locations shows. See
 * `src/ui/lazyViews.tsx`.
 */
import '../location/location.css'
export { LocationCard } from '../location/LocationCard'
export { LocationPicker } from '../location/LocationPicker'
export { LiveBanner } from '../location/LiveBanner'
export { liveSharer } from '../location/sharing'
