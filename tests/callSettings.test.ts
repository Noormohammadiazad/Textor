// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AppSettings, LocaleCode } from '@/core/models/types'
import { serverKey, TURN_HEALTH, type TurnHealth, type TurnHealthMap } from '@/core/calls/turn'
import type * as Store from '@/app/store'
import { FakeIceNetwork, FakePeerConnection, type NetworkProfile } from './fakeRtc'
import { makeVault, type TestVault } from './helpers'

/**
 * The Calls settings (ADR-068): saying that Textor ships no TURN server and
 * why, adding one by password or shared secret, showing how each is doing,
 * and testing them from this device.
 */

const harness = vi.hoisted(() => ({ repo: null as unknown }))

vi.mock('@/app/store', async (importOriginal) => {
  const actual = await importOriginal<typeof Store>()
  return { ...actual, getRepo: () => harness.repo }
})

const { useApp } = await import('@/app/store')
const { CallSettings } = await import('@/ui/screens/CallSettings')
const { I18nContext, LOCALE_DIRECTION, translate } = await import('@/i18n')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TURN = { urls: 'turn:turn.example.org:3478', username: 'alice', credential: 'pw' }
const TLS = { urls: 'turns:turn.example.org:443?transport=tcp', username: 'alice', credential: 'pw' }

const health = (patch: Partial<TurnHealth>): TurnHealth => ({
  ok: 0,
  fail: 0,
  streak: 0,
  allocMs: 0,
  rttMs: 0,
  kbps: 0,
  error: 0,
  lastOkAt: 0,
  lastFailAt: 0,
  ...patch,
})

let root: Root
let host: HTMLElement
let vault: TestVault
let saveSettings: ReturnType<typeof vi.fn>

const text = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
const settle = async (ms = 50) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
const inputs = () => [...document.body.querySelectorAll<HTMLInputElement>('form input.input')]
const type = async (input: HTMLInputElement | undefined, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () => document.body.querySelector('form')!.requestSubmit())
  await settle()
}
const secretToggle = () =>
  [...document.body.querySelectorAll<HTMLInputElement>('form input[type=checkbox]')][0] as HTMLInputElement

