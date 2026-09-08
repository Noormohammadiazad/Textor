import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/** The words of the screen that finds someone by their ID, kept in its chunk with it. */
const en = {
  retry: 'Try again',
  searching: 'Looking for {id}',
  invalid: 'That is not an ID.',
  nobody:
    'Nobody found with this ID. Check it with them: one wrong character finds nobody. An ID not opened for a year also stops being found, until its owner comes back.',
  unreachable: 'Could not look this up just now.',
  conflict:
    '{n} different keys hold this ID, by bad luck or by someone working to imitate one. Add one only once you have checked its safety number with the person.',
  crowded:
    'False records are being added to this ID, so its owner may not be among these. Ask them for an invite instead.',
  own: 'This is your own ID.',
}

export type TextorIdTextKey = keyof typeof en

const fa: Record<TextorIdTextKey, string> = {
  retry: 'تلاش دوباره',
  searching: 'در جست‌وجوی {id}',
  invalid: 'این یک شناسه نیست.',
  nobody:
    'کسی با این شناسه پیدا نشد. آن را با خودش بررسی کنید: یک نویسهٔ اشتباه کسی را پیدا نمی‌کند. شناسه‌ای که یک سال باز نشده باشد هم تا برگشتن صاحبش پیدا نمی‌شود.',
  unreachable: 'الان نشد این را جست‌وجو کرد.',
  conflict:
    '{n} کلید متفاوت این شناسه را دارند، یا از بدشانسی یا چون کسی برای تقلید آن زحمت کشیده است. فقط وقتی یکی را اضافه کنید که شمارهٔ امنیتی‌اش را با خود آن شخص بررسی کرده باشید.',
  crowded:
    'رکوردهای جعلی به این شناسه افزوده می‌شوند، پس شاید صاحبش میان اینها نباشد. از او دعوت‌نامه بخواهید.',
  own: 'این شناسهٔ خود شماست.',
}

export const TEXTOR_ID_TEXT: Record<LocaleCode, Record<TextorIdTextKey, string>> = { en, fa }

export function useTextorIdText(): (key: TextorIdTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(TEXTOR_ID_TEXT[locale][key], values)
}
