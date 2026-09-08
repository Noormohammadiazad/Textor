// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { BackupCeremony } from '@/ui/screens/BackupCeremony'
import type { LocaleCode } from '@/core/models/types'
import type * as Store from '@/app/store'

/**
 * Writing the recovery phrase down: shown, then one word asked back before it
 * counts as written. Its words travel with the screen (ADR-043), and read as
 * they did from the dictionaries, in both languages.
 */

const updateIdentity = vi.fn(async () => undefined)
vi.mock('@/app/store', async (original) => ({
  ...(await original<typeof Store>()),
  getRepo: () => ({ updateIdentity }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PHRASE = 'garden ladder ocean pencil river silver table umbrella valley window yellow zebra'
const WORDS = PHRASE.split(' ')

let root: Root
let host: HTMLElement
let deferBackup: ReturnType<typeof vi.fn>
let updateProfile: ReturnType<typeof vi.fn>

async function render(locale: LocaleCode = 'en') {
  const value = { locale, dir: LOCALE_DIRECTION[locale], t: (k: never, v?: never) => translate(locale, k, v) }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: value as never },
        createElement(BackupCeremony, { mnemonic: PHRASE }),
      ),
    ),
  )
}

const text = () => host.textContent ?? ''
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!
const click = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
const type = (value: string) =>
  act(async () => {
    const input = host.querySelector<HTMLInputElement>('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const enter = () =>
  act(async () => {
    host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
/** The word asked for, by the number the screen gives. */
const asked = () => WORDS[Number(/word number (\d+)/.exec(text())![1]) - 1]!

beforeEach(() => {
  updateIdentity.mockClear()
  deferBackup = vi.fn()
  updateProfile = vi.fn(async () => undefined)
  useApp.setState({ deferBackup, updateProfile } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('writing the recovery phrase down', () => {
  it('shows the words only when asked, then asks one back', async () => {
    await render()
    expect(text()).toContain('These twelve words are the only way to restore your identity')
    expect(host.querySelector('.mnemonic-grid')?.classList.contains('blurred')).toBe(true)
    await click(button('Reveal the phrase'))
    expect(host.querySelector('.mnemonic-grid')?.classList.contains('blurred')).toBe(false)
    await click(button('I have written it down'))
    expect(text()).toContain('Confirm your recovery phrase')
    expect(text()).toMatch(/Enter word number \d+ to confirm you saved it\./)
  })

  it('refuses a wrong word, by button or by Enter, and takes the right one', async () => {
    await render()
    await click(button('Reveal the phrase'))
    await click(button('I have written it down'))
    await type('nonsense')
    await click(button('Confirm'))
    expect(text()).toContain('That is not the right word')
    // Typing again clears it, and Enter refuses a wrong word as well.
    await type('still wrong')
    expect(text()).not.toContain('That is not the right word')
    await enter()
    expect(text()).toContain('That is not the right word')
    expect(updateIdentity).not.toHaveBeenCalled()

    await type(` ${asked().toUpperCase()} `)
    await click(button('Confirm'))
    expect(updateIdentity).toHaveBeenCalledWith({ mnemonicBackedUp: true })
    expect(updateProfile).toHaveBeenCalledWith({ mnemonicBackedUp: true })
  })

  it('takes the right word on Enter too, and goes back to the words', async () => {
    await render()
    await click(button('Reveal the phrase'))
    await click(button('I have written it down'))
    await click(button('Back'))
    expect(text()).toContain('Write down your recovery phrase')
    await click(button('I have written it down'))
    await enter()
    expect(updateIdentity).not.toHaveBeenCalled()
    await type(asked())
    await enter()
    expect(updateIdentity).toHaveBeenCalledTimes(1)
  })

  it('can be put off, saying what that risks', async () => {
    await render()
    expect(text()).toContain('You can find the phrase later in Settings')
    await click(button('Skip for now'))
    expect(deferBackup).toHaveBeenCalled()
  })

  it('says it all in Persian', async () => {
    await render('fa')
    expect(text()).toContain(translate('fa', 'onboarding.backupTitle'))
    expect(text()).toContain('این دوازده واژه')
    expect(text()).toContain('فعلاً بگذریم')
    await click(button('نمایش عبارت'))
    await click(button('یادداشت کردم'))
    await type('wrong')
    await enter()
    expect(text()).toContain('این واژه درست نیست')
  })
})
