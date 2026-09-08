// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { createInvite } from '@/core/identity/invite'
import { toNpub } from '@/core/identity/keys'
import type { Contact, IdentityRecord, LocaleCode } from '@/core/models/types'
import type * as TextorIdModule from '@/core/identity/textorId'
import type * as Store from '@/app/store'
import { bytesToHex } from '@/core/util/bytes'

/**
 * The ID on the screens (ADR-079): it comes first, it is what a tap copies, and a raw
 * key is there only for whoever goes looking. The sums are in `textorId.test.ts`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  messenger: null as unknown,
  lookup: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/app/store', async (original) => ({
  ...(await original<typeof Store>()),
  getMessenger: () => state.messenger,
}))

vi.mock('@/core/identity/textorId', async (original) => ({
  ...(await original<typeof TextorIdModule>()),
  lookUpTextorId: state.lookup,
}))

vi.mock('@/ui/components/dialog', () => ({ confirmDanger: state.confirm }))

const { useApp } = await import('@/app/store')
const { TextorIdScreen } = await import('@/ui/screens/TextorIdScreen')
const { AddContact } = await import('@/ui/screens/AddContact')
const { ContactDetail } = await import('@/ui/screens/ContactDetail')
const { InviteScreen } = await import('@/ui/screens/InviteScreen')
const { SettingsHome } = await import('@/ui/screens/Settings')
const { TEXTOR_ID_TEXT } = await import('@/ui/screens/textorIdText')
const { PEOPLE_TEXT } = await import('@/ui/screens/peopleText')
const { PRIVACY_TEXT } = await import('@/ui/screens/privacyText')

let root: Root | null = null
const secretKey = generateSecretKey()
const pubkey = getPublicKey(secretKey)
const text = TEXTOR_ID_TEXT.en
const people = PEOPLE_TEXT.en
const ID = '7X9K2M4QHD'
const SHOWN = '7X9K2-M4QHD'
const writeText = vi.fn(async () => undefined)

const identity = (over: Partial<IdentityRecord> = {}): IdentityRecord => ({
  pubkey,
  npub: toNpub(pubkey),
  secretKeyHex: bytesToHex(secretKey),
  name: 'me',
  about: '',
  createdAt: 1,
  mnemonicBackedUp: true,
  ...over,
})

async function show(element: ReactElement, locale: LocaleCode = 'en'): Promise<void> {
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root = createRoot(host)
  const i18n = {
    locale,
    dir: LOCALE_DIRECTION[locale],
    t: (key: never, values?: never) => translate(locale, key, values),
  }
  await act(async () => {
    root!.render(createElement(I18nContext.Provider, { value: i18n as never }, element))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

const body = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === label) as HTMLButtonElement
const press = async (label: string) => {
  await act(async () => {
    button(label).click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}
/** The key is in the page, as a closed `details` holds it, but nobody sees it unless they open it. */
const keyIsHidden = (npub: string) => {
  const box = document.querySelector('details') as HTMLDetailsElement
  expect(box.open).toBe(false)
  expect(box.querySelector('summary')?.textContent).toBe(translate('en', 'contacts.showKey'))
  expect(box.textContent).toContain(npub)
  const outside = [...document.body.querySelectorAll('*')].filter(
    (node) => !node.closest('details') && node.childElementCount === 0,
  )
  expect(outside.map((node) => node.textContent).join(' ')).not.toContain(npub)
}