async function render(settings: Partial<AppSettings> = {}, locale: LocaleCode = 'en') {
  useApp.setState({ settings: { ...useApp.getState().settings, locale, ...settings } } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const value = {
    locale,
    dir: LOCALE_DIRECTION[locale],
    t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
      translate(locale, key, values),
  }
  await act(async () =>
    root.render(createElement(I18nContext.Provider, { value }, createElement(CallSettings))),
  )
  await settle()
}

beforeEach(async () => {
  vault = await makeVault('call-settings')
  harness.repo = vault.repo
  saveSettings = vi.fn(async (patch: Partial<AppSettings>) => {
    useApp.setState({ settings: { ...useApp.getState().settings, ...patch } } as never)
  })
  useApp.setState({
    settings: { ...useApp.getState().settings, iceServers: [], callRelayOnly: false },
    saveSettings,
  } as never)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  await vault.destroy()
})

describe('what the page says', () => {
  it('says calls need nothing set up, and that a TURN server is optional and personal', async () => {
    await render()
    expect(text()).toContain('Calls need no setup and no account')
    expect(text()).toContain('the walkie-talkie in a conversation’s header still works over relays')
    expect(text()).toContain('A TURN server is optional: add one here only if you already run your own')
    expect(text()).toContain('bring it in only when that fails')
    expect(text()).toContain('never what is said')
    expect(text()).not.toContain('Every TURN address here uses UDP')
  })

  it('never tells anyone to go and get an account', async () => {
    for (const locale of ['en', 'fa'] as const) {
      await render({}, locale)
      expect(text()).not.toMatch(/free account|TURN provider|metered|expressturn/i)
      expect(text()).not.toContain('حساب رایگان')
      act(() => root.unmount())
      host.remove()
    }
    await render()
  })

  it('warns when every TURN address is UDP, which a network blocking UDP blocks too', async () => {
    await render({ iceServers: [TURN] })
    expect(text()).toContain('Every TURN address here uses UDP')
    act(() => root.unmount())
    await render({ iceServers: [TURN, TLS] })
    expect(text()).not.toContain('Every TURN address here uses UDP')
  })

  it('shows how each TURN server has been doing', async () => {
    const SLOW = { urls: 'turn:slow.example.org', username: 'alice', credential: 'pw' }
    const DOWN = { urls: 'turn:down.example.org', username: 'alice', credential: 'pw' }
    const ODD = { urls: 'turn:odd.example.org', username: 'alice', credential: 'pw' }
    const MID = { urls: 'turn:mid-call.example.org', username: 'alice', credential: 'pw' }
    const map: TurnHealthMap = {
      // Measured ten seconds into a call, before the call ended and judged it.
      [serverKey(MID)]: health({ rttMs: 90 }),
      [serverKey(TURN)]: health({ ok: 3, allocMs: 120, rttMs: 80, lastOkAt: 2 }),
      [serverKey(SLOW)]: health({ ok: 1, allocMs: 300, kbps: 150, lastOkAt: 2 }),
      [serverKey(DOWN)]: health({ fail: 3, streak: 3, error: 401, lastFailAt: 2 }),
      [serverKey(ODD)]: health({ fail: 1, streak: 1, error: 403, lastFailAt: 2 }),
    }
    await vault.repo.putState(TURN_HEALTH, map)
    await render({ iceServers: [TURN, SLOW, DOWN, ODD, MID, TLS] })
    expect(text()).toContain('Relay in 120 ms · 80 ms round trip on calls')
    expect(text()).toContain('Relay in 300 ms · too slow for video')
    expect(text()).toContain('Wrong username or password · set aside after 3 failed tries')
    expect(text()).toContain('Refused the request (error 403)')
    expect(text()).not.toContain('Relay in 0 ms')
    expect(text().match(/Relay in/g)).toHaveLength(2)
  })

  it('reads nothing about TURN while there is no TURN server', async () => {
    const getState = vi.spyOn(vault.repo, 'getState')
    await render({ iceServers: [{ urls: 'stun:stun.example.org' }] })
    expect(getState).not.toHaveBeenCalled()
  })

  it('says it all in Persian too', async () => {
    await render({ iceServers: [TURN] }, 'fa')
    expect(text()).toContain('تماس‌ها به هیچ راه‌اندازی و حسابی نیاز ندارند')
    expect(text()).toContain('نشانی turns: روی درگاه 443')
  })
})

describe('adding a server', () => {
  it('adds one with a shared secret, whose username is optional, and says what the secret is for', async () => {
    await render()
    await act(async () => secretToggle().click())
    expect(text()).toContain('the secret itself never leaves this device')
    expect(text()).toContain('Name (optional)')
    expect(text()).toContain('Shared secret')
    const [url, , secret] = inputs()
    await type(url, 'turns:turn.example.org:443?transport=tcp')
    await submit()
    expect(text()).toContain('Enter the server’s shared secret.')
    expect(saveSettings).not.toHaveBeenCalled()
    await type(secret, 'k3y')
    await submit()
    expect(saveSettings).toHaveBeenCalledWith({
      iceServers: [{ urls: 'turns:turn.example.org:443?transport=tcp', credential: 'k3y', secret: true }],
    })
    // Listed as a shared secret, the secret itself shown nowhere.
    expect(text()).toContain('shared secret')
    expect(text()).not.toContain('k3y')
    // The form is reset for the next one.
    expect(secretToggle().checked).toBe(false)
  })

  it('still asks a password server for both, and refuses what is not a server', async () => {
    await render()
    const [url] = inputs()
    await type(url, 'turn:turn.example.org')
    await submit()
    expect(text()).toContain('A TURN server needs a username and a password.')
    await type(url, 'https://turn.example.org')
    await submit()
    expect(text()).toContain('Use a stun:, turn: or turns: address.')
  })

  it('names a secret server by the label it was given', async () => {
    await render({
      iceServers: [{ urls: 'turn:turn.example.org', username: 'office', credential: 'k', secret: true }],
    })
    expect(text()).toContain('shared secret · office')
  })
})

describe('testing the servers', () => {
  const stubPeerConnection = (profile: NetworkProfile) => {
    const ice = new FakeIceNetwork()
    vi.stubGlobal(
      'RTCPeerConnection',
      class extends FakePeerConnection {
        constructor(config: RTCConfiguration) {
          super(config, ice, profile)
        }
      },
    )
  }

  it('tests each TURN server, keeps what it found, and shows it beside each', async () => {
    const WRONG = { urls: 'turn:wrong.example.org', username: 'alice', credential: 'nope' }
    const SECRET = { urls: 'turns:secret.example.org', credential: 'k', secret: true as const }
    stubPeerConnection({
      stun: true,
      symmetric: false,
      turn: true,
      turnErrors: { [WRONG.urls]: 401 },
    })
    await render({ iceServers: [TURN, WRONG, SECRET] })
    await act(async () => button('Test connection')!.click())
    await settle(200)
    expect(text()).toContain('Calls should connect on almost any network.')
    const kept = await vault.repo.getState<TurnHealthMap>(TURN_HEALTH)
    expect(kept?.[serverKey(TURN)]).toMatchObject({ ok: 1 })
    expect(kept?.[serverKey(SECRET)]).toMatchObject({ ok: 1 })
    expect(kept?.[serverKey(WRONG)]).toMatchObject({ fail: 1, error: 401 })
    expect(text()).toContain('Wrong username or password')
    expect(text()).toMatch(/Relay in \d+ ms/)
  })

  it('reports nothing reachable when the test itself cannot run', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          throw new Error('no WebRTC here')
        }
      },
    )
    await render({ iceServers: [TURN] })
    await act(async () => button('Test connection')!.click())
    await settle()
    expect(text()).toContain('Your network blocks STUN')
    expect(text()).toContain('Not reachable')
  })
})
