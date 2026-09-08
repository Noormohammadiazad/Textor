/**
 * The settings screens, as one lazy chunk.
 *
 * One chunk rather than one per screen: they are reached from each other, so
 * whoever opens one is about to open another, and a single download is cheaper
 * than several small ones on a slow link. See `src/ui/lazyViews.tsx`.
 */
export { SettingsHome, PrivacySettings } from '../screens/Settings'
export { RelaySettings } from '../screens/RelaySettings'
export { DataSettings } from '../screens/DataSettings'
export { CallSettings } from '../screens/CallSettings'
export { AboutScreen } from '../screens/AboutScreen'
