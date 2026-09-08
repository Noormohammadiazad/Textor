import { describe, expect, it } from 'vitest'
import {
  blindId,
  contactId,
  conversationId,
  deriveVaultKeys,
  generateDataKey,
  open,
  openJson,
  seal,
  sealJson,
  seenEventId,
} from '@/core/crypto/vaultCrypto'
import { randomBytes, utf8ToBytes, bytesToUtf8 } from '@/core/util/bytes'

describe('vault record sealing', () => {
  const key = randomBytes(32)

  it('round-trips bytes', () => {
    const plaintext = utf8ToBytes('the quick brown fox')
    const blob = seal(key, plaintext, 'textor/test/1')
    expect(bytesToUtf8(open(key, blob, 'textor/test/1'))).toBe('the quick brown fox')
  })

  it('round-trips JSON', () => {
    const value = { a: 1, b: ['x', 'y'], c: { nested: true } }
    const blob = sealJson(key, value, 'textor/test/2')
    expect(openJson(key, blob, 'textor/test/2')).toEqual(value)
  })

  it('produces a different ciphertext each time (random nonce)', () => {
    const a = seal(key, utf8ToBytes('same'), 'aad')
    const b = seal(key, utf8ToBytes('same'), 'aad')
    expect(a).not.toEqual(b)
  })

  it('rejects the wrong key', () => {
    const blob = seal(key, utf8ToBytes('secret'), 'aad')
    expect(() => open(randomBytes(32), blob, 'aad')).toThrow()
  })

  it('rejects a ciphertext moved to a different record address', () => {
    // This is the whole point of binding the AAD to table+primary key: an
    // attacker with write access to IndexedDB must not be able to graft one
    // contact's sealed metadata onto another contact's row.
    const blob = seal(key, utf8ToBytes('alice metadata'), 'textor/contacts/aaa')
    expect(() => open(key, blob, 'textor/contacts/bbb')).toThrow()
  })

  it('rejects a flipped bit anywhere in the blob', () => {
    const blob = seal(key, utf8ToBytes('tamper me'), 'aad')
    for (const index of [1, 5, 25, blob.length - 1]) {
      const tampered = new Uint8Array(blob)
      tampered[index] = (tampered[index] as number) ^ 0x01
      expect(() => open(key, tampered, 'aad')).toThrow()
    }
  })

  it('rejects an unknown blob version', () => {
    const blob = seal(key, utf8ToBytes('x'), 'aad')
    const bumped = new Uint8Array(blob)
    bumped[0] = 9
    expect(() => open(key, bumped, 'aad')).toThrow(/version/)
  })

  it('rejects a truncated blob', () => {
    const blob = seal(key, utf8ToBytes('x'), 'aad')
    expect(() => open(key, blob.subarray(0, 20), 'aad')).toThrow()
  })
})

describe('key hierarchy', () => {
  it('derives distinct, deterministic subkeys', () => {
    const dataKey = generateDataKey()
    const a = deriveVaultKeys(dataKey)
    const b = deriveVaultKeys(dataKey)

    expect(a.recordKey).toEqual(b.recordKey)
    expect(a.indexKey).toEqual(b.indexKey)
    expect(a.identityKey).toEqual(b.identityKey)

    expect(a.recordKey).not.toEqual(a.indexKey)
    expect(a.recordKey).not.toEqual(a.identityKey)
    expect(a.indexKey).not.toEqual(a.identityKey)
    expect(a.recordKey).not.toEqual(dataKey)
  })

  it('rejects a data key of the wrong length', () => {
    expect(() => deriveVaultKeys(randomBytes(16))).toThrow()
  })

  it('a record sealed with recordKey cannot be opened with identityKey', () => {
    const keys = deriveVaultKeys(generateDataKey())
    const blob = seal(keys.recordKey, utf8ToBytes('body'), 'aad')
    expect(() => open(keys.identityKey, blob, 'aad')).toThrow()
  })
})

describe('blinded index keys', () => {
  const indexKey = randomBytes(32)

  it('is deterministic under one vault key and different under another', () => {
    const pubkey = 'a'.repeat(64)
    expect(contactId(indexKey, pubkey)).toBe(contactId(indexKey, pubkey))
    expect(contactId(indexKey, pubkey)).not.toBe(contactId(randomBytes(32), pubkey))
  })

  it('does not contain the input it blinds', () => {
    const pubkey = 'deadbeef'.repeat(8)
    expect(contactId(indexKey, pubkey)).not.toContain('deadbeef')
  })

  it('gives both peers the same conversation id regardless of order', () => {
    const alice = '1'.repeat(64)
    const bob = '2'.repeat(64)
    expect(conversationId(indexKey, alice, bob)).toBe(conversationId(indexKey, bob, alice))
  })

  it('separates domains so a pubkey and a relay url cannot collide', () => {
    const value = 'collide'
    expect(blindId(indexKey, 'contact', value)).not.toBe(blindId(indexKey, 'relay', value))
    expect(seenEventId(indexKey, value)).not.toBe(blindId(indexKey, 'contact', value))
  })

  it('produces stable 32-character handles', () => {
    expect(contactId(indexKey, 'f'.repeat(64))).toMatch(/^[0-9a-f]{32}$/)
  })
})