beforeEach(() => {
  state.messenger = null
  state.lookup.mockReset()
  state.confirm.mockReset()
  writeText.mockClear()
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  location.hash = ''
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe('your own ID', () => {
  const open = async (over: Partial<IdentityRecord> = {}, locale: LocaleCode = 'en') => {
    useApp.setState({ identity: identity(over) } as never)
    await show(createElement(SettingsHome), locale)
  }

  it('is in the profile card, and one tap copies it', async () => {
    await open({ textorId: ID })
    await press(SHOWN)
    expect(writeText).toHaveBeenCalledWith(SHOWN)
  })

  it('keeps the key out of the way, and says what having an ID means', async () => {
    await open({ textorId: ID })
    keyIsHidden(toNpub(pubkey))
    expect(body()).toContain(PRIVACY_TEXT.en.idBody)
  })

  it('has no screen of its own to go to', async () => {
    await open({ textorId: ID })
    expect(body()).not.toContain('Textor ID')
    expect(body()).not.toContain('Your ID')
  })

  it('shows nothing in its place until it is worked out', async () => {
    await open()
    expect(button(SHOWN)).toBeUndefined()
    expect(document.querySelector('details')).not.toBeNull()
  })

  it('reads in Persian', async () => {
    await open({ textorId: ID }, 'fa')
    expect(body()).toContain(PRIVACY_TEXT.fa.idBody)
    expect(body()).not.toContain(PRIVACY_TEXT.en.idBody)
    expect(button(SHOWN)).toBeTruthy()
  })
})

describe("a contact's page", () => {
  const peer = getPublicKey(generateSecretKey())
  const updateContact = vi.fn(async () => undefined)
  const removeContact = vi.fn(async () => undefined)
  const setPinned = vi.fn()
  const contact = (over: Partial<Contact> = {}): Contact =>
    ({
      id: peer,
      pubkey: peer,
      npub: toNpub(peer),
      name: 'Sara',
      relays: [],
      verification: 'unverified',
      source: 'manual',
      accepted: true,
      addedAt: 1,
      lastSeenAt: 1,
      blocked: false,
      ...over,
    }) as Contact
  const open = async (over: Partial<Contact> | null = {}, pinned = false) => {
    useApp.setState({
      contacts: new Map(over ? [[peer, contact(over)]] : []),
      conversations: pinned ? [{ peerPubkey: peer, pinned: true }] : [],
      updateContact,
      removeContact,
      setPinned,
    } as never)
    await show(createElement(ContactDetail, { peer }))
  }
  const editField = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  beforeEach(() => {
    updateContact.mockClear()
    removeContact.mockClear()
    setPinned.mockClear()
  })

  it('leads with their ID, and one tap copies it', async () => {
    await open({ textorId: ID })
    await press(SHOWN)
    expect(writeText).toHaveBeenCalledWith(SHOWN)
    keyIsHidden(toNpub(peer))
  })

  it('still has the key, for someone who goes looking, and copies that when asked', async () => {
    await open({ textorId: ID })
    await press(translate('en', 'common.copy'))
    expect(writeText).toHaveBeenCalledWith(toNpub(peer))
  })

  it('says their ID is on its way, rather than show a key in its place', async () => {
    await open()
    expect(body()).toContain(people.noId)
    keyIsHidden(toNpub(peer))
  })

  it('goes by their ID where they have no name', async () => {
    await open({ name: '', textorId: ID })
    expect(document.querySelector('h1')?.textContent).toBe(SHOWN)
  })

  it('is still a page, for someone it does not know', async () => {
    await open(null)
    expect(body()).toContain(translate('en', 'common.unknown'))
    await act(async () => {
      ;(document.querySelector('.btn-back') as HTMLButtonElement).click()
    })
  })

  it('shows their relays, what they say of themselves, and that they are verified', async () => {
    await open({ relays: ['wss://a.example'], about: 'hello', verification: 'verified' })
    expect(body()).toContain('a.example')
    expect(body()).toContain('hello')
    expect(body()).toContain(translate('en', 'contacts.verified'))
    expect(body()).not.toContain(people.unverified)
  })

  it('goes to the conversation and to verifying', async () => {
    await open()
    await press(translate('en', 'nav.chats'))
    expect(location.hash).toBe(`#/c/${peer}`)
    await press(translate('en', 'contacts.verify'))
    expect(location.hash).toBe(`#/verify/${peer}`)
  })

  it('pins and unpins', async () => {
    await open()
    await press(people.pin)
    expect(setPinned).toHaveBeenCalledWith(peer, true)
    act(() => root?.unmount())
    await open({}, true)
    await press(people.unpin)
    expect(setPinned).toHaveBeenCalledWith(peer, false)
  })

  it('saves a name or note only if it changed', async () => {
    await open({ note: 'old' })
    const name = document.querySelector('input') as HTMLInputElement
    await editField(name, 'Sara')
    expect(updateContact).not.toHaveBeenCalled()
    await editField(name, 'Sarah')
    expect(updateContact).toHaveBeenCalledWith(peer, { name: 'Sarah' })
    updateContact.mockClear()
    const note = document.querySelector('textarea') as HTMLTextAreaElement
    await editField(note, 'old')
    expect(updateContact).not.toHaveBeenCalled()
    await editField(note, 'new')
    expect(updateContact).toHaveBeenCalledWith(peer, { note: 'new' })
  })

  it('treats no note as an empty one', async () => {
    await open()
    await editField(document.querySelector('textarea') as HTMLTextAreaElement, '')
    expect(updateContact).not.toHaveBeenCalled()
  })

  it('blocks only once confirmed', async () => {
    await open()
    state.confirm.mockResolvedValueOnce(false)
    await press(translate('en', 'chat.block'))
    expect(updateContact).not.toHaveBeenCalled()
    state.confirm.mockResolvedValueOnce(true)
    await press(translate('en', 'chat.block'))
    expect(updateContact).toHaveBeenCalledWith(peer, { blocked: true })
  })

  it('unblocks, and offers no way to write to someone blocked', async () => {
    await open({ blocked: true })
    expect(button(translate('en', 'nav.chats')).disabled).toBe(true)
    await press(translate('en', 'chat.unblock'))
    expect(updateContact).toHaveBeenCalledWith(peer, { blocked: false })
  })

  it('removes only once confirmed', async () => {
    await open()
    const remove = () =>
      act(async () => {
        ;(document.querySelector('.btn-danger') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    state.confirm.mockResolvedValueOnce(false)
    await remove()
    expect(removeContact).not.toHaveBeenCalled()
    state.confirm.mockResolvedValueOnce(true)
    await remove()
    expect(removeContact).toHaveBeenCalledWith(peer)
    expect(location.hash).toBe('#/contacts')
  })
})

describe('the page an invite opens', () => {
  const inviter = generateSecretKey()
  const inviterKey = getPublicKey(inviter)
  const addContact = vi.fn(async () => undefined)
  const toast = vi.fn()
  const open = async (payload: string, contacts: Contact[] = []) => {
    useApp.setState({
      identity: identity(),
      contacts: new Map(contacts.map((entry) => [entry.pubkey, entry])),
      addContact,
      toast,
    } as never)
    await show(createElement(InviteScreen, { payload }))
  }
  const invite = (name = 'Sara', relays: string[] = [], createdAt?: number) =>
    createInvite(inviter, { name, relays, ...(createdAt ? { createdAt } : {}) })

  beforeEach(() => {
    addContact.mockClear()
    toast.mockClear()
  })

  it('shows who it is from, with the key out of the way, and adds them', async () => {
    await open(invite('Sara', ['wss://a.example']))
    expect(body()).toContain('Sara')
    expect(body()).toContain('a.example')
    keyIsHidden(toNpub(inviterKey))
    await press(translate('en', 'contacts.add'))
    expect(addContact).toHaveBeenCalledWith({
      pubkey: inviterKey,
      name: 'Sara',
      relays: ['wss://a.example'],
      source: 'invite',
    })
    expect(toast).toHaveBeenCalled()
    expect(location.hash).toBe(`#/c/${inviterKey}`)
  })

  it('goes by a piece of the key for an invite with no name, having nothing else', async () => {
    await open(invite(''))
    expect(document.querySelector('h1')?.textContent).toMatch(/^npub1/)
  })

  it('says so for an invite that is not one, and goes nowhere', async () => {
    await open('nope')
    expect(body()).toContain(people.invalidInvite)
    await press(translate('en', 'common.close'))
    expect(location.hash).toBe('#/')
  })

  it('says so for an old invite', async () => {
    await open(invite('Sara', [], 1000))
    expect(body()).toContain(people.staleInvite)
  })

  it('goes straight to the conversation with someone already a contact', async () => {
    await open(invite(), [{ pubkey: inviterKey, accepted: true } as Contact])
    expect(body()).toContain(translate('en', 'contacts.alreadyAdded'))
    await press(translate('en', 'nav.chats'))
    expect(location.hash).toBe(`#/c/${inviterKey}`)
  })

  it('leaves at once on your own invite', async () => {
    await open(createInvite(secretKey, { name: 'me', relays: [] }))
    expect(location.hash).toBe('#/')
  })

  it('can be turned down', async () => {
    await open(invite())
    await press(translate('en', 'common.cancel'))
    expect(location.hash).toBe('#/')
    expect(addContact).not.toHaveBeenCalled()
  })

  it('says so and lets go of the button if adding fails', async () => {
    addContact.mockRejectedValueOnce(new Error('no'))
    await open(invite())
    await press(translate('en', 'contacts.add'))
    expect(toast).toHaveBeenCalledWith(translate('en', 'errors.generic'), 'danger')
    expect(button(translate('en', 'contacts.add')).disabled).toBe(false)
  })
})

describe('finding someone by an ID', () => {
  const owner = getPublicKey(generateSecretKey())
  const second = getPublicKey(generateSecretKey())
  const addContact = vi.fn(async () => undefined)
  const toast = vi.fn()
  const pool = {
    readRelays: ['wss://read.example'],
    writeRelays: ['wss://write.example'],
    query: vi.fn(async () => []),
  }

  const contact = (over: Partial<Contact>): Contact =>
    ({
      id: owner,
      pubkey: owner,
      npub: '',
      name: '',
      relays: [],
      verification: 'unverified',
      source: 'manual',
      accepted: true,
      addedAt: 1,
      lastSeenAt: 1,
      blocked: false,
      ...over,
    }) as Contact

  const open = async (id = ID, contacts: Contact[] = []) => {
    useApp.setState({
      identity: identity(),
      contacts: new Map(contacts.map((entry) => [entry.pubkey, entry])),
      addContact,
      toast,
    } as never)
    await show(createElement(TextorIdScreen, { id }))
  }

  beforeEach(() => {
    state.messenger = { pool }
    addContact.mockClear()
    toast.mockClear()
    pool.query.mockClear()
  })

  it('refuses what is not one, and goes nowhere', async () => {
    await open('nope')
    expect(body()).toContain(text.invalid)
    expect(body()).not.toContain('Textor')
    expect(state.lookup).not.toHaveBeenCalled()
    await press('Close')
    expect(location.hash).toBe('#/')
  })

  it('asks every relay in use and the defaults, by the ID in its one spelling', async () => {
    state.lookup.mockImplementation(async (_id, query) => {
      await query({ kinds: [30078] })
      return { owners: [], crowded: false }
    })
    await open('7x9k2-m4qhd')
    expect(state.lookup.mock.calls[0]?.[0]).toBe(ID)
    const [, relays, options] = pool.query.mock.calls[0] as unknown as [unknown, string[], object]
    expect(relays.slice(0, 2)).toEqual(['wss://read.example', 'wss://write.example'])
    expect(relays).toContain('wss://relay.primal.net')
    expect(options).toEqual({ graceMs: 3000, maxWait: 12_000 })
  })

  it('says who it is looking for while it looks', async () => {
    state.lookup.mockReturnValue(new Promise(() => undefined))
    await open()
    expect(body()).toContain(`Looking for ${SHOWN}`)
  })

  it('adds the key it found, keeps the ID it was found by, and says to verify', async () => {
    state.lookup.mockResolvedValue({
      owners: [{ pubkey: owner, relays: ['wss://theirs.example'] }],
      crowded: false,
    })
    await open()
    expect(body()).toContain(translate('en', 'chat.verifyPromptBody'))
    keyIsHidden(toNpub(owner))
    await press(translate('en', 'contacts.add'))
    expect(addContact).toHaveBeenCalledWith({
      pubkey: owner,
      relays: ['wss://theirs.example'],
      source: 'id',
      textorId: ID,
    })
    expect(toast).toHaveBeenCalled()
    expect(location.hash).toBe(`#/c/${owner}`)
  })

  it('says so and lets go of the button if adding fails', async () => {
    state.lookup.mockResolvedValue({ owners: [{ pubkey: owner, relays: [] }], crowded: false })
    addContact.mockRejectedValueOnce(new Error('no'))
    await open()
    await press(translate('en', 'contacts.add'))
    expect(toast).toHaveBeenCalledWith(translate('en', 'errors.generic'), 'danger')
    expect(button(translate('en', 'contacts.add')).disabled).toBe(false)
  })

  it('says nobody when nobody is found, and what might be wrong', async () => {
    state.lookup.mockResolvedValue({ owners: [], crowded: false })
    await open()
    expect(body()).toContain(text.nobody)
    expect(body()).not.toContain(translate('en', 'chat.verifyPromptBody'))
  })

  it('shows everyone an ID gives, with the keys open as they are what tells them apart', async () => {
    state.lookup.mockResolvedValue({
      owners: [
        { pubkey: owner, relays: [] },
        { pubkey: second, relays: [] },
      ],
      crowded: false,
    })
    await open()
    expect(body()).toContain(text.conflict.replace('{n}', '2'))
    expect([...document.querySelectorAll('.card')]).toHaveLength(2)
    expect([...document.querySelectorAll('details')].every((box) => box.open)).toBe(true)
    expect(addContact).not.toHaveBeenCalled()
  })

  it('says so when an ID is being flooded, rather than that nobody has it', async () => {
    state.lookup.mockResolvedValue({ owners: [], crowded: true })
    await open()
    expect(body()).toContain(text.crowded)
    expect(body()).not.toContain(text.nobody)
  })

  it('knows your own ID', async () => {
    state.lookup.mockResolvedValue({ owners: [{ pubkey, relays: [] }], crowded: false })
    await open()
    expect(body()).toContain(text.own)
    expect(button(translate('en', 'contacts.add'))).toBeUndefined()
  })

  it('goes to the conversation with someone already a contact', async () => {
    state.lookup.mockResolvedValue({ owners: [{ pubkey: owner, relays: [] }], crowded: false })
    await open(ID, [contact({})])
    expect(body()).toContain(translate('en', 'contacts.alreadyAdded'))
    await press(translate('en', 'nav.chats'))
    expect(location.hash).toBe(`#/c/${owner}`)
    expect(addContact).not.toHaveBeenCalled()
  })

  it('offers to add someone who only asked to talk', async () => {
    state.lookup.mockResolvedValue({ owners: [{ pubkey: owner, relays: [] }], crowded: false })
    await open(ID, [contact({ accepted: false })])
    expect(button(translate('en', 'contacts.add'))).toBeTruthy()
  })

  it('can try again if it could not look', async () => {
    state.lookup.mockRejectedValueOnce(new Error('offline'))
    await open()
    expect(body()).toContain(text.unreachable)
    state.lookup.mockResolvedValue({ owners: [], crowded: false })
    await press(text.retry)
    expect(body()).toContain(text.nobody)
  })

  it('does not say nobody has it when it was not able to ask', async () => {
    state.messenger = null
    await open()
    expect(body()).toContain(text.unreachable)
    expect(state.lookup).not.toHaveBeenCalled()
  })

  it('drops an answer that comes after leaving', async () => {
    let answer: (value: unknown) => void = () => undefined
    let fail: (reason: Error) => void = () => undefined
    state.lookup.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    await open()
    act(() => root?.unmount())
    root = null
    await act(async () => answer({ owners: [], crowded: false }))
    state.lookup.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    await open()
    act(() => root?.unmount())
    root = null
    await act(async () => fail(new Error('late')))
    expect(document.body.textContent).toBe('')
  })
})

describe('the add contact screen', () => {
  const addContact = vi.fn(async () => undefined)
  const open = async (over: Partial<IdentityRecord> = {}) => {
    useApp.setState({
      identity: identity(over),
      contacts: new Map(),
      addContact,
      toast: vi.fn(),
      inviteRelays: 'wss://a.example',
      fallbackInviteRelays: () => ['wss://a.example'],
    } as never)
    await show(createElement(AddContact))
  }
  const paste = async (value: string) => {
    const field = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      button(translate('en', 'common.add')).click()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
  }

  beforeEach(() => addContact.mockClear())

  it('shows your ID first, once there is one, and one tap copies it', async () => {
    await open()
    expect(body()).not.toContain(people.myId)
    act(() => root?.unmount())
    await open({ textorId: ID })
    expect(body()).toContain(people.myId)
    expect(body()).not.toContain('Textor ID')
    await press(SHOWN)
    expect(writeText).toHaveBeenCalledWith(SHOWN)
  })

  it('goes to look for an ID, without adding anyone yet', async () => {
    await open()
    await paste('7x9k2-m4qhd')
    expect(location.hash).toBe(`#/id/${ID}`)
    expect(addContact).not.toHaveBeenCalled()
  })

  it('still says so for anything that is not one', async () => {
    await open()
    await paste('neither')
    expect(body()).toContain(people.invalidInvite)
  })

  it('says so for an invite that will not read, and warns about an old one', async () => {
    const toast = vi.fn()
    await open()
    useApp.setState({ toast } as never)
    await paste('https://textor.ir/#/i/AAAA')
    expect(body()).toContain(people.invalidInvite)
    const friend = generateSecretKey()
    await paste(
      `https://textor.ir/#/i/${createInvite(friend, { name: 'Sara', relays: [], createdAt: 1000 })}`,
    )
    expect(toast).toHaveBeenCalledWith(people.staleInvite)
    expect(addContact).toHaveBeenCalledWith({
      pubkey: getPublicKey(friend),
      name: 'Sara',
      relays: [],
      source: 'invite',
    })
  })

  it('still takes an npub, and will not add you to yourself', async () => {
    await open()
    await paste(toNpub(pubkey))
    expect(body()).toContain(people.cannotAddSelf)
    expect(addContact).not.toHaveBeenCalled()
  })
})
