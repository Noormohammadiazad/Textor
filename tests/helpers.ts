import { TextorDatabase, setDbForTesting } from '@/core/vault/db'
import { Vault } from '@/core/vault/vault'
import { VaultRepo } from '@/core/vault/repo'
import type { KdfParams } from '@/core/crypto/kdf'

/** Deliberately weak: tests exercise logic, not KDF cost. */
export const TEST_KDF: KdfParams = { algo: 'scrypt', N: 2 ** 12, r: 8, p: 1 }

let counter = 0

export interface TestVault {
  vault: Vault
  repo: VaultRepo
  db: TextorDatabase
  destroy: () => Promise<void>
}

export async function makeVault(passphrase = 'correct horse battery staple'): Promise<TestVault> {
  const db = new TextorDatabase(`textor-test-${counter++}-${Math.random().toString(36).slice(2)}`)
  setDbForTesting(db)
  const vault = new Vault(db)
  await vault.create(passphrase, { params: TEST_KDF })
  // Tests advance fake timers by hours; auto-lock is exercised deliberately in
  // vault.test.ts rather than being allowed to fire in the middle of unrelated
  // assertions.
  vault.configureAutoLock(0)
  const repo = new VaultRepo(vault)
  return {
    vault,
    repo,
    db,
    destroy: async () => {
      vault.lock()
      await db.delete()
      setDbForTesting(null)
    },
  }
}
