/** Build metadata, injected by Vite at build time. */
export const APP_VERSION: string = __APP_VERSION__
export const BUILD_TIME: string = __BUILD_TIME__
/**
 * Where this build's source lives.
 *
 * Shown in Settings and in the crash screen, so a user can read the code they
 * are actually running or report a fault against it. Anyone deploying a fork
 * should point this at their own repository — a "source code" link that leads
 * somewhere other than the running build is worse than none in an app whose
 * central claim is that you can check it.
 *
 * Overridable at build time with `VITE_SOURCE_URL` so a fork needs no patch.
 */
export const SOURCE_URL: string = import.meta.env.VITE_SOURCE_URL || 'https://github.com/textor-ir/textor'

/** Host and path only, for prose where a bare URL reads better than a link. */
export const SOURCE_LABEL: string = SOURCE_URL.replace(/^https?:\/\//, '')
