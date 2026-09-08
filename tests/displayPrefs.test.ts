import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDisplayPrefs, loadDisplayPrefs, saveDisplayPrefs } from '@/app/displayPrefs'

/** Minimal localStorage stand-in; Node has none. */
function installStorage(impl?: Partial<Storage>) {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    ...impl,
  } as Storage
  vi.stubGlobal('localStorage', storage)
  return store
}

describe('pre-unlock display preferences', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips language and theme', () => {
    installStorage()
    saveDisplayPrefs({ locale: 'fa', theme: 'light' })
    expect(loadDisplayPrefs()).toEqual({ locale: 'fa', theme: 'light' })
  })

  it('stores nothing beyond language and theme', () => {
    const store = installStorage()
    saveDisplayPrefs({ locale: 'fa', theme: 'dark' })
    // The whole point is that this cache is outside the vault, so it must never
    // grow to hold anything identifying.
    expect(JSON.parse(store.get('textor:display') as string)).toEqual({ locale: 'fa', theme: 'dark' })
  })

  it('ignores corrupted or hostile values', () => {
    const store = installStorage()
    for (const raw of ['not json', 'null', '[]', '{"locale":"xx","theme":"neon"}', '{"locale":123}']) {
      store.set('textor:display', raw)
      expect(loadDisplayPrefs()).toEqual({})
    }
  })

  it('keeps whichever half is valid', () => {
    const store = installStorage()
    store.set('textor:display', '{"locale":"fa","theme":"bogus"}')
    expect(loadDisplayPrefs()).toEqual({ locale: 'fa' })
  })

  it('survives storage being blocked entirely', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      removeItem: () => {
        throw new Error('storage disabled')
      },
    })
    expect(loadDisplayPrefs()).toEqual({})
    expect(() => saveDisplayPrefs({ locale: 'en', theme: 'dark' })).not.toThrow()
    expect(() => clearDisplayPrefs()).not.toThrow()
  })

  it('returns empty when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadDisplayPrefs()).toEqual({})
  })
})
