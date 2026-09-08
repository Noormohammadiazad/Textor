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
  turnTitle: 'To a TURN server, if you add one',
  turnBody:
    'Textor includes no TURN server, and a call needs none. If you already run one and add it in Settings → Calls, a call is brought to it only when your devices cannot connect directly — or every call, with “always relay calls” on. It then sees your IP address and the other person’s, and when and for how long you talk, never what is said. Added with its shared secret, it never sees the secret: this device makes a password from it for each call.',
  voiceTitle: 'To relays, if you talk over them by walkie-talkie',
  voiceBody:
    'Only while you hold the button of a walkie-talkie, which starts from a conversation’s header and nowhere else. Your voice goes in small sealed pieces through relays — the other person’s, or one of three known to carry it: relay.primal.net, nostr-pub.wellorder.net and purplerelay.com — which pass them on and do not keep them. They see your IP address and when you talk, and can tell which address is listening, under keys made for that one session — never what is said, or either of your keys. A walkie-talkie never connects your devices to each other, so the other person does not learn your IP address.',
  scoutTitle: 'To relays being tested',
  scoutBody:
    'When a relay you use has stopped working for days, or when you ask Textor to find relays, it tests others from this device: the relays your contacts use, the ones it ships with, and — only if you ask — ones public monitors report. Each relay tested sees your IP address and receives one small unreadable message, from a throwaway key to nobody, that expires within the hour. Asking the monitors reveals only that someone looked, to a relay you already use.',
  tilesTitle: 'To OpenStreetMap, if you turn on street maps',
  tilesBody:
    'Off unless you turn it on. Then your browser fetches the map squares on screen from OpenStreetMap’s tile servers, behind their content delivery network: they see your IP address, which areas you look at — often where a contact is or was — and the address of this app, never the page. Nothing else: no message, name or key. Fetched squares stay in your browser’s cache, like any picture.',
  streetMaps: 'Street maps from OpenStreetMap',
  streetMapsBody:
    'Draw streets and places under locations. OpenStreetMap’s servers then see your IP address and the areas you look at. Off, maps are drawn on this device alone.',
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
  turnTitle: 'به سرور TURN، اگر یکی اضافه کنید',
  turnBody:
    'تکستور هیچ سرور TURN همراه خود ندارد و تماس به آن نیازی ندارد. اگر از قبل سروری دارید و آن را در تنظیمات ← تماس‌ها اضافه کنید، تماس فقط وقتی به آن سپرده می‌شود که دستگاه‌هایتان نتوانند مستقیم به هم وصل شوند — یا همهٔ تماس‌ها، اگر «همیشه تماس‌ها را رله کن» روشن باشد. آن‌وقت نشانی IP شما و طرف مقابل، و زمان و مدت گفت‌وگو را می‌بیند، ولی هرگز محتوای آن را نه. اگر با رمز مشترکش اضافه شده باشد، خود رمز را هرگز نمی‌بیند: این دستگاه برای هر تماس از آن گذرواژه‌ای می‌سازد.',
  voiceTitle: 'به رله‌ها، اگر با بی‌سیم از راه آن‌ها حرف بزنید',
  voiceBody:
    'فقط تا وقتی دکمهٔ بی‌سیم را نگه داشته‌اید، که فقط از سربرگ گفت‌وگو شروع می‌شود. صدای شما در تکه‌های کوچک مهرشده از راه رله‌ها می‌رود — رله‌های طرف مقابل، یا یکی از سه رله‌ای که می‌دانیم آن را می‌رسانند: relay.primal.net و nostr-pub.wellorder.net و purplerelay.com — که آن‌ها را می‌رسانند و نگه نمی‌دارند. رله‌ها نشانی IP شما و زمان حرف زدنتان را می‌بینند و می‌توانند بفهمند کدام نشانی گوش می‌دهد، زیر کلیدهایی که فقط برای همان گفت‌وگو ساخته شده — ولی هرگز نه آنچه گفته می‌شود و نه کلید هیچ‌یک از شما را. بی‌سیم هرگز دستگاه‌هایتان را مستقیم به هم وصل نمی‌کند، پس طرف مقابل نشانی IP شما را نمی‌فهمد.',
  scoutTitle: 'به رله‌هایی که آزموده می‌شوند',
  scoutBody:
    'وقتی رله‌ای که به کار می‌برید روزها از کار افتاده باشد، یا وقتی از تکستور بخواهید رله پیدا کند، رله‌های دیگر را از همین دستگاه می‌آزماید: رله‌هایی که مخاطبانتان به کار می‌برند، رله‌هایی که همراه خودش است، و فقط اگر بخواهید، رله‌هایی که پایشگرهای عمومی گزارش می‌دهند. هر رله‌ای که آزموده شود نشانی IP شما را می‌بیند و یک پیام کوچک ناخوانا دریافت می‌کند، از یک کلید دورریختنی به هیچ‌کس، که تا یک ساعت دیگر منقضی می‌شود. پرسیدن از پایشگرها فقط نشان می‌دهد کسی نگاه کرده، آن هم به رله‌ای که از قبل به کار می‌برید.',
  tilesTitle: 'به OpenStreetMap، اگر نقشهٔ خیابان‌ها را روشن کنید',
  tilesBody:
    'تا روشنش نکنید خاموش است. پس از آن مرورگرتان مربع‌های نقشهٔ روی صفحه را از سرورهای کاشی OpenStreetMap، که پشت شبکهٔ توزیع محتوایشان است، می‌گیرد: آن‌ها نشانی IP شما، ناحیه‌هایی که نگاه می‌کنید — که اغلب جایی است که مخاطبی هست یا بوده — و نشانی این برنامه را می‌بینند، نه صفحه را. چیز دیگری نه: نه پیام، نه نام و نه کلید. مربع‌های گرفته‌شده مانند هر تصویر دیگری در حافظهٔ نهان مرورگرتان می‌مانند.',
  streetMaps: 'نقشهٔ خیابان‌ها از OpenStreetMap',
  streetMapsBody:
    'خیابان‌ها و مکان‌ها زیر موقعیت‌ها کشیده می‌شوند. آن‌گاه سرورهای OpenStreetMap نشانی IP شما و ناحیه‌هایی را که نگاه می‌کنید می‌بینند. خاموش که باشد، نقشه فقط روی همین دستگاه کشیده می‌شود.',
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
