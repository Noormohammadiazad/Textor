// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { ContactsList } from '@/ui/screens/Contacts'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import type { Contact } from '@/core/models/types'

/**
 * Who the Contacts screen names (ADR-078): someone asking to talk is not a contact
 * until accepted, which is also how someone removed stays out of it after a
 * restore, should they have written within the last month.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const contact = (name: string, over: Partial<Contact>): [string, Contact] => {
  const pubkey = name.repeat(64).slice(0, 64)
  return [
    pubkey,
    {
      id: pubkey,
      pubkey,
      npub: `npub1${pubkey}`,
      name,
      relays: [],
      verification: 'unverified',
      source: 'manual',
      accepted: true,
      addedAt: 1,
      lastSeenAt: 1,
      blocked: false,
      ...over,
    },
  ]
}

async function show(entries: [string, Contact][]): Promise<string> {
  useApp.setState({ contacts: new Map(entries) })
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root = createRoot(host)
  const i18n = {
    locale: 'en',
    dir: LOCALE_DIRECTION.en,
    t: (key: never, values?: never) => translate('en', key, values),
  }
  await act(async () => {
    root!.render(createElement(I18nContext.Provider, { value: i18n as never }, createElement(ContactsList)))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return document.body.textContent ?? ''
}

describe('the contacts screen', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('names contacts, and those blocked so they can be unblocked, but not those asking to talk', async () => {
    const text = await show([
      contact('a', { name: 'Accepted one' }),
      contact('b', { name: 'Blocked stranger', accepted: false, blocked: true, source: 'incoming' }),
      contact('c', { name: 'Only asking', accepted: false, source: 'incoming' }),
    ])
    expect(text).toContain('Accepted one')
    expect(text).toContain('Blocked stranger')
    expect(text).not.toContain('Only asking')
  })

  it('says there are none when all there is are people asking to talk', async () => {
    const text = await show([contact('c', { name: 'Only asking', accepted: false, source: 'incoming' })])
    expect(text).not.toContain('Only asking')
    expect(text).toContain(translate('en', 'contacts.empty'))
  })
})
