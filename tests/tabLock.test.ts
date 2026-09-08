import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimEngine } from '@/app/tabLock'

/** The parts of Web Locks a claim uses, over one lock, as the specification has them. */
class FakeLocks {
  holder: { release: () => void; reject: (err: Error) => void } | null = null
  queue: { run: () => void }[] = []

  async request(
    _name: string,
    opts: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<void> {
    if (opts.ifAvailable && this.holder) {
      await callback(null)
      return
    }
    if (opts.steal && this.holder) {
      const stolen = this.holder
      this.holder = null
      stolen.reject(Object.assign(new Error('stolen'), { name: 'AbortError' }))
    }
    if (this.holder) {
      await new Promise<void>((run, reject) => {
        const entry = { run }
        this.queue.push(entry)
        opts.signal?.addEventListener('abort', () => {
          this.queue = this.queue.filter((queued) => queued !== entry)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }
    await new Promise<void>((resolve, reject) => {
      this.holder = {
        release: () => {
          this.holder = null
          this.queue.shift()?.run()
          resolve()
        },
        reject,
      }
      void Promise.resolve(callback({})).then(() => this.holder?.release())
    })
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const asLocks = (locks: FakeLocks) => locks as unknown as LockManager

describe('one engine per browser', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('goes straight ahead where nothing else holds it, and lets go when asked', async () => {
    const locks = new FakeLocks()
    const onWaiting = vi.fn()
    const claim = claimEngine({ locks: asLocks(locks), onWaiting, onTaken: () => undefined })
    expect(await claim.held).toBe(true)
    expect(onWaiting).not.toHaveBeenCalled()
    expect(locks.holder).not.toBeNull()
    claim.release()
    await tick()
    expect(locks.holder).toBeNull()
  })

  it('waits while another tab holds it, and takes over when that one lets go', async () => {
    const locks = new FakeLocks()
    const first = claimEngine({ locks: asLocks(locks), onWaiting: () => undefined, onTaken: () => undefined })
    await first.held
    const onWaiting = vi.fn()
    const second = claimEngine({ locks: asLocks(locks), onWaiting, onTaken: () => undefined })
    let held: boolean | null = null
    void second.held.then((value) => (held = value))
    await tick()
    expect(onWaiting).toHaveBeenCalledOnce()
    expect(held).toBeNull()

    first.release()
    await tick()
    await tick()
    expect(held).toBe(true)
    second.release()
  })

  it('stops waiting when given up on, without taking anything', async () => {
    const locks = new FakeLocks()
    const first = claimEngine({ locks: asLocks(locks), onWaiting: () => undefined, onTaken: () => undefined })
    await first.held
    const onTaken = vi.fn()
    const second = claimEngine({ locks: asLocks(locks), onWaiting: () => undefined, onTaken })
    await tick()
    second.release()
    expect(await second.held).toBe(false)
    expect(onTaken).not.toHaveBeenCalled()
    first.release()
  })

  it('takes it from another tab when told to, and that tab hears', async () => {
    const locks = new FakeLocks()
    const onTaken = vi.fn()
    const first = claimEngine({ locks: asLocks(locks), onWaiting: () => undefined, onTaken })
    await first.held
    const second = claimEngine({
      steal: true,
      locks: asLocks(locks),
      onWaiting: () => undefined,
      onTaken: () => undefined,
    })
    expect(await second.held).toBe(true)
    await tick()
    expect(onTaken).toHaveBeenCalledOnce()
    second.release()
  })

  it('goes on unguarded in a browser without Web Locks', async () => {
    const claim = claimEngine({ locks: undefined, onWaiting: () => undefined, onTaken: () => undefined })
    expect(await claim.held).toBe(true)
    claim.release()
  })

  it('uses the browser’s own locks when none are given', async () => {
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    const claim = claimEngine({ onWaiting: () => undefined, onTaken: () => undefined })
    expect(await claim.held).toBe(true)
    expect(locks.holder).not.toBeNull()
    claim.release()
  })
})
