// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  kindForFile,
  makePreview,
  MAX_IMAGE_EDGE,
  prepareImage,
  prepareVideoPoster,
  STICKER_EDGE,
} from '@/media/image'
import { MAX_PREVIEW_CHARS, MAX_RELAY_BYTES } from '@/core/models/attachment'

/**
 * A photo goes as sharp as the relays carry (ADR-083): the largest size and
 * quality that fits, a step at a time, and never with what the camera wrote
 * into it — the canvas keeps pixels only. happy-dom draws nothing, so the
 * canvas here is a stand-in that records what it was asked for and answers
 * with a blob of the size a test chooses.
 */

interface Encode {
  type: string
  quality: number
  width: number
  height: number
}

let encodes: Encode[]
let drawn: number
let weigh: (encode: Encode) => number
let typeOf: (encode: Encode) => string
let webp: boolean | 'throws'
let context: object | null
let previewBlob: 'small' | 'huge' | 'none'
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }

const isPreview = (encode: Encode) => encode.width <= 24 && encode.height <= 24

const realCreate = document.createElement.bind(document)

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => {
      drawn++
      return context
    },
    toDataURL(type: string) {
      if (webp === 'throws') throw new Error('tainted')
      return webp ? `data:${type};base64,AA==` : 'data:image/png;base64,AA=='
    },
    toBlob(done: (blob: Blob | null) => void, type: string, quality: number) {
      const encode = { type, quality, width: this.width, height: this.height }
      if (isPreview(encode)) {
        if (previewBlob === 'none') return done(null)
        const size = previewBlob === 'huge' ? MAX_PREVIEW_CHARS : 8
        return done(new Blob([new Uint8Array(size)], { type: 'image/jpeg' }))
      }
      encodes.push(encode)
      const size = weigh(encode)
      done(size < 0 ? null : new Blob([new Uint8Array(size)], { type: typeOf(encode) }))
    },
  }
}

const file = (type: string, size = 1000, name = 'picked') => new File([new Uint8Array(size)], name, { type })

beforeEach(() => {
  encodes = []
  drawn = 0
  webp = true
  context = { drawImage: vi.fn() }
  previewBlob = 'small'
  weigh = () => 1000
  typeOf = (encode) => encode.type
  bitmap = { width: 4000, height: 3000, close: vi.fn() }
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? fakeCanvas() : realCreate(tag)) as typeof document.createElement)
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a photo, as sharp as the relays carry', () => {
  it('goes at Telegram’s high-quality size when that fits', async () => {
    const photo = await prepareImage(file('image/jpeg'))
    expect(photo).toMatchObject({ mime: 'image/webp', width: MAX_IMAGE_EDGE, height: 1920 })
    expect(encodes).toEqual([{ type: 'image/webp', quality: 0.9, width: 2560, height: 1920 }])
    expect(photo!.preview).toMatch(/^data:image\/jpeg;base64,/)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('gives up quality before pixels, and pixels a step at a time, until it fits', async () => {
    // Only a picture at 1600 pixels or fewer comes in under the budget.
    weigh = (encode) => (encode.width > 1600 ? MAX_RELAY_BYTES + 1 : MAX_RELAY_BYTES)
    const photo = await prepareImage(file('image/jpeg'))
    expect(encodes.map(({ width, quality }) => [width, quality])).toEqual([
      [2560, 0.9],
      [2560, 0.8],
      [2048, 0.8],
      [1600, 0.8],
    ])
    expect(photo).toMatchObject({ width: 1600, height: 1200 })
    expect(photo!.bytes.length).toBe(MAX_RELAY_BYTES)
    // Drawn once for each size, not once for each try: the two at 2560 share
    // a canvas. The preview has one of its own.
    expect(drawn).toBe(1 + 3)
  })

  it('sends the last step whatever it weighs, and leaves the transport to refuse it', async () => {
    weigh = () => MAX_RELAY_BYTES * 2
    const photo = await prepareImage(file('image/jpeg'))
    expect(encodes).toHaveLength(5)
    expect(photo).toMatchObject({ width: 1280, height: 960 })
    expect(photo!.bytes.length).toBe(MAX_RELAY_BYTES * 2)
  })

  it('does not enlarge a small picture, and draws it once', async () => {
    bitmap = { width: 800, height: 600, close: vi.fn() }
    weigh = (encode) => (encode.quality > 0.8 ? MAX_RELAY_BYTES + 1 : 10)
    const photo = await prepareImage(file('image/jpeg'))
    expect(photo).toMatchObject({ width: 800, height: 600 })
    expect(encodes.every((encode) => encode.width === 800)).toBe(true)
    expect(drawn).toBe(1 + 1)
  })

  it('keeps a screenshot lossless, and its transparency, while that fits', async () => {
    bitmap = { width: 1170, height: 2532, close: vi.fn() }
    const photo = await prepareImage(file('image/png'))
    expect(encodes).toEqual([{ type: 'image/png', quality: 1, width: 1170, height: 2532 }])
    expect(photo).toMatchObject({ mime: 'image/png', width: 1170, height: 2532 })
  })

  it('falls back to a lossy picture when a lossless one is too heavy', async () => {
    bitmap = { width: 1170, height: 2532, close: vi.fn() }
    weigh = (encode) => (encode.type === 'image/png' ? MAX_RELAY_BYTES + 1 : 5000)
    const photo = await prepareImage(file('image/png'))
    expect(encodes.map((encode) => encode.type)).toEqual(['image/png', 'image/webp'])
    expect(photo!.mime).toBe('image/webp')
  })

  it('sends a GIF as it is, so it still moves, unless it is too heavy for that', async () => {
    const gif = file('image/gif', 2048)
    const photo = await prepareImage(gif)
    expect(encodes).toEqual([])
    expect(photo).toMatchObject({ mime: 'image/gif', width: 4000, height: 3000 })
    expect(photo!.bytes.length).toBe(2048)

    const heavy = await prepareImage(file('image/gif', MAX_RELAY_BYTES + 1))
    expect(heavy!.mime).toBe('image/webp')
  })

  it('writes JPEG where the browser cannot write WebP, and says what came out', async () => {
    webp = false
    expect((await prepareImage(file('image/jpeg')))!.mime).toBe('image/jpeg')
    webp = 'throws'
    expect((await prepareImage(file('image/jpeg')))!.mime).toBe('image/jpeg')
    // A blob with no type is taken to be what was asked for.
    typeOf = () => ''
    expect((await prepareImage(file('image/jpeg')))!.mime).toBe('image/jpeg')
    // One that says otherwise is believed.
    webp = true
    typeOf = () => 'image/png'
    expect((await prepareImage(file('image/jpeg')))!.mime).toBe('image/png')
  })

  it('is no larger than a sticker when asked for one', async () => {
    const sticker = await prepareImage(file('image/jpeg'), { edge: STICKER_EDGE })
    expect(sticker).toMatchObject({ width: 512, height: 384 })
  })

  it('goes without a preview the encoder made too large, or none at all', async () => {
    previewBlob = 'huge'
    expect(await prepareImage(file('image/jpeg'))).not.toHaveProperty('preview')
    previewBlob = 'none'
    expect(await prepareImage(file('image/jpeg'))).not.toHaveProperty('preview')
  })

  it('is nothing the browser cannot decode or draw, to be sent as a file instead', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('HEIC')
      }),
    )
    expect(await prepareImage(file('image/heic'))).toBeNull()

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    )
    weigh = () => -1
    expect(await prepareImage(file('image/jpeg'))).toBeNull()

    context = null
    expect(await prepareImage(file('image/jpeg'))).toBeNull()
    expect(bitmap.close).toHaveBeenCalledTimes(2)
  })

  it('makes no preview when the picture cannot be read back', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        onerror: (() => void) | null = null
        readAsDataURL() {
          queueMicrotask(() => this.onerror?.())
        }
      },
    )
    expect(await makePreview(bitmap as never)).toBeUndefined()
  })
})

