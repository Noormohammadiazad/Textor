import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for starting a small group and looking at one, kept in the groups
 * chunk with the two screens that say them, as `secureText` is: they need not
 * grow the dictionaries every cold start downloads (ADR-043). What a
 * conversation itself says about its group stays there under `groups.*`.
 */
const en = {
  name: 'Group name',
  namePlaceholder: 'Optional — members see it',
  pickMembers: 'Choose people',
  chosen: '{n} of {max} chosen',
  limitTitle: 'Up to {max} people, including you',
  limitBody:
    'There is no server to send a group message for you, so your device encrypts and sends a separate copy to every member. Small groups keep each message quick to send, light on everyone’s relays, and small enough that you can still check who everyone is.',
  fixedMembers:
    'Who is in a group cannot change. Adding or removing someone starts a new group, because a group is defined by exactly who is in it.',
  create: 'Create group',
  noContacts: 'You need at least two contacts to start a group.',
  full: 'That is everyone a group can hold.',
  notInContacts: 'Not in your contacts',
}

type GroupKey = keyof typeof en

const fa: Record<GroupKey, string> = {
  name: 'نام گروه',
  namePlaceholder: 'اختیاری — اعضا آن را می‌بینند',
  pickMembers: 'انتخاب افراد',
  chosen: '{n} از {max} انتخاب شده',
  limitTitle: 'حداکثر {max} نفر، با خودتان',
  limitBody:
    'هیچ سروری نیست که پیام گروهی را برایتان بفرستد؛ دستگاه شما برای هر عضو نسخه‌ای جداگانه رمزگذاری می‌کند و می‌فرستد. گروه کوچک یعنی هر پیام سریع فرستاده می‌شود، بار کمی روی رله‌های همه می‌گذارد و آن‌قدر کوچک می‌ماند که هنوز بتوانید هویت همه را بررسی کنید.',
  fixedMembers:
    'اعضای یک گروه تغییر نمی‌کنند. افزودن یا حذف کسی گروه تازه‌ای می‌سازد، چون هر گروه دقیقاً با اعضایش تعریف می‌شود.',
  create: 'ساختن گروه',
  noContacts: 'برای ساختن گروه دست‌کم به دو مخاطب نیاز دارید.',
  full: 'گروه بیش از این جا ندارد.',
  notInContacts: 'در مخاطبان شما نیست',
}

const GROUP_TEXT: Record<LocaleCode, Record<GroupKey, string>> = { en, fa }

export type GroupTextFn = (key: GroupKey, values?: Interpolations) => string

export function useGroupText(): GroupTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(GROUP_TEXT[locale][key], values)
}
