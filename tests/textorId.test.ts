import { afterEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  deriveTextorId,
  ID_BITS,
  ID_KDF,
  ID_LANES,
  idOf,
  idSaltOf,
  lookUpTextorId,
  parseTextorId,
  textorIdEvent,
  textorIdFrom,
  textorIdLink,
  type Derive,
} from '@/core/identity/textorId'
import { KIND_APP_DATA, RECORD_TTL_SEC } from '@/core/engine/profileRecord'
import { formatId } from '@/core/identity/keys'
import { deriveKek } from '@/core/crypto/kdf'
import { bytesToHex, concatBytes, utf8ToBytes } from '@/core/util/bytes'

/**
 * The Textor ID (ADR-079). Most of this runs on a fast stand-in for scrypt, since what
 * is being tested is what is done with its output; the vectors pin the real thing.
 */

// The real thing, not the stand-in every other file gets from `setup.ts`.
vi.unmock('@/core/identity/textorId')

const fast: Derive = async (password, salt) => sha256(concatBytes(utf8ToBytes(password), salt))
/** For the few that run the real thing, which is slow by design, and more so under coverage. */
const REAL_SCRYPT_MS = 180_000

const keyOf = (...bytes: number[]): Uint8Array => {
  const key = new Uint8Array(32).fill(0)
  key.set(bytes)
  return key
}
const giving =
  (key: Uint8Array): Derive =>
  async () =>
    key

const person = () => {
  const secretKey = generateSecretKey()
  return { secretKey, pubkey: getPublicKey(secretKey) }
}

/** Spelled out here, so a change to any of these is caught. */
const saltOf = (secretKey: Uint8Array): string =>
  bytesToHex(hkdf(sha256, secretKey, undefined, utf8ToBytes('textor/id/v1/salt'), 16))

const laneSalts = (label: string): Uint8Array[] =>
  [0, 1].map((lane) => sha256(utf8ToBytes(`${label}\0${lane}`)))

async function placeOf(id: string, derive: Derive = fast): Promise<{ d: string; sealKey: Uint8Array }> {
  const [one, two] = laneSalts('textor/id/v1/address') as [Uint8Array, Uint8Array]
  const key = sha256(concatBytes(await derive(id, one), await derive(id, two)))
  const drawn = hkdf(sha256, key, undefined, utf8ToBytes('textor/id/v1/record'), 48)
  return { d: bytesToHex(drawn.subarray(0, 16)), sealKey: drawn.slice(16, 48) }
}

const signed = (secretKey: Uint8Array, id: string, k: string, w: unknown, r: unknown, t: unknown): string =>
  bytesToHex(
    schnorr.sign(sha256(utf8ToBytes(JSON.stringify(['textor/id/v1/signature', id, k, w, r, t]))), secretKey),
  )

/** A relay that holds whatever it is given and answers `#d`. */
const relayOf = (events: NostrEvent[]) => async (filter: Filter) =>
  events.filter((event) =>
    event.tags.some((tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] as string)),
  )

const NOW = 1_800_000_000

describe('reading an ID', () => {
  it('takes it however it arrives', () => {
    for (const raw of [
      '7X9K2M4QHD',
      '7x9k2m4qhd',
      '7X9K2-M4QHD',
      '7x9k2 m4qhd',
      '  7X9K2.M4QHD\n',
      '7X9K2\u2010M4QHD',
      '\u200e7X9K2-M4QHD\u200f',
      '\u20667X9K2-M4QHD\u2069',
      'https://textor.ir/#/id/7X9K2M4QHD',
      '#/id/7x9k2-m4qhd',
    ]) {
      expect(parseTextorId(raw)).toBe('7X9K2M4QHD')
    }
  })

  it('forgives the characters the alphabet left out, and reads Persian digits', () => {
    expect(parseTextorId('O0I1L1abcd')).toBe('001111ABCD')
    expect(parseTextorId('\u06f1\u06f2\u06f3\u06f4\u0665\u0666\u0667\u0668\u0669\u0660')).toBe('1234567890')
  })

  it('refuses what cannot be one', () => {
    for (const bad of [
      '',
      'ABC',
      '7X9K2M4QH',
      '7X9K2M4QHDD',
      '7X9K2M4QHU',
      '7X9K2M4QH!',
      'abcdefghijk',
      '#/id/abc',
    ]) {
      expect(parseTextorId(bad)).toBeNull()
    }
  })

  it('is written in two groups of five, and reads back the same', () => {
    expect(formatId('7X9K2M4QHD')).toBe('7X9K2-M4QHD')
    expect(parseTextorId(formatId('7X9K2M4QHD'))).toBe('7X9K2M4QHD')
  })
})

