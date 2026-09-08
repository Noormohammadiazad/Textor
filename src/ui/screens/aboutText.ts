import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * What leaves this device, in words: the account the About screen gives, and
 * the lines Settings borrows from it. Kept in the settings chunk with the
 * screens that read it (ADR-061); the introduction and the line on this
 * device's storage, which first run and Security show too, stay in the main
 * dictionaries under `privacy.*`.
 */
const en = {
  title: 'What leaves your device',
  relaysTitle: 'To relays you choose',
  relaysBody:
    'Encrypted, gift-wrapped messages addressed to your contact. Every message is signed by a throwaway key, so a relay cannot tell who sent it — only who it is for. Timestamps are randomised by up to two days.',
  relaysSee:
    'A relay can see: that someone sent a message to a given public key, at a fuzzy time, and the size class of the ciphertext.',
  relaysCannot: 'A relay cannot see: the message text, who sent it, your name, or your contact list.',
  hostTitle: 'To the web host',
  hostBody:
    'Only requests for the app files themselves, the first time you visit or after an update. Invite links keep their payload in the URL fragment, which browsers never send to a server.',
  directTitle: 'To your contacts',
  directBody:
    'If a direct connection succeeds, your contact learns your IP address — the same as any peer-to-peer call. Turn direct connections off in Settings to always route through relays.',
  stunTitle: 'To STUN servers',
  stunBody:
    'When setting up a direct connection, your browser asks a public STUN server for your externally visible address. It learns your IP and nothing else.',
  deviceTitle: 'On this device',
  limitsTitle: 'Known limits',
  limitsForwardSecrecy:
    'Direct messages and small groups have no forward secrecy: if your key is stolen, an attacker who also kept copies of old ciphertexts could read them. They are asked to expire from relays after 30 days. Forward-secret groups do not share this limit: their keys change with every change of members and at least weekly, and old keys are deleted.',
  limitsMetadata:
    'Your relay set is visible to your network provider, and the fact that a public key is fetching mail is visible to relays.',
  limitsNoPush:
    'No push notifications. Delivering them would need a server we do not run, so new messages arrive when the app is open.',
  limitsXss:
    'A cross-site scripting flaw in this app would defeat all of the above. There is no inline script, no eval, no third-party code, and a strict Content-Security-Policy.',
}

const fa: typeof en = {
  title: 'چه چیزی از دستگاه شما خارج می‌شود',
  relaysTitle: 'به رله‌هایی که خودتان انتخاب می‌کنید',
  relaysBody:
    'پیام‌های رمزگذاری‌شده و بسته‌بندی‌شده که به مخاطب شما نشانی داده شده‌اند. هر پیام با کلیدی یک‌بارمصرف امضا می‌شود، بنابراین رله نمی‌فهمد چه کسی فرستاده — فقط می‌داند برای چه کسی است. زمان‌ها تا دو روز به‌طور تصادفی جابه‌جا می‌شوند.',
  relaysSee:
    'رله می‌بیند: اینکه کسی به یک کلید عمومی مشخص پیامی فرستاده، در زمانی تقریبی، و اندازه تقریبی داده رمزشده.',
  relaysCannot: 'رله نمی‌بیند: متن پیام، فرستنده، نام شما، یا فهرست مخاطبانتان.',
  hostTitle: 'به میزبان وب',
  hostBody:
    'فقط درخواست خود فایل‌های برنامه، آن هم در نخستین بازدید یا پس از به‌روزرسانی. محتوای پیوندهای دعوت در بخش قطعه‌ای نشانی می‌ماند که مرورگرها هرگز برای سرور نمی‌فرستند.',
  directTitle: 'به مخاطبان شما',
  directBody:
    'اگر اتصال مستقیم برقرار شود، مخاطب شما نشانی IP شما را می‌بیند — مانند هر تماس نظیر به نظیر دیگری. برای عبور همیشگی از رله‌ها، اتصال مستقیم را در تنظیمات خاموش کنید.',
  stunTitle: 'به سرورهای STUN',
  stunBody:
    'هنگام برقراری اتصال مستقیم، مرورگر شما نشانی بیرونی‌تان را از یک سرور عمومی STUN می‌پرسد. آن سرور فقط نشانی IP شما را می‌بیند و نه چیز دیگری.',
  deviceTitle: 'روی همین دستگاه',
  limitsTitle: 'محدودیت‌های شناخته‌شده',
  limitsForwardSecrecy:
    'پیام‌های مستقیم و گروه‌های کوچک رازداری پیش‌رو ندارند: اگر کلید شما دزدیده شود، مهاجمی که نسخه‌های قدیمی داده رمزشده را هم نگه داشته باشد می‌تواند آن‌ها را بخواند. از رله‌ها خواسته می‌شود آن‌ها را پس از ۳۰ روز حذف کنند. گروه‌های رازداری پیش‌رو این محدودیت را ندارند: کلیدهایشان با هر تغییر در اعضا و دست‌کم هر هفته عوض می‌شود و کلیدهای قدیمی پاک می‌شوند.',
  limitsMetadata:
    'مجموعه رله‌های شما برای ارائه‌دهنده اینترنتتان دیده می‌شود، و رله‌ها می‌بینند که یک کلید عمومی در حال دریافت پیام است.',
  limitsNoPush:
    'اعلان فوری ندارد. برای آن به سروری نیاز است که ما اداره نمی‌کنیم، پس پیام‌های تازه وقتی می‌رسند که برنامه باز باشد.',
  limitsXss:
    'یک نقص اسکریپت‌نویسی میان‌سایتی در این برنامه همه موارد بالا را بی‌اثر می‌کند. هیچ اسکریپت درون‌خطی، هیچ eval و هیچ کد شخص ثالثی وجود ندارد و سیاست امنیتی محتوا سخت‌گیرانه است.',
}

const ABOUT_TEXT: Record<LocaleCode, typeof en> = { en, fa }

export type AboutTextKey = keyof typeof en

export function useAboutText(): (key: AboutTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(ABOUT_TEXT[locale][key], values)
}
