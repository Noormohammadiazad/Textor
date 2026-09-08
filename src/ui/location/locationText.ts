import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for locations, kept in their chunk (ADR-064) the way polls and
 * calls keep theirs: read only by the card, the picker, the viewer and the
 * banner, so they travel with those rather than growing the dictionaries every
 * cold start downloads. The attach menu's label and the chat list's preview
 * stay in the main dictionaries.
 */
const en = {
  title: 'Location',
  place: 'Location',
  live: 'Live location',
  liveEnded: 'Live location ended',
  open: 'Show on the map',
  stop: 'Stop sharing',
  untilOff: 'Until turned off',
  updatedNow: 'Updated just now',
  updated: 'Updated {ago}',
  stale: 'Last heard from {ago}',
  endedAt: 'Ended {ago}',
  left: '{time} left',

  sharingHere: 'You are sharing your live location here',
  sharingWith: 'Sharing live location with {name}',
  sharingIn: 'Sharing live location in {n} chats',

  finding: 'Finding where you are…',
  accuracy: 'Accurate to {distance}',
  moved: 'Pin moved {distance} from you',
  denied:
    'This browser is not letting Textor know where you are. You can still send a place by its coordinates.',
  unavailable: 'Your position could not be found just now.',
  unsupported: 'This browser cannot tell where you are. You can still send a place by its coordinates.',
  paste: 'Coordinates or a map link',
  notAPosition: 'That is not a position Textor can read. Try “35.6892, 51.3890” or a map link.',
  placeName: 'Name of the place (optional)',
  sendHere: 'Send your current location',
  sendPin: 'Send this place',
  shareLive: 'Share live location',
  for15: '15 minutes',
  for60: '1 hour',
  for480: '8 hours',
  forever: 'Until I turn it off',
  liveHint:
    'Everyone in this chat sees where you are as you move, until the time is up or you stop. Textor moves it only while it is open.',
  tapHint: 'Drag to look around; tap to put the pin somewhere else.',
  privacy:
    'Encrypted end to end. Your browser finds your position, and may ask its maker’s location service to. The map is drawn on this device; streets come from OpenStreetMap only if you turn them on.',

  coordinates: 'Coordinates',
  accuracyLabel: 'Accuracy',
  heading: 'Heading',
  speed: 'Speed',
  updatedLabel: 'Updated',
  endsLabel: 'Ends',
  fromYou: 'From you',
  away: '{distance} {direction}',
  showMe: 'Show where I am',
  hideMe: 'Hide where I am',
  copy: 'Copy coordinates',
  copied: 'Coordinates copied',
  openApp: 'Open in a maps app',
  openOsm: 'Open on OpenStreetMap',
  osmNote:
    'The maps app and OpenStreetMap each learn this place when you open it there. Nothing is sent until you do.',
  drawn:
    'Drawn on this device, without streets. Street maps come from OpenStreetMap, and are off until you turn them on.',
  streetsShown:
    'Streets from OpenStreetMap, whose servers see your IP address and the area shown. Turn them off with the layers button, or in Settings → Privacy.',
  streets: 'Street map',
  streetsTitle: 'Show streets from OpenStreetMap?',
  streetsBody:
    'Street maps are pictures of the map fetched from OpenStreetMap’s tile servers. They see your IP address, which areas you look at — often where a contact is — and the address of this app, never the page. Nothing else is sent: no message, name or key. You can turn them off at any time.',
  streetsYes: 'Show streets',
  streetsNo: 'Not now',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  recenter: 'Back to the marker',
  map: 'Map of {place}',
  you: 'You',

  n: 'north',
  ne: 'north-east',
  e: 'east',
  se: 'south-east',
  s: 'south',
  sw: 'south-west',
  w: 'west',
  nw: 'north-west',
}

