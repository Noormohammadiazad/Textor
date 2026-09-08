// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useApp } from '@/app/store'
import { I18nContext, LOCALE_DIRECTION, translate } from '@/i18n'
import { EmojiButton, VoiceButton } from '@/ui/components/Composer'
import EmojiPicker from '@/ui/emoji/EmojiPicker'
import { LAZY_CHUNKS } from '@/ui/lazyViews'
import { canRecordVoice } from '@/media/voiceSupport'
import { VoiceRecorder } from '@/media/recorder'
import { prepareImage, STICKER_EDGE } from '@/media/image'
import { MAX_VOICE_BYTES } from '@/core/models/attachment'
import type { LocaleCode, Sticker, StickerPack } from '@/core/models/types'
import type * as Image from '@/media/image'

/**
 * The composer's other controls: the microphone, which records a voice note
 * and sends it on the second press, and the emoji and sticker picker, whose
 * words travel in its own chunk (ADR-043) — and whose stickers are made from
 * pictures at a sticker's size, by the same encoder as a photo (ADR-083).
 */

vi.mock('@/media/voiceSupport', () => ({ canRecordVoice: vi.fn(() => true) }))
vi.mock('@/media/recorder', () => ({ VoiceRecorder: vi.fn() }))
vi.mock('@/media/image', async (original) => ({
  ...(await original<typeof Image>()),
  prepareImage: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const click = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

let toast: ReturnType<typeof vi.fn>
let sendAttachment: ReturnType<typeof vi.fn>

beforeEach(() => {
  toast = vi.fn()
  sendAttachment = vi.fn(async () => undefined)
  useApp.setState({ toast, sendAttachment } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the microphone', () => {
  type Fake = {
    onLevel: ((level: number) => void) | null
    onAutoStop: (() => void) | null
    elapsedMs: number
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  let recorder: Fake
  const recording = { bytes: new Uint8Array(10), mime: 'audio/webm', durationMs: 3000, waveform: [1, 2] }

  beforeEach(() => {
    vi.mocked(canRecordVoice).mockReturnValue(true)
    recorder = {
      onLevel: null,
      onAutoStop: null,
      elapsedMs: 0,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => recording),
      cancel: vi.fn(),
    }
    vi.mocked(VoiceRecorder).mockImplementation(function () {
      return recorder
    } as never)
  })

  const start = async () => {
    await click(button('Record a voice note'))
    await vi.waitFor(() =>
      expect(document.querySelector('[role=group][aria-label="Recording"]')).not.toBeNull(),
    )
  }

  it('is not offered where the browser cannot record', async () => {
    vi.mocked(canRecordVoice).mockReturnValue(false)
    await render(createElement(VoiceButton, {}))
    expect(host.innerHTML).toBe('')
  })

  it('records, shows for how long and how loud, and sends it on the second press', async () => {
    await render(createElement(VoiceButton, {}))
    await start()
    await act(async () => recorder.onLevel!(0.5))
    expect(host.querySelector('.recording-meter span')?.getAttribute('style')).toContain('scaleX(0.5)')
    // A meter never shrinks to nothing, so it is plain the microphone is on.
    await act(async () => recorder.onLevel!(0))
    expect(host.querySelector('.recording-meter span')?.getAttribute('style')).toContain('scaleX(0.03)')
    recorder.elapsedMs = 3000
    await wait(250)
    expect(host.querySelector('.recording-time')?.textContent).toBe('0:03')

    await click(button('Send voice note'))
    await vi.waitFor(() =>
      expect(sendAttachment).toHaveBeenCalledWith({
        bytes: recording.bytes,
        kind: 'voice',
        mime: 'audio/webm',
        caption: 'Voice message · 0:03',
        durationMs: 3000,
        waveform: [1, 2],
      }),
    )
    expect(button('Record a voice note')).not.toBeNull()
  })

  it('throws a recording away', async () => {
    await render(createElement(VoiceButton, {}))
    await start()
    await click(button('Discard recording'))
    expect(recorder.cancel).toHaveBeenCalled()
    expect(recorder.stop).not.toHaveBeenCalled()
    expect(sendAttachment).not.toHaveBeenCalled()
  })

  it('sends nothing it did not hear, and refuses what is too long to send', async () => {
    await render(createElement(VoiceButton, {}))
    for (const result of [null, { ...recording, bytes: new Uint8Array(0) }]) {
      recorder.stop.mockResolvedValueOnce(result)
      await start()
      await click(button('Send voice note'))
    }
    recorder.stop.mockResolvedValueOnce({ ...recording, bytes: new Uint8Array(MAX_VOICE_BYTES + 1) })
    await start()
    await click(button('Send voice note'))
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('That file is too large to send', 'danger'))
    expect(sendAttachment).not.toHaveBeenCalled()
  })

  it('stops itself at the limit, and only once', async () => {
    await render(createElement(VoiceButton, {}))
    await start()
    const stop = recorder.onAutoStop!
    await act(async () => stop())
    await vi.waitFor(() => expect(sendAttachment).toHaveBeenCalledTimes(1))
    await act(async () => stop())
    expect(recorder.stop).toHaveBeenCalledTimes(1)
  })

  it('says so when the microphone is refused, or the recorder will not load', async () => {
    recorder.start.mockRejectedValueOnce(new Error('NotAllowedError'))
    await render(createElement(VoiceButton, {}))
    await click(button('Record a voice note'))
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Microphone access was refused', 'danger'))
    expect(recorder.cancel).toHaveBeenCalled()

    vi.spyOn(LAZY_CHUNKS, 'media').mockRejectedValueOnce(new Error('offline'))
    await click(button('Record a voice note'))
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Something went wrong', 'danger'))
  })

  it('lets go of the microphone when it leaves the screen', async () => {
    await render(createElement(VoiceButton, {}))
    await start()
    act(() => root.unmount())
    expect(recorder.cancel).toHaveBeenCalled()
    await render(createElement('div'))
  })
})

const sticker: Sticker = {
  id: '1'.repeat(64),
  key: '2'.repeat(64),
  salt: '3'.repeat(32),
  size: 10,
  chunks: 1,
  mime: 'image/webp',
  width: 512,
  height: 512,
}
const pack: StickerPack = { id: 'p1', name: 'Cats', stickers: [sticker], createdAt: 0 }

describe('the emoji and sticker picker', () => {
  let importStickerPack: ReturnType<typeof vi.fn>
  let deleteStickerPack: ReturnType<typeof vi.fn>
  let openSticker: ReturnType<typeof vi.fn>
  let sendSticker: ReturnType<typeof vi.fn>

  beforeEach(() => {
    importStickerPack = vi.fn(async () => undefined)
    deleteStickerPack = vi.fn(async () => undefined)
    openSticker = vi.fn(async () => 'blob:sticker')
    sendSticker = vi.fn(async () => undefined)
    useApp.setState({ packs: [], importStickerPack, deleteStickerPack, openSticker, sendSticker } as never)
    vi.mocked(prepareImage).mockReset()
  })

  const tab = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === label)!
  const headings = () => [...host.querySelectorAll('.picker-heading')].map((h) => h.textContent)

  it('puts a chosen emoji into the message, from the button beside it', async () => {
    const onInsertEmoji = vi.fn()
    await render(createElement(EmojiButton, { onInsertEmoji }))
    const toggle = button('Emoji and stickers')
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await vi.waitFor(() => expect(document.querySelector('.picker-emoji')).not.toBeNull())
    await click(document.querySelector('.picker-emoji')!)
    expect(onInsertEmoji).toHaveBeenCalledWith('😀')
    expect(document.querySelector('.popover')).toBeNull()
    await click(toggle)
    await click(toggle)
    expect(document.querySelector('.popover')).toBeNull()
    await click(toggle)
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.popover')).toBeNull()
  })

  it('sends a sticker straight away', async () => {
    useApp.setState({ packs: [pack] } as never)
    await render(createElement(EmojiButton, { onInsertEmoji: () => undefined }))
    await click(button('Emoji and stickers'))
    await vi.waitFor(() => expect(tab('Stickers')).toBeDefined())
    await click(tab('Stickers'))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('.picker-sticker')!.disabled).toBe(false),
    )
    await click(document.querySelector('.picker-sticker')!)
    expect(sendSticker).toHaveBeenCalledWith(sticker)
    expect(document.querySelector('.popover')).toBeNull()
  })

  it('names its groups and tabs, in English and in Persian', async () => {
    await render(createElement(EmojiPicker, { mode: 'reaction', onPickEmoji: () => undefined }))
    expect(document.querySelector('[role=tab]')).toBeNull()
    expect(headings()[0]).toBe('Smileys & Emotion')
    expect(headings()).toHaveLength(8)
    act(() => root.unmount())

    await render(createElement(EmojiPicker, { mode: 'compose', onPickEmoji: () => undefined }), 'fa')
    expect(headings()[0]).toBe('شکلک‌ها و احساسات')
    expect(tab('ایموجی').getAttribute('aria-selected')).toBe('true')
    await click(tab('استیکر'))
    expect(host.textContent).toContain('هنوز بسته استیکری ندارید')
    expect(host.textContent).toContain('افزودن بسته')
    await click(tab('ایموجی'))
    expect(host.querySelector('.picker-panel')?.getAttribute('aria-labelledby')).toBe('picker-tab-emoji')
  })

  describe('making a pack', () => {
    const pick = async (files: File[] | null) => {
      const input = host.querySelector<HTMLInputElement>('input[type=file]')!
      await act(async () => {
        Object.defineProperty(input, 'files', { value: files, configurable: true })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    const png = (name: string) => new File([new Uint8Array(4)], name, { type: 'image/png' })

    beforeEach(async () => {
      await render(createElement(EmojiPicker, { mode: 'compose', onPickEmoji: () => undefined }))
      await click(tab('Stickers'))
      expect(host.textContent).toContain('No sticker packs yet.')
    })

    it('makes each picture a sticker at a sticker’s size, and names the pack by the first', async () => {
      let finish: () => void = () => undefined
      importStickerPack.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
      vi.mocked(prepareImage)
        .mockResolvedValueOnce({
          bytes: new Uint8Array(1),
          mime: 'image/webp',
          width: 512,
          height: 512,
          preview: 'x',
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ bytes: new Uint8Array(2), mime: 'image/png', width: 300, height: 200 })
      const files = [png('Cats.png'), png('broken.png'), png('two.png')]
      await pick(files)
      await vi.waitFor(() => expect(host.textContent).toContain('Adding…'))
      expect(host.querySelector<HTMLInputElement>('input[type=file]')!.disabled).toBe(true)
      expect(vi.mocked(prepareImage).mock.calls.map(([file, options]) => [file, options])).toEqual([
        [files[0], { edge: STICKER_EDGE }],
        [files[1], { edge: STICKER_EDGE }],
        [files[2], { edge: STICKER_EDGE }],
      ])
      await act(async () => finish())
      expect(importStickerPack).toHaveBeenCalledWith('Cats', [
        { bytes: new Uint8Array(1), mime: 'image/webp', width: 512, height: 512 },
        { bytes: new Uint8Array(2), mime: 'image/png', width: 300, height: 200 },
      ])
      expect(toast).toHaveBeenCalledWith('Added 2 sticker(s)')
      expect(host.textContent).toContain('Add a pack')
    })

    it('says so when nothing picked is a picture, or the pack cannot be kept', async () => {
      vi.mocked(prepareImage).mockResolvedValue(null)
      await pick([png('a.png')])
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith('Those files could not be read as pictures.', 'danger'),
      )
      expect(importStickerPack).not.toHaveBeenCalled()

      vi.mocked(prepareImage).mockResolvedValue({
        bytes: new Uint8Array(1),
        mime: 'image/png',
        width: 1,
        height: 1,
      })
      importStickerPack.mockRejectedValueOnce(new Error('quota'))
      await pick([png('a.png')])
      await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2))
    })

    it('finishes a pack whose picker has closed meanwhile', async () => {
      let finish: () => void = () => undefined
      importStickerPack.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
      vi.mocked(prepareImage).mockResolvedValue({
        bytes: new Uint8Array(1),
        mime: 'image/png',
        width: 1,
        height: 1,
      })
      await pick([png('Dogs.jpeg')])
      await vi.waitFor(() => expect(importStickerPack).toHaveBeenCalledWith('Dogs', expect.any(Array)))
      act(() => root.unmount())
      await act(async () => finish())
      expect(toast).toHaveBeenCalledWith('Added 1 sticker(s)')
      await render(createElement('div'))
    })

    it('does nothing when the picker closes with nothing picked', async () => {
      await pick(null)
      await pick([])
      expect(prepareImage).not.toHaveBeenCalled()
    })
  })

  it('lists each pack, removes one, and waits for a sticker before it can be sent', async () => {
    let show: (url: string) => void = () => undefined
    openSticker.mockReturnValue(new Promise((resolve) => (show = resolve)))
    useApp.setState({ packs: [pack] } as never)
    await render(createElement(EmojiPicker, { mode: 'compose', onPickEmoji: () => undefined }))
    await click(tab('Stickers'))
    expect(headings()[0]).toBe('CatsRemove')
    expect(host.querySelector<HTMLButtonElement>('.picker-sticker')!.disabled).toBe(true)
    expect(host.querySelector('.picker-sticker-loading')).not.toBeNull()
    await act(async () => show('blob:cat'))
    expect(host.querySelector('.picker-sticker img')?.getAttribute('src')).toBe('blob:cat')
    // Pressing one where nothing sends it does nothing.
    await click(host.querySelector('.picker-sticker')!)
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!)
    expect(deleteStickerPack).toHaveBeenCalledWith('p1')

    // A sticker still loading when the picker closes is let go.
    let late: (url: string) => void = () => undefined
    openSticker.mockReturnValue(new Promise((resolve) => (late = resolve)))
    act(() => root.unmount())
    await render(createElement(EmojiPicker, { mode: 'compose', onPickEmoji: () => undefined }))
    await click(tab('Stickers'))
    act(() => root.unmount())
    await act(async () => late('blob:late'))
    await render(createElement('div'))
  })
})
