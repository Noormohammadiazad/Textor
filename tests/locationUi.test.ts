// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { MapView } from '@/ui/location/MapView'
import { LocationCard } from '@/ui/location/LocationCard'
import { LocationPicker } from '@/ui/location/LocationPicker'
import { LiveBanner } from '@/ui/location/LiveBanner'
import { ChatView } from '@/ui/screens/ChatView'
import { formatAgo, formatDegrees, formatDistance, formatLeft } from '@/ui/location/format'
import { startLive } from '@/core/models/location'
import type { Contact, Conversation, Message } from '@/core/models/types'

/**
 * Locations on screen (ADR-064): a map drawn from the positions alone, the
 * card a location makes in a conversation, the sheet it opens, the picker
 * that sends one — with the browser's location service played by the test —
 * and the bar that never lets someone forget they are sharing.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)
const peer = 'b'.repeat(64)
const HOME = { lat: 35.6892, lon: 51.389 }
const MINUTE = 60_000

const contact: Contact = {
  id: 'c',
  pubkey: peer,
  npub: 'npub1peer',
  name: 'Alex Rivera',
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

const located = (patch: Partial<Message>): Message => ({
  id: 'l'.repeat(64),
  convoId: 'convo',
  direction: 'in',
  status: 'delivered',
  ts: Date.now(),
  tsCoarse: 0,
  body: '📍 geo:35.6892,51.389',
  authorPubkey: peer,
  location: { ...HOME, acc: 12, place: 'Café Naderi' },
  ...patch,
})

let root: Root
let host: HTMLElement
let stopSharing: ReturnType<typeof vi.fn>
let shareLocation: ReturnType<typeof vi.fn>

async function render(element: ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(element))
}

const text = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label,
  )
const click = async (node: Element | undefined | null) => {
  expect(node).toBeTruthy()
  await act(async () => (node as HTMLElement).click())
}

beforeEach(() => {
  stopSharing = vi.fn(async () => undefined)
  shareLocation = vi.fn(async () => true)
  useApp.setState({
    identity: { pubkey: me, name: 'Sam Me' } as never,
    contacts: new Map([[peer, contact]]),
    conversations: [conversation],
    conversationsLoaded: true,
    settings: { ...useApp.getState().settings, locale: 'en' },
    liveShares: [],
    stopSharing,
    shareLocation,
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('the map', () => {
  it('draws a place with its halo on a grid, with a scale and north', async () => {
    await render(
      createElement(MapView, {
        center: HOME,
        span: 150,
        markers: [{ at: HOME, kind: 'place', acc: 40 }],
        label: 'Map of the café',
      }),
    )
    const svg = host.querySelector('svg[role="img"]')!
    expect(svg.getAttribute('aria-label')).toBe('Map of the café')
    expect(host.querySelectorAll('.map-grid line').length).toBeGreaterThan(4)
    expect(host.querySelector('.map-pin')).not.toBeNull()
    expect(host.querySelector('.map-halo')).not.toBeNull()
    expect(host.querySelector('.map-north text')?.textContent).toBe('N')
    expect(host.querySelector('.map-scale text')?.textContent).toBe('50 m')
    // Not interactive: no controls, nothing to focus.
    expect(host.querySelector('.map-controls')).toBeNull()
    expect(svg.getAttribute('tabindex')).toBeNull()
  })

  it('draws a live marker with its sharer, the way it came, and where it is heading', async () => {
    await render(
      createElement(MapView, {
        center: HOME,
        span: 300,
        markers: [{ at: HOME, kind: 'live', hdg: 90, pulse: true, color: 'red', initials: 'AR' }],
        trail: { points: [{ lat: 35.688, lon: 51.388 }, HOME], color: 'red' },
        label: 'Live',
      }),
    )
    expect(host.querySelector('.map-pulse')).not.toBeNull()
    expect(host.querySelector('.map-live-initials')?.textContent).toBe('AR')
    expect(host.querySelector('.map-beam')?.getAttribute('transform')).toBe('rotate(90)')
    expect(host.querySelectorAll('.map-beam path')).toHaveLength(2)
    expect(host.querySelector('.map-trail')?.getAttribute('points')?.split(' ')).toHaveLength(2)
  })

  it('moves, zooms and takes a pin where it is tapped', async () => {
    const onMove = vi.fn()
    const onZoom = vi.fn()
    const onPick = vi.fn()
    const onRecenter = vi.fn()
    await render(
      createElement(MapView, {
        center: HOME,
        span: 150,
        shape: 'tall',
        markers: [],
        label: 'Pick',
        moves: { onMove, onZoom, onPick, onRecenter },
      }),
    )
    const svg = host.querySelector('svg[role="img"]')!
    const pointer = (type: string, x: number, y: number) =>
      act(async () => {
        svg.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
      })

    // A tap in the middle picks the middle.
    await pointer('pointerdown', 160, 120)
    await pointer('pointerup', 160, 120)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0].lat).toBeCloseTo(HOME.lat, 6)
    expect(onPick.mock.calls[0]?.[0].lon).toBeCloseTo(HOME.lon, 6)

    // A drag moves the map the other way, and picks nothing.
    await pointer('pointerdown', 160, 120)
    await pointer('pointermove', 160, 160)
    await pointer('pointerup', 160, 160)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onMove.mock.calls.at(-1)?.[0].lat).toBeGreaterThan(HOME.lat)

    await act(async () => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    })
    expect(onMove.mock.calls.at(-1)?.[0].lon).toBeGreaterThan(HOME.lon)
    expect(onZoom.mock.calls.map((call) => call[0])).toEqual([0.8, 1.25, 1.25])

    await click(button('Zoom in'))
    await click(button('Back to the marker'))
    expect(onZoom).toHaveBeenLastCalledWith(0.5)
    expect(onRecenter).toHaveBeenCalled()
  })
})

describe('a location in the conversation', () => {
  it('shows a place by name, where it is, and how sure', async () => {
    await render(createElement(LocationCard, { message: located({}) }))
    expect(host.querySelector('.location-title')?.textContent).toBe('Café Naderi')
    expect(host.querySelector('.location-detail')?.textContent).toBe('35.68920, 51.38900 · ±12 m')
    expect(host.querySelector('.map-pin')).not.toBeNull()
    expect(button('Stop sharing')).toBeUndefined()
  })

  it('opens the details, with the ways out that each tell someone else, only when asked', async () => {
    await render(createElement(LocationCard, { message: located({}) }))
    await click(button('Show on the map'))
    const sheet = document.body.querySelector('[role="dialog"]')!
    // In the page, not in the bubble, whose colours it would take on.
    expect(host.contains(sheet)).toBe(false)
    expect(sheet.textContent).toContain('Coordinates')
    expect(sheet.textContent).toContain('±12 m')
    const links = [...sheet.querySelectorAll('a')].map((link) => link.getAttribute('href'))
    expect(links).toEqual([
      'geo:35.689200,51.389000',
      'https://www.openstreetmap.org/?mlat=35.689200&mlon=51.389000#map=17/35.689200/51.389000',
    ])
    expect(sheet.querySelector('a[target="_blank"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    await click(button('Close'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows our own live location running, with a way to stop it', async () => {
    const now = Date.now()
    const message = located({
      direction: 'out',
      authorPubkey: me,
      status: 'read',
      ts: now,
      location: { ...HOME, live: 15 * 60 },
      live: startLive({ ...HOME, live: 900 }, now, now),
    })
    await render(createElement(LocationCard, { message }))
    expect(host.querySelector('.location-title')?.textContent).toBe('Live location')
    expect(host.querySelector('.location-detail')?.textContent).toBe('Updated just now · 15 mins left')
    expect(host.querySelector('.location-countdown')?.getAttribute('aria-label')).toBe('15 mins left')
    expect(host.querySelector('.map-live-initials')?.textContent).toBe('SM')
    expect(host.querySelector('.map-pulse')).not.toBeNull()
    await click(button('Stop sharing'))
    expect(stopSharing).toHaveBeenCalledWith(message.id)
  })

  it('keeps someone else’s share live though their clock runs an hour behind', async () => {
    const now = Date.now()
    const theirs = now - 60 * MINUTE
    const message = located({
      ts: theirs,
      location: { ...HOME, live: 0 },
      live: { ...startLive({ ...HOME, live: 0 }, theirs, now), hdg: 45 },
    })
    await render(createElement(LocationCard, { message }))
    expect(host.querySelector('.location-title')?.textContent).toBe('Live location')
    expect(host.querySelector('.location-detail')?.textContent).toBe('Updated just now · Until turned off')
    expect(host.querySelector('.location-countdown text')?.textContent).toBe('∞')
    expect(host.querySelector('.map-live-initials')?.textContent).toBe('AR')
    // Theirs to stop, not ours.
    expect(button('Stop sharing')).toBeUndefined()
  })

  it('says when a share ended, and stops pulsing or pointing', async () => {
    const now = Date.now()
    const message = located({
      ts: now - 30 * MINUTE,
      location: { ...HOME, live: 900 },
      live: { ...HOME, hdg: 90, seq: 3, at: now - 20 * MINUTE, lag: 0, end: now - 20 * MINUTE },
    })
    await render(createElement(LocationCard, { message }))
    expect(host.querySelector('.location-title')?.textContent).toBe('Live location ended')
    expect(host.querySelector('.location-detail')?.textContent).toBe('Ended 20 minutes ago')
    expect(host.querySelector('.map-pulse')).toBeNull()
    expect(host.querySelector('.map-beam')).toBeNull()
    expect(host.querySelector('.location-countdown')).toBeNull()
  })

  it('shows a quiet share as last heard from, and its path', async () => {
    const now = Date.now()
    const message = located({
      ts: now - 60 * MINUTE,
      location: { ...HOME, live: 8 * 3600 },
      live: { ...HOME, seq: 9, at: now - 40 * MINUTE, lag: 0, trail: [[35.68, 51.38]] },
    })
    await render(createElement(LocationCard, { message }))
    expect(host.querySelector('.location-detail')?.textContent).toBe(
      'Last heard from 40 minutes ago · 7 hrs left',
    )
    expect(host.querySelector('.map-pulse')).toBeNull()
    expect(host.querySelector('.map-trail')).not.toBeNull()
  })

  it('frames the reader and the share together when asked where the reader is, and never sends it', async () => {
    const geo = fakeGeolocation()
    const now = Date.now()
    // Two and a half kilometres apart, mostly east to west: the wide way.
    const message = located({
      ts: now,
      location: { lat: 35.699, lon: 51.414, live: 3600 },
      live: startLive({ lat: 35.699, lon: 51.414, live: 3600 }, now, now),
    })
    await render(createElement(LocationCard, { message }))
    await click(button('Show on the map'))
    await click(button('Show where I am'))
    geo.fix({})
    const sheet = document.body.querySelector('[role="dialog"]')!
    expect(sheet.textContent).toContain('From you2.5 km north-east')
    for (const selector of ['.map-self', '.map-live']) {
      const placed = sheet.querySelector(selector)!.closest('g[transform^="translate"]')!
      const [x, y] = placed
        .getAttribute('transform')!
        .match(/-?[\d.]+/g)!
        .map(Number)
      expect(Math.abs(x!), selector).toBeLessThan(160)
      expect(Math.abs(y!), selector).toBeLessThan(120)
    }
    expect(shareLocation).not.toHaveBeenCalled()
    await click(button('Hide where I am'))
    expect(sheet.querySelector('.map-self')).toBeNull()
    expect(geo.cleared).toEqual([7])
  })

  it('arrives in a conversation as a card, with its text only until the chunk is there', async () => {
    const now = Date.now()
    useApp.setState({ identity: { pubkey: me } as never })
    await render(createElement(ChatView, { address: peer }))
    await act(async () => useApp.setState({ messages: [located({ ts: now })] }))
    await vi.waitFor(() => expect(host.querySelector('.bubble .location-card')).not.toBeNull())
    expect(host.querySelector('.bubble .bubble-body')).toBeNull()
  })
})

/** The browser's location service, played by the test. */
function fakeGeolocation(): {
  fix: (coords: Partial<GeolocationCoordinates>) => void
  fail: (code: number) => void
  cleared: number[]
} {
  let success: PositionCallback | null = null
  let failure: PositionErrorCallback | null | undefined = null
  const cleared: number[] = []
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (ok: PositionCallback, error?: PositionErrorCallback | null) => {
        success = ok
        failure = error
        return 7
      },
      clearWatch: (id: number) => cleared.push(id),
      getCurrentPosition: () => undefined,
    },
  })
  return {
    fix: (coords) =>
      act(() =>
        success?.({
          coords: {
            latitude: HOME.lat,
            longitude: HOME.lon,
            accuracy: 12,
            heading: null,
            speed: null,
            ...coords,
          },
          timestamp: Date.now(),
        } as GeolocationPosition),
      ),
    fail: (code) =>
      act(() => failure?.({ code, message: '', PERMISSION_DENIED: 1 } as GeolocationPositionError)),
    cleared,
  }
}