describe('the number', () => {
  // Pinned in PROTOCOL §4.9, for anyone writing another client.
  const vector = new Uint8Array(32).fill(1)

  it(
    'uses these settings, and these exact values',
    async () => {
      expect(ID_KDF).toEqual({ algo: 'scrypt', N: 32_768, r: 8, p: 1 })
      expect(ID_BITS).toBe(50)
      expect(ID_LANES).toBe(2)
      expect(getPublicKey(vector)).toBe('1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f')
      expect(saltOf(vector)).toBe('64edf4353e796219de4976c24e289628')
      expect(await deriveTextorId(vector)).toBe('NT0VBCW75F')
    },
    REAL_SCRYPT_MS,
  )

  it('is the same for one secret key, on any device, and differs for any other', async () => {
    const { secretKey } = person()
    const id = await deriveTextorId(secretKey, fast)
    expect(await deriveTextorId(secretKey.slice(), fast)).toBe(id)
    expect(await deriveTextorId(generateSecretKey(), fast)).not.toBe(id)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/)
  })

  it('cannot be worked out from a public key alone, so no relay can test a key for using Textor', async () => {
    const { secretKey, pubkey } = person()
    const asked: string[] = []
    await deriveTextorId(secretKey, async (password, salt) => {
      asked.push(password)
      return fast(password, salt)
    })
    expect(asked).toEqual(Array(ID_LANES).fill(`${pubkey}:${saltOf(secretKey)}`))
    expect(saltOf(secretKey)).toHaveLength(32)
  })

  it('takes every lane, each with its own salt, and needs all of them', async () => {
    const salts: string[] = []
    const { secretKey } = person()
    const whole = await deriveTextorId(secretKey, async (password, salt) => {
      salts.push(bytesToHex(salt))
      return fast(password, salt)
    })
    expect(salts).toEqual(laneSalts('textor/id/v1/claim').map(bytesToHex))
    expect(new Set(salts).size).toBe(2)
    // An attacker who stops after one lane has learned nothing about the answer.
    const firstOnly = await deriveTextorId(secretKey, async (password, salt) =>
      bytesToHex(salt) === salts[0] ? fast(password, salt) : new Uint8Array(32),
    )
    const secondOnly = await deriveTextorId(secretKey, async (password, salt) =>
      bytesToHex(salt) === salts[1] ? fast(password, salt) : new Uint8Array(32),
    )
    expect(firstOnly).not.toBe(whole)
    expect(secondOnly).not.toBe(whole)
    expect(firstOnly).not.toBe(secondOnly)
  })

  it('is what a contact works out from the key and the salt it is told, and no other salt gives it', async () => {
    const { secretKey, pubkey } = person()
    const id = await deriveTextorId(secretKey, fast)
    expect(idSaltOf(secretKey)).toBe(saltOf(secretKey))
    expect(await textorIdFrom(pubkey, idSaltOf(secretKey), fast)).toBe(id)
    expect(await textorIdFrom(pubkey, '0'.repeat(32), fast)).not.toBe(id)
    expect(await textorIdFrom(person().pubkey, idSaltOf(secretKey), fast)).not.toBe(id)
  })

  it('reads exactly the first 50 bits, leading zeros and all', () => {
    expect(idOf(keyOf())).toBe('0000000000')
    // Bit 49 is the last that counts, and bit 50 the first that does not.
    expect(idOf(keyOf(0, 0, 0, 0, 0, 0, 0b0100_0000))).toBe('0000000001')
    expect(idOf(keyOf(0, 0, 0, 0, 0, 0, 0b0010_0000))).toBe('0000000000')
    expect(idOf(keyOf(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe('ZZZZZZZZZZ')
    expect(idOf(keyOf(0x80))).toBe('G000000000')
    // Across the join between the two words it reads: 2^18 and 2^17 from the end of the first and the top of the second.
    expect(idOf(keyOf(0, 0, 0, 1))).toBe('0000008000')
    expect(idOf(keyOf(0, 0, 0, 0, 0x80))).toBe('0000004000')
    const inside = new Uint8Array(40)
    inside.set([0, 0, 0, 0, 0, 0, 0b1000_0000], 8)
    expect(idOf(inside.subarray(8))).toBe('0000000002')
  })

  it('agrees with reading the same bits as one long number', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    for (let round = 0; round < 200; round++) {
      const key = sha256(utf8ToBytes(`round ${round}`))
      let value = BigInt(`0x${bytesToHex(key)}`) >> BigInt(256 - 50)
      let id = ''
      for (let place = 0; place < 10; place++) {
        id = (alphabet[Number(value % BigInt(32))] as string) + id
        value /= BigInt(32)
      }
      expect(idOf(key)).toBe(id)
    }
  })
})

describe('where it runs', () => {
  afterEach(() => vi.unstubAllGlobals())

  class FakeWorker {
    static made: FakeWorker[] = []
    listeners: Record<string, ((event: unknown) => void)[]> = {}
    posted: unknown[] = []
    terminated = false
    constructor() {
      FakeWorker.made.push(this)
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      ;(this.listeners[type] ??= []).push(listener)
    }
    postMessage(message: unknown) {
      this.posted.push(message)
    }
    terminate() {
      this.terminated = true
    }
    emit(type: string, event: unknown = {}) {
      for (const listener of this.listeners[type] ?? []) listener(event)
    }
  }
  const start = () => {
    FakeWorker.made = []
    vi.stubGlobal('Worker', FakeWorker)
    const { secretKey, pubkey } = person()
    const answer = deriveTextorId(secretKey)
    return { answer, workers: FakeWorker.made, pubkey, salt: saltOf(secretKey) }
  }

  it('asks a worker of its own for each lane, takes the answers past any progress, and ends them', async () => {
    const { answer, workers, pubkey, salt } = start()
    expect(workers).toHaveLength(2)
    const salts = laneSalts('textor/id/v1/claim')
    workers.forEach((worker, lane) => {
      expect(worker.posted).toEqual([
        { id: 1, passphrase: `${pubkey}:${salt}`, salt: salts[lane], params: ID_KDF },
      ])
      worker.emit('message', { data: { id: 1, type: 'progress', fraction: 0.5 } })
      expect(worker.terminated).toBe(false)
    })
    workers.forEach((worker, lane) =>
      worker.emit('message', { data: { id: 1, type: 'done', key: keyOf(lane) } }),
    )
    await expect(answer).resolves.toBe(idOf(sha256(concatBytes(keyOf(0), keyOf(1)))))
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  })

  it('passes on what goes wrong in a worker, and still ends it', async () => {
    const { answer, workers } = start()
    ;(workers[0] as FakeWorker).emit('message', { data: { id: 1, type: 'error', message: 'too much' } })
    await expect(answer).rejects.toThrow('too much')
    expect((workers[0] as FakeWorker).terminated).toBe(true)
  })

  it(
    'works it out here, with the same answer, if a worker will not load or cannot be made',
    async () => {
      const { secretKey } = person()
      const password = `${getPublicKey(secretKey)}:${saltOf(secretKey)}`
      const lanes = await Promise.all(
        laneSalts('textor/id/v1/claim').map((salt) => deriveKek(password, salt, ID_KDF)),
      )
      const want = idOf(sha256(concatBytes(...lanes)))

      FakeWorker.made = []
      vi.stubGlobal('Worker', FakeWorker)
      const failing = deriveTextorId(secretKey)
      for (const worker of FakeWorker.made) worker.emit('error')
      await expect(failing).resolves.toBe(want)

      vi.stubGlobal('Worker', undefined)
      await expect(deriveTextorId(secretKey)).resolves.toBe(want)
    },
    REAL_SCRYPT_MS,
  )
})

describe('the record', () => {
  const idOf = (secretKey: Uint8Array) => deriveTextorId(secretKey, fast)

  it('shows a relay an opaque event from a key seen nowhere else', async () => {
    const { secretKey, pubkey } = person()
    const id = await idOf(secretKey)
    const event = await textorIdEvent(secretKey, id, ['wss://a.example'], NOW, fast)
    const { d } = await placeOf(id)
    expect(event.kind).toBe(KIND_APP_DATA)
    expect(event.created_at).toBe(NOW)
    expect(event.tags).toEqual([
      ['d', d],
      ['expiration', String(NOW + RECORD_TTL_SEC)],
    ])
    expect(event.pubkey).not.toBe(pubkey)
    const seen = JSON.stringify(event)
    expect(seen).not.toContain(pubkey)
    expect(seen).not.toContain(id)
    expect(seen).not.toContain('wss://a.example')
    expect(seen).not.toContain(saltOf(secretKey))
  })

  it('is signed by the same key on every device of one identity, and no other', async () => {
    const { secretKey } = person()
    const id = await idOf(secretKey)
    const signer = (await textorIdEvent(secretKey, id, [], NOW, fast)).pubkey
    expect((await textorIdEvent(secretKey, id, [], NOW + 1, fast)).pubkey).toBe(signer)
    expect((await textorIdEvent(generateSecretKey(), id, [], NOW, fast)).pubkey).not.toBe(signer)
  })

  it('needs nothing from the key after the first moment, when the vault may have locked', async () => {
    const { secretKey, pubkey } = person()
    const copy = secretKey.slice()
    const id = await idOf(secretKey)
    const wiping: Derive = async (password, salt) => {
      secretKey.fill(0)
      return fast(password, salt)
    }
    const event = await textorIdEvent(secretKey, id, ['wss://a.example'], NOW, wiping)
    expect(event.pubkey).toBe((await textorIdEvent(copy, id, [], NOW, fast)).pubkey)
    const { owners } = await lookUpTextorId(id, relayOf([event]), fast)
    expect(owners.map((owner) => owner.pubkey)).toEqual([pubkey])

    const again = generateSecretKey()
    const whole = again.slice()
    const answer = deriveTextorId(again, wiping)
    again.fill(0)
    await expect(answer).resolves.toBe(await deriveTextorId(whole, fast))
  })

  it('is found by anyone given the ID, on the relays its owner named', async () => {
    const { secretKey, pubkey } = person()
    const id = await idOf(secretKey)
    const event = await textorIdEvent(
      secretKey,
      id,
      ['wss://A.example/', 'ftp://nope.example', 'wss://b.example'],
      NOW,
      fast,
    )
    const query = vi.fn(relayOf([event]))
    const { owners, crowded } = await lookUpTextorId(id, query, fast)
    expect(owners).toEqual([{ pubkey, relays: ['wss://a.example', 'wss://b.example'] }])
    expect(crowded).toBe(false)
    // By the record's address alone: the point is not yet knowing who wrote it.
    const { d } = await placeOf(id)
    expect(query).toHaveBeenCalledWith({ kinds: [KIND_APP_DATA], '#d': [d], limit: 64 })
  })

  it('costs two runs of two lanes each to find one, and no more', async () => {
    const { secretKey } = person()
    const id = await idOf(secretKey)
    const event = await textorIdEvent(secretKey, id, [], NOW, fast)
    const derive = vi.fn(fast)
    await lookUpTextorId(id, relayOf([event]), derive)
    expect(derive).toHaveBeenCalledTimes(4)
  })

  it('finds nobody when nothing is there, or under another ID', async () => {
    const { secretKey } = person()
    const id = await idOf(secretKey)
    const event = await textorIdEvent(secretKey, id, [], NOW, fast)
    expect(await lookUpTextorId(id, relayOf([]), fast)).toEqual({ owners: [], crowded: false })
    const wrong = id === 'ZZZZZZZZZZ' ? 'YYYYYYYYYY' : 'ZZZZZZZZZZ'
    expect((await lookUpTextorId(wrong, relayOf([event]), fast)).owners).toEqual([])
  })

  it('takes the newest of what one key has written', async () => {
    const { secretKey, pubkey } = person()
    const id = await idOf(secretKey)
    const events = [
      await textorIdEvent(secretKey, id, ['wss://old.example'], NOW, fast),
      await textorIdEvent(secretKey, id, ['wss://new.example'], NOW + 10, fast),
      await textorIdEvent(secretKey, id, ['wss://older.example'], NOW - 10, fast),
    ]
    const { owners } = await lookUpTextorId(id, relayOf(events), fast)
    expect(owners).toEqual([{ pubkey, relays: ['wss://new.example'] }])
  })

  describe('against someone trying to pass as the owner', () => {
    const sealed = (d: string, content: string) =>
      finalizeEvent({ kind: KIND_APP_DATA, created_at: NOW, tags: [['d', d]], content }, generateSecretKey())

    it('refuses a record from another key: the number is not theirs', async () => {
      const owner = person()
      const attacker = person()
      const id = await idOf(owner.secretKey)
      const forged = await textorIdEvent(attacker.secretKey, id, [], NOW + 100, fast)
      const genuine = await textorIdEvent(owner.secretKey, id, [], NOW, fast)
      const { owners } = await lookUpTextorId(id, relayOf([forged, genuine]), fast)
      expect(owners.map((found) => found.pubkey)).toEqual([owner.pubkey])
    })

    it("refuses the owner's key and salt signed by anyone else", async () => {
      const owner = person()
      const attacker = person()
      const id = await idOf(owner.secretKey)
      const { d, sealKey } = await placeOf(id)
      const w = saltOf(owner.secretKey)
      const body = {
        k: owner.pubkey,
        w,
        r: ['wss://attacker.example'],
        t: NOW,
        s: signed(attacker.secretKey, id, owner.pubkey, w, ['wss://attacker.example'], NOW),
      }
      const event = sealed(d, nip44.encrypt(JSON.stringify(body), sealKey))
      expect((await lookUpTextorId(id, relayOf([event]), fast)).owners).toEqual([])
    })

    it("refuses the owner's own record with its relays changed, so nobody can be sent elsewhere", async () => {
      const owner = person()
      const id = await idOf(owner.secretKey)
      const { d, sealKey } = await placeOf(id)
      const genuine = await textorIdEvent(owner.secretKey, id, ['wss://mine.example'], NOW, fast)
      const body = JSON.parse(nip44.decrypt(genuine.content, sealKey)) as { r: string[] }
      body.r = ['wss://attacker.example']
      const changed = sealed(d, nip44.encrypt(JSON.stringify(body), sealKey))
      expect((await lookUpTextorId(id, relayOf([changed]), fast)).owners).toEqual([])
    })

    it('does not move a record to an ID it was not made for', async () => {
      const owner = person()
      const id = await idOf(owner.secretKey)
      const other = id === 'ZZZZZZZZZZ' ? 'YYYYYYYYYY' : 'ZZZZZZZZZZ'
      const genuine = await textorIdEvent(owner.secretKey, id, [], NOW, fast)
      const from = await placeOf(id)
      const to = await placeOf(other)
      const moved = sealed(to.d, nip44.encrypt(nip44.decrypt(genuine.content, from.sealKey), to.sealKey))
      expect((await lookUpTextorId(other, relayOf([moved]), fast)).owners).toEqual([])
    })

    it('shows everyone an ID really gives, rather than choose among them', async () => {
      // As if someone had put in the 2^50 runs, or the same number had come up twice by chance.
      const both = giving(keyOf())
      const one = person()
      const two = person()
      const id = await deriveTextorId(one.secretKey, both)
      expect(await deriveTextorId(two.secretKey, both)).toBe(id)
      const events = [
        await textorIdEvent(one.secretKey, id, [], NOW, both),
        await textorIdEvent(two.secretKey, id, [], NOW + 1, both),
      ]
      const { owners } = await lookUpTextorId(id, relayOf(events), both)
      expect(owners.map((owner) => owner.pubkey)).toEqual([two.pubkey, one.pubkey])
    })

    it('spends only so much on records someone has flooded an ID with, and says so', async () => {
      const id = await idOf(generateSecretKey())
      const events = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          textorIdEvent(generateSecretKey(), id, [], NOW + index, fast),
        ),
      )
      const derive = vi.fn(fast)
      const { owners, crowded } = await lookUpTextorId(id, relayOf(events), derive)
      expect(owners).toEqual([])
      expect(crowded).toBe(true)
      // One run to find the record and four to check, of two lanes each.
      expect(derive).toHaveBeenCalledTimes(10)
    })

    it('does not count four as a flood', async () => {
      const id = await idOf(generateSecretKey())
      const events = await Promise.all(
        Array.from({ length: 4 }, () => textorIdEvent(generateSecretKey(), id, [], NOW, fast)),
      )
      expect((await lookUpTextorId(id, relayOf(events), fast)).crowded).toBe(false)
    })

    it('throws out anything malformed before spending scrypt on it', async () => {
      const owner = person()
      const id = await idOf(owner.secretKey)
      const { sealKey, d } = await placeOf(id)
      const w = saltOf(owner.secretKey)
      const body = (over: object) =>
        sealed(
          d,
          nip44.encrypt(
            JSON.stringify({
              k: owner.pubkey,
              w,
              r: [],
              t: NOW,
              s: signed(owner.secretKey, id, owner.pubkey, w, [], NOW),
              ...over,
            }),
            sealKey,
          ),
        )
      const many = Array(7).fill('wss://a.example')
      const events = [
        sealed(d, ''),
        sealed(d, 'not sealed'),
        sealed(d, nip44.encrypt('not json', sealKey)),
        sealed(d, nip44.encrypt('null', sealKey)),
        body({ k: 'nope' }),
        body({ w: 'nope', s: signed(owner.secretKey, id, owner.pubkey, 'nope', [], NOW) }),
        body({ w: 5 }),
        body({ s: 'nope' }),
        body({ s: 5 }),
        body({ r: 'nope' }),
        body({ r: many, s: signed(owner.secretKey, id, owner.pubkey, w, many, NOW) }),
        body({ t: 0, s: signed(owner.secretKey, id, owner.pubkey, w, [], 0) }),
        body({ t: 'x', s: signed(owner.secretKey, id, owner.pubkey, w, [], 'x') }),
        body({ s: '0'.repeat(128) }),
      ]
      const derive = vi.fn(fast)
      expect(await lookUpTextorId(id, relayOf(events), derive)).toEqual({ owners: [], crowded: false })
      expect(derive).toHaveBeenCalledTimes(2)
      expect((await lookUpTextorId(id, relayOf([body({})]), fast)).owners).toHaveLength(1)
    })
  })

  it(
    'works from end to end on the real thing',
    async () => {
      const { secretKey, pubkey } = person()
      const id = await deriveTextorId(secretKey)
      const event = await textorIdEvent(secretKey, id, ['wss://a.example'], NOW)
      const { owners } = await lookUpTextorId(id, relayOf([event]))
      expect(owners).toEqual([{ pubkey, relays: ['wss://a.example'] }])
    },
    REAL_SCRYPT_MS,
  )
})

describe('a link to an ID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the app on it, and comes back as the same ID', () => {
    const link = textorIdLink('7X9K2M4QHD', 'https://textor.ir/?a=1#/settings')
    expect(link).toBe('https://textor.ir/#/id/7X9K2M4QHD')
    expect(parseTextorId(link)).toBe('7X9K2M4QHD')
  })

  it('goes by where the app is, if it has to', () => {
    expect(textorIdLink('7X9K2M4QHD')).toBe('/#/id/7X9K2M4QHD')
    vi.stubGlobal('location', { origin: 'https://example.org', pathname: '/Textor/' })
    expect(textorIdLink('7X9K2M4QHD')).toBe('https://example.org/Textor/#/id/7X9K2M4QHD')
  })
})
