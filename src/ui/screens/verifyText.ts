import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words for comparing safety numbers, kept in the verify chunk with the
 * one screen that reads them (ADR-061).
 */
const en = {
  title: 'Safety number',
  body: 'Compare these numbers with {name} in person or over a call you trust. If they match, nobody is intercepting your conversation.',
  markVerified: 'They match — mark as verified',
  markUnverified: 'Mark as not verified',
  verifiedAt: 'Verified on this device',
  mismatchTitle: 'If they do not match',
  mismatchBody:
    'Someone may have given you the wrong key. Do not send anything sensitive, and exchange invites again in person.',
}

const fa: typeof en = {
  title: 'شماره ایمنی',
  body: 'این شماره‌ها را حضوری یا در تماسی که به آن اعتماد دارید با {name} مقایسه کنید. اگر یکسان بودند، کسی گفتگوی شما را شنود نمی‌کند.',
  markVerified: 'یکسان است — تأیید شود',
  markUnverified: 'علامت‌گذاری به عنوان تأیید نشده',
  verifiedAt: 'روی این دستگاه تأیید شده',
  mismatchTitle: 'اگر یکسان نبودند',
  mismatchBody:
    'ممکن است کلید اشتباهی به شما داده شده باشد. چیز حساسی نفرستید و دعوت‌نامه‌ها را دوباره حضوری رد و بدل کنید.',
}

const VERIFY_TEXT: Record<LocaleCode, typeof en> = { en, fa }

export type VerifyTextKey = keyof typeof en

export function useVerifyText(): (key: VerifyTextKey, values?: Interpolations) => string {
  const { locale } = useI18n()
  return (key, values) => interpolate(VERIFY_TEXT[locale][key], values)
}
