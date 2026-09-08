import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The in-call screen's own words, kept in the call chunk.
 *
 * The main dictionaries are part of the shell every cold start downloads;
 * these are read only while a call is on screen, so they travel with the
 * screen that reads them (ADR-046). What the rest of the app says about calls
 * — the header buttons, the lines in a conversation, the Calls settings page —
 * stays in the main dictionaries under `calls.*` and `settings.*`.
 */
const en = {
  calling: 'Calling…',
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  relaying: 'Connecting through a relay…',
  reconnecting: 'Reconnecting…',
  incomingVoice: 'Incoming voice call',
  incomingVideo: 'Incoming video call',
  incomingRadio: 'Incoming walkie-talkie',
  accept: 'Accept',
  acceptVoice: 'Answer with voice only',
  decline: 'Decline',
  hangUp: 'Hang up',
  mute: 'Mute',
  unmute: 'Unmute',
  cameraOn: 'Turn camera on',
  cameraOff: 'Turn camera off',
  flip: 'Switch camera',
  share: 'Share screen',
  stopShare: 'Stop sharing',
  minimize: 'Minimize call',
  expand: 'Return to call',
  callWith: 'Call with {name}',
  sharing: 'You are sharing your screen',
  theyShare: '{name} is sharing their screen',
  theyMuted: '{name} is muted',
  cameraIsOff: 'Camera off',
  encrypted: 'End-to-end encrypted',
  direct: 'Direct',
  directHint:
    'Audio and video go straight between your devices, so each of you can see the other’s IP address.',
  relayed: 'Relayed',
  relayedHint: 'Audio and video go through a TURN server, which sees only encrypted traffic.',
  notReached:
    '{name} has not received the call yet. Calls ring only while Textor is open on their device — there are no push notifications.',
  endedHangup: 'Call ended',
  endedCancelled: 'Call cancelled',
  endedDeclined: '{name} declined the call',
  endedBusy: '{name} is on another call',
  endedUnanswered: 'No answer',
  endedMissed: 'Missed call',
  endedLost: 'Connection lost',
  endedError: 'The call could not be placed. Check your connection and try again.',
  failedTitle: 'Could not connect the call',
  failedPeer: 'The call could not be set up on {name}’s side.',
  diagSymmetric:
    'Your two networks cannot reach each other directly, usually because of symmetric NAT or a strict firewall, and Textor has no server to relay calls through. You can still talk with the walkie-talkie in the conversation’s header.',
  diagBlocked:
    'Your network blocks the kind of traffic calls use, and Textor has no server to relay calls through. You can still talk with the walkie-talkie in the conversation’s header.',
  diagPeerBlocked:
    '{name}’s network blocks the kind of traffic calls use, and Textor has no server to relay calls through. You can still talk with the walkie-talkie in the conversation’s header.',
  diagTurnFailed: 'Your TURN server did not respond. Check its address, username and password.',
  diagUnknown:
    'The two devices could not reach each other directly, and Textor has no server to relay calls through. You can still talk with the walkie-talkie in the conversation’s header.',
  checkTurn: 'Check TURN settings',
  mediaTitle: 'Could not start the call',
  mediaDenied:
    'Textor is not allowed to use your microphone. Allow it in your browser’s settings for this site, then try again.',
  mediaMissing: 'No microphone was found.',
  mediaBusy: 'Your microphone or camera is being used by another app.',
  mediaFailed: 'Your microphone could not be started.',
  relayNeedsTurn: '“Always relay calls” is on, but there is no TURN server to relay through.',
  cameraUnavailable: 'The camera could not be started, so this is a voice call.',
  screenFailed: 'Screen sharing could not start.',
  close: 'Close',
  voiceRefused: 'Every relay that could reach {name} refused the voice stream.',
  voiceHold: 'Hold to talk',
  voiceRelease: 'Release to listen',
  voiceYouTalk: 'You are talking',
  voiceTheyTalk: '{name} is talking',
  voiceTheyListen: '{name} is listening',
  voiceTheyAway: 'Waiting for {name} to join',
  voiceRelays: 'Through {count} relays',
  voiceHeard: '{name} hears you',
  voiceUnheard: '{name} has not heard you yet. Trying more relays.',
  voiceThrottled: 'Relays are at their limit. Let go for a moment.',
  voiceLimit: 'Hold for up to 30 seconds at a time.',
  radioUnsupported: 'This browser cannot send voice over relays, so a walkie-talkie cannot start here.',
}

export type CallTextKey = keyof typeof en

