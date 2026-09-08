import { MAX_PREVIEW_CHARS } from '../core/models/attachment'

/**
 * Client-side image preparation.
 *
 * Two jobs, both of which exist because of the relay path. A modern phone photo
 * is 4-8 MB, which no relay will carry; re-encoding it at a sane size brings a
 * typical picture under 300 KB with no visible loss on a screen. And a tiny
 * preview — a handful of pixels, inlined into the message itself — is what lets
 * the recipient see *something* immediately instead of a grey box.
 *
 * All of it runs in the browser on a canvas. Nothing is uploaded anywhere, and
 * re-encoding has the useful side effect of dropping EXIF: location, camera
 * serial, and timestamp do not travel with the picture.
 */

/** Longest edge after downscaling. Comfortably past any phone screen. */
export const MAX_IMAGE_EDGE = 1600

/** Quality for the transferred image. Above this, size grows faster than fidelity. */
const IMAGE_QUALITY = 0.82

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

function draw(source: ImageBitmap, width: number, height: number): HTMLCanvasElement {
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

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))

/**
 * Re-encode a picture for sending.
 *
 * Falls back to the original bytes if anything about the canvas path fails —
 * an image the browser cannot decode is still a file worth sending, just as a
 * file rather than as a picture.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const type = pickImageType()
    const size = scaleToFit(bitmap.width, bitmap.height, MAX_IMAGE_EDGE)
    const encoded = await toBlob(draw(bitmap, size.width, size.height), type, IMAGE_QUALITY)
    if (!encoded) return null

    // Re-encoding is not always a win: a small, already-optimised PNG can grow.
    // Keep whichever is smaller, and keep the original's type when it wins.
    const useOriginal = file.size > 0 && file.size <= encoded.size && bitmap.width <= MAX_IMAGE_EDGE
    const chosen = useOriginal ? file : encoded

    return {
      bytes: new Uint8Array(await chosen.arrayBuffer()),
      mime: (useOriginal ? file.type : type) || type,
      width: useOriginal ? bitmap.width : size.width,
      height: useOriginal ? bitmap.height : size.height,
      preview: await makePreview(bitmap),
    }
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

/** Which attachment kind a file should be sent as. */
export function kindForFile(file: File | Blob): 'image' | 'video' | 'voice' | 'file' {
  const type = file.type.toLowerCase()
  // SVG is excluded on purpose: it is a document that can carry script, and
  // rendering one from a peer inside the app would be a real vector.
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image'
  if (type.startsWith('video/')) return 'video'
  // An attached audio file gets the player, not a download link. It has no
  // waveform, which the player already handles.
  if (type.startsWith('audio/')) return 'voice'
  return 'file'
}

/** Playback length of an audio file, for its bubble. Zero if undeterminable. */
export async function audioDuration(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file)
  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  try {
    const ms = await new Promise<number>((resolve) => {
      audio.onloadedmetadata = () =>
        resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0)
      audio.onerror = () => resolve(0)
      // Media produced by MediaRecorder often has no duration in its header, so
      // this legitimately never fires for some files.
      setTimeout(() => resolve(0), 1500)
      audio.src = url
    })
    return ms
  } finally {
    URL.revokeObjectURL(url)
    audio.src = ''
  }
}
