import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for polls and checklists, kept in their chunk (ADR-061).
 *
 * Read only by the cards and the forms that make them, so they travel with
 * those rather than growing the dictionaries every cold start downloads — the
 * arrangement the call screen and forward-secret groups already have. The
 * attach menu's own labels stay in the main dictionaries under
 * `interactive.*`.
 */
const en = {
  newPoll: 'New poll',
  newChecklist: 'New checklist',
  question: 'Question',
  questionPlaceholder: 'Ask something',
  options: 'Options',
  option: 'Option {n}',
  addOption: 'Add an option',
  removeRow: 'Remove',
  multi: 'Allow more than one answer',
  title: 'Title',
  titlePlaceholder: 'What is this list for?',
  items: 'Items',
  item: 'Item {n}',
  addItem: 'Add an item',
  send: 'Send',
  votes: '{n} voted',
  noVotes: 'No votes yet',
  chooseOne: 'Choose one',
  chooseAny: 'Choose any',
  progress: '{done} of {total} done',
  newItemPlaceholder: 'Add to the list',
  tickedBy: 'Ticked by {name}',
  needQuestion: 'Write the question first.',
  needOptions: 'A poll needs at least two options.',
  needTitle: 'Give the list a title.',
  needItems: 'Add at least one item.',
}

const fa: typeof en = {
  newPoll: 'نظرسنجی جدید',
  newChecklist: 'فهرست کارهای جدید',
  question: 'پرسش',
  questionPlaceholder: 'چیزی بپرسید',
  options: 'گزینه‌ها',
  option: 'گزینهٔ {n}',
  addOption: 'افزودن گزینه',
  removeRow: 'حذف',
  multi: 'امکان انتخاب بیش از یک پاسخ',
  title: 'عنوان',
  titlePlaceholder: 'این فهرست برای چیست؟',
  items: 'موارد',
  item: 'مورد {n}',
  addItem: 'افزودن مورد',
  send: 'فرستادن',
  votes: '{n} رأی',
  noVotes: 'هنوز رأیی نیست',
  chooseOne: 'یکی را انتخاب کنید',
  chooseAny: 'هر تعداد را انتخاب کنید',
  progress: '{done} از {total} انجام شده',
  newItemPlaceholder: 'به فهرست بیفزایید',
  tickedBy: 'علامت‌زده توسط {name}',
  needQuestion: 'اول پرسش را بنویسید.',
  needOptions: 'نظرسنجی دست‌کم به دو گزینه نیاز دارد.',
  needTitle: 'برای فهرست عنوانی بنویسید.',
  needItems: 'دست‌کم یک مورد اضافه کنید.',
}

const INTERACTIVE_TEXT: Record<LocaleCode, typeof en> = { en, fa }

export type InteractiveTextKey = keyof typeof en

export function useInteractiveText(): (key: InteractiveTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(INTERACTIVE_TEXT[locale][key], values)
}
