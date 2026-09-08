// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { ChatList } from '@/ui/screens/ChatList'
import { ChatView } from '@/ui/screens/ChatView'
import { ForwardSheet } from '@/ui/conversation/ForwardSheet'
import { AttachButton } from '@/ui/components/Composer'
import { Avatar, GroupAvatar, SavedAvatar } from '@/ui/components/primitives'
import { immersive, RouteView } from '@/app/App'
import { DialogHost } from '@/ui/components/dialog'
import { MAX_DIRECT_BYTES, MAX_RELAY_BYTES } from '@/core/models/attachment'
import type { Contact, Conversation, LocaleCode, Message } from '@/core/models/types'

/**
 * Saved Messages on screen (ADR-082): its own row and avatar in the list, one
 * tap from the list's header, first among where to forward, and a conversation
 * with nobody else in it — no calls, reactions or polls, and a delete that
 * asks nothing but whether.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)
const peer = 'b'.repeat(64)

const contact: Contact = {
  id: 'c',
  pubkey: peer,
  npub: 'npub1peer',
  name: 'Bob',
  relays: [],
  verification: 'unverified',
  source: 'manual',
  accepted: true,
  addedAt: 0,
  lastSeenAt: 0,
  blocked: false,
}

const saved: Conversation = {
  id: 'saved',
  kind: 'self',
  peerPubkey: me,
  members: [me],
  accepted: true,
  lastActivity: Date.now(),
  unread: 0,
  pinned: false,
}

const withBob: Conversation = {
  id: 'bob',
  kind: 'direct',
  peerPubkey: peer,
  members: [peer],
  accepted: true,
  lastActivity: Date.now() - 1000,
  unread: 0,
  pinned: false,
}

const note = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  convoId: 'saved',
  direction: 'out',
  status: 'sent',
  ts: Date.now(),
  tsCoarse: 0,
  body: `note ${id}`,
  authorPubkey: me,
  ...extra,
})

let root: Root
let host: HTMLElement

async function render(element: ReactElement, locale: LocaleCode = 'en') {
  const value = {
    locale,
    dir: LOCALE_DIRECTION[locale],
    t: (key: never, values?: never) => translate(locale, key, values),
  }
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
const text = () => document.body.textContent ?? ''

beforeEach(() => {
  location.hash = '#/'
  useApp.setState({
    identity: { pubkey: me } as never,
    contacts: new Map([[peer, contact]]),
    conversations: [saved, withBob],
    conversationsLoaded: true,
    previews: new Map([
      ['saved', note('p1', { body: 'milk, eggs' })],
      ['bob', note('p2', { convoId: 'bob', body: 'see you' })],
    ]),
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('in the list', () => {
  const rowOf = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.convo-row')].find(
      (row) => row.querySelector('.convo-name')?.textContent === name,
    )

  it('has a row of its own, with a bookmark for a face, and every note is yours', async () => {
    await render(createElement(ChatList))
    const row = rowOf('Saved Messages')!
    expect(row.querySelector('.avatar-saved svg')).not.toBeNull()
    expect(row.querySelector('.convo-preview-text')?.textContent).toBe('milk, eggs')
    // Anyone else's says whose it was.
    expect(rowOf('Bob')!.querySelector('.convo-preview-text')?.textContent).toBe('You: see you')

    await click(row)
    expect(location.hash).toBe('#/saved')
  })

  it('marks it open beside the list', async () => {
    location.hash = '#/saved'
    await render(createElement(ChatList))
    expect(rowOf('Saved Messages')!.getAttribute('aria-current')).toBe('true')
    expect(rowOf('Bob')!.getAttribute('aria-current')).toBeNull()
  })

  it('is one tap from the header, before anything is saved', async () => {
    useApp.setState({ conversations: [withBob] })
    await render(createElement(ChatList))
    expect(rowOf('Saved Messages')).toBeUndefined()
    await click(host.querySelector('header button[aria-label="Saved Messages"]')!)
    expect(location.hash).toBe('#/saved')
  })

  it('is called what Persian calls it, and found by that name', async () => {
    useApp.setState({
      conversations: [
        saved,
        withBob,
        { ...withBob, id: 'x1' },
        { ...withBob, id: 'x2' },
        { ...withBob, id: 'x3' },
      ],
    })
    await render(createElement(ChatList), 'fa')
    const title = translate('fa', 'saved.title')
    expect(title).toBe('پیام‌های ذخیره‌شده')
    expect(rowOf(title)).toBeDefined()
    const search = host.querySelector<HTMLInputElement>('input[type=search]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'ذخیره')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...host.querySelectorAll('.convo-row')]).toHaveLength(1)
  })
})

describe('the conversation', () => {
  let deleteMessages: ReturnType<typeof vi.fn>
  let forwardMessages: ReturnType<typeof vi.fn>
  let toast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    deleteMessages = vi.fn(async () => undefined)
    forwardMessages = vi.fn(async () => undefined)
    toast = vi.fn()
    useApp.setState({ deleteMessages, forwardMessages, toast } as never)
  })

  async function open(messages: Message[]) {
    await render(
      createElement(Fragment, null, createElement(ChatView, { address: me }), createElement(DialogHost)),
    )
    await act(async () => useApp.setState({ messages }))
  }
  const bubble = (id: string) => host.querySelector<HTMLElement>(`#msg-${id} .bubble`)!
  const menu = () => document.querySelector('.popover')
  const dialog = () => document.querySelector<HTMLElement>('[role=dialog]')
  const labels = (scope: Element | null) =>
    [...(scope?.querySelectorAll(':scope > button') ?? [])].map((b) => b.textContent?.trim())
  const openMenu = (id: string) =>
    act(async () => void bubble(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))

  it('says what it is, to whom, and offers nobody to call or open', async () => {
    await open([])
    const header = host.querySelector('.chat-header')!
    expect(header.querySelector('.avatar-saved')).not.toBeNull()
    expect(header.querySelector('.chat-header-name')?.textContent).toBe('Saved Messages')
    expect(header.querySelector('.chat-header-status')?.textContent).toBe('Only you')
    expect(header.querySelector<HTMLButtonElement>('.chat-header-info')!.disabled).toBe(true)
    expect(header.querySelector('[aria-label="Voice call"]')).toBeNull()
    expect(host.querySelector('.empty h3')?.textContent).toBe('Saved Messages')
    expect(host.querySelector('.empty p')?.textContent).toBe(translate('en', 'saved.body'))
  })

  it('has no reactions on a note', async () => {
    await open([note('n1')])
    expect(host.querySelector('#msg-n1 [aria-label="React"]')).toBeNull()
    await openMenu('n1')
    expect(menu()?.querySelector('.quick-reactions')).toBeNull()
    expect(labels(menu())).not.toContain('More…')
    expect(labels(menu())).toContain('Forward')
  })

  it('shows a reaction another client put there, which cannot be changed from here', async () => {
    useApp.setState({
      reactions: new Map([
        ['n1', [{ id: 'r', messageId: 'n1', convoId: 'saved', authorPubkey: me, emoji: '👍', ts: 0 }]],
      ]),
    } as never)
    await open([note('n1')])
    expect(host.querySelector<HTMLButtonElement>('.reaction')!.disabled).toBe(true)
  })

  it('deletes everywhere, asking only whether', async () => {
    await open([note('n1')])
    await openMenu('n1')
    await click([...menu()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!)
    expect(labels(dialog()?.querySelector('.dialog-actions') ?? null)).toEqual(['Delete', 'Cancel'])
    expect(dialog()?.textContent).not.toContain(translate('en', 'chat.deleteBody'))
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!)
    expect(deleteMessages).toHaveBeenCalledWith(['n1'], 'everyone')
  })

  it('keeps what is forwarded to it without leaving where it came from', async () => {
    await open([note('n1')])
    await openMenu('n1')
    await click([...menu()!.querySelectorAll('button')].find((b) => b.textContent === 'Forward')!)
    await vi.waitFor(() => expect(document.querySelector('.forward-list')).not.toBeNull())
    await click(document.querySelector('.forward-list .list-row')!)
    expect(forwardMessages).toHaveBeenCalledWith(['n1'], me)
    expect(toast).toHaveBeenCalledWith('Saved')
    expect(location.hash).toBe('#/')
  })

  it('goes to whoever else it is forwarded to', async () => {
    await open([note('n1')])
    await openMenu('n1')
    await click([...menu()!.querySelectorAll('button')].find((b) => b.textContent === 'Forward')!)
    await vi.waitFor(() => expect(document.querySelector('.forward-list')).not.toBeNull())
    await click(document.querySelectorAll('.forward-list .list-row')[1]!)
    expect(forwardMessages).toHaveBeenCalledWith(['n1'], peer)
    expect(location.hash).toBe(`#/c/${peer}`)
  })

  it('offers no poll to attach', async () => {
    await open([])
    await click(host.querySelector('.composer [aria-label="Attach"]')!)
    expect(labels(menu())).toEqual(['Photo or Video', 'File', 'Checklist', 'Location'])
    // Each with its icon, Poll's included where it is offered.
    expect(menu()!.querySelectorAll('[role=menuitem] > svg')).toHaveLength(4)
  })
})

describe('where to forward', () => {
  it('lists Saved Messages first, once, and by its name', async () => {
    const onPick = vi.fn()
    await render(createElement(ForwardSheet, { onPick, onClose: () => undefined }))
    const rows = () => [...document.querySelectorAll('.forward-list .list-row')]
    const names = () => rows().map((row) => row.querySelector('.grow')?.textContent)
    expect(names()).toEqual(['Saved Messages', 'Bob'])
    expect(rows()[0]!.querySelector('.avatar-saved')).not.toBeNull()

    const search = document.querySelector<HTMLInputElement>('input[type=search]')!
    const type = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await type('bob')
    expect(names()).toEqual(['Bob'])
    await type('saved')
    expect(names()).toEqual(['Saved Messages'])
    await click(rows()[0]!)
    expect(onPick).toHaveBeenCalledWith(me)
  })

  it('offers it before anything has been saved', async () => {
    useApp.setState({ conversations: [withBob] })
    await render(createElement(ForwardSheet, { onPick: () => undefined, onClose: () => undefined }))
    expect(text()).toContain('Saved Messages')
  })
})

describe('attaching to a note', () => {
  it('refuses a file larger than the relays carry, there being no direct channel', async () => {
    const toast = vi.fn()
    const sendAttachment = vi.fn(async () => undefined)
    useApp.setState({ toast, sendAttachment } as never)
    await render(createElement(AttachButton, { own: true }))
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    const pick = (size: number) =>
      act(async () => {
        const file = new File([new Uint8Array(size)], 'big.bin', { type: 'application/octet-stream' })
        Object.defineProperty(input, 'files', { value: [file], configurable: true })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    await pick(MAX_RELAY_BYTES + 1)
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('That file is too large to send', 'danger'))
    expect(sendAttachment).not.toHaveBeenCalled()
    await pick(1000)
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledTimes(1))
  })
})

describe('as a route', () => {
  it('opens at this identity’s own key, full screen on a phone', async () => {
    await render(createElement(RouteView, { route: { name: 'saved' } }))
    expect(host.querySelector('.chat-header-name')?.textContent).toBe('Saved Messages')
    expect(immersive({ name: 'saved' })).toBe(true)
    expect(immersive({ name: 'chats' })).toBe(false)
  })

  it('waits for an identity to have one', async () => {
    useApp.setState({ identity: null } as never)
    await render(createElement(RouteView, { route: { name: 'saved' } }))
    expect(host.innerHTML).toBe('')
  })
})

/** What the same screens do everywhere else, where Saved Messages changed a line. */
describe('everywhere else', () => {
  const groupId = 'e'.repeat(32)
  const group: Conversation = {
    id: groupId,
    kind: 'group',
    peerPubkey: '',
    members: [peer, 'c'.repeat(64)],
    subject: 'Hikers',
    accepted: true,
    lastActivity: Date.now(),
    unread: 0,
    pinned: false,
  }
  let react: ReturnType<typeof vi.fn>
  let deleteMessages: ReturnType<typeof vi.fn>
  let forwardMessages: ReturnType<typeof vi.fn>

  beforeEach(() => {
    react = vi.fn(async () => undefined)
    deleteMessages = vi.fn(async () => undefined)
    forwardMessages = vi.fn(async () => undefined)
    useApp.setState({ conversations: [group, withBob], react, deleteMessages, forwardMessages } as never)
  })

  const said = (id: string, by: string, convoId: string): Message =>
    note(id, { convoId, authorPubkey: by, direction: by === me ? 'out' : 'in', status: 'delivered' })
  async function open(address: string, messages: Message[]) {
    await render(
      createElement(Fragment, null, createElement(ChatView, { address }), createElement(DialogHost)),
    )
    await act(async () => useApp.setState({ messages }))
  }
  const openMenu = (id: string) =>
    act(async () => {
      host
        .querySelector(`#msg-${id} .bubble`)!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
  const menuButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.popover button')].find((b) => b.textContent === label)!
  const choices = () =>
    [...document.querySelectorAll('[role=dialog] .dialog-actions > button')].map((b) => b.textContent)

  it('lists a group with its own avatar, and opens it by its id', async () => {
    await render(createElement(ChatList))
    const row = [...host.querySelectorAll<HTMLButtonElement>('.convo-row')].find((r) =>
      r.textContent?.includes('Hikers'),
    )!
    expect(row.querySelector('.avatar-group')).not.toBeNull()
    expect(row.querySelector('.avatar-saved')).toBeNull()
    await click(row)
    expect(location.hash).toBe(`#/g/${groupId}`)
  })

  it('heads a group with its name, its people, and a way to its details', async () => {
    await open(groupId, [said('m1', me, groupId), said('m2', peer, groupId)])
    const header = host.querySelector('.chat-header')!
    expect(header.querySelector('.avatar-group')).not.toBeNull()
    expect(header.querySelector('.chat-header-name')?.textContent).toBe('Hikers')
    expect(header.querySelector('.chat-header-status')?.textContent).toBe('3 people')
    const info = header.querySelector<HTMLButtonElement>('.chat-header-info')!
    expect(info.getAttribute('aria-label')).toBe('Group info')
    await click(info)
    expect(location.hash).toBe(`#/g/${groupId}/info`)
  })

  it('names nothing yet for a group still loading', async () => {
    useApp.setState({ conversations: [], conversationsLoaded: false })
    await open(groupId, [])
    expect(host.querySelector('.chat-header-name')?.textContent).toBe('')
  })

  it('deletes in a group for everyone only what is ours', async () => {
    await open(groupId, [said('m1', me, groupId), said('m2', peer, groupId)])
    await openMenu('m1')
    await click(menuButton('Delete'))
    expect(choices()).toEqual(['Delete for everyone', 'Delete for me', 'Cancel'])
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(translate('en', 'chat.deleteBody'))
    await click(
      [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Cancel')!,
    )
    await openMenu('m2')
    await click(menuButton('Delete'))
    expect(choices()).toEqual(['Delete for me', 'Cancel'])
  })

  it('goes to the group something is forwarded to', async () => {
    await open(peer, [said('m1', peer, 'bob')])
    await openMenu('m1')
    await click(menuButton('Forward'))
    await vi.waitFor(() => expect(document.querySelector('.forward-list')).not.toBeNull())
    const target = [...document.querySelectorAll('.forward-list .list-row')].find((r) =>
      r.textContent?.includes('Hikers'),
    )!
    await click(target)
    expect(forwardMessages).toHaveBeenCalledWith(['m1'], groupId)
    expect(location.hash).toBe(`#/g/${groupId}`)
  })

  it('reacts from the menu, the button beside a message, and a reaction already there', async () => {
    useApp.setState({
      reactions: new Map([
        ['m1', [{ id: 'r', messageId: 'm1', convoId: 'bob', authorPubkey: peer, emoji: '🎉', ts: 0 }]],
      ]),
    } as never)
    await open(peer, [said('m1', peer, 'bob')])
    await openMenu('m1')
    await click(document.querySelector('.popover .quick-reactions button')!)
    expect(react).toHaveBeenLastCalledWith('m1', '👍')

    await openMenu('m1')
    await click(menuButton('More…'))
    const reactButton = host.querySelector('#msg-m1 [aria-label="React"]')!
    await click(reactButton)
    expect(reactButton.getAttribute('aria-expanded')).toBe('true')
    // Pressed again, it closes what it opened.
    await click(reactButton)
    expect(reactButton.getAttribute('aria-expanded')).toBe('false')

    const chip = host.querySelector<HTMLButtonElement>('#msg-m1 .reaction')!
    expect(chip.disabled).toBe(false)
    await click(chip)
    expect(react).toHaveBeenLastCalledWith('m1', '🎉')
  })

  it('offers everything to attach, and opens each form', async () => {
    await open(peer, [])
    const attach = host.querySelector('.composer [aria-label="Attach"]')!
    const pick = async (label: string) => {
      await click(attach)
      await click(menuButton(label))
    }
    await click(attach)
    expect([...document.querySelectorAll('.popover [role=menuitem]')].map((b) => b.textContent)).toEqual([
      'Photo or Video',
      'File',
      'Poll',
      'Checklist',
      'Location',
    ])
    await click(attach)
    await pick('Poll')
    await vi.waitFor(() => expect(document.body.textContent).toContain('New poll'))
    await click(document.querySelector('.modal [aria-label="Close"]')!)
    await pick('Checklist')
    await vi.waitFor(() => expect(document.body.textContent).toContain('New checklist'))
    await click(document.querySelector('.modal [aria-label="Close"]')!)
    await pick('Location')
    await vi.waitFor(() => expect(document.querySelector('.location-live-choices')).not.toBeNull())
    expect(document.querySelector<HTMLFieldSetElement>('.location-live-choices')!.hidden).toBe(false)
    await click(document.querySelector('.modal [aria-label="Close"]')!)
    expect(document.querySelector('.location-live-choices')).toBeNull()
  })

  it('attaches nothing in a forward-secret group, which carries text only', async () => {
    const secure: Conversation = {
      ...group,
      mls: { group: 'a'.repeat(64), admins: [me], epoch: 1, code: '0000', refreshedAt: 0 },
    }
    useApp.setState({ conversations: [secure] })
    await open(groupId, [])
    expect(host.querySelector('.composer textarea')).not.toBeNull()
    expect(host.querySelector('.composer [aria-label="Attach"]')).toBeNull()
  })

  it('sends a file past what the relays carry where a direct channel can take it', async () => {
    const toast = vi.fn()
    const sendAttachment = vi.fn(async () => undefined)
    useApp.setState({ toast, sendAttachment } as never)
    await render(createElement(AttachButton, {}))
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    await act(async () => {
      const file = new File([new Uint8Array(MAX_RELAY_BYTES + 1)], 'big.bin', {
        type: 'application/octet-stream',
      })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledTimes(1))
    expect(toast).not.toHaveBeenCalled()
    expect(MAX_DIRECT_BYTES).toBeGreaterThan(MAX_RELAY_BYTES + 1)
  })

  it('draws each avatar at each size', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(GroupAvatar, { seed: 'g', size: 'lg' }),
        createElement(GroupAvatar, { seed: 'g', size: 'sm' }),
        createElement(GroupAvatar, { seed: 'g' }),
        createElement(SavedAvatar, { size: 'lg' }),
        createElement(Avatar, { name: 'Bob', seed: peer, size: 'lg' }),
      ),
    )
    const classes = [...host.querySelectorAll('.avatar')].map((a) => a.className)
    expect(classes).toEqual([
      'avatar avatar-group avatar-lg',
      'avatar avatar-group avatar-sm',
      'avatar avatar-group',
      'avatar avatar-group avatar-saved avatar-lg',
      'avatar avatar-lg',
    ])
    expect([...host.querySelectorAll('svg')].map((svg) => svg.getAttribute('width'))).toEqual([
      '30',
      '15',
      '19',
      '30',
    ])
  })

  it('offers Saved Messages to forward to even before an identity has loaded', async () => {
    useApp.setState({ identity: null } as never)
    const onPick = vi.fn()
    await render(createElement(ForwardSheet, { onPick, onClose: () => undefined }))
    await click(document.querySelector('.forward-list .list-row')!)
    expect(onPick).toHaveBeenCalledWith('')
  })
})
