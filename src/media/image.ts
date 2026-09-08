import { MAX_PREVIEW_CHARS, MAX_RELAY_BYTES } from '../core/models/attachment'

/**
 * Client-side image preparation, for a picture sent as a photo (ADR-083).
 *
 * Two jobs, both of which exist because of the relay path. A phone photo is
 * 4-8 MB, which no relay carries, so it is re-encoded as sharp as fits in what
 * a relay does carry. And a tiny preview, a handful of pixels inlined into the
 * message itself, lets the recipient see *something* before the rest arrives.
 *
 * All of it runs in the browser on a canvas. Nothing is uploaded anywhere, and
 * the canvas keeps pixels only: location, camera serial and timestamp do not
 * travel with a photo. A picture sent as a file is sent as it is, and carries
 * whatever it carries.
 */

/** Longest edge of a photo as sent: Telegram's, for one sent in high quality. */
export const MAX_IMAGE_EDGE = 2560

/**
 * Tried in order until one fits the budget: quality is given up before
 * pixels, and pixels only a step at a time. The last is a phone screen's
 * worth, which fits whatever the picture.
 */
const STEPS: readonly (readonly [edge: number, quality: number])[] = [
  [MAX_IMAGE_EDGE, 0.9],
  [MAX_IMAGE_EDGE, 0.8],
  [2048, 0.8],
  [1600, 0.8],
  [1280, 0.75],
]

/** The inline preview is deliberately tiny — it is paid for on every relay. */
const PREVIEW_EDGE = 24
const PREVIEW_QUALITY = 0.5

export interface PreparedImage {
  bytes: Uint8Array
  mime: string
  width: number
  height: number
  /** data: URI, small enough to ship inside the message. */
  preview?: string
}

/** Fit within a square bound without distorting or upscaling. */
export function scaleToFit(width: number, height: number, edge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const longest = Math.max(width, height)
  // Never upscale: enlarging a small image costs bytes and adds nothing.
  if (longest <= edge) return { width, height }
  const scale = edge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** WebP where it exists, JPEG otherwise. Both are universally decodable. */
function pickImageType(): 'image/webp' | 'image/jpeg' {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    return canvas.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'
  } catch {
    return 'image/jpeg'
  }
}

function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas is unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
  return canvas
}

interface Drawn {
  width: number
  canvas: HTMLCanvasElement
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))

/** A sticker's longest edge: Telegram's, and plenty for one drawn in a bubble. */
export const STICKER_EDGE = 512

/**
 * Re-encode a picture for sending as a photo, as sharp as `budget` allows, and
 * no larger than `edge`.
 *
 * Null when the browser cannot decode it or the canvas fails: such a picture is
 * still worth sending, as a file.
 */
export async function prepareImage(
  file: Blob,
  { edge: limit = MAX_IMAGE_EDGE, budget = MAX_RELAY_BYTES } = {},
): Promise<PreparedImage | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const preview = await makePreview(bitmap)
    const done = async (blob: Blob, mime: string, width: number, height: number): Promise<PreparedImage> => ({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime,
      width,
      height,
      ...(preview ? { preview } : {}),
    })

    // A canvas keeps a GIF's first frame only; sent as it is, it still moves.
    // The format has nowhere standard for a camera to write where it was.
    if (file.type === 'image/gif' && file.size <= budget)
      return done(file, file.type, bitmap.width, bitmap.height)

    // Lossless first for a PNG: a screenshot keeps its sharp text and its
    // transparency, which JPEG would fill with black.
    const lossy = pickImageType()
    const steps: [type: string, edge: number, quality: number][] = STEPS.map(([edge, quality]) => [
      lossy,
      Math.min(edge, limit),
      quality,
    ])
    if (file.type === 'image/png') steps.unshift(['image/png', limit, 1])

    const encode = async (index: number, drawn?: Drawn): Promise<PreparedImage | null> => {
      const [type, edge, quality] = steps[index] as (typeof steps)[number]
      const size = scaleToFit(bitmap.width, bitmap.height, edge)
      // Drawn once per size: a picture smaller than an edge is the same at it.
      const canvas = drawn?.width === size.width ? drawn.canvas : draw(bitmap, size.width, size.height)
      const encoded = await toBlob(canvas, type, quality)
      if (!encoded) return null
      // The last step is sent whatever it weighs, and the transport decides.
      if (encoded.size > budget && index + 1 < steps.length) {
        return encode(index + 1, { width: size.width, canvas })
      }
      // What came out, not what was asked: a browser that cannot write WebP
      // writes PNG instead, and says so.
      return done(encoded, encoded.type || type, size.width, size.height)
    }
    return await encode(0)
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * A handful of pixels, stretched and blurred by the bubble.
 *
 * Returns undefined rather than an oversized string if the encoder produces
 * something too big for the cap: the preview is a nicety, and a message that
 * fails to send because of one would not be.
 */
export async function makePreview(bitmap: ImageBitmap): Promise<string | undefined> {
  try {
    const size = scaleToFit(bitmap.width, bitmap.height, PREVIEW_EDGE)
    const blob = await toBlob(draw(bitmap, size.width, size.height), 'image/jpeg', PREVIEW_QUALITY)
    if (!blob) return undefined
    const uri = await blobToDataUri(blob)
    return uri.length <= MAX_PREVIEW_CHARS ? uri : undefined
  } catch {
    return undefined
  }
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('could not read blob'))
    reader.readAsDataURL(blob)
  })
}

/** Poster frame and dimensions for a video, so its bubble is not a grey box. */
export async function prepareVideoPoster(
  file: Blob,
): Promise<{ width: number; height: number; durationMs: number; preview?: string } | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('video could not be decoded'))
      video.src = url
    })
    // A frame slightly in is far more representative than frame zero, which is
    // often black.
    video.currentTime = Math.min(0.5, (video.duration || 1) / 4)
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve()
      // Some browsers never fire onseeked for very short clips.
      setTimeout(resolve, 400)
    })

    const size = scaleToFit(video.videoWidth, video.videoHeight, PREVIEW_EDGE)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    canvas.getContext('2d')?.drawImage(video, 0, 0, size.width, size.height)
    const blob = await toBlob(canvas, 'image/jpeg', PREVIEW_QUALITY)
    const preview = blob ? await blobToDataUri(blob) : undefined

    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
      ...(preview && preview.length <= MAX_PREVIEW_CHARS ? { preview } : {}),
    }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
    video.src = ''
  }
}

/** How a file picked as a photo or a video is shown: anything else is a file. */
export function kindForFile(file: Blob): 'image' | 'video' | 'file' {
  const type = file.type.toLowerCase()
  // SVG is excluded on purpose: it is a document that can carry script, and
  // rendering one from a peer inside the app would be a real vector.
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image'
  if (type.startsWith('video/')) return 'video'
  return 'file'
}
