import { Suspense } from 'react'
import { useI18n } from '../../i18n'
import type { Sticker } from '../../core/models/types'
import { EmojiPicker } from '../lazyViews'

/**
 * The bridge between the shell and the emoji chunk.
 *
 * This module stays in the startup bundle; the picker it loads does not. The
 * loader in `lazyViews.tsx` is what keeps `src/ui/emoji/` out of the service
 * worker's precache — a static import here would pull the whole picker, its
 * emoji table and its sticker grid into every cold start, and
 * `scripts/check-bundle.mjs` fails the build if that ever happens.
 *
 * The fallback is a fixed-size block rather than a spinner: the panel is
 * already positioned by the popover that holds it, and a panel that changes
 * size as it loads would move the thing being aimed at.
 */
export interface LazyPickerProps {
  mode: 'reaction' | 'compose'
  onPickEmoji: (emoji: string) => void
  onPickSticker?: (sticker: Sticker) => void
}

export function LazyPicker({ mode, onPickEmoji, onPickSticker }: LazyPickerProps) {
  const { t } = useI18n()
  return (
    <Suspense
      fallback={
        <div className="picker picker-loading" role="status">
          {t('emoji.loading')}
        </div>
      }
    >
      <EmojiPicker mode={mode} onPickEmoji={onPickEmoji} onPickSticker={onPickSticker} />
    </Suspense>
  )
}
