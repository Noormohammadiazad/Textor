import { interpolate, useI18n, type Interpolations } from '../../i18n'
import type { LocaleCode } from '../../core/models/types'

/**
 * The words of writing the recovery phrase down, kept in the chunk of the one
 * screen that says them (ADR-043). The reminder in the chat list stays in the
 * dictionaries as `onboarding.backupTitle`.
 */
const en = {
  backupBody:
    'These twelve words are the only way to restore your identity if you lose this device. Write them on paper. Anyone who reads them can read your messages.',
  backupReveal: 'Reveal the phrase',
  backupConfirm: 'I have written it down',
  verifyTitle: 'Confirm your recovery phrase',
  verifyBody: 'Enter word number {n} to confirm you saved it.',
  verifyWrong: 'That is not the right word',
  skipBackup: 'Skip for now',
  skipBackupWarning: 'You can find the phrase later in Settings, but only while you can unlock this device.',
}

type BackupKey = keyof typeof en

const fa: Record<BackupKey, string> = {
  backupBody:
    'این دوازده واژه تنها راه بازیابی هویت شما در صورت از دست دادن این دستگاه است. روی کاغذ بنویسیدشان. هر کس آن‌ها را بخواند می‌تواند پیام‌های شما را بخواند.',
  backupReveal: 'نمایش عبارت',
  backupConfirm: 'یادداشت کردم',
  verifyTitle: 'عبارت بازیابی را تأیید کنید',
  verifyBody: 'واژه شماره {n} را وارد کنید تا مطمئن شویم ذخیره‌اش کرده‌اید.',
  verifyWrong: 'این واژه درست نیست',
  skipBackup: 'فعلاً بگذریم',
  skipBackupWarning:
    'بعداً می‌توانید عبارت را در تنظیمات ببینید، اما فقط تا وقتی بتوانید این دستگاه را باز کنید.',
}

const BACKUP_TEXT: Record<LocaleCode, Record<BackupKey, string>> = { en, fa }

export type BackupTextFn = (key: BackupKey, values?: Interpolations) => string

export function useBackupText(): BackupTextFn {
  const { locale } = useI18n()
  return (key, values) => interpolate(BACKUP_TEXT[locale][key], values)
}
