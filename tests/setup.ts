import 'fake-indexeddb/auto'
import { sha256 } from '@noble/hashes/sha2.js'
import { vi } from 'vitest'
import type * as TextorId from '@/core/identity/textorId'
import { concatBytes, utf8ToBytes } from '@/core/util/bytes'

// The vault talks to WebCrypto for randomness and to structuredClone through
// Dexie; Node 20+ provides both natively, so nothing else needs shimming.

/*
 * A Textor ID takes scrypt, and every engine works one out as it starts, and one for
 * each contact. At the real cost, under coverage and alongside every other test file,
 * that alone doubled the time this suite takes, and tests that wait on a clock began
 * to fail. So everyone gets a stand-in, and `textorId.test.ts`, which pins the real
 * thing, opts out.
 */
vi.mock('@/core/identity/textorId', async (original) => {
  const actual = await original<typeof TextorId>()
  const stand: TextorId.Derive = async (password, salt) => sha256(concatBytes(utf8ToBytes(password), salt))
  return {
    ...actual,
    textorIdOf: (pubkey: string) => actual.textorIdOf(pubkey, stand),
    lookUpTextorId: (id: string, query: Parameters<typeof TextorId.lookUpTextorId>[1]) =>
      actual.lookUpTextorId(id, query, stand),
  }
})
