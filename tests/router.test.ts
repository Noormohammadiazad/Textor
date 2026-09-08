import { describe, expect, it } from 'vitest'
import { parseHash, routeToHash, type Route } from '@/app/router'

const HEX = 'a'.repeat(64)

describe('hash routing', () => {
  it('round-trips every route', () => {
    const routes: Route[] = [
      { name: 'chats' },
      { name: 'chat', peer: HEX },
      { name: 'contacts' },
      { name: 'contact', peer: HEX },
      { name: 'add-contact' },
      { name: 'invite', payload: 'AbCd_-123' },
      { name: 'verify', peer: HEX },
      { name: 'settings' },
      { name: 'settings-relays' },
      { name: 'settings-privacy' },
      { name: 'settings-security' },
      { name: 'settings-data' },
      { name: 'about' },
    ]
    for (const route of routes) {
      expect(parseHash(routeToHash(route))).toEqual(route)
    }
  })

  it('falls back to the chat list for anything unrecognised', () => {
    for (const hash of ['', '#', '#/', '#/nope', '#/settings/nonsense/deeper', '#//']) {
      expect(parseHash(hash).name).toMatch(/^(chats|settings)$/)
    }
  })

  it('rejects a peer that is not a 32-byte hex key', () => {
    // Without this a crafted link could push arbitrary text into a lookup key.
    expect(parseHash('#/c/not-a-key').name).toBe('chats')
    expect(parseHash('#/c/' + 'z'.repeat(64)).name).toBe('chats')
    expect(parseHash('#/verify/short').name).toBe('contacts')
    expect(parseHash('#/p/<script>').name).toBe('contacts')
  })

  it('keeps an invite payload intact', () => {
    const payload = 'AattCV9a27Gz9czQMVeFV24W4wFiV-vBjQQYLtNyFTr5apL1WgRTYXJh'
    const route = parseHash(`#/i/${payload}`)
    expect(route).toEqual({ name: 'invite', payload })
  })

  it('tolerates a leading slash-heavy hash', () => {
    expect(parseHash('#///contacts').name).toBe('contacts')
  })
})
