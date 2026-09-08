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
    'A call connects your device straight to the other person’s, encrypted end to end. Textor runs no servers of its own: the servers below are the only ones a call touches, and unless a call goes through a TURN server, each of you can see the other’s IP address.',
  relayCalls: 'Always relay calls',
  relayCallsBody:
    'Send every call through your TURN server, so the other person sees the server’s address instead of yours. Adds a little delay.',
  relayCallsNeedsTurn: 'Add a TURN server below to turn this on.',
  iceServers: 'Connection servers',
  iceServersBody:
    'A STUN server tells your device its public address, which is all a direct call needs. If you add a TURN server, it can relay a call your two networks cannot carry. Calls try the direct way first and bring it in only when that fails, so it hears only of the calls that needed it. It then sees both your IP addresses and when and for how long you talk, never what is said.',
  iceNoPublicTurn:
    'Calls need no setup and no account. They connect directly whenever your two networks allow it, and when they do not, the walkie-talkie in a conversation’s header still works over relays. A TURN server is optional: add one here only if you already run your own, such as coturn or one for Matrix. One of you having one is enough.',
  iceBuiltIn: 'Built in: public STUN from Google and Cloudflare',
  iceNone: 'No servers of your own yet.',
  iceUrl: 'Server address',
  iceUrlPlaceholder: 'turn:turn.example.com:3478',
  iceUsername: 'Username',
  icePassword: 'Password',
  iceSecret: 'The password is a shared secret',
  iceSecretBody:
    'For a coturn server set up with use-auth-secret, as for Nextcloud Talk or Matrix. Textor makes a password from it for each call, good for a day; the secret itself never leaves this device.',
  iceSecretLabel: 'Shared secret',
  iceSecretName: 'Name (optional)',
  iceSecretTag: 'shared secret',
  iceAdd: 'Add server',
  iceRemove: 'Remove server',
  iceInvalid: 'Use a stun:, turn: or turns: address.',
  iceExists: 'That server is already in the list.',
  iceNeedsCredentials: 'A TURN server needs a username and a password.',
  iceNeedsSecret: 'Enter the server’s shared secret.',
  iceTest: 'Test connection',
  iceTesting: 'Testing…',
  iceStun: 'Public address (STUN)',
  iceTurn: 'Relay (TURN)',
  iceWorking: 'Working',
  iceNotReachable: 'Not reachable',
  iceNotSet: 'Not set up',
  iceSymmetric: 'Symmetric NAT (likely)',
  iceIpv6: 'IPv6, with no NAT',
  iceIpv6Yes: 'Available',
  iceIpv6No: 'Not available',
  iceIpv6Body:
    'A call to someone who also has IPv6 can usually connect directly, whatever either of your NATs does.',
  iceVerdictGood: 'Calls should connect on almost any network.',
  iceVerdictStun:
    'Direct calls should connect with most people. If the other person’s network is strict, the walkie-talkie still works.',
  iceVerdictSymmetric:
    'Your network looks like symmetric NAT, so direct calls will often fail, unless the other person’s network is more open. The walkie-talkie still works.',
  iceVerdictNone:
    'Your network blocks STUN, so direct calls will likely fail. The walkie-talkie still works, since it goes over the same relays as your messages.',
  iceVerdictTurnFailed: 'Your TURN server did not respond. Check its address, username and password.',
  iceUnsupported: 'This browser cannot make calls.',
  turnRelayIn: 'Relay in {ms} ms',
  turnRoundTrip: '{ms} ms round trip on calls',
  turnNarrow: 'too slow for video',
  turnAuth: 'Wrong username or password',
  turnFull: 'The server is full',
  turnRefused: 'Refused the request (error {code})',
  turnNoAnswer: 'Did not answer',
  turnResting: 'set aside after {count} failed tries',
  turnUdpOnly:
    'Every TURN address here uses UDP, and a network that blocks UDP blocks calls through them too. Add a turns: address on port 443 if your server has one.',
}

export type CallSettingsTextKey = keyof typeof en

