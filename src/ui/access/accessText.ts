import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for setting up and managing how this device opens Textor, kept in
 * the access chunk with the screens that say them: onboarding, restoring a
 * backup, and Settings → Security. None of it is said by anything a returning
 * user sees before unlocking, so it stays out of the dictionaries every cold
 * start downloads (ADR-046). The lock screen's own words are in the main
 * dictionaries under `lock.*`.
 */
const en = {
  eyebrow: 'End-to-end encrypted',
  welcomeTitle: 'Welcome to Textor',
  welcomeBody:
    'Textor is a messenger with no accounts and no servers we run. Your identity is a key that lives on this device, and your messages are encrypted before they ever leave it.',
  point1: 'No phone number, no email, no sign-up',
  point2: 'Messages are end-to-end encrypted; relays only ever see ciphertext',
  point3: 'Everything is stored encrypted on this device and nowhere else',
  createIdentity: 'Create a new identity',
  restoreIdentity: 'I already have one',
  nameTitle: 'What should people call you?',
  nameBody: 'This name is only shared with people you exchange invites with. It is not published anywhere.',
  namePlaceholder: 'Your display name',

  protectTitle: 'How should this device open Textor?',
  protectBody:
    'Your messages are encrypted on this device whichever you choose. This decides what it takes to open them.',
  choiceBiometricBody:
    'Opens with {method}. Textor keeps its key on this device, never in a cloud, and asks {method} before using it. It stops someone who picks up this device — not someone who copies its browser data.',
  choicePin: 'A PIN',
  choicePinBody:
    'Six digits or more. Ten wrong tries erase it, and then your recovery phrase opens Textor. Someone who copies this device’s browser data can guess a PIN in minutes.',
  choicePattern: 'A pattern',
  choicePatternBody:
    'Connect four dots or more. Ten wrong tries erase it, and then your recovery phrase opens Textor. Like a PIN, it does not hold against a copy of this device’s browser data.',
  choiceInstant: 'Open instantly',
  choiceInstantBody:
    'No unlock step at all. Anyone who can use this device, or copy its browser data, can read your messages.',
  choicePassphrase: 'Use a passphrase',
  choicePassphraseBody:
    'You type it each time Textor opens. The only choice that protects your messages against a copy of this device’s browser data — if it is long.',
  recoveryNote:
    'Your twelve-word recovery phrase will open this device too, so losing the way you choose here does not lose your messages.',
  twoPrompts: '{method} is asked twice: once to set it up, and once to check that it works.',

  bioNotSetUp:
    '{method} is not set up on this device. Turn it on in your system settings, then come back — or choose another way.',
  bioFailed: '{method} could not be set up here. Choose another way.',
  bioNotSetUpApple:
    '{method} can guard Textor only through a passkey manager — Passwords with iCloud Keychain, or one you installed. Turn one on in Settings → General → AutoFill & Passwords, then come back. It keeps nothing that opens your messages.',
  bioNotSetUpWindows:
    'Windows Hello is not set up. Add a PIN, your face or a fingerprint in Settings → Accounts → Sign-in options, then come back.',
  bioNotSetUpAndroid:
    'Set a screen lock, with your fingerprint or face if you like, in this phone’s settings, then come back.',
  bioPrivate: 'A private window cannot use it either.',
  bioLinux:
    'Browsers on Linux cannot reach a fingerprint reader. A security key can guard Textor instead, or a PIN, a pattern or a passphrase.',
  bioFinish: 'One more step: confirm with {method} to finish setting it up.',
  bioUnverifiedSetup:
    '{method} answered without confirming it was you, so it cannot guard Textor here. Choose another way.',
  choiceKey: 'A security key',
  choiceKeyBody:
    'A FIDO2 key such as a YubiKey, unlocked with its PIN or fingerprint. Textor keeps its key on this device and asks for the security key before using it. It stops someone who picks up this device — not someone who copies its browser data.',
  instantConfirm:
    'With instant opening, anyone who can use this device, or copy its browser data, can read your messages. Turn it on?',

  passphrase: 'Passphrase',
  passphraseConfirm: 'Confirm passphrase',
  passphraseHint: 'Use at least 10 characters. A few unrelated words works well.',
  passphraseMismatch: 'The two passphrases do not match',
  passphraseTooShort: 'Use at least 10 characters',
  passphraseStrength: 'Strength',
  pin: 'PIN',
  pinConfirm: 'Confirm PIN',
  pinHint: 'Six to sixteen digits.',
  pinTooShort: 'Use six to sixteen digits',
  pinMismatch: 'The two PINs do not match',
  pattern: 'Pattern',
  patternDraw: 'Draw a pattern through four dots or more',
  patternAgain: 'Draw the same pattern again',
  patternTooShort: 'Connect four dots or more',
  patternMismatch: 'That was a different pattern. Start again.',
  patternRestart: 'Start again',
  strengthWeak: 'Weak',
  strengthFair: 'Fair',
  strengthGood: 'Good',
  strengthStrong: 'Strong',

  restoreTitle: 'Restore your identity',
  restoreBody: 'Enter your twelve-word recovery phrase, or import an encrypted backup file.',
  restorePhrase: 'Recovery phrase',
  restorePhrasePlaceholder: 'twelve words separated by spaces',
  restoreInvalid: 'That does not look like a valid recovery phrase',
  restoreFromFile: 'Import a backup file instead',
  restoreFilePassphrase: 'Backup passphrase',
  fileWithRecovery: 'Open it with my recovery phrase instead',
  fileWithPassphrase: 'Open it with its backup passphrase instead',

  levelTitle: 'How well this device is protected',
  levelInstant:
    'Anyone who can use this device, or copy its browser data, can read your messages. Its own screen lock is the only protection.',
  levelPassphrase:
    'As strong as your passphrase. Someone with a copy of this device’s data can try to guess it, as fast as their hardware allows.',
  levelBiometric:
    'Opening Textor here takes {method}. Its key is kept on this device, so this stops someone who picks up the device, not someone who copies its browser data.',
  levelPin:
    'Opening Textor here takes your PIN, and ten wrong tries erase it. Someone who copies this device’s browser data can guess a PIN in minutes.',
  levelPattern:
    'Opening Textor here takes your pattern, and ten wrong tries erase it. Someone who copies this device’s browser data can guess a pattern in minutes.',
  levelRecoveryOnly: 'Only your recovery phrase opens Textor on this device. Add an everyday way in below.',

  waysTitle: 'Ways to open Textor',
  waysBody: 'Any one of these opens this device, so it is only as safe as the weakest.',
  wayRecovery: 'Recovery phrase',
  wayRecoveryBody: 'Always opens this device. Keep the words offline.',
  wayPassphraseBody: 'Typed each time. As strong as what you chose.',
  wayBiometricBody: 'Asked for before Textor uses a key kept on this device.',
  wayPinBody: 'Ten wrong tries erase it.',
  wrongTries: '{n} wrong tries since it last opened Textor.',
  wayInstantBody: 'Opens without asking for anything.',
  added: 'Added {date}',
  onlyWay: 'Your only everyday way in: add another before removing it.',
  removeLast:
    'This is your only everyday way in. Without it, only your twelve-word recovery phrase opens Textor here. Remove it?',
  securityKeyName: 'Security key',
  addKey: 'Add a security key',
  instantExclusive:
    'Open instantly is offered only when nothing else guards this device, since it would make every other way in pointless. To use it, remove the others first: your recovery phrase still opens Textor.',
  instantWillStop: 'Setting this up turns off opening instantly: the key it kept on this device is deleted.',
  instantOff: 'Added. This device no longer opens instantly.',
  removeConfirm:
    'Stop opening Textor this way? A copy of this device’s data made before now can still be opened with it.',
  removed: 'Removed',
  addTitle: 'Add a way to open Textor',
  addBiometric: 'Add {method}',
  addPin: 'Set a PIN',
  changePin: 'Change PIN',
  addPattern: 'Set a pattern',
  changePattern: 'Change pattern',
  onePin: 'One PIN or pattern at a time: setting one replaces the other.',
  addPassphrase: 'Add a passphrase',
  changePassphrase: 'Change passphrase',
  addedToast: 'Added',
  notRetroactive:
    'Removing a way in is not retroactive: a copy of this device’s data taken earlier still opens with it.',

  sessionTitle: 'While Textor is open',
  autoLock: 'Lock after inactivity',
  autoLockNever: 'Never',
  autoLockMinutes: '{n} minutes',
  lockOnHide: 'Lock when the app goes to the background',
  instantSession: 'With instant opening, locking only hides your messages until someone taps Open.',

  recoveryPhraseBody: 'Anyone who sees these words controls your identity.',
  passphraseChanged: 'Passphrase changed',
  pinChanged: 'PIN changed',
  patternChanged: 'Pattern changed',

  confirmTitle: 'Confirm it is you',
  confirmBody: 'Open Textor again the way you usually do, to continue.',
  confirmWith: 'Confirm with {method}',
}