describe('sending a location', () => {
  it('waits for a position, then sends where you are or shares it live', async () => {
    const geo = fakeGeolocation()
    const onClose = vi.fn()
    await render(createElement(LocationPicker, { onClose }))
    expect(text()).toContain('Finding where you are…')
    expect(button('15 minutes')?.disabled).toBe(true)

    geo.fix({})
    expect(text()).toContain('35.68920, 51.38900 · Accurate to 12 m')
    expect(document.body.querySelector('.map-self')).not.toBeNull()

    await click(button('15 minutes'))
    expect(shareLocation).toHaveBeenCalledWith({ ...HOME, acc: 12, live: 900 })
    expect(onClose).toHaveBeenCalled()

    await click(button('Until I turn it off'))
    expect(shareLocation).toHaveBeenLastCalledWith({ ...HOME, acc: 12, live: 0 })

    await click(button('Send your current location'))
    expect(shareLocation).toHaveBeenLastCalledWith({ ...HOME, acc: 12 })

    act(() => root.unmount())
    expect(geo.cleared).toEqual([7])
    root = createRoot(host)
  })

  it('sends a place pasted from a map link, named, and exact', async () => {
    const geo = fakeGeolocation()
    await render(createElement(LocationPicker, { onClose: () => undefined }))
    geo.fix({})
    const [coordinates, name] = [...document.body.querySelectorAll<HTMLInputElement>('input')]
    const type = (input: HTMLInputElement, value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

    type(coordinates!, 'nowhere at all')
    await act(async () => coordinates!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(text()).toContain('That is not a position Textor can read')

    type(coordinates!, 'https://www.openstreetmap.org/#map=17/35.7/51.4')
    expect(text()).not.toContain('That is not a position Textor can read')
    expect(text()).toMatch(/Pin moved \d+(\.\d)? km from you/)
    type(name!, '  Tochal  ')
    await click(button('Send this place'))
    expect(shareLocation).toHaveBeenLastCalledWith({ lat: 35.7, lon: 51.4, place: 'Tochal' })

    // Back to where you are, and the pin goes with it.
    type(coordinates!, 'geo:35.7,51.4')
    await click(button('Send your current location'))
    expect(text()).toContain('Accurate to 12 m')
  })

  it('still sends a place by its coordinates when location is refused', async () => {
    const geo = fakeGeolocation()
    await render(createElement(LocationPicker, { onClose: () => undefined }))
    geo.fail(1)
    expect(text()).toContain('This browser is not letting Textor know where you are')
    expect(button('Send your current location')?.disabled).toBe(true)
    expect(button('1 hour')?.disabled).toBe(true)
    const [coordinates] = [...document.body.querySelectorAll<HTMLInputElement>('input')]
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(coordinates!, '-33.8568, 151.2153')
      coordinates!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Send this place'))
    expect(shareLocation).toHaveBeenLastCalledWith({ lat: -33.8568, lon: 151.2153 })
    expect(button('1 hour')?.disabled).toBe(true)
  })
})

describe('the sharing bar', () => {
  const share = (address: string, id = 's1') => ({ id, address, until: null })

  it('names who you are sharing with, opens the chat, and stops it', async () => {
    useApp.setState({ liveShares: [share(peer)] })
    await render(createElement(LiveBanner))
    expect(text()).toContain('Sharing live location with Alex Rivera')
    await click(button('Stop sharing'))
    expect(stopSharing).toHaveBeenCalledWith('s1')
    await click(button('Sharing live location with Alex Rivera'))
    expect(location.hash).toBe(`#/c/${peer}`)
  })

  it('counts chats when there are several, and says so in the one it is shared to', async () => {
    const group = 'f'.repeat(32)
    useApp.setState({
      liveShares: [share(peer), share(group, 's2')],
      conversations: [
        conversation,
        { ...conversation, id: group, kind: 'group', members: [peer], subject: 'Hike' },
      ],
    })
    await render(createElement(LiveBanner))
    expect(text()).toContain('Sharing live location in 2 chats')
    await click(button('Stop sharing'))
    expect(stopSharing.mock.calls.map((call) => call[0])).toEqual(['s1', 's2'])

    act(() => root.unmount())
    await render(createElement(LiveBanner, { address: group }))
    expect(text()).toContain('You are sharing your live location here')
    act(() => root.unmount())
    await render(createElement(LiveBanner, { address: 'e'.repeat(64) }))
    expect(host.querySelector('.live-banner')).toBeNull()
  })

  it('names a group by its name', async () => {
    const group = 'f'.repeat(32)
    useApp.setState({
      liveShares: [share(group)],
      conversations: [{ ...conversation, id: group, kind: 'group', members: [peer], subject: 'Hike' }],
    })
    await render(createElement(LiveBanner))
    expect(text()).toContain('Sharing live location with Hike')
  })
})

describe('numbers in the reader’s language', () => {
  it('uses the browser’s own unit names, in Western digits in both languages', () => {
    expect(formatDistance(350.4, 'en')).toBe('350 m')
    expect(formatDistance(1234, 'en')).toBe('1.2 km')
    expect(formatDistance(12_345, 'en')).toBe('12 km')
    // Persian takes the long names, whose number and word stay apart.
    expect(formatDistance(350, 'fa')).toBe('350 متر')
    expect(formatLeft(15 * MINUTE, 'fa')).toBe('15 دقیقه')
    expect(formatDegrees(271.6)).toBe('272°')
    expect(formatLeft(30_000, 'en')).toBe('1 min')
    expect(formatLeft(90 * MINUTE, 'en')).toBe('2 hrs')
    expect(formatAgo(3 * 60 * MINUTE, 'en')).toBe('3 hours ago')
    expect(formatAgo(3 * 24 * 60 * MINUTE, 'en')).toBe('3 days ago')
  })
})
