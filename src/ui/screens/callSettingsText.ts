import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The Calls settings page's own words, kept in the settings chunk with the
 * page — like the in-call screen's, and for the same reason: the main
 * dictionaries ship in the shell every cold start downloads, and nothing in
 * the shell says any of this (ADR-046).
 */
const en = {
  callsBody:
    'A call connects your device straight to the other person’s, encrypted end to end. Textor runs no servers of its own: the servers below are the only ones a call touches, and without a TURN server each of you can see the other’s IP address.',
  relayCalls: 'Always relay calls',
  relayCallsBody:
    'Send every call through your TURN server, so the other person sees the server’s address instead of yours. Adds a little delay.',
  relayCallsNeedsTurn: 'Add a TURN server below to turn this on.',
  iceServers: 'Connection servers',
  iceServersBody:
    'A STUN server tells your device its public address. A TURN server relays the call when the two devices cannot reach each other — behind strict office, school or mobile networks, or symmetric NAT. Add one you run or trust.',
  iceBuiltIn: 'Built in: public STUN from Google and Cloudflare',
  iceNone: 'No servers of your own yet.',
  iceUrl: 'Server address',
  iceUrlPlaceholder: 'turn:turn.example.com:3478',
  iceUsername: 'Username',
  icePassword: 'Password',
  iceAdd: 'Add server',
  iceRemove: 'Remove server',
  iceInvalid: 'Use a stun:, turn: or turns: address.',
  iceExists: 'That server is already in the list.',
  iceNeedsCredentials: 'A TURN server needs a username and a password.',
  iceTest: 'Test connection',
  iceTesting: 'Testing…',
  iceStun: 'Public address (STUN)',
  iceTurn: 'Relay (TURN)',
  iceWorking: 'Working',
  iceNotReachable: 'Not reachable',
  iceNotSet: 'Not set up',
  iceSymmetric: 'Symmetric NAT (likely)',
  iceVerdictGood: 'Calls should connect on almost any network.',
  iceVerdictStun:
    'Calls should connect on most networks. Behind strict firewalls or symmetric NAT they need a TURN server.',
  iceVerdictSymmetric:
    'Your network looks like symmetric NAT, so direct calls will often fail. Add a TURN server.',
  iceVerdictNone:
    'Your network blocks STUN, so calls will likely fail. A TURN server reached over TCP or TLS (turns:) can get through.',
  iceVerdictTurnFailed: 'Your TURN server did not respond. Check its address, username and password.',
  iceUnsupported: 'This browser cannot make calls.',
}

export type CallSettingsTextKey = keyof typeof en

const fa: Record<CallSettingsTextKey, string> = {
  callsBody:
    'تماس، دستگاه شما را مستقیماً و با رمزنگاری سرتاسری به دستگاه طرف مقابل وصل می‌کند. تکستور هیچ سروری از خود ندارد: تنها سرورهایی که یک تماس با آن‌ها سروکار دارد همین‌هایی است که در زیر آمده، و بدون سرور TURN هر یک از شما نشانی IP دیگری را می‌بیند.',
  relayCalls: 'همیشه تماس‌ها را رله کن',
  relayCallsBody:
    'همهٔ تماس‌ها از سرور TURN شما عبور می‌کند تا طرف مقابل به جای نشانی شما نشانی سرور را ببیند. کمی تأخیر اضافه می‌کند.',
  relayCallsNeedsTurn: 'برای روشن کردن این گزینه، در زیر یک سرور TURN اضافه کنید.',
  iceServers: 'سرورهای اتصال',
  iceServersBody:
    'سرور STUN نشانی عمومی دستگاه شما را به آن می‌گوید. سرور TURN تماس را وقتی دو دستگاه به هم نمی‌رسند رله می‌کند — پشت شبکه‌های سخت‌گیر اداری، دانشگاهی یا موبایل، یا NAT متقارن. سروری را که خودتان اداره می‌کنید یا به آن اعتماد دارید اضافه کنید.',
  iceBuiltIn: 'داخلی: STUN عمومی گوگل و کلادفلر',
  iceNone: 'هنوز سروری از خودتان ندارید.',
  iceUrl: 'نشانی سرور',
  iceUrlPlaceholder: 'turn:turn.example.com:3478',
  iceUsername: 'نام کاربری',
  icePassword: 'گذرواژه',
  iceAdd: 'افزودن سرور',
  iceRemove: 'حذف سرور',
  iceInvalid: 'از نشانی stun:، turn: یا turns: استفاده کنید.',
  iceExists: 'این سرور از قبل در فهرست هست.',
  iceNeedsCredentials: 'سرور TURN به نام کاربری و گذرواژه نیاز دارد.',
  iceTest: 'آزمایش اتصال',
  iceTesting: 'در حال آزمایش…',
  iceStun: 'نشانی عمومی (STUN)',
  iceTurn: 'رله (TURN)',
  iceWorking: 'کار می‌کند',
  iceNotReachable: 'در دسترس نیست',
  iceNotSet: 'تنظیم نشده',
  iceSymmetric: 'NAT متقارن (احتمالاً)',
  iceVerdictGood: 'تماس‌ها باید تقریباً روی هر شبکه‌ای برقرار شوند.',
  iceVerdictStun:
    'تماس‌ها باید روی بیشتر شبکه‌ها برقرار شوند. پشت فایروال‌های سخت‌گیر یا NAT متقارن به سرور TURN نیاز دارند.',
  iceVerdictSymmetric:
    'به نظر می‌رسد شبکهٔ شما NAT متقارن دارد، پس تماس مستقیم اغلب شکست می‌خورد. یک سرور TURN اضافه کنید.',
  iceVerdictNone:
    'شبکهٔ شما STUN را مسدود می‌کند، پس تماس‌ها احتمالاً شکست می‌خورند. سرور TURN که از راه TCP یا TLS (turns:) در دسترس باشد می‌تواند عبور کند.',
  iceVerdictTurnFailed: 'سرور TURN شما پاسخ نداد. نشانی، نام کاربری و گذرواژه‌اش را بررسی کنید.',
  iceUnsupported: 'این مرورگر نمی‌تواند تماس برقرار کند.',
}

export const CALL_SETTINGS_TEXT: Record<LocaleCode, Record<CallSettingsTextKey, string>> = { en, fa }

export type CallSettingsTextFn = (key: CallSettingsTextKey, values?: Interpolations) => string

export function useCallSettingsText(): CallSettingsTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(CALL_SETTINGS_TEXT[locale][key], values)
}
