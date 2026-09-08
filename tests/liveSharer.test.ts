import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoFix } from '@/core/models/location'
import {
  LIVE_POLICY,
  LiveSharer,
  worthSending,
  type LiveShare,
  type SharerHost,
} from '@/core/location/sharer'
import {
  browserPositions,
  fixOf,
  PositionError,
  type PositionFailure,
  type PositionSource,
} from '@/core/location/position'
import { unproject } from '@/core/location/geo'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOME = { lat: 35.6892, lon: 51.389 }
/** `metres` north of home. */
const north = (metres: number, extra: Partial<GeoFix> = {}): GeoFix => ({
  ...unproject(HOME, 0, metres),
  ...extra,
})

describe('what is worth sending', () => {
  it('is the first position, always', () => {
    expect(worthSending(null, HOME, 0, 'fine')).toBe(true)
  })

  it('waits out the gap, closer while someone moves and looks', () => {
    expect(worthSending(HOME, north(500), 9 * SECOND, 'fine')).toBe(false)
    expect(worthSending(HOME, north(500), 10 * SECOND, 'fine')).toBe(true)
    expect(worthSending(HOME, north(500), 59 * SECOND, 'coarse')).toBe(false)
    expect(worthSending(HOME, north(500), MINUTE, 'coarse')).toBe(true)
  })

  it('is a move bigger than the position is vague', () => {
    expect(worthSending(HOME, north(15), MINUTE, 'fine')).toBe(false)
    expect(worthSending(HOME, north(25), MINUTE, 'fine')).toBe(true)
    expect(worthSending(HOME, north(40, { acc: 65 }), MINUTE, 'fine')).toBe(false)
  })

  it('is a vague position found properly', () => {
    expect(worthSending({ ...HOME, acc: 1000 }, { ...HOME, acc: 400 }, MINUTE, 'fine')).toBe(true)
    expect(worthSending({ ...HOME, acc: 1000 }, { ...HOME, acc: 600 }, MINUTE, 'fine')).toBe(false)
    expect(worthSending({ ...HOME, acc: 12 }, { ...HOME, acc: 5 }, MINUTE, 'fine')).toBe(false)
  })

  it('is a turn while moving, not while standing', () => {
    expect(worthSending({ ...HOME, hdg: 0 }, { ...HOME, hdg: 90, spd: 1.4 }, MINUTE, 'fine')).toBe(true)
    expect(worthSending({ ...HOME, hdg: 0 }, { ...HOME, hdg: 20, spd: 1.4 }, MINUTE, 'fine')).toBe(false)
    expect(worthSending({ ...HOME, hdg: 0 }, { ...HOME, hdg: 90, spd: 0.2 }, MINUTE, 'fine')).toBe(false)
    expect(worthSending({ ...HOME, hdg: 0 }, { ...HOME, hdg: 90 }, MINUTE, 'fine')).toBe(false)
    expect(worthSending(HOME, { ...HOME, hdg: 90, spd: 3 }, MINUTE, 'fine')).toBe(false)
  })

  it('is anything at all, every heartbeat', () => {
    expect(worthSending(HOME, HOME, LIVE_POLICY.heartbeatMs - 1, 'coarse')).toBe(false)
    expect(worthSending(HOME, HOME, LIVE_POLICY.heartbeatMs, 'coarse')).toBe(true)
  })
})

/** A location service that says whatever the test tells it to. */
class FakePositions implements PositionSource {
  watching: { precise: boolean; onFix: (fix: GeoFix) => void; onError: (f: PositionFailure) => void } | null =
    null
  watches: boolean[] = []
  watch(precise: boolean, onFix: (fix: GeoFix) => void, onError: (f: PositionFailure) => void) {
    this.watching = { precise, onFix, onError }
    this.watches.push(precise)
    return () => {
      this.watching = null
    }
  }
  current(): Promise<GeoFix> {
    return Promise.resolve(HOME)
  }
  fix(fix: GeoFix): void {
    this.watching?.onFix(fix)
  }
  fail(failure: PositionFailure): void {
    this.watching?.onError(failure)
  }
}

