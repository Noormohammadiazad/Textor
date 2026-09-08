import { sanitizeName } from '../core/models/attachment'
import type { SendAttachmentInput } from '../app/store'
import type { TranslateFn } from '../i18n'
import { kindForFile, prepareImage, prepareVideoPoster } from './image'

/**
 * How a picked file is sent, by the item it was picked from (ADR-083).
 *
 *   media   "Photo or Video": a picture re-encoded as sharp as the relays carry
 *           and without its metadata, a video as it is; both drawn in the
 *           conversation, edge to edge
 *   file    "File": the bytes exactly as picked, whatever they are, shown as a
 *           card to save
 */
export type AttachAs = 'media' | 'file'

/**
 * Turn a picked file into what is sent.
 *
 * Every attachment carries words for a client that does not read its tag —
 * "Photo", "File · notes.pdf" — as the rumor's content (PROTOCOL §3.1). Textor
 * shows none of them. A photo or a video goes without its file name, which a
 * camera fills with when it was taken.
 */
export async function prepareAttachment(
  file: File,
  as: AttachAs,
  t: TranslateFn,
): Promise<SendAttachmentInput> {
  const kind = as === 'media' ? kindForFile(file) : 'file'
  if (kind === 'image') {
    const photo = await prepareImage(file)
    if (photo) {
      return {
        bytes: photo.bytes,
        kind: 'image',
        mime: photo.mime,
        caption: t('attachment.captionImage'),
        width: photo.width,
        height: photo.height,
        ...(photo.preview ? { preview: photo.preview } : {}),
      }
    }
  } else if (kind === 'video') {
    // A video this browser cannot open, the recipient's likely cannot either:
    // it goes as a file to save rather than a player that stays black.
    const poster = await prepareVideoPoster(file)
    if (poster) {
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        kind: 'video',
        mime: file.type,
        caption: t('attachment.captionVideo'),
        width: poster.width,
        height: poster.height,
        durationMs: poster.durationMs,
        ...(poster.preview ? { preview: poster.preview } : {}),
      }
    }
  }
  // Picked as a file, or as a photo the browser cannot open, or as neither a
  // photo nor a video, which a desktop picker lets through.
  const name = sanitizeName(file.name || t('attachment.file'))
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    kind: 'file',
    mime: file.type || 'application/octet-stream',
    caption: `${t('attachment.captionFile')} · ${name}`,
    name,
  }
}
