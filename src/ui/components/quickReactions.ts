/**
 * The reactions offered inline, without opening the picker.
 *
 * Deliberately in the shell rather than in the lazy emoji chunk: these six are
 * drawn on every message action bar, so importing them from the picker would
 * pull the whole picker into the startup bundle — which is exactly what
 * `scripts/check-bundle.mjs` refuses. They cover the overwhelming majority of
 * what people actually send, so the common case costs one tap and no download.
 */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '😮', '😢']