describe('sharing live', () => {
  let positions: FakePositions
  let moves: { id: string; fix: GeoFix | null }[]
  let stored: LiveShare[]
  let shown: LiveShare[]
  let failures: PositionFailure[]
  let visible: boolean
  let moveResult: boolean | Error
  let host: SharerHost

  const share = (id: string, until: number | null = null): LiveShare => ({
    id,
    address: 'p'.repeat(64),
    until,
  })
  const sent = (id = 'a') => moves.filter((move) => move.id === id)

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    positions = new FakePositions()
    moves = []
    stored = []
    shown = []
    failures = []
    visible = true
    moveResult = true
    host = {
      positions,
      move: async (id, fix) => {
        moves.push({ id, fix })
        if (moveResult instanceof Error) throw moveResult
        return moveResult
      },
      load: async () => stored,
      save: async (shares) => {
        stored = shares
      },
      visible: () => visible,
      changed: (shares) => {
        shown = shares
      },
      failed: (failure) => failures.push(failure),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('watches closely from the start, remembers the share, and sends moves', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a', Date.now() + 15 * MINUTE), HOME)
    expect(positions.watches).toEqual([true])
    expect(sharer.precision).toBe('fine')
    expect(stored.map((s) => s.id)).toEqual(['a'])
    expect(shown).toEqual(sharer.shares)

    // Too soon after the start, and too small a move: nothing.
    positions.fix(north(5))
    await vi.advanceTimersByTimeAsync(11 * SECOND)
    expect(sent()).toEqual([])

    positions.fix(north(60))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toEqual([{ id: 'a', fix: north(60) }])

    // A second move inside the gap waits for it, then goes by itself, on
    // the next tick after.
    positions.fix(north(200))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(LIVE_POLICY.gapMs.fine + LIVE_POLICY.tickMs)
    expect(sent().at(-1)?.fix).toEqual(north(200))
    sharer.pause()
  })

  it('watches coarsely once hidden, and closely again when looked at', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    visible = false
    sharer.retune()
    expect(sharer.precision).toBe('coarse')
    expect(positions.watches).toEqual([true, false])

    positions.fix(north(100))
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    // A minute between updates while nobody is looking.
    expect(sent()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    expect(sent()).toHaveLength(1)

    visible = true
    sharer.retune()
    expect(sharer.precision).toBe('fine')
    sharer.pause()
  })

  it('watches coarsely after standing still, and closely once moving again', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(MINUTE)
      positions.fix(north(3))
    }
    expect(sharer.precision).toBe('coarse')
    positions.fix(north(80))
    expect(sharer.precision).toBe('fine')
    sharer.pause()
  })

  it('sends the same position again every heartbeat, so late readers see a recent one', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    positions.fix(HOME)
    await vi.advanceTimersByTimeAsync(LIVE_POLICY.heartbeatMs - LIVE_POLICY.tickMs)
    expect(sent()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(LIVE_POLICY.tickMs)
    expect(sent()).toEqual([{ id: 'a', fix: HOME }])
    sharer.pause()
  })

  it('ends a share when its time is up, and stops watching when none is left', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a', Date.now() + 15 * MINUTE), HOME)
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(sent().at(-1)).toEqual({ id: 'a', fix: null })
    expect(stored).toEqual([])
    expect(shown).toEqual([])
    expect(positions.watching).toBeNull()
    expect(sharer.precision).toBeNull()
  })

  it('ends one share by hand and keeps the others going', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    await sharer.start(share('b'), HOME)
    await sharer.stop('a')
    expect(moves).toEqual([{ id: 'a', fix: null }])
    expect(sharer.shares.map((s) => s.id)).toEqual(['b'])
    expect(positions.watching).not.toBeNull()

    // Ending a share this device is not running still tells everyone.
    await sharer.stop('elsewhere')
    expect(moves.at(-1)).toEqual({ id: 'elsewhere', fix: null })
    sharer.pause()
  })

  it('forgets a share that ended somewhere else, without a word', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    await sharer.ended('a')
    await sharer.ended('never')
    expect(moves).toEqual([])
    expect(stored).toEqual([])
    expect(positions.watching).toBeNull()
  })

  it('drops a share the engine no longer has, and keeps one it merely could not reach', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    moveResult = new Error('the vault is locked')
    positions.fix(north(500))
    await vi.advanceTimersByTimeAsync(LIVE_POLICY.gapMs.fine)
    expect(sharer.shares).toHaveLength(1)

    moveResult = false
    positions.fix(north(1000))
    await vi.advanceTimersByTimeAsync(LIVE_POLICY.gapMs.fine)
    expect(sharer.shares).toEqual([])
    expect(stored).toEqual([])
  })

  it('pauses while locked and takes up again, ending what ran out meanwhile', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('short', Date.now() + 15 * MINUTE), HOME)
    await sharer.start(share('long', Date.now() + 8 * 60 * MINUTE), HOME)
    await sharer.start(share('open'), HOME)
    sharer.pause()
    expect(positions.watching).toBeNull()
    expect(stored).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(moves).toEqual([])
    moves = []

    const again = new LiveSharer(host)
    await again.resume()
    expect(moves).toEqual([{ id: 'short', fix: null }])
    expect(again.shares.map((s) => s.id)).toEqual(['long', 'open'])
    expect(stored.map((s) => s.id)).toEqual(['long', 'open'])
    // Each sends where the device is the moment it knows.
    positions.fix(north(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent('long')).toHaveLength(1)
    expect(sent('open')).toHaveLength(1)

    // Resuming twice does not take anything up twice.
    await again.resume()
    expect(again.shares).toHaveLength(2)
    again.pause()
  })

  it('ends every share when location is refused, and says so', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    await sharer.start(share('b'), HOME)
    positions.fail('denied')
    await vi.advanceTimersByTimeAsync(0)
    expect(moves).toEqual([
      { id: 'a', fix: null },
      { id: 'b', fix: null },
    ])
    expect(failures).toEqual(['denied'])
    expect(sharer.shares).toEqual([])
  })

  it('keeps sharing through a gap in positions, and says so once', async () => {
    const sharer = new LiveSharer(host)
    await sharer.start(share('a'), HOME)
    positions.fail('unavailable')
    positions.fail('unavailable')
    expect(failures).toEqual(['unavailable'])
    positions.fix(north(100))
    positions.fail('unavailable')
    expect(failures).toEqual(['unavailable', 'unavailable'])
    expect(sharer.shares).toHaveLength(1)
    sharer.pause()
  })

  it('logs rather than throws when the vault cannot remember or the end cannot be sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    host.save = () => Promise.reject(new Error('locked'))
    moveResult = new Error('offline')
    stored = [share('gone', Date.now() - 1)]
    const sharer = new LiveSharer(host)
    await sharer.resume()
    await sharer.start(share('a'), HOME)
    await sharer.stop('a')
    expect(sharer.shares).toEqual([])
    warn.mockRestore()
  })
})

