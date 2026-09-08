import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words of the relay settings, kept in the settings chunk with the one
 * screen that reads them (ADR-067), as polls and locations keep theirs. Only
 * the screen's name stays in the main dictionaries, under `settings.relays`:
 * the settings list, About and message details say it too.
 */
const en = {
  body: 'Relays are public servers that hold your encrypted messages until you fetch them. They cannot read anything. Add or remove any you like.',
  summary:
    'Textor keeps {n} of your {total} relays connected — the quickest that work. The others stand by, and one takes over the moment a relay in use fails.',
  none: 'You have no active relays. Messages cannot be sent or received.',

  inUse: 'In use',
  standby: 'Standing by',
  down: 'Not answering',
  refuses: 'Refuses your inbox',
  unreliable: 'Unreliable',
  off: 'Turned off',
  downDetail: 'Textor tries it again now and then, and uses the others meanwhile.',
  refusesDetail:
    'This relay requires sign-in to read your inbox, so it cannot deliver messages to you. Textor does not sign in to relays.',
  offDetail: 'Kept here in case you want it back.',
  turnOn: 'Turn on',
  connects: 'Connects in {n} ms',
  inbox: 'Inbox in {n} ms',
  acks: 'Accepts in {n} ms',
  stats: '{ok} delivered / {fail} failed',
  drops: 'Dropped {n}×',

  read: 'Read',
  write: 'Write',
  remove: 'Remove relay',
  add: 'Add a relay',
  placeholder: 'wss://relay.example.com',
  invalid: 'That is not a valid relay address',
  exists: 'That relay is already in your list',
  restore: 'Restore default relays',

  autoTitle: 'Replace relays that stop working',
  autoBody:
    'When a relay has not answered for three days, or has never answered at all, or keeps refusing your inbox, Textor turns it off and adds a replacement it has tested, from the relays your contacts use and the ones it ships with. Never more than you had.',
  repairedOff: 'Turned off {names}, which stopped working.',
  repairedAdded: 'Added {names} in its place, after testing it from this device.',
  dismiss: 'Dismiss',

  findTitle: 'Find relays',
  findBody:
    'Tests the relays your contacts use and the ones Textor knows, from this device. Each test connects to the relay, which then sees your IP address, and leaves one small unreadable message that expires within the hour.',
  monitors: 'Also ask public relay monitors',
  monitorsBody:
    'Monitors publish reports on relays (NIP-66). Asking downloads up to a few hundred kilobytes of them from a relay you use. What they claim decides only what gets tested.',
  test: 'Test relays',
  testing: 'Testing {n} of {total}…',
  nothing: 'There are no relays left to test.',
  fromContacts: 'Your contacts read here: {n}',
  fromTextor: 'Known to Textor',
  fromMonitors: 'Reported by {n} monitors',
  failed: 'Did not pass: {reason}',
  addThis: 'Add',
}

const fa: typeof en = {
  body: 'رله‌ها سرورهای عمومی‌اند که پیام‌های رمزشده شما را تا زمان دریافت نگه می‌دارند. آن‌ها نمی‌توانند چیزی بخوانند. هر کدام را خواستید اضافه یا حذف کنید.',
  summary:
    'تکستور {n} رله از {total} رله شما را وصل نگه می‌دارد: سریع‌ترین‌هایی که کار می‌کنند. بقیه آماده می‌مانند و هر وقت رله‌ای که در حال استفاده است از کار بیفتد، یکی جایش را می‌گیرد.',
  none: 'هیچ رله فعالی ندارید. پیام‌ها نه ارسال می‌شوند و نه دریافت.',

  inUse: 'در حال استفاده',
  standby: 'آماده',
  down: 'پاسخ نمی‌دهد',
  refuses: 'صندوق شما را نمی‌دهد',
  unreliable: 'ناپایدار',
  off: 'خاموش',
  downDetail: 'تکستور هر از گاهی دوباره امتحانش می‌کند و تا آن موقع از بقیه استفاده می‌کند.',
  refusesDetail:
    'این رله برای خواندن صندوق ورودی شما ورود به حساب می‌خواهد، پس نمی‌تواند پیامی به شما برساند. تکستور به رله‌ها وارد نمی‌شود.',
  offDetail: 'اینجا نگه داشته شده، اگر خواستید برش گردانید.',
  turnOn: 'روشن کردن',
  connects: 'اتصال در {n} میلی‌ثانیه',
  inbox: 'صندوق در {n} میلی‌ثانیه',
  acks: 'پذیرش در {n} میلی‌ثانیه',
  stats: '{ok} تحویل / {fail} ناموفق',
  drops: '{n} بار قطع شده',

  read: 'خواندن',
  write: 'نوشتن',
  remove: 'حذف رله',
  add: 'افزودن رله',
  placeholder: 'wss://relay.example.com',
  invalid: 'این نشانی رله معتبر نیست',
  exists: 'این رله از قبل در فهرست شماست',
  restore: 'بازگرداندن رله‌های پیش‌فرض',

  autoTitle: 'جایگزینی رله‌هایی که از کار می‌افتند',
  autoBody:
    'وقتی رله‌ای سه روز پاسخ ندهد، یا هرگز پاسخی نداده باشد، یا مدام صندوق شما را ندهد، تکستور خاموشش می‌کند و رله‌ای را که آزموده به جایش می‌گذارد، از رله‌هایی که مخاطبانتان به کار می‌برند و رله‌هایی که خودش همراه دارد. هرگز بیش از آنچه داشتید.',
  repairedOff: '{names} خاموش شد، چون از کار افتاده بود.',
  repairedAdded: '{names} پس از آزمودن از همین دستگاه به جایش اضافه شد.',
  dismiss: 'بستن',

  findTitle: 'یافتن رله',
  findBody:
    'رله‌هایی را که مخاطبانتان به کار می‌برند و رله‌هایی را که تکستور می‌شناسد از همین دستگاه می‌آزماید. هر آزمون به رله وصل می‌شود، که آن وقت نشانی IP شما را می‌بیند، و یک پیام کوچک ناخوانا می‌گذارد که تا یک ساعت دیگر منقضی می‌شود.',
  monitors: 'از پایشگرهای عمومی رله هم بپرس',
  monitorsBody:
    'پایشگرها گزارش‌هایی درباره رله‌ها منتشر می‌کنند (NIP-66). پرسیدن تا چند صد کیلوبایت از این گزارش‌ها را از یکی از رله‌های شما دریافت می‌کند. ادعای آن‌ها فقط تعیین می‌کند چه چیزی آزموده شود.',
  test: 'آزمودن رله‌ها',
  testing: 'در حال آزمودن {n} از {total}…',
  nothing: 'رله دیگری برای آزمودن نمانده.',
  fromContacts: 'مخاطبانی که صندوقشان اینجاست: {n}',
  fromTextor: 'شناخته‌شده برای تکستور',
  fromMonitors: 'گزارش {n} پایشگر',
  failed: 'رد شد: {reason}',
  addThis: 'افزودن',
}

const RELAY_TEXT: Record<LocaleCode, typeof en> = { en, fa }

export type RelayTextKey = keyof typeof en

export function useRelayText(): (key: RelayTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(RELAY_TEXT[locale][key], values)
}
