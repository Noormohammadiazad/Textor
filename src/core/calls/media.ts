/**
 * Camera, microphone and screen capture, behind a seam the tests can replace.
 *
 * Everything here is reached only from the call chunk, so none of it costs a
 * byte until a call is placed or rings (ADR-046).
 */

export interface MediaBackend {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  /** Absent where the browser cannot share a screen — every mobile browser, today. */
  getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>
  enumerateDevices(): Promise<MediaDeviceInfo[]>
}

/** The browser's own devices, or null where there are none to ask for. */
export function browserMedia(): MediaBackend | null {
  const devices = (globalThis.navigator as Navigator | undefined)?.mediaDevices
  if (!devices || typeof devices.getUserMedia !== 'function') return null
  return {
    getUserMedia: (constraints) => devices.getUserMedia(constraints),
    getDisplayMedia:
      typeof devices.getDisplayMedia === 'function'
        ? (options) => devices.getDisplayMedia(options)
        : undefined,
    enumerateDevices: () => devices.enumerateDevices(),
  }
}

export type Facing = 'user' | 'environment'

/**
 * Voice processing on, always. Every one of these is the browser's default in
 * principle and not always in practice, and a call without echo cancellation
 * is a call where the other person hears themselves.
 */
export const MICROPHONE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/**
 * 720p at 30 frames is what a phone camera and an ordinary uplink both manage;
 * the browser scales down from there when the connection cannot carry it.
 */
export function camera(facing: Facing, exact = false): MediaTrackConstraints {
  return {
    facingMode: exact ? { exact: facing } : facing,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  }
}

/**
 * Why a device could not be opened, in the terms the person can act on.
 *
 *  - `denied`  — permission refused, now or earlier; only the browser can undo it.
 *  - `missing` — there is no such device.
 *  - `busy`    — another app has it (a camera already in a video meeting).
 *  - `failed`  — anything else.
 */
export type MediaFailure = 'denied' | 'missing' | 'busy' | 'failed'

export function classifyMediaError(err: unknown): MediaFailure {
  const name = (err as { name?: unknown } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'missing'
    case 'NotReadableError':
    case 'AbortError':
    case 'TrackStartError':
      return 'busy'
    default:
      return 'failed'
  }
}

/** Raised by the call manager so the reason survives the trip to the UI. */
export class MediaError extends Error {
  constructor(readonly failure: MediaFailure) {
    super(`media unavailable: ${failure}`)
    this.name = 'MediaError'
  }
}

/** Stop every track, so the camera light goes out the moment a call no longer needs it. */
export function stopTracks(tracks: readonly (MediaStreamTrack | null | undefined)[]): void {
  for (const track of tracks) {
    try {
      track?.stop()
    } catch {
      /* already stopped */
    }
  }
}
