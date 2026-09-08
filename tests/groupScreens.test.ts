// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { NewGroup } from '@/ui/groups/NewGroup'
import { GroupInfo } from '@/ui/groups/GroupInfo'
import { DialogHost } from '@/ui/components/dialog'
import type { Contact, Conversation, LocaleCode } from '@/core/models/types'

/**
 * Starting a small group and looking at one. Their words travel in the groups
 * chunk rather than the dictionaries every start downloads (ADR-043), and say
 * the same in both languages as they did from there.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)
const key = (n: number) => n.toString(16).padStart(64, '0')

const person = (n: number, extra: Partial<Contact> = {}): Contact => ({
  id: `c${n}`,
  pubkey: key(n),
  npub: `npub${n}`,
  name: `Person ${n}`,
  relays: [],
  verification: 'unverified',
  source: 'manual',
  accepted: true,
  addedAt: 0,
  lastSeenAt: 0,
  blocked: false,
  ...extra,
})

let root: Root
let host: HTMLElement

async function render(element: ReactElement, locale: LocaleCode = 'en') {
  const value = { locale, dir: LOCALE_DIRECTION[locale], t: (k: never, v?: never) => translate(locale, k, v) }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(I18nContext.Provider, { value: value as never }, createElement(Fragment, null, element)),
    ),
  )
}

const click = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
const text = () => host.textContent ?? ''
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  location.hash = '#/new-group'
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('starting a small group', () => {
  let createGroup: ReturnType<typeof vi.fn>
  let createSecureGroup: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createGroup = vi.fn(async () => 'f'.repeat(32))
    createSecureGroup = vi.fn(() => new Promise(() => undefined))
    useApp.setState({
      contacts: new Map(Array.from({ length: 9 }, (_, i) => [key(i + 1), person(i + 1)])),
      createGroup,
      createSecureGroup,
      toast: vi.fn(),
    } as never)
  })

  const tick = (n: number) =>
    act(async () => {
      host.querySelector<HTMLInputElement>(`input[aria-label="Person ${n}"]`)!.click()
    })

  it('says how many it holds and why, and makes one of who is chosen', async () => {
    await render(createElement(NewGroup))
    expect(text()).toContain('Up to 8 people, including you')
    expect(text()).toContain('There is no server to send a group message for you')
    expect(host.querySelector('input[placeholder="Optional — members see it"]')).not.toBeNull()
    expect(text()).toContain('Group name')
    expect(text()).toContain('Choose people')
    expect(text()).toContain('Who is in a group cannot change.')
    expect(text()).toContain('0 of 7 chosen')
    expect(button('Create group')!.disabled).toBe(true)

    await tick(1)
    await tick(2)
    expect(text()).toContain('2 of 7 chosen')
    await click(button('Create group')!)
    expect(createGroup).toHaveBeenCalledWith([key(1), key(2)], '')
    expect(location.hash).toBe(`#/g/${'f'.repeat(32)}`)
  })

  it('says so once everyone it can hold is chosen', async () => {
    await render(createElement(NewGroup))
    for (let n = 1; n <= 7; n++) await tick(n)
    expect(text()).toContain('That is everyone a group can hold.')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Person 8"]')!.disabled).toBe(true)
  })

  it('says it is finding keys while a forward-secret group is made', async () => {
    await render(createElement(NewGroup))
    await click(button('Forward-secret')!)
    expect(text()).not.toContain('Who is in a group cannot change.')
    await tick(1)
    await click(button('Create group')!)
    expect(createSecureGroup).toHaveBeenCalled()
    expect(text()).toContain('Finding everyone’s keys…')
  })

  it('asks for contacts first, when there are not enough of them', async () => {
    useApp.setState({ contacts: new Map([[key(1), person(1)]]) })
    await render(createElement(NewGroup))
    expect(text()).toContain('You need at least two contacts to start a group.')
  })

  it('says it all in Persian', async () => {
    await render(createElement(NewGroup), 'fa')
    expect(text()).toContain('حداکثر 8 نفر، با خودتان')
    expect(text()).toContain('نام گروه')
    expect(text()).toContain('انتخاب افراد')
    expect(text()).toContain('0 از 7 انتخاب شده')
    expect(button('ساختن گروه')).toBeDefined()
  })
})

describe('a small group’s details', () => {
  const group: Conversation = {
    id: 'e'.repeat(32),
    kind: 'group',
    peerPubkey: '',
    members: [key(1), key(2), key(3)],
    subject: 'Hikers',
    accepted: true,
    lastActivity: 0,
    unread: 0,
    pinned: false,
  }
  let deleteConversation: ReturnType<typeof vi.fn>

  beforeEach(() => {
    deleteConversation = vi.fn(async () => undefined)
    useApp.setState({
      identity: { pubkey: me, name: 'Me' } as never,
      conversations: [group],
      conversationsLoaded: true,
      contacts: new Map([
        [key(1), person(1, { verification: 'verified' })],
        [key(2), person(2, { accepted: false })],
      ]),
      deleteConversation,
    } as never)
  })

  it('lists everyone, says who is not a contact, and that it cannot change', async () => {
    await render(createElement(GroupInfo, { id: group.id }))
    expect(host.querySelector('h2')?.textContent).toBe('Hikers')
    expect(text()).toContain('4 people')
    const rows = [...host.querySelectorAll('.card-section .list-row')]
    // By name, in the reader's language: a stranger's key sorts with the rest.
    expect(rows.map((row) => row.querySelector('bdi')?.textContent)).toEqual([
      'Me',
      expect.stringMatching(/^npub1/),
      'Person 1',
      'Person 2',
    ])
    // Not accepted, and not in the address book at all, alike.
    expect(rows.filter((row) => row.textContent?.includes('Not in your contacts'))).toHaveLength(2)
    expect(text()).toContain('Who is in a group cannot change.')

    // A stranger has no page to open; a contact does.
    expect(rows[1]!.tagName).toBe('DIV')
    await click(rows[2]!)
    expect(location.hash).toBe(`#/p/${key(1)}`)
  })

  it('is deleted only once that is confirmed', async () => {
    await render(
      createElement(Fragment, null, createElement(GroupInfo, { id: group.id }), createElement(DialogHost)),
    )
    await click(button('Delete group')!)
    await click(
      [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Delete group')!,
    )
    expect(deleteConversation).toHaveBeenCalledWith(group.id)
    expect(location.hash).toBe('#/')
  })

  it('says a member is not a contact in Persian', async () => {
    await render(createElement(GroupInfo, { id: group.id }), 'fa')
    expect(text()).toContain('در مخاطبان شما نیست')
    expect(text()).toContain('اعضای یک گروه تغییر نمی‌کنند.')
  })
})
