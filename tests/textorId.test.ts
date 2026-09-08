import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Event as NostrEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  ID_BITS,
  ID_KDF,
  ID_LANES,
  ID_LENGTH,
  idOf,
  isTextorId,
  lookUpTextorId,
  readTextorId,
  textorIdEvent,
  textorIdLink,
  textorIdOf,
  type Derive,
} from '@/core/identity/textorId'
import { KIND_APP_DATA, RECORD_TTL_SEC } from '@/core/engine/profileRecord'
import { formatId } from '@/core/identity/keys'
import { deriveKek } from '@/core/crypto/kdf'
import { verifyEventSignature } from '@/core/crypto/eventSignature'
import { bytesToHex, concatBytes, utf8ToBytes } from '@/core/util/bytes'

/**
 * The Textor ID (ADR-081). Most of this runs on a fast stand-in for scrypt, since what
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

const laneSalts = (label: string): Uint8Array[] =>
  [0, 1].map((lane) => sha256(utf8ToBytes(`${label}\0${lane}`)))

// Spelled out here by other means than the module's, so that neither the check nor
// the cut at 75 bits is taken on its own word.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** GF(32) by long multiplication, reduced by x^5 + x^2 + 1: no tables. */
const gfTimes = (a: number, b: number): number => {
  let product = 0
  for (let bit = 0; bit < 5; bit++) if ((b >> bit) & 1) product ^= a << bit
  for (let bit = 9; bit >= 5; bit--) if ((product >> bit) & 1) product ^= 0b100101 << (bit - 5)
  return product
}
const powerOfX = (exponent: number): number => {
  let value = 1
  for (let step = 0; step < exponent; step++) value = gfTimes(value, 2)
  return value
}
const withCheck = (fifteen: string): string => {
  let check = 0
  ;[...fifteen].forEach((symbol, place) => {
    check ^= gfTimes(powerOfX(place + 1), ALPHABET.indexOf(symbol))
  })
  return fifteen + ALPHABET[check]
}
/** The first 75 bits of a key, read as one long number. */
const firstBits = (key: Uint8Array): string => {
  let value = BigInt(`0x${bytesToHex(key)}`) >> BigInt(key.length * 8 - 75)
  let symbols = ''
  for (let place = 0; place < 15; place++) {
    symbols = (ALPHABET[Number(value % BigInt(32))] as string) + symbols
    value /= BigInt(32)
  }
  return symbols
}

/** The same every run: what is drawn comes from a counter, not from chance. */
const drawer = (seed: string) => {
  let count = 0
  return (below: number): number => {
    const bytes = sha256(utf8ToBytes(`${seed} ${count++}`))
    return (((bytes[0] as number) << 16) | ((bytes[1] as number) << 8) | (bytes[2] as number)) % below
  }
}

/** A relay that holds whatever it is given and answers `#d`. */
const relayOf = (events: NostrEvent[]) => async (filter: Filter) =>
  events.filter((event) =>
    event.tags.some((tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] as string)),
  )

const NOW = 1_800_000_000
const ID = withCheck('7X9K2M4QHD3RT8V')