describe('a video’s poster', () => {
  let behaviour: 'loads' | 'fails' | 'never seeks'
  let duration: number

  beforeEach(() => {
    behaviour = 'loads'
    duration = 12.4
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') return fakeCanvas()
      if (tag !== 'video') return realCreate(tag)
      let at = 0
      const video = {
        muted: false,
        playsInline: false,
        preload: '',
        videoWidth: 1920,
        videoHeight: 1080,
        duration,
        onloadeddata: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onseeked: null as (() => void) | null,
        set src(url: string) {
          if (url) queueMicrotask(() => (behaviour === 'fails' ? video.onerror?.() : video.onloadeddata?.()))
        },
        get currentTime() {
          return at
        },
        set currentTime(value: number) {
          at = value
          if (behaviour !== 'never seeks') queueMicrotask(() => video.onseeked?.())
        },
      }
      return video
    }) as typeof document.createElement)
  })

  it('is a frame a little way in, at the video’s own size and length', async () => {
    const poster = await prepareVideoPoster(file('video/mp4'))
    expect(poster).toEqual({
      width: 1920,
      height: 1080,
      durationMs: 12400,
      preview: expect.stringMatching(/^data:image\/jpeg;base64,/),
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip')
  })

  it('waits only so long for a short clip that never says it has seeked', async () => {
    behaviour = 'never seeks'
    duration = Number.NaN
    const poster = await prepareVideoPoster(file('video/webm'))
    expect(poster).toMatchObject({ durationMs: 0 })
  })

  it('goes without a preview it could not make small enough, or at all', async () => {
    previewBlob = 'huge'
    expect(await prepareVideoPoster(file('video/mp4'))).not.toHaveProperty('preview')
    previewBlob = 'none'
    expect(await prepareVideoPoster(file('video/mp4'))).not.toHaveProperty('preview')
  })

  it('is nothing for a video this browser cannot open', async () => {
    behaviour = 'fails'
    expect(await prepareVideoPoster(file('video/x-matroska'))).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})

describe('what a picked file is shown as', () => {
  it('is a photo or a video by its type, and anything else a file', () => {
    expect(kindForFile(file('image/jpeg'))).toBe('image')
    expect(kindForFile(file('IMAGE/PNG'))).toBe('image')
    expect(kindForFile(file('video/mp4'))).toBe('video')
    // A picture that can carry script is never drawn.
    expect(kindForFile(file('image/svg+xml'))).toBe('file')
    // A song picked as a photo or video is a file to save.
    expect(kindForFile(file('audio/mpeg'))).toBe('file')
    expect(kindForFile(file(''))).toBe('file')
  })
})