const fa: Record<CallTextKey, string> = {
  calling: 'در حال تماس…',
  ringing: 'در حال زنگ خوردن…',
  connecting: 'در حال اتصال…',
  relaying: 'در حال اتصال از راه رله…',
  reconnecting: 'در حال اتصال دوباره…',
  incomingVoice: 'تماس صوتی ورودی',
  incomingVideo: 'تماس تصویری ورودی',
  incomingRadio: 'بی‌سیم ورودی',
  accept: 'پاسخ',
  acceptVoice: 'پاسخ فقط با صدا',
  decline: 'رد تماس',
  hangUp: 'قطع تماس',
  mute: 'بستن میکروفون',
  unmute: 'باز کردن میکروفون',
  cameraOn: 'روشن کردن دوربین',
  cameraOff: 'خاموش کردن دوربین',
  flip: 'تعویض دوربین',
  share: 'اشتراک‌گذاری صفحه',
  stopShare: 'توقف اشتراک‌گذاری',
  minimize: 'کوچک کردن تماس',
  expand: 'بازگشت به تماس',
  callWith: 'تماس با {name}',
  sharing: 'در حال اشتراک‌گذاری صفحهٔ خود هستید',
  theyShare: '{name} صفحهٔ خود را به اشتراک گذاشته است',
  theyMuted: 'میکروفون {name} بسته است',
  cameraIsOff: 'دوربین خاموش',
  encrypted: 'رمزنگاری سرتاسری',
  direct: 'مستقیم',
  directHint: 'صدا و تصویر مستقیماً میان دستگاه‌های شما می‌رود، پس هر یک از شما نشانی IP دیگری را می‌بیند.',
  relayed: 'رله‌شده',
  relayedHint: 'صدا و تصویر از یک سرور TURN عبور می‌کند که فقط ترافیک رمزنگاری‌شده را می‌بیند.',
  notReached:
    'تماس هنوز به {name} نرسیده است. تماس فقط وقتی زنگ می‌خورد که تکستور روی دستگاه او باز باشد — اعلان فوری (push) وجود ندارد.',
  endedHangup: 'تماس پایان یافت',
  endedCancelled: 'تماس لغو شد',
  endedDeclined: '{name} تماس را رد کرد',
  endedBusy: '{name} در تماس دیگری است',
  endedUnanswered: 'پاسخی نیامد',
  endedMissed: 'تماس بی‌پاسخ',
  endedLost: 'اتصال قطع شد',
  endedError: 'تماس برقرار نشد. اتصال خود را بررسی کنید و دوباره تلاش کنید.',
  failedTitle: 'تماس وصل نشد',
  failedPeer: 'تماس در سمت {name} راه‌اندازی نشد.',
  diagSymmetric:
    'شبکه‌های شما نمی‌توانند مستقیم به هم برسند، معمولاً به خاطر NAT متقارن یا فایروالی سخت‌گیر، و تکستور سروری برای رله کردن تماس ندارد. همچنان می‌توانید با بی‌سیم در سربرگ گفت‌وگو حرف بزنید.',
  diagBlocked:
    'شبکهٔ شما نوع ترافیکی را که تماس‌ها به کار می‌برند مسدود می‌کند، و تکستور سروری برای رله کردن تماس ندارد. همچنان می‌توانید با بی‌سیم در سربرگ گفت‌وگو حرف بزنید.',
  diagPeerBlocked:
    'شبکهٔ {name} نوع ترافیکی را که تماس‌ها به کار می‌برند مسدود می‌کند، و تکستور سروری برای رله کردن تماس ندارد. همچنان می‌توانید با بی‌سیم در سربرگ گفت‌وگو حرف بزنید.',
  diagTurnFailed: 'سرور TURN شما پاسخ نداد. نشانی، نام کاربری و گذرواژه‌اش را بررسی کنید.',
  diagUnknown:
    'دو دستگاه نتوانستند مستقیم به هم برسند، و تکستور سروری برای رله کردن تماس ندارد. همچنان می‌توانید با بی‌سیم در سربرگ گفت‌وگو حرف بزنید.',
  checkTurn: 'بررسی تنظیمات TURN',
  mediaTitle: 'تماس آغاز نشد',
  mediaDenied:
    'تکستور اجازهٔ استفاده از میکروفون شما را ندارد. در تنظیمات مرورگر برای این سایت اجازه دهید و دوباره تلاش کنید.',
  mediaMissing: 'میکروفونی پیدا نشد.',
  mediaBusy: 'میکروفون یا دوربین شما در اختیار برنامهٔ دیگری است.',
  mediaFailed: 'میکروفون شما راه‌اندازی نشد.',
  relayNeedsTurn: 'گزینهٔ «همیشه تماس‌ها را رله کن» روشن است، اما سرور TURN‌ای برای رله کردن وجود ندارد.',
  cameraUnavailable: 'دوربین راه‌اندازی نشد، پس این یک تماس صوتی است.',
  screenFailed: 'اشتراک‌گذاری صفحه آغاز نشد.',
  close: 'بستن',
  voiceRefused: 'هیچ رله‌ای که به {name} می‌رسد جریان صدا را نپذیرفت.',
  voiceHold: 'برای حرف زدن نگه دارید',
  voiceRelease: 'برای شنیدن رها کنید',
  voiceYouTalk: 'شما در حال حرف زدن هستید',
  voiceTheyTalk: '{name} در حال حرف زدن است',
  voiceTheyListen: '{name} گوش می‌دهد',
  voiceTheyAway: 'در انتظار پیوستن {name}',
  voiceRelays: 'از راه {count} رله',
  voiceHeard: '{name} صدای شما را می‌شنود',
  voiceUnheard: '{name} هنوز صدای شما را نشنیده است. رله‌های بیشتری امتحان می‌شود.',
  voiceThrottled: 'رله‌ها به سقف خود رسیده‌اند. لحظه‌ای رها کنید.',
  voiceLimit: 'هر بار تا ۳۰ ثانیه نگه دارید.',
  radioUnsupported: 'این مرورگر نمی‌تواند صدا را از راه رله‌ها بفرستد، پس بی‌سیم اینجا راه نمی‌افتد.',
}

export const CALL_TEXT: Record<LocaleCode, Record<CallTextKey, string>> = { en, fa }

export type CallTextFn = (key: CallTextKey, values?: Interpolations) => string

export const callText = (locale: LocaleCode, key: CallTextKey, values?: Interpolations): string =>
  interpolate(CALL_TEXT[locale][key], values)

export function useCallText(): CallTextFn {
  const { locale } = useI18n()
  return (key, values) => callText(locale, key, values)
}
