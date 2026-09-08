import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAttachment } from '@/media/attach'
import { prepareImage, prepareVideoPoster } from '@/media/image'
import { translate, type TranslateFn } from '@/i18n'
import type * as Image from '@/media/image'

/**
 * What a picked file is sent as, by the item it was picked from (ADR-083):
 * "Photo or Video" draws a picture or a video in the conversation, re-encoded
 * or as it is; "File" sends exactly the bytes picked, whatever they are, as a
 * card to save. The words each carries are for clients that do not read the
 * attachment tag, never shown by Textor.
 */

vi.mock('@/media/image', async (original) => ({
  ...(await original<typeof Image>()),
  prepareImage: vi.fn(),
  prepareVideoPoster: vi.fn(),
}))

const en: TranslateFn = (key, values) => translate('en', key, values)
const fa: TranslateFn = (key, values) => translate('fa', key, values)

const bytes = (n: number) => new Uint8Array(n).fill(7)
const file = (type: string, name = 'IMG_20261113_101500.jpg', size = 64) =>
  new File([bytes(size)], name, { type })

beforeEach(() => {
  vi.mocked(prepareImage).mockReset()
  vi.mocked(prepareVideoPoster).mockReset()
})

describe('a photo or a video', () => {
  it('sends a photo re-encoded, without the name its camera gave it', async () => {
    vi.mocked(prepareImage).mockResolvedValue({
      bytes: bytes(10),
      mime: 'image/webp',
      width: 2560,
      height: 1920,
      preview: 'data:image/jpeg;base64,AA==',
    })
    const sent = await prepareAttachment(file('image/jpeg'), 'media', en)
    expect(sent).toEqual({
      bytes: bytes(10),
      kind: 'image',
      mime: 'image/webp',
      caption: 'Photo',
      width: 2560,
      height: 1920,
      preview: 'data:image/jpeg;base64,AA==',
    })
    expect(sent).not.toHaveProperty('name')
  })

  it('sends one with no preview without one', async () => {
    vi.mocked(prepareImage).mockResolvedValue({ bytes: bytes(10), mime: 'image/png', width: 10, height: 10 })
    expect(await prepareAttachment(file('image/png'), 'media', fa)).toEqual({
      bytes: bytes(10),
      kind: 'image',
      mime: 'image/png',
      caption: 'عکس',
      width: 10,
      height: 10,
    })
  })

  it('sends a video as it is, with its poster, size and length', async () => {
    vi.mocked(prepareVideoPoster).mockResolvedValue({
      width: 1920,
      height: 1080,
      durationMs: 4000,
      preview: 'data:image/jpeg;base64,AA==',
    })
    const sent = await prepareAttachment(file('video/mp4', 'VID_1.mp4', 300), 'media', en)
    expect(sent).toEqual({
      bytes: bytes(300),
      kind: 'video',
      mime: 'video/mp4',
      caption: 'Video',
      width: 1920,
      height: 1080,
      durationMs: 4000,
      preview: 'data:image/jpeg;base64,AA==',
    })

    vi.mocked(prepareVideoPoster).mockResolvedValue({ width: 2, height: 2, durationMs: 0 })
    expect(await prepareAttachment(file('video/webm'), 'media', fa)).not.toHaveProperty('preview')
  })

  it('sends one this browser cannot open as a file to save, under its own name', async () => {
    vi.mocked(prepareImage).mockResolvedValue(null)
    expect(await prepareAttachment(file('image/heic', 'IMG_1.HEIC'), 'media', en)).toEqual({
      bytes: bytes(64),
      kind: 'file',
      mime: 'image/heic',
      caption: 'File · IMG_1.HEIC',
      name: 'IMG_1.HEIC',
    })
    vi.mocked(prepareVideoPoster).mockResolvedValue(null)
    expect(await prepareAttachment(file('video/x-matroska', 'a.mkv'), 'media', en)).toMatchObject({
      kind: 'file',
      mime: 'video/x-matroska',
    })
  })

  it('sends anything else picked through it as a file, as a desktop picker allows', async () => {
    expect(await prepareAttachment(file('application/pdf', 'notes.pdf'), 'media', en)).toMatchObject({
      kind: 'file',
      name: 'notes.pdf',
    })
    expect(prepareImage).not.toHaveBeenCalled()
  })
})

describe('a file', () => {
  it('sends a picture exactly as picked, drawn nowhere', async () => {
    const sent = await prepareAttachment(file('image/jpeg'), 'file', en)
    expect(sent).toEqual({
      bytes: bytes(64),
      kind: 'file',
      mime: 'image/jpeg',
      caption: 'File · IMG_20261113_101500.jpg',
      name: 'IMG_20261113_101500.jpg',
    })
    expect(prepareImage).not.toHaveBeenCalled()
  })

  it('sends a video and anything else the same way, in Telegram’s Persian word', async () => {
    expect(await prepareAttachment(file('video/mp4', 'clip.mp4'), 'file', fa)).toMatchObject({
      kind: 'file',
      mime: 'video/mp4',
      caption: 'فایل · clip.mp4',
    })
    expect(prepareVideoPoster).not.toHaveBeenCalled()
  })

  it('names a file that came without a name or a type', async () => {
    expect(await prepareAttachment(file('', ''), 'file', en)).toEqual({
      bytes: bytes(64),
      kind: 'file',
      mime: 'application/octet-stream',
      caption: 'File · File',
      name: 'File',
    })
  })

  it('takes nothing from a name that could move it or hide it', async () => {
    const sent = await prepareAttachment(file('text/plain', '../.secret/report.txt'), 'file', en)
    expect(sent.name).toBe('_.secret_report.txt')
  })
})
