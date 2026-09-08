// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { ChatView } from '@/ui/screens/ChatView'
import { CallBubble, type CallEntry } from '@/ui/components/CallBubble'
import type { Contact, Conversation } from '@/core/models/types'

/**
 * The conversation header's ways to call (ADR-070): a walkie-talkie beside
 * voice and video, each there whenever this contact can be called at all, and
 * each saying — muted, on its button and when pressed — why it cannot work
 * from here and now, when it cannot.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)
const peer = 'b'.repeat(64)

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
  lastActivity: 0,
  unread: 0,
  pinned: false,
}

let root: Root
let host: HTMLElement
let startCall: ReturnType<typeof vi.fn>
let toast: ReturnType<typeof vi.fn>

const button = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(`header button[aria-label="${label}"]`)

async function render(sync: { online: boolean; connectedRelays: number }, who: Contact = contact) {
  useApp.setState({
    identity: { pubkey: me } as never,
    contacts: new Map([[peer, who]]),
    conversations: [conversation],
    conversationsLoaded: true,
    syncState: { ...useApp.getState().syncState, ...sync },
    startCall,
    toast,
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ChatView, { address: peer })))
}

beforeEach(() => {
  startCall = vi.fn(async () => undefined)
  toast = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the ways to call', () => {
  it('offers a walkie-talkie, a voice call and a video call, and starts the one pressed', async () => {
    vi.stubGlobal('RTCPeerConnection', class {})
    vi.stubGlobal('AudioEncoder', class {})
    await render({ online: true, connectedRelays: 2 })
    for (const label of ['Walkie-talkie', 'Voice call', 'Video call']) {
      expect(button(label)?.getAttribute('aria-disabled')).toBeNull()
      expect(button(label)?.title).toBe(label)
    }
    await act(async () => button('Walkie-talkie')!.click())
    await act(async () => button('Video call')!.click())
    expect(startCall.mock.calls).toEqual([
      [peer, 'radio'],
      [peer, 'video'],
    ])
  })

  it('mutes them all, saying why, when nothing can reach the relays', async () => {
    vi.stubGlobal('RTCPeerConnection', class {})
    vi.stubGlobal('AudioEncoder', class {})
    await render({ online: false, connectedRelays: 0 })
    for (const label of ['Walkie-talkie', 'Voice call', 'Video call']) {
      expect(button(label)?.getAttribute('aria-disabled')).toBe('true')
      expect(button(label)?.title).toBe('You are offline. Calls need a connection.')
    }
    await act(async () => button('Voice call')!.click())
    expect(startCall).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('You are offline. Calls need a connection.')
    act(() => root.unmount())
    host.remove()
    await render({ online: true, connectedRelays: 0 })
    expect(button('Walkie-talkie')?.title).toBe('No relay is connected yet, and calls go through them.')
  })

  it('mutes what this browser cannot do, and only that', async () => {
    // No WebRTC and no WebCodecs here, as in the test environment itself.
    await render({ online: true, connectedRelays: 1 })
    expect(button('Voice call')?.title).toBe('Calls are not supported in this browser.')
    expect(button('Walkie-talkie')?.title).toBe('This browser cannot send voice over relays.')
    act(() => root.unmount())
    host.remove()
    vi.stubGlobal('AudioEncoder', class {})
    await render({ online: true, connectedRelays: 1 })
    expect(button('Walkie-talkie')?.getAttribute('aria-disabled')).toBeNull()
    expect(button('Video call')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('offers none of them to someone not taken into the address book', async () => {
    await render({ online: true, connectedRelays: 1 }, { ...contact, accepted: false })
    expect(button('Walkie-talkie')).toBeNull()
    expect(button('Voice call')).toBeNull()
  })
})

describe('calling back from a call in the conversation (ADR-071)', () => {
  const bubble = async (media: CallEntry['call']['media'], onCallBack: (media: string) => void) => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const message = {
      id: 'call',
      direction: 'out',
      ts: 0,
      call: { media, outcome: 'completed', durationMs: 5000 },
    } as unknown as CallEntry
    await act(async () =>
      root.render(
        createElement(CallBubble, {
          message,
          groupStart: true,
          groupEnd: true,
          selecting: false,
          selected: false,
          onSelect: () => undefined,
          onDelete: () => undefined,
          onCallBack,
        } as never),
      ),
    )
  }

  it('calls back from a voice or a video call', async () => {
    const onCallBack = vi.fn()
    await bubble('video', onCallBack)
    await act(async () => host.querySelector<HTMLButtonElement>('button.call-bubble-back')!.click())
    expect(onCallBack).toHaveBeenCalledWith('video')
  })

  it('offers no way to start a walkie-talkie from its record: only the header starts one', async () => {
    await bubble('radio', vi.fn())
    expect(host.querySelector('button.call-bubble-back')).toBeNull()
    expect(host.querySelector('span.call-bubble-back')).not.toBeNull()
  })
})
