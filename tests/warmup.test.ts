import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserWarmupEnvironment, warmLazyChunks, type WarmupEnvironment } from '@/app/warmup'

/**
 * The warm-up is what keeps lazy screens available offline without putting
 * them back in the precache. What matters: it never runs before the page is
 * idle, it respects Save-Data, and one chunk failing does not stop the rest.
 */

/** Lets the promise chain between "called" and "scheduled" run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function manualSchedule(): WarmupEnvironment & { run: () => void; pending: boolean } {
  let task: (() => void) | null = null
  return {
    saveData: false,
    whenControlled: () => Promise.resolve(),
    schedule: (next) => {
      task = next
    },
    get pending() {
      return task !== null
    },
    run: () => task?.(),
  }
}

describe('warmLazyChunks', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('loads nothing until the page is idle, then every chunk', async () => {
    const env = manualSchedule()
    const loaded: string[] = []
    const loaders = ['a', 'b', 'c'].map((name) => async () => {
      loaded.push(name)
    })

    const done = warmLazyChunks(loaders, env)
    await flush()
    expect(env.pending).toBe(true)
    expect(loaded).toEqual([])

    env.run()
    expect(await done).toBe(3)
    expect(loaded).toEqual(['a', 'b', 'c'])
  })

  it('loads one chunk at a time rather than all at once', async () => {
    const env = manualSchedule()
    let active = 0
    let peak = 0
    const loaders = Array.from({ length: 4 }, () => async () => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
    })

    const done = warmLazyChunks(loaders, env)
    await flush()
    env.run()
    await done
    expect(peak).toBe(1)
  })

  it('carries on past a chunk that fails to load', async () => {
    const env = manualSchedule()
    const loaded: string[] = []
    const done = warmLazyChunks(
      [
        async () => {
          loaded.push('first')
        },
        () => Promise.reject(new Error('offline')),
        async () => {
          loaded.push('third')
        },
      ],
      env,
    )
    await flush()
    env.run()
    expect(await done).toBe(3)
    expect(loaded).toEqual(['first', 'third'])
  })

  it('does nothing at all when the browser asks to save data', async () => {
    const env = { ...manualSchedule(), saveData: true }
    const load = vi.fn(async () => undefined)
    expect(await warmLazyChunks([load], env)).toBe(0)
    expect(load).not.toHaveBeenCalled()
  })

  it('does not schedule anything when there is nothing to load', async () => {
    const env = manualSchedule()
    expect(await warmLazyChunks([], env)).toBe(0)
    expect(env.pending).toBe(false)
  })

  it('waits for the service worker to take the page before fetching anything', async () => {
    let takeControl: () => void = () => undefined
    // Overridden in place rather than spread: a spread would copy the
    // `pending` getter's value once and never see the task arrive.
    const env = manualSchedule()
    env.whenControlled = () =>
      new Promise<void>((resolve) => {
        takeControl = resolve
      })
    const load = vi.fn(async () => undefined)
    const done = warmLazyChunks([load], env)
    await flush()
    // Not even scheduled: an idle callback now would fetch around the worker.
    expect(env.pending).toBe(false)

    takeControl()
    await flush()
    expect(env.pending).toBe(true)
    env.run()
    expect(await done).toBe(1)
    expect(load).toHaveBeenCalledOnce()
  })
})

describe('browserWarmupEnvironment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('waits for an idle callback when the browser has one', () => {
    const idle = vi.fn()
    vi.stubGlobal('requestIdleCallback', idle)
    const task = vi.fn()
    browserWarmupEnvironment().schedule(task)
    expect(idle).toHaveBeenCalledWith(task, { timeout: 10_000 })
    expect(task).not.toHaveBeenCalled()
  })

  it('falls back to a delay where there is no idle callback', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const task = vi.fn()
    browserWarmupEnvironment().schedule(task)
    vi.advanceTimersByTime(2999)
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(task).toHaveBeenCalledOnce()
  })

  it('does not wait for a worker where none is registered', async () => {
    vi.stubGlobal('navigator', { serviceWorker: new EventTarget() })
    await expect(browserWarmupEnvironment().whenControlled()).resolves.toBeUndefined()
  })

  it('does not wait when the page is already controlled', async () => {
    vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), { controller: {} }) })
    await expect(browserWarmupEnvironment({ serviceWorker: true }).whenControlled()).resolves.toBeUndefined()
  })

  it('waits for the worker to claim the page', async () => {
    const container = Object.assign(new EventTarget(), { controller: null })
    vi.stubGlobal('navigator', { serviceWorker: container })
    let settled = false
    const waiting = browserWarmupEnvironment({ serviceWorker: true })
      .whenControlled()
      .then(() => {
        settled = true
      })
    await flush()
    expect(settled).toBe(false)
    container.dispatchEvent(new Event('controllerchange'))
    await waiting
    expect(settled).toBe(true)
  })

  it('gives up waiting for a worker that never takes control', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), { controller: null }) })
    let settled = false
    void browserWarmupEnvironment({ serviceWorker: true })
      .whenControlled()
      .then(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('reads Save-Data from the connection', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    expect(browserWarmupEnvironment().saveData).toBe(true)
    vi.stubGlobal('navigator', { connection: { saveData: false } })
    expect(browserWarmupEnvironment().saveData).toBe(false)
    vi.stubGlobal('navigator', {})
    expect(browserWarmupEnvironment().saveData).toBe(false)
  })
})

describe('what the warm-up fetches', () => {
  it('never includes calling, which loads only when a call is placed or rings', async () => {
    // The warm-up fetches every loader in LAZY_CHUNKS, so the call chunk must
    // not be one of them — and must not be reachable through one either.
    const { readFileSync } = await import('node:fs')
    const table = readFileSync(new URL('../src/ui/lazyViews.tsx', import.meta.url), 'utf8')
    expect(table).not.toMatch(/chunks\/calls|callsChunk/)
    const loader = readFileSync(new URL('../src/app/callsChunk.ts', import.meta.url), 'utf8')
    expect(loader).toContain("import('../ui/chunks/calls')")
  })
})
