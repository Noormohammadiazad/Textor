import type { Message } from '../../core/models/types'
import { LOCALE_CODES, translate, type TranslationKey } from '../../i18n'

/**
 * The words written for an attachment rather than by anyone (ADR-083).
 *
 * A Textor attachment carries "Photo", "Voice message · 0:12" or
 * "File · notes.pdf" as its content, so a client that does not read the
 * attachment tag still says what arrived (PROTOCOL §3.1). Every build wrote
 * them from these, in its sender's language, so they are known in every
 * language rather than only the reader's.
 */
const LABELS: readonly TranslationKey[] = [
  'attachment.captionImage',
  'attachment.captionVideo',
  'attachment.captionVoice',
  'attachment.captionFile',
]
/** Persian for a file, before ADR-083 took Telegram's word. */
const RETIRED = ['پرونده']

let labels: readonly string[] | undefined

/**
 * What a bubble shows beside its attachment: the words someone wrote, never
 * the ones written for them. The picture, the player or the card already says
 * what it is. A message with no attachment is shown as it is.
 */
export function captionOf({ body, attachment }: Pick<Message, 'body' | 'attachment'>): string {
  if (!attachment) return body
  labels ??= [...RETIRED, ...LOCALE_CODES.flatMap((locale) => LABELS.map((key) => translate(locale, key)))]
  return labels.some((label) => body === label || body.startsWith(`${label} · `)) ? '' : body
}
