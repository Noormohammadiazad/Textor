// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { emptyHealth, type RelayEntry, type RelayHealth } from '@/core/models/types'
import type { RelayStatus } from '@/core/transport/relayPool'
import { RelayPool } from '@/core/transport/relayPool'
import type { ScoutHost } from '@/core/transport/relayScout'
import type * as Store from '@/app/store'
import { FakeSocketNetwork } from './fakeWebSocket'
import { makeVault, type TestVault } from './helpers'

/**
 * The relay settings (ADR-067): where each relay stands and what it measures,
 * what a repair did, and finding relays by testing them from this device.
 */

const harness = vi.hoisted(() => ({
  repo: null as unknown,
  messenger: null as unknown,
}))

vi.mock('@/app/store', async (importOriginal) => {
  const actual = await importOriginal<typeof Store>()
  return { ...actual, getRepo: () => harness.repo, getMessenger: () => harness.messenger }
})

const { useApp } = await import('@/app/store')
const { RelaySettings } = await import('@/ui/screens/RelaySettings')
const { I18nContext, LOCALE_DIRECTION, translate } = await import('@/i18n')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entry = (url: string, patch: Partial<RelayEntry> = {}): RelayEntry => ({
  id: url,
  url,
  read: true,
  write: true,
  enabled: true,
  discovered: false,
  health: emptyHealth(),
  ...patch,
})

const status = (url: string, active: boolean, health: Partial<RelayHealth> = {}): RelayStatus => ({
  url,
  state: active ? 'online' : 'idle',
  active,
  health: { ...emptyHealth(), connectOk: 1, publishOk: 5, ...health },
})

let root: Root
let host: HTMLElement
let vault: TestVault
let network: FakeSocketNetwork
let pool: RelayPool
let refreshRelays: ReturnType<typeof vi.fn>
let saveSettings: ReturnType<typeof vi.fn>

const text = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  )
const click = async (node: Element | undefined | null) => {
  expect(node).toBeTruthy()
  await act(async () => (node as HTMLElement).click())
}
const settle = async (ms = 50) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const locale = useApp.getState().settings.locale
  const value = {
    locale,
    dir: LOCALE_DIRECTION[locale],
    t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
      translate(locale, key, values),
  }
  await act(async () =>
    root.render(createElement(I18nContext.Provider, { value }, createElement(RelaySettings))),
  )
  await settle()
}

beforeEach(async () => {
  vault = await makeVault('relay-settings')
  network = new FakeSocketNetwork()
  pool = new RelayPool({ socket: { createSocket: network.factory, random: () => 0, isOffline: () => false } })
  const scoutHost: ScoutHost = { repo: vault.repo, pool, apply: async () => undefined }
  harness.repo = vault.repo
  harness.messenger = { scoutHost }
  refreshRelays = vi.fn(async () => undefined)
  saveSettings = vi.fn(async () => undefined)
  useApp.setState({
    settings: { ...useApp.getState().settings, locale: 'en', autoRelays: true },
    relayEntries: [],
    relayStatuses: [],
    refreshRelays,
    saveSettings,
    toast: vi.fn(),
  } as never)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  pool.destroy()
  await vault.destroy()
})

