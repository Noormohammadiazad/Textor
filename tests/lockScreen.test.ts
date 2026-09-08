// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { LockScreen } from '@/ui/screens/LockScreen'
import { bytesToB64url, randomBytes } from '@/core/util/bytes'
import type { KeyslotSummary } from '@/core/vault/vault'

/**
 * The lock screen's one unprompted biometric request (ADR-054, ADR-059): made
 * on a cold start once the page is visible and has focus — Chrome refuses
 * WebAuthn to a page without it — at most once, never after the person has
 * chosen another way, and silent when the browser refuses it, since nobody
 * asked. A tap that is refused says so.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const credentialId = bytesToB64url(randomBytes(16))
const slots: KeyslotSummary[] = [
  { id: 'b', type: 'biometric', createdAt: 1, credentialId, authenticator: 'platform' },
  { id: 'p', type: 'pin', createdAt: 1, style: 'digits', failures: 0 },
  { id: 'r', type: 'recovery', createdAt: 1 },
]

let root: Root
let host: HTMLElement
let focused = false
const get = vi.fn(async () => {
  throw new DOMException('not focused, or no tap', 'NotAllowedError')
})

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
const alert = () => host.querySelector('[role=alert]')?.textContent ?? null
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)

describe('the lock screen’s unprompted request', () => {
  beforeEach(async () => {
    get.mockClear()
    focused = false
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true })
    useApp.setState({ keyslots: slots, autoPrompt: true, autoLocked: false, passkeyRetired: false })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(createElement(LockScreen)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it('waits for focus, asks once, and says nothing when the browser refuses it', async () => {
    expect(get).not.toHaveBeenCalled()
    focused = true
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await flush()
    expect(get).toHaveBeenCalledOnce()
    expect(useApp.getState().autoPrompt).toBe(false)
    expect(alert()).toBeNull()

    // Spent: focus again, and nothing more is asked.
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await flush()
    expect(get).toHaveBeenCalledOnce()
  })

  it('says a refused tap was refused', async () => {
    // The primary button: its label depends on the user agent.
    await act(async () => void host.querySelector<HTMLButtonElement>('.btn-primary')?.click())
    await flush()
    expect(get).toHaveBeenCalledOnce()
    expect(alert()).toBe('Unlocking was cancelled. Try again when you are ready.')
  })

  it('asks nothing once the person has chosen another way', async () => {
    await act(async () => void button('Use your PIN instead')?.click())
    focused = true
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await flush()
    expect(get).not.toHaveBeenCalled()
    expect(host.querySelector('input[inputmode=numeric]')).not.toBeNull()
  })
})
