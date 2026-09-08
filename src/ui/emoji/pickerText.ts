import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words of the emoji and sticker picker, kept in its chunk with the one
 * component that says them, as `groupText` is: they need not grow the
 * dictionaries every cold start downloads (ADR-043). What a bubble says about
 * reactions stays there under `emoji.*`.
 */
const en = {
  smileys: 'Smileys & Emotion',
  people: 'People & Body',
  animals: 'Animals & Nature',
  food: 'Food & Drink',
  activities: 'Activities',
  travel: 'Travel & Places',
  objects: 'Objects',
  symbols: 'Symbols',
  tabEmoji: 'Emoji',
  tabStickers: 'Stickers',
  noPacks: 'No sticker packs yet. Add pictures from this device to make one.',
  addPack: 'Add a pack',
  importing: 'Adding…',
  imported: 'Added {n} sticker(s)',
  importFailed: 'Those files could not be read as pictures.',
  removePack: 'Remove',
}

export type PickerKey = keyof typeof en

const fa: Record<PickerKey, string> = {
  smileys: 'شکلک‌ها و احساسات',
  people: 'آدم‌ها و بدن',
  animals: 'حیوانات و طبیعت',
  food: 'خوراکی و نوشیدنی',
  activities: 'فعالیت‌ها',
  travel: 'سفر و مکان‌ها',
  objects: 'اشیا',
  symbols: 'نمادها',
  tabEmoji: 'ایموجی',
  tabStickers: 'استیکر',
  noPacks: 'هنوز بسته استیکری ندارید. از تصاویر همین دستگاه یکی بسازید.',
  addPack: 'افزودن بسته',
  importing: 'در حال افزودن…',
  imported: '{n} استیکر افزوده شد',
  importFailed: 'این فایل‌ها به‌عنوان تصویر خوانده نشدند.',
  removePack: 'حذف',
}

export const PICKER_TEXT: Record<LocaleCode, Record<PickerKey, string>> = { en, fa }

export type PickerTextFn = (key: PickerKey, values?: Interpolations) => string

export function usePickerText(): PickerTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(PICKER_TEXT[locale][key], values)
}
