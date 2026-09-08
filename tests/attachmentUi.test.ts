// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { AttachButton } from '@/ui/components/Composer'
import { AttachmentView } from '@/ui/components/AttachmentView'
import { MessageBubble } from '@/ui/components/MessageBubble'
import { prepareAttachment } from '@/media/attach'
import { blobRef, blobRefKey } from '@/core/crypto/blobCrypto'
import type { Attachment } from '@/core/models/attachment'
import type { LocaleCode, Message } from '@/core/models/types'

/**
 * Attaching and showing what was attached, as Telegram does it (ADR-083): the
 * menu offers "Photo or Video" and "File" apart, each with its icon; a photo or
 * a video fills its bubble with nothing written under it but what someone
 * wrote; and anything sent as a file is a card to save, whatever it holds.
 */

vi.mock('@/media/attach', () => ({ prepareAttachment: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = 'a'.repeat(64)

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
  await act(async () => root.render(createElement(I18nContext.Provider, { value: value as never }, element)))
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const click = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
const key = (target: Element, name: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })
const fire = (target: Element, type: string) =>
  act(async () => {
    target.dispatchEvent(new Event(type))
  })

let openAttachment: ReturnType<typeof vi.fn>
let toast: ReturnType<typeof vi.fn>
let sendAttachment: ReturnType<typeof vi.fn>

beforeEach(() => {
  openAttachment = vi.fn(async () => 'blob:bytes')
  toast = vi.fn()
  sendAttachment = vi.fn(async () => undefined)
  useApp.setState({
    identity: { pubkey: me } as never,
    openAttachment,
    blobProgress: new Map(),
    toast,
    sendAttachment,
  } as never)
  vi.mocked(prepareAttachment).mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the attach menu', () => {
  const menuItems = () => [...document.querySelectorAll('.popover [role=menuitem]')]
  const open = async () => click(host.querySelector('[aria-label="Attach"], [aria-label="پیوست"]')!)
  const pickers = () => [...host.querySelectorAll<HTMLInputElement>('input[type=file]')]

  it('offers Telegram’s five, in Telegram’s order, each with its icon', async () => {
    await render(createElement(AttachButton, {}))
    await open()
    expect(menuItems().map((item) => item.textContent)).toEqual([
      'Photo or Video',
      'File',
      'Poll',
      'Checklist',
      'Location',
    ])
    expect(menuItems().every((item) => item.querySelector(':scope > svg[aria-hidden="true"]'))).toBe(true)
  })

  it('says them in Persian', async () => {
    await render(createElement(AttachButton, {}), 'fa')
    await open()
    expect(menuItems().map((item) => item.textContent)).toEqual([
      'عکس یا ویدیو',
      'فایل',
      'نظرسنجی',
      'فهرست کارها',
      'موقعیت مکانی',
    ])
  })

  it('opens a picker of photos and videos, or of anything at all', async () => {
    const opened: string[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this.accept)
    })
    await render(createElement(AttachButton, {}))
    // Out of the tab order and out of reach of a screen reader: the menu is
    // the way to them.
    expect(pickers().map((input) => [input.tabIndex, input.getAttribute('aria-hidden')])).toEqual([
      [-1, 'true'],
      [-1, 'true'],
    ])
    await open()
    await click(menuItems()[0]!)
    expect(document.querySelector('.popover')).toBeNull()
    await open()
    await click(menuItems()[1]!)
    expect(opened).toEqual(['image/*,video/*', ''])
    // Escape closes it without choosing anything.
    await open()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.popover')).toBeNull()
    expect(opened).toHaveLength(2)
  })

  it('sends what was picked as what it was picked as', async () => {
    const payload = { bytes: new Uint8Array(3), kind: 'image', mime: 'image/webp', caption: 'Photo' }
    vi.mocked(prepareAttachment).mockResolvedValue(payload as never)
    await render(createElement(AttachButton, {}))
    const pick = (input: HTMLInputElement, file: File | null) =>
      act(async () => {
        Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    const photo = new File([new Uint8Array(3)], 'a.jpg', { type: 'image/jpeg' })

    await pick(pickers()[0]!, photo)
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledWith(payload))
    expect(vi.mocked(prepareAttachment).mock.calls[0]!.slice(0, 2)).toEqual([photo, 'media'])
    // In the reader's words, for the clients that will show them.
    expect(vi.mocked(prepareAttachment).mock.calls[0]![2]('attachment.captionImage')).toBe('Photo')

    await pick(pickers()[1]!, photo)
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledTimes(2))
    expect(vi.mocked(prepareAttachment).mock.calls[1]![1]).toBe('file')

    // A picker closed with nothing chosen sends nothing.
    await pick(pickers()[1]!, null)
    expect(prepareAttachment).toHaveBeenCalledTimes(2)
  })

  it('waits while it prepares, and says so when it cannot', async () => {
    let fail: (reason: Error) => void = () => undefined
    vi.mocked(prepareAttachment).mockReturnValue(new Promise((_, reject) => (fail = reject)))
    await render(createElement(AttachButton, {}))
    const input = pickers()[0]!
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'x.png')], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.disabled).toBe(true),
    )
    await act(async () => fail(new Error('canvas')))
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Something went wrong', 'danger'))
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.disabled).toBe(false)
    expect(sendAttachment).not.toHaveBeenCalled()
  })
})

