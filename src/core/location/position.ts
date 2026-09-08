import { MAX_ACCURACY_M, MAX_SPEED_MS, readFix, type GeoFix } from '../models/location'

/**
 * Where this device is, from the browser (ADR-064).
 *
 * The browser decides how to find out — satellites, or nearby networks looked
 * up with its maker's location service — and asks the person before it tells
 * the app anything. Textor cannot change either, and the threat model says so.
 */

export type PositionFailure = 'denied' | 'unavailable' | 'unsupported'

export class PositionError extends Error {
  constructor(readonly failure: PositionFailure) {
    super(`position ${failure}`)
    this.name = 'PositionError'
  }
}

export interface PositionSource {
  /**
   * Report positions as they change until the returned function is called:
   * `precise` asks for satellites, at a cost in battery; otherwise whatever is
   * cheapest, reused for up to a minute.
   */
  watch(
    precise: boolean,
    onFix: (fix: GeoFix) => void,
    onError: (failure: PositionFailure) => void,
  ): () => void
  /** One position, now. */
  current(precise: boolean): Promise<GeoFix>
}

const known = (value: number | null): number | undefined =>
  value !== null && Number.isFinite(value) ? value : undefined

/**
 * A browser's reading as a position, or `null`. A heading of NaN is the
 * browser saying the device is not moving, and a reading vaguer or faster than
 * anything a person carries is capped rather than thrown away.
 */
export function fixOf(
  coords: Pick<GeolocationCoordinates, 'latitude' | 'longitude' | 'accuracy' | 'heading' | 'speed'>,
): GeoFix | null {
  const acc = known(coords.accuracy)
  const spd = known(coords.speed)
  return readFix({
    lat: coords.latitude,
    lon: coords.longitude,
    acc: acc === undefined ? undefined : Math.min(acc, MAX_ACCURACY_M),
    hdg: known(coords.heading),
    spd: spd === undefined ? undefined : Math.min(spd, MAX_SPEED_MS),
  })
}

export function browserPositions(
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation,
): PositionSource {
  const failure = (error: GeolocationPositionError): PositionFailure =>
    error.code === 1 ? 'denied' : 'unavailable'
  return {
    watch(precise, onFix, onError) {
      if (!geolocation) {
        onError('unsupported')
        return () => undefined
      }
      const id = geolocation.watchPosition(
        (position) => {
          const fix = fixOf(position.coords)
          if (fix) onFix(fix)
        },
        (error) => onError(failure(error)),
        { enableHighAccuracy: precise, maximumAge: precise ? 5_000 : 60_000 },
      )
      return () => geolocation.clearWatch(id)
    },
    current(precise) {
      return new Promise((resolve, reject) => {
        if (!geolocation) {
          reject(new PositionError('unsupported'))
          return
        }
        geolocation.getCurrentPosition(
          (position) => {
            const fix = fixOf(position.coords)
            if (fix) resolve(fix)
            else reject(new PositionError('unavailable'))
          },
          (error) => reject(new PositionError(failure(error))),
          { enableHighAccuracy: precise, maximumAge: 10_000, timeout: 30_000 },
        )
      })
    },
  }
}
