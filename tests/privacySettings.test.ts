// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { PrivacySettings } from '@/ui/screens/Settings'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { DEFAULT_SETTINGS, type LocaleCode } from '@/core/models/types'

/**
 * What Privacy says about relays and devices (ADR-073): the lifetimes a wrap may
 * ask for, and another device of this identity, which may not be yours.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

async function show(locale: LocaleCode, heard: number[] | Error) {
  useApp.setState({
    settings: { ...DEFAULT_SETTINGS, locale },
    otherDevices: () => (heard instanceof Error ? Promise.reject(heard) : Promise.resolve(heard)),
  })
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root = createRoot(host)
  const i18n = {
    locale,
    dir: LOCALE_DIRECTION[locale],
    t: (key: never, values?: never) => translate(locale, key, values),
  }
  await act(async () => {
    root!.render(
      createElement(I18nContext.Provider, { value: i18n as never }, createElement(PrivacySettings)),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return document.body.textContent ?? ''
}

describe('privacy settings', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('offers no lifetime longer than can be kept', async () => {
    await show('en', [])
    const selects = [...document.querySelectorAll('select')]
    const expiry = selects.at(-1)!
    expect([...expiry.options].map((option) => option.value)).toEqual(['7', '30'])
  })

  it('says nothing of other devices when there are none', async () => {
    expect(await show('en', [])).not.toContain('Another device')
    expect(await show('en', new Error('locked'))).not.toContain('Another device')
  })

  it('says when another device was last heard from, and what it means if it is not yours', async () => {
    const seen = new Date('2026-11-01T12:00:00Z').getTime()
    const text = await show('en', [seen - 86_400_000, seen])
    expect(text).toContain('Another device with this key was last heard from on')
    expect(text).toContain('Nov')
    expect(text).toContain('move to a new identity')
  })

  it('says so in Persian too', async () => {
    expect(await show('fa', [Date.now()])).toContain('دستگاه دیگری با همین کلید')
  })
})