const hex = (n: number, c: string) => c.repeat(n)
const described = (extra: Partial<Attachment>): Attachment => ({
  kind: 'image',
  id: hex(64, '1'),
  key: hex(64, '2'),
  salt: hex(32, '3'),
  size: 348_000,
  chunks: 22,
  mime: 'image/webp',
  ...extra,
})

describe('a bubble holding a photo, a video or a file', () => {
  const message = (
    body: string,
    attachment?: Partial<Attachment>,
    extra: Partial<Message> = {},
  ): Message => ({
    id: 'm1',
    convoId: 'c',
    direction: 'out',
    status: 'sent',
    ts: Date.UTC(2026, 10, 13, 10, 15),
    tsCoarse: 0,
    body,
    authorPubkey: me,
    ...(attachment ? { attachment: described(attachment) } : {}),
    ...extra,
  })
  const show = (shown: Message, props: Record<string, unknown> = {}) =>
    render(
      createElement(MessageBubble, {
        message: shown,
        groupStart: false,
        groupEnd: true,
        selecting: false,
        selected: false,
        onSelect: () => undefined,
        onDelete: () => undefined,
        selfPubkey: me,
        onReply: () => undefined,
        onRetry: () => undefined,
        senderLabel: 'You said',
        ...props,
      }),
    )
  const bubble = () => host.querySelector<HTMLElement>('.bubble')!
  const caption = () => host.querySelector('.bubble-body')?.textContent ?? null
  const menuLabels = async () => {
    await act(async () => void bubble().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    return [...document.querySelectorAll('.popover [role=menuitem]')].map((item) => item.textContent)
  }

  it('draws a photo alone, edge to edge, with its time on it and no word for what it is', async () => {
    await show(message('Photo', { width: 2560, height: 1920 }))
    await settle()
    expect(bubble().className).toBe('bubble bubble-media bubble-bare bubble-image')
    expect(caption()).toBeNull()
    expect(bubble().querySelector('img.attachment-full')?.getAttribute('src')).toBe('blob:bytes')
    expect(bubble().querySelector('.bubble-meta time')).not.toBeNull()
    // Nothing to copy: the words were never anyone's.
    expect(await menuLabels()).not.toContain('Copy text')
  })

  it('knows the word whichever language the sender’s Textor wrote it in', async () => {
    await show(message('عکس', {}))
    expect(caption()).toBeNull()
    expect(bubble().classList.contains('bubble-bare')).toBe(true)
  })

  it('writes what someone wrote under the picture, and copies that', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await show(message('Sunset at Darband', {}))
    expect(bubble().className).toBe('bubble bubble-media')
    expect(caption()).toBe('Sunset at Darband')
    expect(host.querySelector('.bubble-body')?.getAttribute('dir')).toBe('auto')
    await menuLabels()
    await click(
      [...document.querySelectorAll('.popover [role=menuitem]')].find((b) => b.textContent === 'Copy text')!,
    )
    expect(writeText).toHaveBeenCalledWith('Sunset at Darband')
    // A clipboard the browser will not let us write to changes nothing.
    writeText.mockRejectedValueOnce(new Error('denied'))
    await menuLabels()
    await click(
      [...document.querySelectorAll('.popover [role=menuitem]')].find((b) => b.textContent === 'Copy text')!,
    )
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('keeps its bubble for a reply or a name above the picture', async () => {
    await show(message('Photo', {}), { quoted: message('the question') })
    expect(bubble().className).toBe('bubble bubble-media')
    act(() => root.unmount())
    await show(message('Photo', {}), { groupStart: true, authorLabel: 'Bob' })
    expect(bubble().className).toBe('bubble bubble-media')
    act(() => root.unmount())
    // Named for a screen reader only, it still stands alone.
    await show(message('Photo', {}), { groupStart: true })
    expect(bubble().classList.contains('bubble-bare')).toBe(true)
  })

  it('puts a video’s time at its head, clear of its controls', async () => {
    await show(message('Video', { kind: 'video', mime: 'video/mp4' }))
    await settle()
    expect(bubble().className).toBe('bubble bubble-media bubble-bare bubble-video')
    expect(bubble().querySelector('video')).not.toBeNull()
  })

  it('shows a picture sent as a file as a card to save, and draws none of it', async () => {
    await show(message('File · IMG_1.jpg', { kind: 'file', mime: 'image/jpeg', name: 'IMG_1.jpg' }))
    await settle()
    expect(bubble().className).toBe('bubble')
    expect(caption()).toBeNull()
    expect(bubble().querySelector('img, video')).toBeNull()
    expect(bubble().querySelector('.attachment-file-name')?.textContent).toBe('IMG_1.jpg')
    expect(bubble().querySelector('.attachment-file')?.textContent).toContain('340 KB')
    const save = bubble().querySelector('a[download]')!
    expect([
      save.getAttribute('download'),
      save.getAttribute('href'),
      save.getAttribute('aria-label'),
    ]).toEqual(['IMG_1.jpg', 'blob:bytes', 'Save'])
  })

  it('says nothing beside a voice note, or a file named the old Persian way', async () => {
    await show(message('Voice message · 0:12', { kind: 'voice', mime: 'audio/webm', durationMs: 12_000 }))
    expect(caption()).toBeNull()
    expect(bubble().className).toBe('bubble')
    act(() => root.unmount())
    await show(message('پرونده · a.pdf', { kind: 'file', mime: 'application/pdf', name: 'a.pdf' }))
    expect(caption()).toBeNull()
  })

  it('leaves a message with nothing attached as it was written', async () => {
    await show(message('Photo'))
    expect(caption()).toBe('Photo')
    expect(bubble().className).toBe('bubble')
  })
})

describe('what is attached, as it arrives', () => {
  const view = (attachment: Attachment) => render(createElement(AttachmentView, { attachment }))
  const progress = (attachment: Attachment, received: number, total: number) =>
    useApp.setState({
      blobProgress: new Map([[blobRefKey(blobRef(attachment)), { received, total }]]),
    } as never)
  const style = (selector: string) => host.querySelector(selector)?.getAttribute('style') ?? ''

  it('holds a photo’s shape and preview until its bytes are here, then opens it full size', async () => {
    openAttachment.mockResolvedValue(null)
    const photo = described({ width: 3, height: 2, preview: 'data:image/jpeg;base64,AA==' })
    await view(photo)
    await settle()
    const box = host.querySelector<HTMLButtonElement>('button.attachment-image')!
    expect(box.disabled).toBe(true)
    expect(style('.attachment-image')).toContain('aspect-ratio: 3 / 2')
    expect(host.querySelector('.attachment-preview')?.getAttribute('src')).toBe('data:image/jpeg;base64,AA==')
    expect(host.querySelector('.attachment-full')).toBeNull()

    act(() => root.unmount())
    openAttachment.mockResolvedValue('blob:photo')
    await view(described({}))
    await settle()
    expect(style('.attachment-image')).toContain('aspect-ratio: 4 / 3')
    expect(host.querySelector('.attachment-full')?.getAttribute('src')).toBe('blob:photo')
    // Without a name, nothing is read out for it but what the button says.
    expect(host.querySelector('.attachment-full')?.getAttribute('alt')).toBe('')

    await click(host.querySelector('button.attachment-image')!)
    const lightbox = () => host.querySelector('.lightbox')
    expect(lightbox()?.getAttribute('aria-label')).toBe('Open image')
    await key(lightbox()!, 'Enter')
    expect(lightbox()).not.toBeNull()
    await key(lightbox()!, 'Escape')
    expect(lightbox()).toBeNull()
    await click(host.querySelector('button.attachment-image')!)
    await click(lightbox()!)
    expect(lightbox()).toBeNull()
  })

  it('shows how far a transfer has got, and waits for it before opening anything', async () => {
    const photo = described({})
    progress(photo, 5, 20)
    await view(photo)
    await settle()
    expect(openAttachment).not.toHaveBeenCalled()
    expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-label')).toBe('Transferring')
    expect(style('.progress > div')).toContain('width: 25%')
    progress(photo, 0, 0)
    await settle()
    expect(style('.progress > div')).toContain('width: 0%')
    await act(async () => useApp.setState({ blobProgress: new Map() } as never))
    await settle()
    expect(openAttachment).toHaveBeenCalledWith(photo)
    expect(host.querySelector('[role=progressbar]')).toBeNull()
  })

  it('keeps a photo or a video that will not open in its place and shape, and says so', async () => {
    openAttachment.mockRejectedValue(new Error('tampered'))
    await view(described({ width: 1, height: 1 }))
    await settle()
    expect(host.querySelector('.attachment-broken')?.textContent).toBe('This attachment could not be loaded')
    expect(style('.attachment-broken')).toContain('aspect-ratio: 1 / 1')

    act(() => root.unmount())
    await view(described({ kind: 'video', mime: 'video/mp4' }))
    await settle()
    expect(style('.attachment-broken')).toContain('aspect-ratio: 16 / 9')

    act(() => root.unmount())
    await view(described({ kind: 'file', mime: 'application/zip' }))
    await settle()
    expect(host.querySelector('.attachment-broken')).toBeNull()
    expect(host.textContent).toBe('This attachment could not be loaded')
  })

  it('plays a video in place, its poster shown only until it can', async () => {
    openAttachment.mockResolvedValue(null)
    const clip = described({
      kind: 'video',
      mime: 'video/mp4',
      width: 16,
      height: 9,
      preview: 'data:image/png;base64,AA==',
    })
    await view(clip)
    await settle()
    expect(host.querySelector('.attachment-preview')).not.toBeNull()
    expect(host.querySelector('video')).toBeNull()
    act(() => root.unmount())
    openAttachment.mockResolvedValue('blob:clip')
    await view(clip)
    await settle()
    expect(host.querySelector('.attachment-preview')).toBeNull()
    const video = host.querySelector('video')!
    expect([video.getAttribute('src'), video.hasAttribute('controls'), style('.attachment-image')]).toEqual([
      'blob:clip',
      true,
      'aspect-ratio: 16 / 9;',
    ])
  })

  it('names a file it was given no name for, and says it is on its way', async () => {
    openAttachment.mockResolvedValue(null)
    await view(described({ kind: 'file', mime: 'application/octet-stream', size: 512 }))
    await settle()
    expect(host.querySelector('.attachment-file-name')?.textContent).toBe('File')
    expect(host.textContent).toContain('512 B')
    expect(host.textContent).toContain('Transferring')
    expect(host.querySelector('a[download]')).toBeNull()
    expect(host.querySelector('.attachment-file-icon svg')).not.toBeNull()
    act(() => root.unmount())
    await view(described({ kind: 'file', mime: 'application/pdf', name: 'a.pdf', size: 1_572_864 }))
    await settle()
    expect(host.textContent).toContain('1.5 MB')
  })

  it('stops reading a payload for a bubble no longer shown', async () => {
    let answer: (url: string) => void = () => undefined
    openAttachment.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await view(described({}))
    act(() => root.unmount())
    await act(async () => answer('blob:late'))
    await render(createElement('div'))
    let refuse: (reason: Error) => void = () => undefined
    openAttachment.mockReturnValue(new Promise((_, reject) => (refuse = reject)))
    act(() => root.unmount())
    await view(described({}))
    act(() => root.unmount())
    await act(async () => refuse(new Error('late')))
    await render(createElement('div'))
    expect(host.textContent).toBe('')
  })
})

describe('a voice note', () => {
  const note = (extra: Partial<Attachment> = {}) =>
    described({ kind: 'voice', mime: 'audio/webm', durationMs: 65_000, waveform: [10, 50, 90, 30], ...extra })
  const play = () => host.querySelector<HTMLButtonElement>('.voice-play')!
  const slider = () => host.querySelector<HTMLElement>('[role=slider]')!
  const audio = () => host.querySelector('audio')!
  const time = () => host.querySelector('.voice-time')?.textContent

  let paused: boolean
  let duration: number

  beforeEach(() => {
    paused = true
    duration = 65
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused)
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockImplementation(() => duration)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  it('waits for its audio with nothing to press, its length and shape already drawn', async () => {
    openAttachment.mockResolvedValue(null)
    await render(createElement(AttachmentView, { attachment: note() }))
    await settle()
    expect(play().disabled).toBe(true)
    expect(slider().tabIndex).toBe(-1)
    expect(host.querySelectorAll('.voice-bar')).toHaveLength(4)
    expect(host.querySelector('.voice-bar')?.getAttribute('style')).toContain('height: 10%')
    expect(time()).toBe('1:05')
    expect(host.querySelector('.visually-hidden')?.textContent).toBe('340 KB')
    // Seeking needs audio to seek in.
    await key(slider(), 'End')
    expect(slider().getAttribute('aria-valuenow')).toBe('0')
  })

  it('plays and pauses, and says which it will do', async () => {
    await render(createElement(AttachmentView, { attachment: note() }))
    await settle()
    expect(play().getAttribute('aria-label')).toBe('Play')
    await click(play())
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    await fire(audio(), 'play')
    paused = false
    expect(play().getAttribute('aria-label')).toBe('Pause')
    expect(time()).toBe('0:00')
    await click(play())
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    await fire(audio(), 'pause')
    expect(play().getAttribute('aria-label')).toBe('Play')

    // A browser that refuses to play leaves it showing Play.
    paused = true
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('autoplay'))
    await fire(audio(), 'play')
    await click(play())
    await settle()
    expect(play().getAttribute('aria-label')).toBe('Play')
  })

  it('moves through it by the keyboard, and by a click from either end', async () => {
    await render(createElement(AttachmentView, { attachment: note() }))
    await settle()
    const at = () => audio().currentTime
    for (const [name, expected] of [
      ['End', 65],
      ['Home', 0],
      ['ArrowRight', 3.25],
      ['ArrowUp', 3.25],
      ['ArrowLeft', 0],
      ['ArrowDown', 0],
    ] as const) {
      await key(slider(), name)
      expect(at()).toBeCloseTo(expected)
    }
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    await act(async () => void slider().dispatchEvent(other))
    expect(other.defaultPrevented).toBe(false)

    vi.spyOn(slider(), 'getBoundingClientRect').mockReturnValue({ left: 100, width: 200 } as DOMRect)
    await act(
      async () => void slider().dispatchEvent(new MouseEvent('click', { clientX: 150, bubbles: true })),
    )
    expect(at()).toBeCloseTo(65 / 4)
    // In Persian the track starts on the right.
    const computed = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element) => ({ ...computed(element), direction: 'rtl' }) as CSSStyleDeclaration,
    )
    await act(
      async () => void slider().dispatchEvent(new MouseEvent('click', { clientX: 150, bubbles: true })),
    )
    expect(at()).toBeCloseTo((65 * 3) / 4)

    // Audio whose length is not known yet cannot be sought in.
    duration = Number.POSITIVE_INFINITY
    audio().currentTime = 1
    await key(slider(), 'End')
    expect(at()).toBe(1)
  })

  it('believes the audio’s own length, follows it playing, and starts over at the end', async () => {
    await render(
      createElement(AttachmentView, { attachment: note({ durationMs: undefined, waveform: undefined }) }),
    )
    await settle()
    expect(host.querySelector('.voice-bar-fallback')).not.toBeNull()
    expect(time()).toBe('0:00')
    // A recording that cannot say how long it is yet.
    duration = Number.POSITIVE_INFINITY
    await fire(audio(), 'loadedmetadata')
    expect(time()).toBe('0:00')
    duration = 42
    await fire(audio(), 'loadedmetadata')
    expect(time()).toBe('0:42')
    audio().currentTime = 21
    await fire(audio(), 'timeupdate')
    expect(time()).toBe('0:21')
    expect(slider().getAttribute('aria-valuenow')).toBe('50')
    expect(slider().getAttribute('aria-valuetext')).toBe('0:21')
    await fire(audio(), 'ended')
    expect(time()).toBe('0:42')
  })

  it('says so when this browser cannot play its format, or it will not open', async () => {
    await render(createElement(AttachmentView, { attachment: note() }))
    await settle()
    await fire(audio(), 'error')
    expect(host.textContent).toBe('This browser cannot play this audio format')
    act(() => root.unmount())
    openAttachment.mockRejectedValue(new Error('tampered'))
    await render(createElement(AttachmentView, { attachment: note() }))
    await settle()
    expect(host.textContent).toBe('This attachment could not be loaded')
  })
})
