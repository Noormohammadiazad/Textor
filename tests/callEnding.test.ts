// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { CallOverlay } from '@/ui/calls/CallOverlay'
import type { CallControl, CallEnd, CallView } from '@/core/calls/callManager'
import type { LocaleCode } from '@/core/models/types'

/**
 * How a call ends on screen (ADR-071, ADR-072). Calls need nothing set up, so a
 * failure never sends anyone off to get a server; and the walkie-talkie is
 * separate, so a failure says it is there and starts nothing.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const peer = 'b'.repeat(64)
const summary = { host: true, srflx: true, relay: false }
const diagnosis = (kind: NonNullable<CallEnd['diagnosis']>['kind']): CallEnd => ({
  kind: 'failed',
  diagnosis: {
    kind,
    local: { ...summary, symmetric: true, ipv6: false },
    remote: { ...summary, ipv6: false },
  },
})

const call = (patch: Partial<CallView>): CallView =>
  ({
    peer,
    media: 'audio',
    direction: 'out',
    phase: 'ended',
    id: 'x',
    startedAt: 0,
    connectedAt: null,
    endedAt: 0,
    reached: true,
    notReached: false,
    ended: null,
    outcome: 'failed',
    path: null,
    relaying: false,
    voice: null,
    notice: null,
    local: { muted: false, camera: false, screen: false, stream: null, facing: 'user' },
    remote: { stream: null, audio: true, video: false, muted: false, screen: false },
    canFlip: false,
    canShare: false,
    ...patch,
  }) as CallView

let root: Root
let host: HTMLElement
let control: ReturnType<typeof vi.fn<(action: CallControl) => void>>

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent?.trim())

async function render(view: CallView, locale: LocaleCode = 'en') {
  useApp.setState({ call: view, contacts: new Map(), callControl: control } as never)
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
    root.render(createElement(I18nContext.Provider, { value }, createElement(CallOverlay))),
  )
}

beforeEach(() => {
  control = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useApp.setState({ call: null } as never)
})

describe('a call that could not connect', () => {
  for (const kind of ['symmetric-nat', 'blocked', 'peer-blocked', 'unknown'] as const) {
    it(`says why (${kind}), points to the walkie-talkie, and asks for nothing to be set up`, async () => {
      await render(call({ ended: diagnosis(kind) }))
      expect(text()).toContain('Could not connect the call')
      expect(text()).toContain('Textor has no server to relay calls through')
      expect(text()).toContain('You can still talk with the walkie-talkie in the conversation’s header.')
      expect(text()).not.toMatch(/set up|TURN/i)
      // Saying so is all it does: there is nothing to press, and nothing has started.
      expect(buttons()).toEqual(['Close'])
      expect(host.querySelector('.call-voice')).toBeNull()
      expect(host.querySelector('.call-voice-talk')).toBeNull()
    })
  }

  it('says the same in Persian', async () => {
    await render(call({ ended: diagnosis('symmetric-nat') }), 'fa')
    expect(text()).toContain('تکستور سروری برای رله کردن تماس ندارد')
    expect(text()).toContain('بی‌سیم در سربرگ گفت‌وگو')
    expect(host.querySelector('.call-voice')).toBeNull()
  })

  it('closes when asked, and does nothing else', async () => {
    await render(call({ ended: diagnosis('symmetric-nat') }))
    await act(async () => host.querySelector<HTMLButtonElement>('.call-ending-close')!.click())
    expect(control.mock.calls).toEqual([[{ type: 'dismiss' }]])
  })

  it('stays out of a video call the same way', async () => {
    await render(call({ media: 'video', ended: diagnosis('unknown') }))
    expect(buttons()).toEqual(['Close'])
  })
})

describe('someone’s own TURN server', () => {
  it('says so when it did not respond, and goes to check it', async () => {
    await render(call({ ended: diagnosis('turn-failed') }))
    expect(text()).toContain('Your TURN server did not respond.')
    expect(buttons()).toEqual(['Check TURN settings', 'Close'])
    await act(async () => host.querySelector<HTMLButtonElement>('.btn-primary')!.click())
    expect(control.mock.calls).toEqual([[{ type: 'dismiss' }]])
  })

  it('goes to check it when "always relay" has nothing to relay through', async () => {
    await render(call({ ended: { kind: 'relay-needs-turn' } }))
    expect(text()).toContain('“Always relay calls” is on')
    expect(buttons()).toEqual(['Check TURN settings', 'Close'])
  })
})

describe('other endings', () => {
  it('leaves a lost call as an ordinary ending, with nothing to press', async () => {
    await render(call({ ended: { kind: 'lost' }, connectedAt: 1 }))
    expect(text()).toContain('Connection lost')
    expect(host.querySelector('.call-ending')).toBeNull()
    expect(host.querySelector('.call-voice')).toBeNull()
  })
})

describe('the walkie-talkie’s own screen', () => {
  const voice = {
    state: 'live',
    peerHere: true,
    peerTalking: false,
    talking: false,
    heard: null,
    throttled: false,
    relays: 3,
  } as const

  it('holds to talk, and hangs up', async () => {
    await render(call({ media: 'radio', phase: 'connected', connectedAt: 1, ended: null, voice }))
    expect(text()).toContain('Hold to talk')
    expect(text()).toContain('Through 3 relays')
    await act(async () => host.querySelector<HTMLButtonElement>('.call-voice .btn-danger')!.click())
    expect(control.mock.calls).toEqual([[{ type: 'hangup' }]])
  })

  it('says when every relay has refused, and hangs up', async () => {
    await render(
      call({
        media: 'radio',
        phase: 'connected',
        connectedAt: 1,
        ended: null,
        voice: { ...voice, state: 'refused' },
      }),
    )
    expect(text()).toContain('refused the voice stream')
    expect(host.querySelector('.call-voice-talk')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.call-voice .btn-danger')!.click())
    expect(control.mock.calls).toEqual([[{ type: 'hangup' }]])
  })
})