export type AccessTextKey = keyof typeof en

const fa: Record<AccessTextKey, string> = {
  eyebrow: 'رمزگذاری سرتاسری',
  welcomeTitle: 'به تکستور خوش آمدید',
  welcomeBody:
    'تکستور پیام‌رسانی است بدون حساب کاربری و بدون سروری که ما اداره کنیم. هویت شما کلیدی است که روی همین دستگاه می‌ماند و پیام‌ها پیش از خروج از دستگاه رمزگذاری می‌شوند.',
  point1: 'بدون شماره تلفن، بدون ایمیل، بدون ثبت‌نام',
  point2: 'پیام‌ها سرتاسر رمزگذاری می‌شوند؛ رله‌ها فقط داده رمزشده می‌بینند',
  point3: 'همه چیز رمزگذاری‌شده روی همین دستگاه ذخیره می‌شود و جای دیگری نه',
  createIdentity: 'ساخت هویت جدید',
  restoreIdentity: 'هویت دارم',
  nameTitle: 'دیگران شما را چه صدا کنند؟',
  nameBody:
    'این نام فقط با کسانی که با آن‌ها دعوت‌نامه رد و بدل می‌کنید به اشتراک گذاشته می‌شود و جایی منتشر نمی‌شود.',
  namePlaceholder: 'نام نمایشی شما',

  protectTitle: 'این دستگاه تکستور را چگونه باز کند؟',
  protectBody:
    'هر کدام را انتخاب کنید، پیام‌ها روی این دستگاه رمزگذاری‌شده می‌مانند. این انتخاب تعیین می‌کند باز کردنشان چه می‌خواهد.',
  choiceBiometricBody:
    'با {method} باز می‌شود. تکستور کلیدش را روی همین دستگاه نگه می‌دارد، هرگز در فضای ابری، و پیش از به کار بردنش {method} را می‌خواهد. جلوی کسی را می‌گیرد که این دستگاه را برمی‌دارد، نه کسی که از داده‌های مرورگرش رونوشت می‌گیرد.',
  choicePin: 'پین',
  choicePinBody:
    'شش رقم یا بیشتر. ده تلاش نادرست پاکش می‌کند و آن وقت عبارت بازیابی تکستور را باز می‌کند. کسی که از داده‌های مرورگر این دستگاه رونوشت بگیرد، پین را در چند دقیقه حدس می‌زند.',
  choicePattern: 'الگو',
  choicePatternBody:
    'چهار نقطه یا بیشتر را به هم وصل کنید. ده تلاش نادرست پاکش می‌کند و آن وقت عبارت بازیابی تکستور را باز می‌کند. مثل پین، در برابر رونوشت داده‌های مرورگر این دستگاه نمی‌ایستد.',
  choiceInstant: 'باز شدن فوری',
  choiceInstantBody:
    'هیچ مرحلهٔ باز کردنی ندارد. هر کس بتواند از این دستگاه استفاده کند یا از داده‌های مرورگرش رونوشت بگیرد، پیام‌های شما را می‌خواند.',
  choicePassphrase: 'با گذرواژه',
  choicePassphraseBody:
    'هر بار که تکستور باز می‌شود آن را وارد می‌کنید. تنها انتخابی که پیام‌ها را در برابر رونوشت داده‌های مرورگر این دستگاه محافظت می‌کند — اگر بلند باشد.',
  recoveryNote:
    'عبارت بازیابی دوازده‌واژه‌ای شما هم این دستگاه را باز می‌کند، پس گم کردن راهی که اینجا انتخاب می‌کنید به معنای از دست رفتن پیام‌ها نیست.',
  twoPrompts: '{method} دو بار خواسته می‌شود: یک بار برای راه‌اندازی و یک بار برای بررسی اینکه کار می‌کند.',

  bioNotSetUp:
    '{method} روی این دستگاه راه‌اندازی نشده است. آن را در تنظیمات سیستم روشن کنید و برگردید، یا راه دیگری انتخاب کنید.',
  bioFailed: '{method} اینجا راه‌اندازی نشد. راه دیگری انتخاب کنید.',
  bioNotSetUpApple:
    '{method} فقط از راه یک مدیر کلید عبور می‌تواند از تکستور محافظت کند — Passwords با iCloud Keychain یا مدیری که نصب کرده‌اید. یکی را در Settings → General → AutoFill & Passwords روشن کنید و برگردید. چیزی که پیام‌هایتان را باز کند در آن نگه داشته نمی‌شود.',
  bioNotSetUpWindows:
    'Windows Hello راه‌اندازی نشده است. در Settings → Accounts → Sign-in options یک پین، چهره یا اثر انگشت اضافه کنید و برگردید.',
  bioNotSetUpAndroid: 'در تنظیمات این گوشی یک قفل صفحه، و اگر خواستید اثر انگشت یا چهره، بگذارید و برگردید.',
  bioPrivate: 'در پنجرهٔ خصوصی هم در دسترس نیست.',
  bioLinux:
    'مرورگرها در Linux به حسگر اثر انگشت دسترسی ندارند. به جای آن یک کلید امنیتی می‌تواند از تکستور محافظت کند، یا پین، الگو یا گذرواژه.',
  bioFinish: 'یک قدم دیگر: برای پایان راه‌اندازی، با {method} تأیید کنید.',
  bioUnverifiedSetup:
    '{method} بدون تأیید اینکه خودتان هستید پاسخ داد، پس اینجا نمی‌تواند از تکستور محافظت کند. راه دیگری انتخاب کنید.',
  choiceKey: 'کلید امنیتی',
  choiceKeyBody:
    'یک کلید FIDO2 مثل YubiKey که با پین یا اثر انگشت خودش باز می‌شود. تکستور کلیدش را روی همین دستگاه نگه می‌دارد و پیش از به کار بردنش کلید امنیتی را می‌خواهد. جلوی کسی را می‌گیرد که این دستگاه را برمی‌دارد، نه کسی که از داده‌های مرورگرش رونوشت می‌گیرد.',
  instantConfirm:
    'با باز شدن فوری، هر کس بتواند از این دستگاه استفاده کند یا از داده‌های مرورگرش رونوشت بگیرد، پیام‌های شما را می‌خواند. روشن شود؟',

  passphrase: 'گذرواژه',
  passphraseConfirm: 'تکرار گذرواژه',
  passphraseHint: 'دست‌کم ۱۰ نویسه. چند واژه بی‌ربط به هم انتخاب خوبی است.',
  passphraseMismatch: 'دو گذرواژه یکسان نیستند',
  passphraseTooShort: 'دست‌کم ۱۰ نویسه وارد کنید',
  passphraseStrength: 'استحکام',
  pin: 'پین',
  pinConfirm: 'تکرار پین',
  pinHint: 'شش تا شانزده رقم.',
  pinTooShort: 'شش تا شانزده رقم وارد کنید',
  pinMismatch: 'دو پین یکسان نیستند',
  pattern: 'الگو',
  patternDraw: 'الگویی از چهار نقطه یا بیشتر بکشید',
  patternAgain: 'همان الگو را دوباره بکشید',
  patternTooShort: 'چهار نقطه یا بیشتر را وصل کنید',
  patternMismatch: 'الگوی دیگری بود. از نو شروع کنید.',
  patternRestart: 'شروع دوباره',
  strengthWeak: 'ضعیف',
  strengthFair: 'متوسط',
  strengthGood: 'خوب',
  strengthStrong: 'قوی',

  restoreTitle: 'بازیابی هویت',
  restoreBody: 'عبارت بازیابی دوازده‌واژه‌ای خود را وارد کنید یا یک فایل پشتیبان رمزگذاری‌شده را وارد کنید.',
  restorePhrase: 'عبارت بازیابی',
  restorePhrasePlaceholder: 'دوازده واژه جدا شده با فاصله',
  restoreInvalid: 'این عبارت بازیابی معتبر به نظر نمی‌رسد',
  restoreFromFile: 'به جای آن، فایل پشتیبان وارد کنید',
  restoreFilePassphrase: 'گذرواژه پشتیبان',
  fileWithRecovery: 'به جای آن، با عبارت بازیابی باز شود',
  fileWithPassphrase: 'به جای آن، با گذرواژهٔ پشتیبان باز شود',

  levelTitle: 'این دستگاه چقدر محافظت می‌شود',
  levelInstant:
    'هر کس بتواند از این دستگاه استفاده کند یا از داده‌های مرورگرش رونوشت بگیرد، پیام‌های شما را می‌خواند. تنها محافظ، قفل صفحهٔ خود دستگاه است.',
  levelPassphrase:
    'به اندازهٔ گذرواژهٔ شما قوی است. کسی که رونوشتی از داده‌های این دستگاه دارد می‌تواند با هر سرعتی که سخت‌افزارش اجازه دهد آن را حدس بزند.',
  levelBiometric:
    'باز کردن تکستور در اینجا {method} می‌خواهد. کلیدش روی همین دستگاه نگه داشته می‌شود، پس جلوی کسی را می‌گیرد که دستگاه را برمی‌دارد، نه کسی که از داده‌های مرورگرش رونوشت می‌گیرد.',
  levelPin:
    'باز کردن تکستور در اینجا پین شما را می‌خواهد و ده تلاش نادرست پاکش می‌کند. کسی که از داده‌های مرورگر این دستگاه رونوشت بگیرد، پین را در چند دقیقه حدس می‌زند.',
  levelPattern:
    'باز کردن تکستور در اینجا الگوی شما را می‌خواهد و ده تلاش نادرست پاکش می‌کند. کسی که از داده‌های مرورگر این دستگاه رونوشت بگیرد، الگو را در چند دقیقه حدس می‌زند.',
  levelRecoveryOnly:
    'فقط عبارت بازیابی تکستور را روی این دستگاه باز می‌کند. در پایین یک راه روزمره اضافه کنید.',

  waysTitle: 'راه‌های باز کردن تکستور',
  waysBody: 'هر کدام از این‌ها این دستگاه را باز می‌کند، پس امنیتش به اندازهٔ ضعیف‌ترینشان است.',
  wayRecovery: 'عبارت بازیابی',
  wayRecoveryBody: 'همیشه این دستگاه را باز می‌کند. واژه‌ها را بیرون از اینترنت نگه دارید.',
  wayPassphraseBody: 'هر بار وارد می‌شود. به اندازهٔ همان چیزی که انتخاب کرده‌اید قوی است.',
  wayBiometricBody: 'پیش از آنکه تکستور کلیدِ نگه‌داشته‌شده روی این دستگاه را به کار ببرد، خواسته می‌شود.',
  wayPinBody: 'ده تلاش نادرست پاکش می‌کند.',
  wrongTries: '{n} تلاش نادرست از آخرین باری که تکستور را باز کرد.',
  wayInstantBody: 'بدون پرسیدن چیزی باز می‌شود.',
  added: 'افزوده در {date}',
  onlyWay: 'تنها راه روزمرهٔ شما برای ورود است: پیش از حذف، راه دیگری اضافه کنید.',
  removeLast:
    'این تنها راه روزمرهٔ شما برای ورود است. بدون آن فقط عبارت بازیابی دوازده‌واژه‌ای تکستور را اینجا باز می‌کند. حذف شود؟',
  securityKeyName: 'کلید امنیتی',
  addKey: 'افزودن کلید امنیتی',
  instantExclusive:
    'باز شدن فوری فقط وقتی پیشنهاد می‌شود که هیچ چیز دیگری از این دستگاه محافظت نکند، چون هر راه دیگر را بی‌اثر می‌کند. برای استفاده از آن، اول بقیه را حذف کنید: عبارت بازیابی همچنان تکستور را باز می‌کند.',
  instantWillStop:
    'راه‌اندازی این، باز شدن فوری را خاموش می‌کند: کلیدی که برایش روی این دستگاه نگه داشته شده بود پاک می‌شود.',
  instantOff: 'افزوده شد. این دستگاه دیگر فوری باز نمی‌شود.',
  removeConfirm:
    'دیگر تکستور از این راه باز نشود؟ رونوشتی از داده‌های این دستگاه که پیش از این گرفته شده، همچنان با آن باز می‌شود.',
  removed: 'حذف شد',
  addTitle: 'افزودن راهی برای باز کردن تکستور',
  addBiometric: 'افزودن {method}',
  addPin: 'گذاشتن پین',
  changePin: 'تغییر پین',
  addPattern: 'گذاشتن الگو',
  changePattern: 'تغییر الگو',
  onePin: 'هر بار یک پین یا یک الگو: گذاشتن یکی، دیگری را جایگزین می‌کند.',
  addPassphrase: 'افزودن گذرواژه',
  changePassphrase: 'تغییر گذرواژه',
  addedToast: 'افزوده شد',
  notRetroactive:
    'حذف یک راه ورود عطف به ماسبق نمی‌شود: رونوشتی از داده‌های این دستگاه که پیش‌تر گرفته شده، همچنان با آن باز می‌شود.',

  sessionTitle: 'وقتی تکستور باز است',
  autoLock: 'قفل پس از بی‌کاری',
  autoLockNever: 'هرگز',
  autoLockMinutes: '{n} دقیقه',
  lockOnHide: 'قفل شدن وقتی برنامه به پس‌زمینه می‌رود',
  instantSession: 'با باز شدن فوری، قفل کردن فقط پیام‌ها را پنهان می‌کند تا کسی «باز کردن» را بزند.',

  recoveryPhraseBody: 'هر کس این واژه‌ها را ببیند هویت شما را در اختیار دارد.',
  passphraseChanged: 'گذرواژه تغییر کرد',
  pinChanged: 'پین تغییر کرد',
  patternChanged: 'الگو تغییر کرد',

  confirmTitle: 'تأیید کنید که خودتان هستید',
  confirmBody: 'برای ادامه، تکستور را همان‌طور که همیشه باز می‌کنید دوباره باز کنید.',
  confirmWith: 'تأیید با {method}',
}

export const ACCESS_TEXT: Record<LocaleCode, Record<AccessTextKey, string>> = { en, fa }

export type AccessTextFn = (key: AccessTextKey, values?: Interpolations) => string

export function useAccessText(): AccessTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(ACCESS_TEXT[locale][key], values)
}