describe('positions from the browser', () => {
  const coords = (patch: Partial<GeolocationCoordinates> = {}): GeolocationCoordinates =>
    ({
      latitude: 35.6892,
      longitude: 51.389,
      accuracy: 12.3,
      heading: null,
      speed: null,
      altitude: null,
      altitudeAccuracy: null,
      ...patch,
    }) as GeolocationCoordinates

  it('reads what the browser knows, and leaves out what it does not', () => {
    expect(fixOf(coords())).toEqual({ ...HOME, acc: 12 })
    expect(fixOf(coords({ heading: Number.NaN, speed: 0 }))).toEqual({ ...HOME, acc: 12, spd: 0 })
    expect(fixOf(coords({ heading: 271.4, speed: 13.37 }))).toEqual({ ...HOME, acc: 12, hdg: 271, spd: 13.4 })
    // Vaguer or faster than anything a person carries is capped, not lost.
    expect(fixOf(coords({ accuracy: 5e6, speed: 900 }))).toMatchObject({ acc: 100_000, spd: 350 })
    expect(fixOf(coords({ accuracy: Number.NaN }))).toEqual(HOME)
    expect(fixOf(coords({ latitude: 91 }))).toBeNull()
  })

  /** Just enough of `navigator.geolocation` to drive. */
  const fakeGeolocation = () => {
    const calls: {
      success: PositionCallback
      error?: PositionErrorCallback | null
      options?: PositionOptions
    }[] = []
    const cleared: number[] = []
    const geolocation = {
      watchPosition: (
        success: PositionCallback,
        error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => calls.push({ success, error, options }),
      clearWatch: (id: number) => cleared.push(id),
      getCurrentPosition: (
        success: PositionCallback,
        error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => {
        calls.push({ success, error, options })
      },
    } as unknown as Geolocation
    const position = (patch: Partial<GeolocationCoordinates> = {}) =>
      ({ coords: coords(patch), timestamp: Date.now() }) as GeolocationPosition
    const failure = (code: number) =>
      ({ code, message: '', PERMISSION_DENIED: 1 }) as GeolocationPositionError
    return { calls, cleared, geolocation, position, failure }
  }

  it('watches finely or coarsely, and stops when told', () => {
    const fake = fakeGeolocation()
    const source = browserPositions(fake.geolocation)
    const fixes: GeoFix[] = []
    const errors: PositionFailure[] = []
    const stop = source.watch(
      true,
      (fix) => fixes.push(fix),
      (f) => errors.push(f),
    )
    source.watch(
      false,
      () => undefined,
      () => undefined,
    )
    expect(fake.calls[0]?.options).toEqual({ enableHighAccuracy: true, maximumAge: 5_000 })
    expect(fake.calls[1]?.options).toEqual({ enableHighAccuracy: false, maximumAge: 60_000 })

    fake.calls[0]?.success(fake.position())
    fake.calls[0]?.success(fake.position({ latitude: 200 }))
    fake.calls[0]?.error?.(fake.failure(1))
    fake.calls[0]?.error?.(fake.failure(3))
    expect(fixes).toEqual([{ ...HOME, acc: 12 }])
    expect(errors).toEqual(['denied', 'unavailable'])
    stop()
    expect(fake.cleared).toEqual([1])
  })

  it('finds where it is once', async () => {
    const fake = fakeGeolocation()
    const source = browserPositions(fake.geolocation)
    const found = source.current(true)
    fake.calls[0]?.success(fake.position())
    await expect(found).resolves.toEqual({ ...HOME, acc: 12 })
    expect(fake.calls[0]?.options).toEqual({ enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 })

    const garbled = source.current(false)
    fake.calls[1]?.success(fake.position({ longitude: 999 }))
    await expect(garbled).rejects.toMatchObject({ failure: 'unavailable' })

    const refused = source.current(false)
    fake.calls[2]?.error?.(fake.failure(1))
    await expect(refused).rejects.toBeInstanceOf(PositionError)
    await expect(refused).rejects.toMatchObject({ failure: 'denied', name: 'PositionError' })
  })

  it('says plainly when there is no location service at all', async () => {
    const source = browserPositions(undefined)
    const errors: PositionFailure[] = []
    source.watch(
      true,
      () => undefined,
      (f) => errors.push(f),
    )()
    expect(errors).toEqual(['unsupported'])
    await expect(source.current(true)).rejects.toMatchObject({ failure: 'unsupported' })
    // By default it asks the browser, which in Node has none.
    await expect(browserPositions().current(true)).rejects.toMatchObject({ failure: 'unsupported' })
  })
})