const fa: Record<CallSettingsTextKey, string> = {
  callsBody:
    'تماس، دستگاه شما را مستقیماً و با رمزنگاری سرتاسری به دستگاه طرف مقابل وصل می‌کند. تکستور هیچ سروری از خود ندارد: تنها سرورهایی که یک تماس با آن‌ها سروکار دارد همین‌هایی است که در زیر آمده، و مگر آنکه تماس از سرور TURN بگذرد، هر یک از شما نشانی IP دیگری را می‌بیند.',
  relayCalls: 'همیشه تماس‌ها را رله کن',
  relayCallsBody:
    'همهٔ تماس‌ها از سرور TURN شما عبور می‌کند تا طرف مقابل به جای نشانی شما نشانی سرور را ببیند. کمی تأخیر اضافه می‌کند.',
  relayCallsNeedsTurn: 'برای روشن کردن این گزینه، در زیر یک سرور TURN اضافه کنید.',
  iceServers: 'سرورهای اتصال',
  iceServersBody:
    'سرور STUN نشانی عمومی دستگاه شما را به آن می‌گوید، و تماس مستقیم به چیزی جز این نیاز ندارد. اگر سرور TURN اضافه کنید، می‌تواند تماسی را که شبکه‌های شما از پسش برنمی‌آیند رله کند. تماس‌ها اول راه مستقیم را امتحان می‌کنند و فقط وقتی آن شکست بخورد این سرور را به کار می‌گیرند، پس فقط از تماس‌هایی باخبر می‌شود که به آن نیاز داشتند. آن‌وقت نشانی IP هر دوی شما و زمان و مدت گفت‌وگو را می‌بیند، ولی هرگز محتوای آن را نه.',
  iceNoPublicTurn:
    'تماس‌ها به هیچ راه‌اندازی و حسابی نیاز ندارند. هر وقت شبکه‌های شما اجازه دهند مستقیم وصل می‌شوند، و وقتی اجازه ندهند، بی‌سیم در سربرگ گفت‌وگو همچنان از راه رله‌ها کار می‌کند. سرور TURN اختیاری است: فقط اگر از قبل سرور خودتان را دارید، مثلاً coturn یا سروری برای Matrix، آن را اینجا اضافه کنید. کافی است یکی از شما چنین سروری داشته باشد.',
  iceBuiltIn: 'داخلی: STUN عمومی گوگل و کلادفلر',
  iceNone: 'هنوز سروری از خودتان ندارید.',
  iceUrl: 'نشانی سرور',
  iceUrlPlaceholder: 'turn:turn.example.com:3478',
  iceUsername: 'نام کاربری',
  icePassword: 'گذرواژه',
  iceSecret: 'گذرواژه یک رمز مشترک است',
  iceSecretBody:
    'برای سرور coturn که با use-auth-secret راه‌اندازی شده، مانند آنچه برای Nextcloud Talk یا Matrix به کار می‌رود. تکستور برای هر تماس از آن گذرواژه‌ای می‌سازد که یک روز اعتبار دارد؛ خود رمز هرگز از این دستگاه بیرون نمی‌رود.',
  iceSecretLabel: 'رمز مشترک',
  iceSecretName: 'نام (اختیاری)',
  iceSecretTag: 'رمز مشترک',
  iceAdd: 'افزودن سرور',
  iceRemove: 'حذف سرور',
  iceInvalid: 'از نشانی stun:، turn: یا turns: استفاده کنید.',
  iceExists: 'این سرور از قبل در فهرست هست.',
  iceNeedsCredentials: 'سرور TURN به نام کاربری و گذرواژه نیاز دارد.',
  iceNeedsSecret: 'رمز مشترک سرور را وارد کنید.',
  iceTest: 'آزمایش اتصال',
  iceTesting: 'در حال آزمایش…',
  iceStun: 'نشانی عمومی (STUN)',
  iceTurn: 'رله (TURN)',
  iceWorking: 'کار می‌کند',
  iceNotReachable: 'در دسترس نیست',
  iceNotSet: 'تنظیم نشده',
  iceSymmetric: 'NAT متقارن (احتمالاً)',
  iceIpv6: 'IPv6، بدون NAT',
  iceIpv6Yes: 'در دسترس',
  iceIpv6No: 'در دسترس نیست',
  iceIpv6Body:
    'تماس با کسی که او هم IPv6 دارد معمولاً مستقیم برقرار می‌شود، هر کاری که NAT هر یک از شما بکند.',
  iceVerdictGood: 'تماس‌ها باید تقریباً روی هر شبکه‌ای برقرار شوند.',
  iceVerdictStun:
    'تماس مستقیم باید با بیشتر افراد برقرار شود. اگر شبکهٔ طرف مقابل سخت‌گیر باشد، بی‌سیم همچنان کار می‌کند.',
  iceVerdictSymmetric:
    'به نظر می‌رسد شبکهٔ شما NAT متقارن دارد، پس تماس مستقیم اغلب شکست می‌خورد، مگر آنکه شبکهٔ طرف مقابل بازتر باشد. بی‌سیم همچنان کار می‌کند.',
  iceVerdictNone:
    'شبکهٔ شما STUN را مسدود می‌کند، پس تماس مستقیم احتمالاً شکست می‌خورد. بی‌سیم همچنان کار می‌کند، چون از همان رله‌هایی می‌گذرد که پیام‌هایتان می‌گذرند.',
  iceVerdictTurnFailed: 'سرور TURN شما پاسخ نداد. نشانی، نام کاربری و گذرواژه‌اش را بررسی کنید.',
  iceUnsupported: 'این مرورگر نمی‌تواند تماس برقرار کند.',
  turnRelayIn: 'رله در {ms} میلی‌ثانیه',
  turnRoundTrip: 'رفت‌وبرگشت {ms} میلی‌ثانیه در تماس‌ها',
  turnNarrow: 'برای تصویر بیش از حد کند',
  turnAuth: 'نام کاربری یا گذرواژه نادرست است',
  turnFull: 'ظرفیت سرور پر است',
  turnRefused: 'درخواست را رد کرد (خطای {code})',
  turnNoAnswer: 'پاسخ نداد',
  turnResting: 'پس از {count} تلاش ناموفق کنار گذاشته شد',
  turnUdpOnly:
    'همهٔ نشانی‌های TURN این فهرست از UDP استفاده می‌کنند، و شبکه‌ای که UDP را مسدود کند تماس از راه آن‌ها را هم مسدود می‌کند. اگر سرورتان نشانی turns: روی درگاه 443 دارد، آن را اضافه کنید.',
}

export const CALL_SETTINGS_TEXT: Record<LocaleCode, Record<CallSettingsTextKey, string>> = { en, fa }

export type CallSettingsTextFn = (key: CallSettingsTextKey, values?: Interpolations) => string

export function useCallSettingsText(): CallSettingsTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(CALL_SETTINGS_TEXT[locale][key], values)
}