describe('reading an ID', () => {
  it('takes it however it arrives', () => {
    const lower = ID.toLowerCase()
    for (const raw of [
      ID,
      lower,
      formatId(ID),
      `${ID.slice(0, 4)} ${ID.slice(4, 8)} ${ID.slice(8, 12)} ${ID.slice(12)}`,
      `  ${ID.slice(0, 8)}.${ID.slice(8)}\n`,
      `${ID.slice(0, 4)}\u2010${ID.slice(4)}`,
      `\u200e${formatId(ID)}\u200f`,
      `\u2066${formatId(ID)}\u2069`,
      `https://textor.ir/#/id/${ID}`,
      `#/id/${formatId(lower)}`,
    ]) {
      expect(readTextorId(raw)).toEqual({ id: ID })
    }
  })

  it('forgives the characters the alphabet left out, and reads Persian digits', () => {
    const typed = withCheck('001111ABCD00111')
    expect(readTextorId(typed.replace(/0/, 'O').replace('1', 'I').replace('1', 'l'))).toEqual({ id: typed })
    const digits = withCheck('123456789012345')
    const persian = digits.replace(/[0-9]/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)))
    const arabic = digits.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)))
    expect(readTextorId(persian)).toEqual({ id: digits })
    expect(readTextorId(arabic)).toEqual({ id: digits })
  })

  it('says a mistake is a mistake, before anything is looked up', () => {
    const wrongLast = ID.slice(0, 15) + (ID[15] === 'Z' ? 'Y' : 'Z')
    for (const typo of [wrongLast, ID.slice(0, 15), `${ID}7`, `#/id/${ID.slice(1)}`]) {
      expect(readTextorId(typo)).toEqual({ problem: 'typo' })
    }
  })

  it('refuses what cannot be one, ten characters among them', () => {
    for (const bad of [
      '',
      '---',
      'ABC',
      '7X9K2M4QHD',
      '7X9K2-M4QHD',
      `${ID.slice(0, 15)}U`,
      `${ID.slice(0, 15)}!`,
      ID + ID,
      '#/id/abc',
    ]) {
      expect(readTextorId(bad)).toEqual({ problem: 'invalid' })
    }
  })

  it('catches every single character wrong and every two neighbours swapped', () => {
    const draw = drawer('single')
    for (let round = 0; round < 40; round++) {
      const id = idOf(sha256(utf8ToBytes(`id ${round} ${draw(1000)}`)))
      for (let place = 0; place < ID_LENGTH; place++) {
        for (const symbol of ALPHABET) {
          if (symbol === id[place]) continue
          const wrong = id.slice(0, place) + symbol + id.slice(place + 1)
          expect(readTextorId(wrong)).toEqual({ problem: 'typo' })
        }
        if (place < ID_LENGTH - 1 && id[place] !== id[place + 1]) {
          const swapped = id.slice(0, place) + id[place + 1] + id[place] + id.slice(place + 2)
          expect(readTextorId(swapped)).toEqual({ problem: 'typo' })
        }
      }
    }
  })

  it('lets through about one in 32 of any other mistakes, as a check character can', () => {
    const draw = drawer('double')
    const tries = 20_000
    let through = 0
    for (let round = 0; round < tries; round++) {
      const id = [...idOf(sha256(utf8ToBytes(`double ${round}`)))]
      const first = draw(ID_LENGTH)
      const second = (first + 1 + draw(ID_LENGTH - 1)) % ID_LENGTH
      for (const place of [first, second]) {
        id[place] = ALPHABET[(ALPHABET.indexOf(id[place] as string) + 1 + draw(31)) % 32] as string
      }
      if ('id' in readTextorId(id.join(''))) through += 1
    }
    // 625 expected, and more than three deviations either side would be a check that is off.
    expect(through).toBeGreaterThan(540)
    expect(through).toBeLessThan(710)
  })

  it('is written in four groups of four, and reads back the same', () => {
    expect(formatId(ID)).toBe(`${ID.slice(0, 4)}-${ID.slice(4, 8)}-${ID.slice(8, 12)}-${ID.slice(12)}`)
    expect(readTextorId(formatId(ID))).toEqual({ id: ID })
  })

  it('knows its one spelling', () => {
    expect(isTextorId(ID)).toBe(true)
    for (const not of [
      ID.toLowerCase(),
      formatId(ID),
      ID.slice(0, 15),
      `${ID.slice(0, 15)}U`,
      7,
      undefined,
    ]) {
      expect(isTextorId(not)).toBe(false)
    }
    expect(isTextorId(ID.slice(0, 15) + (ID[15] === 'Z' ? 'Y' : 'Z'))).toBe(false)
  })
})

