import { useCallback } from 'react'
import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words of the screens for adding and looking at a contact, kept in their chunk
 * with them. What other chunks or the shell say too stays in the main dictionaries.
 */
const en = {
  addTitle: 'Add a contact',
  addBody: 'Exchange an invite in person or over any channel you already trust.',
  myInvite: 'My invite',
  myInviteBody: 'Show this to someone, or send them the link.',
  scanBody: 'Point your camera at the other person’s invite code.',
  pasteInvite: 'Paste an ID, invite or npub',
  pastePlaceholder: 'ID, invite link, npub…, or nostr address',
  myId: 'Your ID',
  noId: 'Their ID is worked out from their key once you accept them, and shows here a moment later.',
  invalidInvite: 'That is not a valid ID, invite or key',
  idTypo: 'That ID has a mistake in it: a character is wrong, missing or swapped.',
  cannotAddSelf: 'That is you',
  staleInvite: 'This invite is old. Its relay hints may be out of date.',
  nameLabel: 'Name',
  noteLabel: 'Note',
  noteHint: 'Only you can see this.',
  unverified: 'Not verified',
  removeConfirm: 'Remove this contact? Your message history stays on this device.',
  blockConfirm: 'Block this contact? You will stop receiving their messages.',
  pin: 'Pin to the top of Chats',
  unpin: 'Unpin from Chats',
}

export type PeopleTextKey = keyof typeof en

const fa: Record<PeopleTextKey, string> = {
  addTitle: 'افزودن مخاطب',
  addBody: 'دعوت‌نامه را حضوری یا از هر مسیری که به آن اعتماد دارید رد و بدل کنید.',
  myInvite: 'دعوت‌نامه من',
  myInviteBody: 'این را به کسی نشان دهید یا پیوند آن را برایش بفرستید.',
  scanBody: 'دوربین را روی کد دعوت طرف مقابل بگیرید.',
  pasteInvite: 'چسباندن شناسه، دعوت‌نامه یا npub',
  pastePlaceholder: 'شناسه، پیوند دعوت، \u202anpub…\u202c یا نشانی nostr',
  myId: 'شناسهٔ شما',
  noId: 'شناسهٔ او پس از پذیرفتنش از کلیدش به دست می‌آید و کمی بعد اینجا نشان داده می‌شود.',
  invalidInvite: 'این شناسه، دعوت‌نامه یا کلید معتبر نیست',
  idTypo: 'این شناسه اشتباهی دارد: نویسه‌ای نادرست، جاافتاده یا جابه‌جاست.',
  cannotAddSelf: 'این خود شمایید',
  staleInvite: 'این دعوت‌نامه قدیمی است و ممکن است نشانی رله‌هایش به‌روز نباشد.',
  nameLabel: 'نام',
  noteLabel: 'یادداشت',
  noteHint: 'فقط خودتان آن را می‌بینید.',
  unverified: 'تأیید نشده',
  removeConfirm: 'این مخاطب حذف شود؟ تاریخچه پیام‌ها روی این دستگاه می‌ماند.',
  blockConfirm: 'این مخاطب مسدود شود؟ دیگر پیام‌هایش را دریافت نمی‌کنید.',
  pin: 'سنجاق به بالای گفتگوها',
  unpin: 'برداشتن سنجاق از گفتگوها',
}

export const PEOPLE_TEXT: Record<LocaleCode, Record<PeopleTextKey, string>> = { en, fa }

/** The same function for as long as the language is the same, so a callback can depend on it. */
export function usePeopleText(): (key: PeopleTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return useCallback((key, values) => interpolate(PEOPLE_TEXT[locale][key], values), [locale])
}
