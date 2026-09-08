import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for forward-secret groups, kept in the groups chunk.
 *
 * Read only on the screens that start and run a group, so they travel with
 * those screens rather than growing the dictionaries every cold start
 * downloads — the same arrangement as the call screen's (ADR-046). The two
 * lines a conversation itself needs stay in the main dictionaries under
 * `groups.secure*`.
 */
const en = {
  kindLabel: 'Kind of group',
  kindSmall: 'Small group',
  kindSecure: 'Forward-secret',
  secureTitle: 'Forward secrecy, and members who can change',
  secureBody:
    'Messages are encrypted to the group with MLS. Its keys move on whenever someone joins or leaves, and at least weekly: a device taken later cannot read what was said before, and one that was compromised stops being able to read once its keys are refreshed. Up to {max} people, each with Textor and invitations turned on. Text, replies and reactions only.',
  finding: 'Finding everyone’s keys…',
  noneReady:
    'None of them can join yet. They need a version of Textor with forward-secret groups, with invitations turned on in Settings → Privacy.',
  someMissing: 'Not added yet, because they have no invitation key published: {names}',
  failed: 'That did not work: {reason}',
  unreachable: 'the group’s relays could not be reached. Check your connection and try again.',
  raced: 'someone else changed the group at the same moment. Try again.',
  badge: 'Forward-secret group',
  explainer:
    'Encrypted with MLS. Its keys change whenever someone joins or leaves, and at least once a week.',
  code: 'Security code',
  codeHint:
    'Everyone in the group sees the same code until the next change. Compare it with someone in person: a different code means you are not seeing the same group.',
  generation: 'Key generation {n}',
  refreshed: 'Your keys here were last refreshed {when}.',
  refreshNow: 'Refresh my keys now',
  working: 'Working…',
  admin: 'Admin',
  add: 'Add people',
  addHint: 'Contacts not yet in the group. Each is added with the invitation key they published.',
  addChosen: 'Add {n}',
  nobodyToAdd: 'Everyone in your contacts is already here.',
  remove: 'Remove',
  removeConfirm: 'Remove {name}? They will not be able to read anything said after this.',
  leave: 'Leave group',
  leaveConfirm:
    'Leave this group? You will not be able to read anything said after you leave. What was said stays on this device.',
  leaveAdmin: 'You are an admin. Leaving hands the role on to the others.',
  left: 'You are no longer in this group.',
  deleteHistory: 'Delete from this device',
  deleteConfirm: 'Delete this group’s history from this device?',
}

export type SecureTextKey = keyof typeof en

const fa: Record<SecureTextKey, string> = {
  kindLabel: 'نوع گروه',
  kindSmall: 'گروه کوچک',
  kindSecure: 'رازداری پیش‌رو',
  secureTitle: 'رازداری پیش‌رو، و اعضایی که می‌توانند تغییر کنند',
  secureBody:
    'پیام‌ها با MLS برای گروه رمزگذاری می‌شوند. کلیدهای گروه هر بار که کسی می‌پیوندد یا می‌رود، و دست‌کم هفته‌ای یک بار، عوض می‌شوند: دستگاهی که بعدها به دست کسی بیفتد نمی‌تواند گفته‌های پیشین را بخواند، و دستگاهی که نفوذ شده، پس از تازه شدن کلیدهایش دیگر نمی‌تواند بخواند. حداکثر {max} نفر، هر کدام با تکستور و دعوت‌های روشن. فقط متن، پاسخ و واکنش.',
  finding: 'در حال یافتن کلیدهای همه…',
  noneReady:
    'هیچ‌کدام هنوز نمی‌توانند بپیوندند. نسخه‌ای از تکستور با گروه‌های رازداری پیش‌رو لازم است، و دعوت‌ها باید در تنظیمات ← حریم خصوصی روشن باشند.',
  someMissing: 'هنوز اضافه نشدند، چون کلید دعوتی منتشر نکرده‌اند: {names}',
  failed: 'انجام نشد: {reason}',
  unreachable: 'به رله‌های گروه دسترسی نبود. اتصال خود را بررسی کنید و دوباره تلاش کنید.',
  raced: 'کس دیگری همان لحظه گروه را تغییر داد. دوباره تلاش کنید.',
  badge: 'گروه رازداری پیش‌رو',
  explainer:
    'با MLS رمزگذاری شده. کلیدهایش هر بار که کسی می‌پیوندد یا می‌رود، و دست‌کم هفته‌ای یک بار، عوض می‌شوند.',
  code: 'کد امنیتی',
  codeHint:
    'همهٔ اعضای گروه تا تغییر بعدی همین کد را می‌بینند. آن را حضوری با کسی مقایسه کنید: کد متفاوت یعنی شما یک گروه را نمی‌بینید.',
  generation: 'نسل کلید {n}',
  refreshed: 'کلیدهای شما در این دستگاه آخرین بار {when} تازه شدند.',
  refreshNow: 'همین حالا کلیدهایم را تازه کن',
  working: 'در حال انجام…',
  admin: 'مدیر',
  add: 'افزودن افراد',
  addHint: 'مخاطبانی که هنوز در گروه نیستند. هر کدام با کلید دعوتی که منتشر کرده اضافه می‌شود.',
  addChosen: 'افزودن {n}',
  nobodyToAdd: 'همهٔ مخاطبان شما از قبل اینجا هستند.',
  remove: 'حذف',
  removeConfirm: '{name} حذف شود؟ او نمی‌تواند هیچ‌چیزی را که پس از این گفته شود بخواند.',
  leave: 'ترک گروه',
  leaveConfirm:
    'این گروه را ترک می‌کنید؟ پس از رفتن نمی‌توانید چیزی را که گفته می‌شود بخوانید. آنچه گفته شد روی این دستگاه می‌ماند.',
  leaveAdmin: 'شما مدیر هستید. با رفتن، این نقش به دیگران سپرده می‌شود.',
  left: 'شما دیگر در این گروه نیستید.',
  deleteHistory: 'حذف از این دستگاه',
  deleteConfirm: 'تاریخچهٔ این گروه از این دستگاه حذف شود؟',
}

export const SECURE_TEXT: Record<LocaleCode, Record<SecureTextKey, string>> = { en, fa }

export type SecureTextFn = (key: SecureTextKey, values?: Interpolations) => string

export function useSecureText(): SecureTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(SECURE_TEXT[locale][key], values)
}

/**
 * An engine error, in words. Two are common enough to deserve their own;
 * anything else is shown as the engine put it, which beats saying nothing.
 */
export function explainFailure(text: SecureTextFn, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const reason = /could not be reached/.test(message)
    ? text('unreachable')
    : /changed while/.test(message)
      ? text('raced')
      : message
  return text('failed', { reason })
}