const fa: typeof en = {
  title: 'موقعیت مکانی',
  place: 'موقعیت مکانی',
  live: 'موقعیت زنده',
  liveEnded: 'اشتراک موقعیت زنده پایان یافت',
  open: 'نمایش روی نقشه',
  stop: 'توقف اشتراک',
  untilOff: 'تا وقتی خاموشش کنید',
  updatedNow: 'همین حالا به‌روز شد',
  updated: 'به‌روزشده {ago}',
  stale: 'آخرین خبر {ago}',
  endedAt: 'پایان‌یافته {ago}',
  left: '{time} مانده',

  sharingHere: 'موقعیت زنده‌تان را در این گفتگو هم‌رسانی می‌کنید',
  sharingWith: 'هم‌رسانی موقعیت زنده با {name}',
  sharingIn: 'هم‌رسانی موقعیت زنده در {n} گفتگو',

  finding: 'در حال یافتن موقعیت شما…',
  accuracy: 'با دقت {distance}',
  moved: 'سنجاق {distance} دورتر از شماست',
  denied: 'این مرورگر به تکستور اجازه نمی‌دهد بداند کجا هستید. هنوز می‌توانید مکانی را با مختصاتش بفرستید.',
  unavailable: 'الان نمی‌شود موقعیت شما را پیدا کرد.',
  unsupported: 'این مرورگر نمی‌تواند بگوید کجا هستید. هنوز می‌توانید مکانی را با مختصاتش بفرستید.',
  paste: 'مختصات یا پیوند نقشه',
  notAPosition: 'تکستور این موقعیت را نمی‌خواند. «35.6892, 51.3890» یا پیوند یک نقشه را امتحان کنید.',
  placeName: 'نام مکان (اختیاری)',
  sendHere: 'فرستادن موقعیت کنونی شما',
  sendPin: 'فرستادن این مکان',
  shareLive: 'هم‌رسانی موقعیت زنده',
  for15: '۱۵ دقیقه',
  for60: '۱ ساعت',
  for480: '۸ ساعت',
  forever: 'تا وقتی خاموشش کنم',
  liveHint:
    'همهٔ این گفتگو، تا پایان زمان یا تا وقتی متوقفش کنید، جابه‌جایی شما را می‌بینند. تکستور فقط وقتی باز است آن را جابه‌جا می‌کند.',
  tapHint: 'برای دیدن اطراف بکشید؛ برای جابه‌جا کردن سنجاق ضربه بزنید.',
  privacy:
    'رمزگذاری سرتاسری. مرورگرتان موقعیت شما را پیدا می‌کند و شاید برای آن از سرویس مکان‌یابی سازنده‌اش کمک بگیرد. نقشه روی همین دستگاه کشیده می‌شود؛ خیابان‌ها فقط اگر روشنشان کنید از OpenStreetMap می‌آیند.',

  coordinates: 'مختصات',
  accuracyLabel: 'دقت',
  heading: 'جهت حرکت',
  speed: 'سرعت',
  updatedLabel: 'به‌روزرسانی',
  endsLabel: 'پایان',
  fromYou: 'فاصله از شما',
  away: '{distance} به سمت {direction}',
  showMe: 'نشان دادن جای من',
  hideMe: 'پنهان کردن جای من',
  copy: 'رونوشت مختصات',
  copied: 'مختصات رونوشت شد',
  openApp: 'باز کردن در برنامهٔ نقشه',
  openOsm: 'باز کردن در OpenStreetMap',
  osmNote:
    'برنامهٔ نقشه و OpenStreetMap هر کدام وقتی این مکان را آن‌جا باز کنید از آن باخبر می‌شوند. تا آن موقع چیزی فرستاده نمی‌شود.',
  drawn:
    'روی همین دستگاه و بدون خیابان کشیده شده. نقشهٔ خیابان‌ها از OpenStreetMap می‌آید و تا روشنش نکنید خاموش است.',
  streetsShown:
    'خیابان‌ها از OpenStreetMap است که سرورهایش نشانی IP شما و ناحیهٔ نمایش‌داده‌شده را می‌بینند. با دکمهٔ لایه‌ها یا در تنظیمات ← حریم خصوصی خاموششان کنید.',
  streets: 'نقشهٔ خیابان‌ها',
  streetsTitle: 'خیابان‌ها از OpenStreetMap نمایش داده شوند؟',
  streetsBody:
    'نقشهٔ خیابان‌ها تصویرهایی از نقشه است که از سرورهای کاشی OpenStreetMap گرفته می‌شود. آن سرورها نشانی IP شما، ناحیه‌هایی که نگاه می‌کنید — که اغلب جای یک مخاطب است — و نشانی این برنامه را می‌بینند، نه صفحه را. چیز دیگری فرستاده نمی‌شود: نه پیام، نه نام و نه کلید. هر وقت بخواهید می‌توانید خاموشش کنید.',
  streetsYes: 'نمایش خیابان‌ها',
  streetsNo: 'فعلاً نه',
  zoomIn: 'بزرگ‌نمایی',
  zoomOut: 'کوچک‌نمایی',
  recenter: 'بازگشت به نشانگر',
  map: 'نقشهٔ {place}',
  you: 'شما',

  n: 'شمال',
  ne: 'شمال شرقی',
  e: 'شرق',
  se: 'جنوب شرقی',
  s: 'جنوب',
  sw: 'جنوب غربی',
  w: 'غرب',
  nw: 'شمال غربی',
}

const LOCATION_TEXT: Record<LocaleCode, typeof en> = { en, fa }

export type LocationTextKey = keyof typeof en

export const locationText = (locale: LocaleCode, key: LocationTextKey, values?: Interpolations): string =>
  interpolate(LOCATION_TEXT[locale][key], values)

export function useLocationText(): (key: LocationTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => locationText(locale, key, values)
}
