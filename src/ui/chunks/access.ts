/**
 * Setting up and managing how this device opens Textor, as one lazy chunk:
 * onboarding, restoring a backup, and Settings → Security (ADR-054).
 *
 * One chunk because they share the protection chooser, the passphrase, PIN and
 * pattern fields, setting biometrics up, and their words. Split across chunks, those
 * would land in a shared chunk that is not named `lazy-` and so is precached
 * — which is how the backup code once ended up in the shell. See
 * `src/ui/lazyViews.tsx`.
 */
export { Onboarding } from '../screens/Onboarding'
export { SecuritySettings } from '../screens/SecuritySettings'
