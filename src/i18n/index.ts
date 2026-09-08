import { createContext, useContext } from 'react'
import type { LocaleCode } from '../core/models/types'
import { en, type Dictionary } from './en'
import { fa } from './fa'

export type { Dictionary }

export const DICTIONARIES: Record<LocaleCode, Dictionary> = { en, fa }

export const LOCALE_NAMES: Record<LocaleCode, string> = { en: 'English', fa: 'فارسی' }

/**
 * Two-character labels for the compact language switch on the entry screens,
 * written in each language's own script so a reader can find their own without
 * knowing the others.
 */
export const LOCALE_SHORT_NAMES: Record<LocaleCode, string> = { en: 'EN', fa: 'فا' }

/** Every shipped locale, in the order they are offered. */
export const LOCALE_CODES = Object.keys(LOCALE_NAMES) as LocaleCode[]

export const LOCALE_DIRECTION: Record<LocaleCode, 'ltr' | 'rtl'> = { en: 'ltr', fa: 'rtl' }

/**
 * Dotted key into the dictionary, e.g. `chat.placeholder`.
 *
 * Typed against the English dictionary so a missing or renamed key is a compile
 * error rather than a string rendered raw in the UI.
 */
type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`
}[keyof T & string]

export type TranslationKey = Leaves<Dictionary>

export type Interpolations = Record<string, string | number>

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let node: unknown = dictionary
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

export function translate(locale: LocaleCode, key: TranslationKey, values?: Interpolations): string {
  // Fall back to English rather than showing a raw key: an untranslated string
  // is a small annoyance, a visible `settings.relayLatency` is a bug report.
  const template = lookup(DICTIONARIES[locale], key) ?? lookup(en, key) ?? key
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}

export type TranslateFn = (key: TranslationKey, values?: Interpolations) => string

export interface I18nContextValue {
  locale: LocaleCode
  dir: 'ltr' | 'rtl'
  t: TranslateFn
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  dir: 'ltr',
  t: (key, values) => translate('en', key, values),
})

export const useI18n = (): I18nContextValue => useContext(I18nContext)

export const useT = (): TranslateFn => useI18n().t

/** Best-effort match of the browser's languages against what we ship. */
export function detectLocale(): LocaleCode {
  if (typeof navigator === 'undefined') return 'en'
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag?.toLowerCase().split('-')[0]
    if (base === 'fa') return 'fa'
    if (base === 'en') return 'en'
  }
  return 'en'
}
