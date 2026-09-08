import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words of the privacy settings, kept in the settings chunk with the one
 * screen that reads them, as the relay and call settings keep theirs. Only the
 * screen's name stays in the main dictionaries, under `settings.privacy`: the
 * settings list says it too.
 */
const en = {
  idBody:
    'Anyone who has your ID can find your public key, and can see when messages reach it. Trying IDs at random to find people takes an enormous amount of computing, but someone who can afford that could list some of who uses Textor. Your name and what you write cannot be found this way.',
  readReceipts: 'Send read receipts',
  typingIndicators: 'Send typing indicators',
  directConnection: 'Use direct connections when possible',
  directConnectionBody:
    'Connects straight to your contact for faster delivery. Reveals your IP address to them, as any direct connection does.',
  notifications: 'Show notifications for new messages',
  notificationsBody:
    'Only while Textor is open in a tab — delivering notifications to a closed app would require a server we do not run. The notification shows who messaged you, never the message.',
  notificationsDenied: 'Your browser has blocked notifications for this site.',
  publicProfile: 'Publish a public profile',
  publicProfileBody:
    'Makes your name and picture readable by anyone on the relay network, linked to your key. Off by default.',
  mlsInvites: 'Let contacts add me to forward-secret groups',
  mlsInvitesBody:
    'Keeps a KeyPackage published: a public key, signed by you, that lets someone add you to a group while you are offline. Turning this off withdraws it.',
  retention: 'Keep message history',
  retentionForever: 'Forever',
  retentionDays: '{n} days',
  messageExpiry: 'Ask relays to delete messages after',
  messageExpiryBody:
    'Relays that support expiration will drop your messages after this long. Not all do. At 30 days, a message someone has not yet received is sent again, at most twice, so it can wait about 80 days for them.',
  otherDevice:
    'Another device with this key was last heard from on {when}. If it is not yours, someone else has your recovery phrase, and you should move to a new identity.',
}

export type PrivacyTextKey = keyof typeof en

const fa: Record<PrivacyTextKey, string> = {
  idBody:
    'هر کسی که شناسهٔ شما را داشته باشد می‌تواند کلید عمومی‌تان را پیدا کند و ببیند پیام‌ها چه زمانی به آن می‌رسند. امتحان کردن شناسه‌های تصادفی برای یافتن افراد به محاسبات بسیار زیادی نیاز دارد، اما کسی که توانش را داشته باشد می‌تواند بخشی از کاربران تکستور را فهرست کند. نام شما و آنچه می‌نویسید از این راه پیدا نمی‌شود.',
  readReceipts: 'ارسال رسید خواندن',
  typingIndicators: 'ارسال نشانگر در حال نوشتن',
  directConnection: 'استفاده از اتصال مستقیم در صورت امکان',
  directConnectionBody:
    'برای تحویل سریع‌تر مستقیماً به مخاطب وصل می‌شود. مانند هر اتصال مستقیمی، نشانی IP شما را برای او آشکار می‌کند.',
  notifications: 'نمایش اعلان برای پیام‌های تازه',
  notificationsBody:
    'فقط تا وقتی تکستور در یک زبانه باز است — رساندن اعلان به برنامه بسته نیازمند سروری است که ما اداره نمی‌کنیم. اعلان فقط فرستنده را نشان می‌دهد، نه متن پیام.',
  notificationsDenied: 'مرورگر شما اعلان‌های این سایت را مسدود کرده است.',
  publicProfile: 'انتشار نمایه عمومی',
  publicProfileBody:
    'نام و تصویر شما را برای هر کسی در شبکه رله قابل خواندن می‌کند و به کلیدتان پیوند می‌زند. به‌طور پیش‌فرض خاموش است.',
  mlsInvites: 'مخاطبان بتوانند مرا به گروه‌های رازداری پیش‌رو اضافه کنند',
  mlsInvitesBody:
    'یک بستهٔ کلید (KeyPackage) منتشرشده نگه می‌دارد: کلیدی عمومی با امضای شما که به دیگران اجازه می‌دهد وقتی آفلاین هستید شما را به گروه اضافه کنند. خاموش کردنش آن را پس می‌گیرد.',
  retention: 'نگهداری تاریخچه پیام',
  retentionForever: 'همیشه',
  retentionDays: '{n} روز',
  messageExpiry: 'درخواست حذف پیام از رله‌ها پس از',
  messageExpiryBody:
    'رله‌هایی که از انقضا پشتیبانی می‌کنند پیام‌ها را پس از این مدت حذف می‌کنند. همه این کار را نمی‌کنند. با گزینهٔ ۳۰ روز، پیامی که هنوز به دست کسی نرسیده حداکثر دو بار دوباره فرستاده می‌شود، تا حدود ۸۰ روز برایش بماند.',
  otherDevice:
    'آخرین خبر از دستگاه دیگری با همین کلید در {when} بوده است. اگر آن دستگاه از شما نیست، کس دیگری عبارت بازیابی شما را دارد و باید به هویت تازه‌ای بروید.',
}

export const PRIVACY_TEXT: Record<LocaleCode, Record<PrivacyTextKey, string>> = { en, fa }

export function usePrivacyText(): (key: PrivacyTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(PRIVACY_TEXT[locale][key], values)
}
