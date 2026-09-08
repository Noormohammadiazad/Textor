// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { ChatView } from '@/ui/screens/ChatView'
import { HOLD_MS, ownEvent } from '@/ui/components/hold'
import { DialogHost } from '@/ui/components/dialog'
import { levelOf, sectionOf } from '@/app/layout'
import { parseHash } from '@/app/router'
import type { Contact, Conversation, Message } from '@/core/models/types'

/**
 * A conversation is one column (ADR-060): every date, message and call is a
 * child of the same stream, in the order it happened, with its side carried by
 * the row — never two lists, one per person, and never a status beside a
 * bubble as a column of its own. A message answers a finger and a mouse as
 * Telegram's do (ADR-061): held, it is selected; tapped, its menu opens; and
 * deleting asks in the app's own dialog.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)
const peer = 'b'.repeat(64)
const HOUR = 3_600_000
const start = new Date(2026, 8, 20, 9).getTime()

const contact: Contact = {
  id: 'c',
  pubkey: peer,
  npub: 'npub1peer',
  name: 'Alex',
  relays: [],
  verification: 'verified',
  source: 'manual',
  accepted: true,
  addedAt: 0,
  lastSeenAt: 0,
  blocked: false,
}

const conversation: Conversation = {
  id: 'convo',
  kind: 'direct',
  peerPubkey: peer,
  members: [peer],
  accepted: true,
  lastActivity: start,
  unread: 0,
  pinned: false,
}

function message(id: string, direction: 'in' | 'out', at: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    convoId: 'convo',
    direction,
    status: direction === 'out' ? 'read' : 'delivered',
    ts: at,
    tsCoarse: at,
    body: `message ${id}`,
    authorPubkey: direction === 'out' ? me : peer,
    ...extra,
  }
}

// Across two days, both sides, a call between them and a message that failed.
const history: Message[] = [
  message('m1', 'in', start),
  message('m2', 'out', start + 60_000),
  message('m3', 'in', start + 120_000),
  message('m4', 'out', start + HOUR, {
    body: '',
    call: { media: 'audio', outcome: 'completed', durationMs: 5000 },
  }),
  message('m5', 'in', start + 24 * HOUR),
  message('m6', 'out', start + 25 * HOUR, { status: 'failed' }),
]

let root: Root
let host: HTMLElement

async function renderChat(messages: Message[]) {
  useApp.setState({
    identity: { pubkey: me } as never,
    contacts: new Map([[peer, contact]]),
    conversations: [conversation],
    conversationsLoaded: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(Fragment, null, createElement(ChatView, { address: peer }), createElement(DialogHost)),
    ),
  )
  // Mounting opens the conversation, which starts from an empty page; the
  // history is what a load would put there.
  await act(async () => useApp.setState({ messages }))
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('the conversation column', () => {
  beforeEach(() => renderChat(history))

  it('is one stream holding every entry, in the order it happened', () => {
    const lists = host.querySelectorAll('.message-list')
    expect(lists).toHaveLength(1)
    const streams = lists[0]!.querySelectorAll('.message-stream')
    expect(streams).toHaveLength(1)
    const stream = streams[0]!
    expect(lists[0]!.children).toHaveLength(1)

    // Every row in the conversation is a child of that one stream.
    const rows = [...host.querySelectorAll('.bubble-row')]
    expect(rows).toHaveLength(history.length)
    for (const row of rows) expect(row.parentElement).toBe(stream)

    const entries = [...stream.children].filter((child) => !child.matches('.faint, .btn'))
    const read = entries.map((entry) =>
      entry.classList.contains('day-separator')
        ? 'day'
        : `${entry.id.replace('msg-', '')}:${entry.classList.contains('out') ? 'out' : 'in'}`,
    )
    expect(read).toEqual(['day', 'm1:in', 'm2:out', 'm3:in', 'm4:out', 'day', 'm5:in', 'm6:out'])
  })

  it('says a message failed under its bubble, inside its row', () => {
    const row = host.querySelector('#msg-m6')!
    expect([...row.children].map((child) => child.className)).toEqual(['bubble', 'bubble-failed'])
  })

  it('keeps the side on the row, not on a column per person', () => {
    const stream = host.querySelector('.message-stream')!
    const sides = [...stream.querySelectorAll(':scope > .bubble-row')].map((row) =>
      row.classList.contains('out') ? 'out' : 'in',
    )
    expect(sides).toEqual(['in', 'out', 'in', 'out', 'in', 'out'])
    expect(host.querySelector('.message-stream .message-stream')).toBeNull()
  })
})

describe('touching, holding and selecting, as Telegram does', () => {
  // Bob's two messages around one of ours, then a read one of ours.
  const exchange = [
    message('m1', 'in', start),
    message('m2', 'out', start + 60_000, { status: 'delivered' }),
    message('m3', 'in', start + 120_000),
    message('m4', 'out', start + 180_000, { status: 'read' }),
  ]
  let deleteMessages: ReturnType<typeof vi.fn>
  let confirmSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    deleteMessages = vi.fn(async () => undefined)
    useApp.setState({ deleteMessages } as never)
    // The browser's own dialog must never be asked.
    confirmSpy = vi.fn(() => true)
    Object.defineProperty(window, 'confirm', { value: confirmSpy, configurable: true })
    await renderChat(exchange)
  })

  const bubble = (id: string) => host.querySelector<HTMLElement>(`#msg-${id} .bubble`)!
  const row = (id: string) => host.querySelector<HTMLElement>(`#msg-${id}`)!
  const menu = () => document.querySelector('.popover')
  const dialog = () => document.querySelector<HTMLElement>('[role=dialog]')
  const press = (target: HTMLElement, type: string, init: PointerEventInit = {}) =>
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', ...init }))
    })
  const click = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  const labels = (scope: Element | null) =>
    [...(scope?.querySelectorAll(':scope > button') ?? [])].map((b) => b.textContent?.trim())

  it('selects what a finger holds, and turns the header into the selection’s bar', async () => {
    vi.useFakeTimers()
    await press(bubble('m1'), 'pointerdown', { clientX: 10, clientY: 10 })
    await act(() => vi.advanceTimersByTime(HOLD_MS - 50))
    expect(host.querySelector('.selection-bar')).toBeNull()
    await act(() => vi.advanceTimersByTime(50))

    expect(host.querySelector('.selection-count')?.textContent).toBe('1 selected')
    expect(row('m1').classList.contains('selected')).toBe(true)
    expect(host.querySelector('.selection-bar [aria-label="Forward"]')).not.toBeNull()
    expect(host.querySelector('.selection-bar [aria-label="Delete"]')).not.toBeNull()

    // The click the lifted finger produces does not also unpick it.
    await press(bubble('m1'), 'pointerup')
    await click(bubble('m1'))
    expect(row('m1').classList.contains('selected')).toBe(true)

    // A tap anywhere on another row picks it; on a picked one, unpicks it.
    await click(row('m3'))
    expect(host.querySelector('.selection-count')?.textContent).toBe('2 selected')
    await click(row('m1'))
    await click(row('m3'))
    expect(host.querySelector('.selection-bar')).toBeNull()
  })

  it('opens the menu on a tap, reactions first and delete last', async () => {
    await press(bubble('m2'), 'pointerdown', { clientX: 10, clientY: 10 })
    await press(bubble('m2'), 'pointerup')
    await click(bubble('m2'))
    expect(menu()?.querySelectorAll('.quick-emoji').length).toBeGreaterThan(0)
    expect(labels(menu())).toEqual(['More…', 'Reply', 'Copy text', 'Forward', 'Select', 'Details', 'Delete'])
  })

  it('leaves a held mouse button alone, and opens the menu on the right one — not over a link', async () => {
    vi.useFakeTimers()
    await press(bubble('m1'), 'pointerdown', { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTime(HOLD_MS * 2))
    expect(host.querySelector('.selection-bar')).toBeNull()
    vi.useRealTimers()

    const right = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => void bubble('m3').dispatchEvent(right))
    expect(right.defaultPrevented).toBe(true)
    expect(labels(menu())).toContain('Select')

    const link = document.createElement('a')
    link.href = 'https://example.com'
    bubble('m1').append(link)
    const onLink = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => void link.dispatchEvent(onLink))
    expect(onLink.defaultPrevented).toBe(false)
  })

  it('lets a finger that moves scroll instead', async () => {
    vi.useFakeTimers()
    await press(bubble('m2'), 'pointerdown', { clientX: 10, clientY: 10 })
    await press(bubble('m2'), 'pointermove', { clientX: 10, clientY: 40 })
    await act(() => vi.advanceTimersByTime(HOLD_MS * 2))
    expect(host.querySelector('.selection-bar')).toBeNull()
  })

  it('asks, in its own dialog, whether to delete for both or for me alone', async () => {
    await act(async () => void bubble('m3').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    await click([...menu()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!)

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete this message?')
    expect(labels(dialog()?.querySelector('.dialog-actions') ?? null)).toEqual([
      'Delete for me and Alex',
      'Delete for me',
      'Cancel',
    ])
    // It opens on the way out, not on either delete.
    expect(document.activeElement?.textContent).toBe('Cancel')

    await click(
      [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete for me and Alex')!,
    )
    expect(deleteMessages).toHaveBeenCalledWith(['m3'], 'everyone')
    expect(dialog()).toBeNull()
  })

  it('draws one tick until it is read, and two only then', () => {
    const tick = (id: string) => row(id).querySelector('.tick')
    expect(tick('m2')?.getAttribute('aria-label')).toBe('Delivered')
    expect(tick('m2')?.querySelectorAll('path')).toHaveLength(1)
    expect(tick('m4')?.getAttribute('aria-label')).toBe('Read')
    expect(tick('m4')?.querySelectorAll('path').length).toBeGreaterThan(1)
  })

  it('gives the last bubble of each run its tail', () => {
    const ends = ['m1', 'm2', 'm3', 'm4'].filter((id) => row(id).classList.contains('group-end'))
    expect(ends).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
})

describe('a conversation whose clocks disagree (ADR-063)', () => {
  it('shows each time as its author gave it, and never announces a day going backwards', async () => {
    // Bob's clock is an hour behind, and his answer crosses midnight on it:
    // it sorts after Alice's question but shows the day before.
    const midnight = new Date(2026, 8, 21).getTime()
    await renderChat([
      message('q', 'out', midnight + 20 * 60_000, { order: midnight + 20 * 60_000 }),
      message('a', 'in', midnight - 35 * 60_000, { order: midnight + 20 * 60_000 + 1 }),
      message('b', 'out', midnight + 30 * 60_000, { order: midnight + 30 * 60_000 }),
    ])
    const stream = host.querySelector('.message-stream')!
    const read = [...stream.children]
      .filter((entry) => !entry.matches('.faint, .btn'))
      .map((entry) => (entry.classList.contains('day-separator') ? 'day' : entry.id.replace('msg-', '')))
    expect(read).toEqual(['day', 'q', 'a', 'b'])
    expect(host.querySelector('#msg-a time')?.getAttribute('datetime')).toBe(
      new Date(midnight - 35 * 60_000).toISOString(),
    )
  })
})

describe('what counts as pressing a message', () => {
  it('is what began inside it — not in a menu portalled out of it, nor its lightbox', () => {
    const bubble = document.createElement('div')
    const text = document.createElement('span')
    const lightbox = document.createElement('div')
    lightbox.setAttribute('role', 'dialog')
    const picture = document.createElement('img')
    lightbox.append(picture)
    bubble.append(text, lightbox)
    const portalled = document.createElement('button')

    expect(ownEvent({ target: text, currentTarget: bubble })).toBe(true)
    expect(ownEvent({ target: portalled, currentTarget: bubble })).toBe(false)
    expect(ownEvent({ target: picture, currentTarget: bubble })).toBe(false)
  })
})

describe('the panes of a wide window', () => {
  it('puts every route beside the list it belongs to, at its depth', () => {
    const cases: [string, ReturnType<typeof sectionOf>, number][] = [
      ['#/', 'chats', 0],
      [`#/c/${peer}`, 'chats', 1],
      ['#/g/' + '0'.repeat(32), 'chats', 1],
      ['#/g/' + '0'.repeat(32) + '/info', 'chats', 2],
      ['#/new-group', 'chats', 2],
      ['#/contacts', 'contacts', 0],
      [`#/p/${peer}`, 'contacts', 1],
      ['#/settings', 'settings', 0],
      ['#/settings/security', 'settings', 1],
      ['#/about', 'settings', 1],
      // Reached from more than one list: beside whichever it was opened from.
      ['#/add', null, 2],
      [`#/verify/${peer}`, null, 2],
      ['#/i/payload', null, 2],
    ]
    for (const [hash, section, level] of cases) {
      const route = parseHash(hash)
      expect([hash, sectionOf(route), levelOf(route)]).toEqual([hash, section, level])
    }
  })
})
