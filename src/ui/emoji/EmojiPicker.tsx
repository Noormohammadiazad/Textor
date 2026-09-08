import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/store'
import { useI18n } from '../../i18n'
import { prepareImage } from '../../media/image'
import type { Sticker, StickerPack } from '../../core/models/types'
import { EMOJI_GROUPS } from './emojiSet'

/**
 * The emoji and sticker picker.
 *
 * Everything under `src/ui/emoji/` is built as the `lazy-emoji` chunk: it is
 * excluded from the service worker's precache and fetched the first time
 * somebody opens the picker, then served from the runtime cache forever after.
 * Most conversations never open it, and the install budget is what decides how
 * long a cold start takes on a slow connection.
 *
 * Stickers are vault-local. The images are sealed and chunked by the same code
 * that carries an attachment, and sending one sends an ordinary image — so the
 * person receiving it needs no pack, and nothing is ever fetched from a host.
 */

export interface EmojiPickerProps {
  /** Reactions take a single emoji; composing also offers stickers. */
  mode: 'reaction' | 'compose'
  onPickEmoji: (emoji: string) => void
  onPickSticker?: (sticker: Sticker) => void
}

type Tab = 'emoji' | 'stickers'

export default function EmojiPicker({ mode, onPickEmoji, onPickSticker }: EmojiPickerProps) {
  const { t } = useI18n()
  const packs = useApp((s) => s.packs)
  const [tab, setTab] = useState<Tab>('emoji')

  return (
    <div className="picker" role="group" aria-label={t('emoji.title')}>
      {mode === 'compose' ? (
        <div className="picker-tabs" role="tablist" aria-label={t('emoji.title')}>
          <button
            type="button"
            role="tab"
            id="picker-tab-emoji"
            aria-selected={tab === 'emoji'}
            aria-controls="picker-panel"
            className={tab === 'emoji' ? 'picker-tab active' : 'picker-tab'}
            onClick={() => setTab('emoji')}
          >
            {t('emoji.tabEmoji')}
          </button>
          <button
            type="button"
            role="tab"
            id="picker-tab-stickers"
            aria-selected={tab === 'stickers'}
            aria-controls="picker-panel"
            className={tab === 'stickers' ? 'picker-tab active' : 'picker-tab'}
            onClick={() => setTab('stickers')}
          >
            {t('emoji.tabStickers')}
          </button>
        </div>
      ) : null}

      <div
        className="picker-panel"
        id="picker-panel"
        role="tabpanel"
        aria-labelledby={tab === 'emoji' ? 'picker-tab-emoji' : 'picker-tab-stickers'}
      >
        {tab === 'emoji' ? (
          <EmojiGrid onPick={onPickEmoji} />
        ) : (
          <StickerTab packs={packs} onPick={onPickSticker} />
        )}
      </div>
    </div>
  )
}

function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useI18n()
  return (
    <>
      {EMOJI_GROUPS.map((group) => (
        <section key={group.key} className="picker-group">
          <h3 className="picker-heading">{t(group.key)}</h3>
          <div className="picker-grid">
            {group.emoji.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="picker-emoji"
                // The character is the label: a screen reader announces the
                // emoji's own name, which is better than anything invented here.
                onClick={() => onPick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function StickerTab({ packs, onPick }: { packs: StickerPack[]; onPick?: (sticker: Sticker) => void }) {
  const { t } = useI18n()
  const importPack = useApp((s) => s.importStickerPack)
  const deletePack = useApp((s) => s.deleteStickerPack)
  const toast = useApp((s) => s.toast)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      const images: { bytes: Uint8Array; mime: string; width: number; height: number }[] = []
      for (const file of [...files].slice(0, 60)) {
        // Re-encoded like any other picture, which also drops EXIF.
        const prepared = await prepareImage(file)
        if (prepared) {
          images.push({
            bytes: prepared.bytes,
            mime: prepared.mime,
            width: prepared.width,
            height: prepared.height,
          })
        }
      }
      if (images.length === 0) {
        toast(t('emoji.importFailed'), 'danger')
        return
      }
      const name = files[0]?.name.replace(/\.[^.]+$/, '') ?? ''
      await importPack(name, images)
      toast(t('emoji.imported', { n: images.length }))
    } catch {
      toast(t('emoji.importFailed'), 'danger')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="picker-stickers">
      {packs.length === 0 ? (
        <p className="muted small picker-empty">{t('emoji.noPacks')}</p>
      ) : (
        packs.map((pack) => (
          <section key={pack.id} className="picker-group">
            <h3 className="picker-heading">
              <span dir="auto">{pack.name}</span>
              <button type="button" className="btn btn-ghost small" onClick={() => void deletePack(pack.id)}>
                {t('emoji.removePack')}
              </button>
            </h3>
            <div className="picker-grid stickers">
              {pack.stickers.map((sticker) => (
                <StickerButton key={sticker.id} sticker={sticker} onPick={onPick} />
              ))}
            </div>
          </section>
        ))
      )}

      <label className="btn btn-ghost small picker-import">
        {busy ? t('emoji.importing') : t('emoji.addPack')}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          disabled={busy}
          onChange={(event) => void onFiles(event.target.files)}
        />
      </label>
    </div>
  )
}

function StickerButton({ sticker, onPick }: { sticker: Sticker; onPick?: (sticker: Sticker) => void }) {
  const openSticker = useApp((s) => s.openSticker)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void openSticker(sticker).then((next) => {
      if (live) setUrl(next)
    })
    return () => {
      live = false
    }
  }, [openSticker, sticker])

  return (
    <button type="button" className="picker-sticker" onClick={() => onPick?.(sticker)} disabled={!url}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="picker-sticker-loading" />}
    </button>
  )
}