describe('where each relay stands', () => {
  it('says which are in use, standing by, down, refusing the inbox, unreliable or off, and what each measured', async () => {
    useApp.setState({
      relayEntries: [
        entry('wss://active.example'),
        entry('wss://spare.example'),
        entry('wss://down.example'),
        entry('wss://auth.example'),
        entry('wss://lossy.example'),
        entry('wss://off.example', { enabled: false }),
      ],
      relayStatuses: [
        status('wss://active.example', true, {
          connectMs: 640,
          eoseMs: 210,
          latencyMs: 300,
          publishFail: 1,
          drops: 3,
        }),
        status('wss://spare.example', false),
        status('wss://down.example', false, { connectStreak: 3, lastError: 'connection failed' }),
        status('wss://auth.example', false, {
          readFail: 1,
          readFailAt: 1,
          lastError: 'auth-required: sign in',
        }),
        status('wss://lossy.example', true, { publishOk: 1, publishFail: 9 }),
      ],
    } as never)
    await render()

    const rows = [...document.body.querySelectorAll('.card-section > div')].map(
      (row) => row.textContent ?? '',
    )
    // In order of what matters: what carries the mail first, what is off last.
    expect(rows.map((row) => row.match(/^[a-z.]+/)?.[0])).toEqual([
      'active.example',
      'lossy.example',
      'spare.example',
      'down.example',
      'auth.example',
      'off.example',
    ])
    expect(rows[0]).toContain('In use')
    expect(rows[0]).toContain('Connects in 640 ms')
    expect(rows[0]).toContain('Inbox in 210 ms')
    expect(rows[0]).toContain('Accepts in 300 ms')
    expect(rows[0]).toContain('5 delivered / 1 failed')
    expect(rows[0]).toContain('Dropped 3×')
    expect(rows[1]).toContain('Unreliable')
    expect(rows[2]).toContain('Standing by')
    expect(rows[3]).toContain('Not answering')
    expect(rows[3]).toContain('Textor tries it again now and then')
    expect(rows[3]).toContain('connection failed')
    expect(rows[4]).toContain('Refuses your inbox')
    expect(rows[4]).toContain('requires sign-in to read your inbox')
    expect(rows[5]).toContain('Turned off')
    expect(text()).toContain('Textor keeps 2 of your 5 relays connected')
  })

  it('warns when nothing can send, and says nothing of standbys when every relay is in use', async () => {
    useApp.setState({ relayEntries: [entry('wss://a.example', { write: false })] } as never)
    await render()
    expect(text()).toContain('You have no active relays')
    expect(text()).not.toContain('Textor keeps')
  })

  it('turns a relay back on, and remembers one removed so nothing adds it back', async () => {
    await vault.repo.upsertRelay('wss://off.example', { enabled: false })
    await vault.repo.upsertRelay('wss://gone.example', {})
    useApp.setState({
      relayEntries: [entry('wss://off.example', { enabled: false }), entry('wss://gone.example')],
    } as never)
    await render()

    await click(button('Turn on'))
    expect((await vault.repo.listRelays()).find((relay) => relay.url === 'wss://off.example')?.enabled).toBe(
      true,
    )

    const remove = [...document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove relay"]')]
    // Sorted by standing: the one standing by first, the one turned off last.
    await click(remove[0])
    await settle()
    expect((await vault.repo.listRelays()).map((relay) => relay.url)).toEqual(['wss://off.example'])
    expect(await vault.repo.getState('relay-declined')).toEqual(['wss://gone.example'])
    expect(refreshRelays).toHaveBeenCalledTimes(2)
  })

  it('changes read and write, and adds a relay by address once', async () => {
    await vault.repo.upsertRelay('wss://a.example', {})
    useApp.setState({ relayEntries: [entry('wss://a.example')] } as never)
    await render()
    const [read, write] = [
      ...document.body.querySelectorAll<HTMLInputElement>('.card-section input[type=checkbox]'),
    ]
    await act(async () => read!.click())
    await settle()
    await act(async () => write!.click())
    await settle()
    expect((await vault.repo.listRelays())[0]).toMatchObject({ read: false, write: false })

    const input = document.body.querySelector<HTMLInputElement>('input.input')!
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type('http://nope.example')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(text()).toContain('That is not a valid relay address')
    await type('a.example')
    await click(document.body.querySelector('.card .btn-primary'))
    expect(text()).toContain('That relay is already in your list')
    await type('new.example')
    await click(document.body.querySelector('.card .btn-primary'))
    await settle()
    expect((await vault.repo.listRelays()).map((relay) => relay.url)).toContain('wss://new.example')
  })

  it('restores the defaults, and switches automatic replacement', async () => {
    await render()
    await click(button('Restore default relays'))
    await settle()
    expect((await vault.repo.listRelays()).length).toBe(6)
    const auto = [...document.body.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((input) =>
      input.closest('label')?.textContent?.includes('Replace relays that stop working'),
    )
    await act(async () => auto!.click())
    expect(saveSettings).toHaveBeenCalledWith({ autoRelays: false })
  })
})

describe('what a repair did', () => {
  it('says which relays were turned off and what took their place, until dismissed', async () => {
    await vault.repo.putState('relay-repairs', [
      { at: 2, off: ['wss://relay.0xchat.com'], added: ['wss://nos.lol'] },
      { at: 1, off: ['wss://relay.damus.io'], added: [] },
    ])
    await render()
    expect(text()).toContain('Turned off relay.0xchat.com, which stopped working.')
    expect(text()).toContain('Added nos.lol in its place')
    expect(text()).toContain('Turned off relay.damus.io')
    await click(button('Dismiss'))
    await settle()
    expect(text()).not.toContain('Turned off')
    expect(await vault.repo.getState('relay-repairs')).toEqual([])
  })
})

describe('finding relays', () => {
  it('tests candidates from this device, best first, and adds one with what was measured', async () => {
    const contact = 'c'.repeat(64)
    await vault.repo.upsertContact(contact, { accepted: true, relays: ['wss://friend.example'] })
    network.relay('wss://friend.example', { connectDelayMs: 5 })
    await render()

    await click(button('Test relays'))
    await settle(300)
    const results = text()
    expect(results).toContain('friend.example')
    expect(results).toContain('Your contacts read here: 1')
    // Textor's own, not reachable here, fail and say why.
    expect(results).toContain('Known to Textor')
    expect(results).toContain('Did not pass: connection failed')
    expect(results).toContain('Connects in')

    await click(button('Add'))
    await settle()
    const added = (await vault.repo.listRelays()).find((relay) => relay.url === 'wss://friend.example')
    expect(added).toMatchObject({ read: true, write: true, enabled: true })
    expect(added?.health.connectOk).toBe(1)
    expect(refreshRelays).toHaveBeenCalled()
  })

  it('asks public monitors only when told to, and says when nothing is left to test', async () => {
    for (const url of (await import('@/core/transport/defaultRelays')).DEFAULT_DM_RELAYS) {
      await vault.repo.upsertRelay(url, {})
    }
    for (const url of (await import('@/core/transport/relayScout')).CATALOG)
      await vault.repo.upsertRelay(url, {})
    await render()
    const monitors = [...document.body.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(
      (input) => input.closest('label')?.textContent?.includes('Also ask public relay monitors'),
    )
    await act(async () => monitors!.click())
    await click(button('Test relays'))
    await settle(100)
    expect(text()).toContain('There are no relays left to test.')
  })

  it('does nothing without a running engine', async () => {
    harness.messenger = null
    await render()
    await click(button('Test relays'))
    expect(text()).not.toContain('Testing')
  })
})

describe('in Persian', () => {
  it('speaks Persian, numbers and all', async () => {
    useApp.setState({
      settings: { ...useApp.getState().settings, locale: 'fa' },
      relayEntries: [entry('wss://active.example')],
      relayStatuses: [status('wss://active.example', true, { connectMs: 640 })],
    } as never)
    await render()
    expect(text()).toContain('در حال استفاده')
    expect(text()).toContain('اتصال در 640 میلی‌ثانیه')
    expect(text()).toContain('یافتن رله')
  })
})

describe('the monitors line', () => {
  it('is shown beside its switch', async () => {
    await render()
    expect(text()).toContain('Monitors publish reports on relays (NIP-66).')
    expect(network.sockets).toHaveLength(0)
  })
})