describe('the number', () => {
  // Pinned in PROTOCOL section 4.9, for anyone writing another client.
  const vector = getPublicKey(new Uint8Array(32).fill(1))

  it(
    'uses these settings, and these exact values',
    async () => {
      expect(ID_KDF).toEqual({ algo: 'scrypt', N: 16_384, r: 8, p: 1 })
      expect(ID_BITS).toBe(75)
      expect(ID_LENGTH).toBe(16)
      expect(ID_LANES).toBe(2)
      expect(vector).toBe('1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f')
      expect(await textorIdOf(vector)).toBe('2KAWY6807587VSE4')
    },
    REAL_SCRYPT_MS,
  )

  it('is worked out from the public key alone, the same anywhere, and differs for any other', async () => {
    const { pubkey } = person()
    const asked: [string, string][] = []
    const id = await textorIdOf(pubkey, async (password, salt, params) => {
      asked.push([password, bytesToHex(salt)])
      expect(params).toBe(ID_KDF)
      return fast(password, salt, params)
    })
    expect(asked).toEqual(laneSalts('textor/id/v2/key').map((salt) => [pubkey, bytesToHex(salt)]))
    expect(await textorIdOf(pubkey, fast)).toBe(id)
    expect(await textorIdOf(person().pubkey, fast)).not.toBe(id)
    expect(isTextorId(id)).toBe(true)
  })

  it('takes every lane, each with its own salt, and needs all of them', async () => {
    const { pubkey } = person()
    const salts = laneSalts('textor/id/v2/key').map(bytesToHex)
    const whole = await textorIdOf(pubkey, fast)
    expect(new Set(salts).size).toBe(2)
    // An attacker who stops after one lane has learned nothing about the answer.
    const only =
      (lane: number): Derive =>
      async (password, salt, params) =>
        bytesToHex(salt) === salts[lane] ? fast(password, salt, params) : new Uint8Array(32)
    const firstOnly = await textorIdOf(pubkey, only(0))
    const secondOnly = await textorIdOf(pubkey, only(1))
    expect(firstOnly).not.toBe(whole)
    expect(secondOnly).not.toBe(whole)
    expect(firstOnly).not.toBe(secondOnly)
  })

  it('reads exactly the first 75 bits, leading zeros and all, and checks them', () => {
    expect(idOf(keyOf())).toBe('0000000000000000')
    // Bit 74 is the last that counts, and bit 75 the first that does not.
    expect(idOf(keyOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0b0010_0000))).toBe(withCheck('000000000000001'))
    expect(idOf(keyOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0b0001_0000))).toBe('0000000000000000')
    expect(idOf(new Uint8Array(32).fill(0xff))).toBe('ZZZZZZZZZZZZZZZN')
    expect(idOf(keyOf(0x80))).toBe(withCheck('G00000000000000'))
    const inside = new Uint8Array(40)
    inside.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0b0100_0000], 8)
    expect(idOf(inside.subarray(8))).toBe(withCheck('000000000000002'))
  })

  it('agrees with reading the same bits as one long number, and with the check worked out by hand', () => {
    for (let round = 0; round < 300; round++) {
      const key = sha256(utf8ToBytes(`round ${round}`))
      expect(idOf(key)).toBe(withCheck(firstBits(key)))
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
    const { pubkey } = person()
    return { answer: textorIdOf(pubkey), workers: FakeWorker.made, pubkey }
  }

  it('asks a worker of its own for each lane, takes the answers past any progress, and ends them', async () => {
    const { answer, workers, pubkey } = start()
    expect(workers).toHaveLength(2)
    const salts = laneSalts('textor/id/v2/key')
    workers.forEach((worker, lane) => {
      expect(worker.posted).toEqual([{ id: 1, passphrase: pubkey, salt: salts[lane], params: ID_KDF }])
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
      const { pubkey } = person()
      const lanes = await Promise.all(
        laneSalts('textor/id/v2/key').map((salt) => deriveKek(pubkey, salt, ID_KDF)),
      )
      const want = idOf(sha256(concatBytes(...lanes)))

      FakeWorker.made = []
      vi.stubGlobal('Worker', FakeWorker)
      const failing = textorIdOf(pubkey)
      for (const worker of FakeWorker.made) worker.emit('error')
      await expect(failing).resolves.toBe(want)

      vi.stubGlobal('Worker', undefined)
      await expect(textorIdOf(pubkey)).resolves.toBe(want)
    },
    REAL_SCRYPT_MS,
  )
})

describe('the record', () => {
  it('is signed by the owner, filed under the ID, and says where they read', async () => {
    const { secretKey, pubkey } = person()
    const id = await textorIdOf(pubkey, fast)
    const event = textorIdEvent(
      secretKey,
      id,
      ['wss://A.example/', 'ftp://nope.example', 'wss://b.example'],
      NOW,
    )
    expect(verifyEventSignature(event)).toBe(true)
    expect(event.pubkey).toBe(pubkey)
    expect(event.kind).toBe(KIND_APP_DATA)
    expect(event.created_at).toBe(NOW)
    expect(event.tags).toEqual([
      ['d', `textor/id/v2:${id}`],
      ['expiration', String(NOW + RECORD_TTL_SEC)],
    ])
    expect(JSON.parse(event.content)).toEqual({ r: ['wss://a.example', 'wss://b.example'] })
  })

  it('names six relays at most', () => {
    const many = Array.from({ length: 9 }, (_, index) => `wss://r${index}.example`)
    const event = textorIdEvent(generateSecretKey(), ID, many, NOW)
    expect((JSON.parse(event.content) as { r: string[] }).r).toHaveLength(6)
  })

  it('is found by anyone given the ID, on the relays its owner named', async () => {
    const { secretKey, pubkey } = person()
    const id = await textorIdOf(pubkey, fast)
    const event = textorIdEvent(secretKey, id, ['wss://a.example', 'wss://b.example'], NOW)
    const query = vi.fn(relayOf([event]))
    const { owners, crowded } = await lookUpTextorId(id, query, fast)
    expect(owners).toEqual([{ pubkey, relays: ['wss://a.example', 'wss://b.example'] }])
    expect(crowded).toBe(false)
    expect(query).toHaveBeenCalledWith({ kinds: [KIND_APP_DATA], '#d': [`textor/id/v2:${id}`], limit: 64 })
  })

  it('costs one run of two lanes for each key it checks, and nothing to find the record', async () => {
    const { secretKey, pubkey } = person()
    const id = await textorIdOf(pubkey, fast)
    const derive = vi.fn(fast)
    await lookUpTextorId(id, relayOf([textorIdEvent(secretKey, id, [], NOW)]), derive)
    expect(derive).toHaveBeenCalledTimes(2)
  })

  it('finds nobody when nothing is there, or under another ID', async () => {
    const { secretKey, pubkey } = person()
    const id = await textorIdOf(pubkey, fast)
    const event = textorIdEvent(secretKey, id, [], NOW)
    expect(await lookUpTextorId(id, relayOf([]), fast)).toEqual({ owners: [], crowded: false })
    expect((await lookUpTextorId(ID, relayOf([event]), fast)).owners).toEqual([])
  })

  it('takes the newest of what one key has written', async () => {
    const { secretKey, pubkey } = person()
    const id = await textorIdOf(pubkey, fast)
    const events = [
      textorIdEvent(secretKey, id, ['wss://old.example'], NOW),
      textorIdEvent(secretKey, id, ['wss://new.example'], NOW + 10),
      textorIdEvent(secretKey, id, ['wss://older.example'], NOW - 10),
    ]
    const { owners } = await lookUpTextorId(id, relayOf(events), fast)
    expect(owners).toEqual([{ pubkey, relays: ['wss://new.example'] }])
  })

  describe('against someone trying to pass as the owner', () => {
    it('refuses a record from another key: the number is not theirs', async () => {
      const owner = person()
      const id = await textorIdOf(owner.pubkey, fast)
      const forged = textorIdEvent(person().secretKey, id, ['wss://attacker.example'], NOW + 100)
      const genuine = textorIdEvent(owner.secretKey, id, [], NOW)
      const { owners } = await lookUpTextorId(id, relayOf([forged, genuine]), fast)
      expect(owners.map((found) => found.pubkey)).toEqual([owner.pubkey])
    })

    it("refuses the owner's record with its relays changed, or put in their name by anyone else", async () => {
      const owner = person()
      const id = await textorIdOf(owner.pubkey, fast)
      const genuine = textorIdEvent(owner.secretKey, id, ['wss://mine.example'], NOW)
      const changed = { ...genuine, content: JSON.stringify({ r: ['wss://attacker.example'] }) }
      const theirs = finalizeEvent(
        { kind: KIND_APP_DATA, created_at: NOW, tags: [['d', `textor/id/v2:${id}`]], content: '{"r":[]}' },
        generateSecretKey(),
      )
      const posing = { ...theirs, pubkey: owner.pubkey }
      const derive = vi.fn(fast)
      expect(await lookUpTextorId(id, relayOf([changed, posing]), derive)).toEqual({
        owners: [],
        crowded: false,
      })
      expect(derive).not.toHaveBeenCalled()
    })

    it('shows everyone an ID really gives, rather than choose among them', async () => {
      // As if someone had put in the 2^75 runs, or the same number had come up twice by chance.
      const both = giving(keyOf())
      const one = person()
      const two = person()
      const id = await textorIdOf(one.pubkey, both)
      expect(await textorIdOf(two.pubkey, both)).toBe(id)
      const events = [
        textorIdEvent(one.secretKey, id, [], NOW),
        textorIdEvent(two.secretKey, id, [], NOW + 1),
      ]
      const { owners } = await lookUpTextorId(id, relayOf(events), both)
      expect(owners.map((owner) => owner.pubkey)).toEqual([two.pubkey, one.pubkey])
    })

    it('spends only so much on records someone has flooded an ID with, and says so', async () => {
      const events = Array.from({ length: 12 }, (_, index) =>
        textorIdEvent(generateSecretKey(), ID, [], NOW + index),
      )
      const derive = vi.fn(fast)
      const { owners, crowded } = await lookUpTextorId(ID, relayOf(events), derive)
      expect(owners).toEqual([])
      expect(crowded).toBe(true)
      // Eight keys checked, the newest first, at two lanes each.
      expect(derive).toHaveBeenCalledTimes(16)
    })

    it('does not count eight as a flood', async () => {
      const events = Array.from({ length: 8 }, () => textorIdEvent(generateSecretKey(), ID, [], NOW))
      expect((await lookUpTextorId(ID, relayOf(events), fast)).crowded).toBe(false)
    })

    it('throws out anything malformed before spending scrypt on it', async () => {
      const owner = person()
      const id = await textorIdOf(owner.pubkey, fast)
      const d = `textor/id/v2:${id}`
      const made = (over: Partial<NostrEvent>) =>
        finalizeEvent(
          { kind: KIND_APP_DATA, created_at: NOW, tags: [['d', d]], content: '{"r":[]}', ...over },
          owner.secretKey,
        )
      const events = [
        made({ content: '' }),
        made({ content: 'not json' }),
        made({ content: 'null' }),
        made({ content: '{"r":"wss://a.example"}' }),
        made({ content: JSON.stringify({ r: Array(7).fill('wss://a.example') }) }),
        made({ content: '{"r":[5]}' }),
        made({ kind: 1 }),
        made({ tags: [] }),
        made({
          tags: [
            ['d', `textor/id/v2:${ID}`],
            ['d', d],
          ],
        }),
      ]
      const derive = vi.fn(fast)
      expect(await lookUpTextorId(id, async () => events, derive)).toEqual({ owners: [], crowded: false })
      expect(derive).not.toHaveBeenCalled()
      expect((await lookUpTextorId(id, async () => [made({})], fast)).owners).toHaveLength(1)
    })
  })

  it(
    'works from end to end on the real thing',
    async () => {
      const { secretKey, pubkey } = person()
      const id = await textorIdOf(pubkey)
      const event = textorIdEvent(secretKey, id, ['wss://a.example'], NOW)
      const { owners } = await lookUpTextorId(id, relayOf([event]))
      expect(owners).toEqual([{ pubkey, relays: ['wss://a.example'] }])
    },
    REAL_SCRYPT_MS,
  )
})

describe('a link to an ID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the app on it, and comes back as the same ID', () => {
    const link = textorIdLink(ID, 'https://textor.ir/?a=1#/settings')
    expect(link).toBe(`https://textor.ir/#/id/${ID}`)
    expect(readTextorId(link)).toEqual({ id: ID })
  })

  it('goes by where the app is, if it has to', () => {
    expect(textorIdLink(ID)).toBe(`/#/id/${ID}`)
    vi.stubGlobal('location', { origin: 'https://example.org', pathname: '/Textor/' })
    expect(textorIdLink(ID)).toBe(`https://example.org/Textor/#/id/${ID}`)
  })
})
