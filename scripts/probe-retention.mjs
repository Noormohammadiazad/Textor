#!/usr/bin/env node
/**
 * How long do relays really keep a gift wrap? (ADR-073)
 *
 * Sampling what relays hold shows they keep old wraps, but not whether one wrap
 * lives until it asked to expire, which is what a message relies on. This finds
 * out: one small wrap and one the size of an attachment chunk on each default
 * relay, asking to expire in 31 days, looked for again over that time.
 *
 * Each comes from a key made for it and thrown away, is addressed to a random
 * key nobody holds, and carries random bytes, so nobody can read it. Checking
 * only reads. What was published is kept outside the repository.
 *
 * Usage: node scripts/probe-retention.mjs start | check | show
 *   CANARY_STATE: where to keep it (default ~/.textor/retention-canary.json)
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const RELAYS = [
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://offchain.pub',
  'wss://purplerelay.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]
const SIZES = { small: 1600, chunk: 54_700 }
const DAY_SEC = 86_400
const LIFETIME_SEC = 31 * DAY_SEC
const TIMEOUT_MS = 15_000
/** Slowly: this is not a test of how much a relay will take. */
const GAP_MS = 5000
const STATE = process.env.CANARY_STATE ?? join(homedir(), '.textor', 'retention-canary.json')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowSec = () => Math.floor(Date.now() / 1000)

async function load() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'))
  } catch {
    return null
  }
}

async function save(state) {
  await mkdir(dirname(STATE), { recursive: true })
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`)
}

function open(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve(socket)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

function publish(socket, event) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'no answer' }), TIMEOUT_MS)
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame[0] !== 'OK' || frame[1] !== event.id) return
      clearTimeout(timer)
      resolve({ ok: frame[2] === true, reason: String(frame[3] ?? '').slice(0, 80) })
    }
    socket.send(JSON.stringify(['EVENT', event]))
  })
}

/** True or false if the relay answered, null if it could not be asked. */
function holds(socket, item) {
  return new Promise((resolve) => {
    const id = `c${randomBytes(4).toString('hex')}`
    let found = false
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS)
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame[1] !== id) return
      if (frame[0] === 'EVENT' && frame[2]?.id === item.id) found = true
      if (frame[0] === 'CLOSED') {
        clearTimeout(timer)
        resolve(null)
      }
      if (frame[0] === 'EOSE') {
        clearTimeout(timer)
        socket.send(JSON.stringify(['CLOSE', id]))
        resolve(found)
      }
    }
    socket.send(JSON.stringify(['REQ', id, { kinds: [1059], '#p': [item.recipient], ids: [item.id] }]))
  })
}

/** Run again, it only tries what a relay did not take last time, to the same expiry. */
async function start() {
  const before = await load()
  const startedAt = before?.startedAt ?? nowSec()
  const items = (before?.items ?? []).filter((item) => item.ok)
  const taken = (relay, size) => items.some((item) => item.relay === relay && item.size === size)
  await Promise.all(
    RELAYS.map(async (relay) => {
      const socket = await open(relay)
      for (const [size, bytes] of Object.entries(SIZES)) {
        if (taken(relay, size)) continue
        const recipient = getPublicKey(generateSecretKey())
        const event = finalizeEvent(
          {
            kind: 1059,
            created_at: nowSec() - 3600,
            tags: [
              ['p', recipient],
              ['expiration', String(startedAt + LIFETIME_SEC)],
            ],
            content: randomBytes(Math.floor(bytes * 0.75)).toString('base64'),
          },
          generateSecretKey(),
        )
        const result = socket ? await publish(socket, event) : { ok: false, reason: 'could not connect' }
        items.push({ relay, size, id: event.id, recipient, ...result })
        await wait(GAP_MS)
      }
      socket?.close()
    }),
  )
  await save({ startedAt, expiresAt: startedAt + LIFETIME_SEC, items, checks: before?.checks ?? [] })
  console.log(`Published. Kept in ${STATE}. It asks to expire in ${LIFETIME_SEC / DAY_SEC} days.`)
}

async function check() {
  const state = await load()
  if (!state) throw new Error('not started: run with "start" first')
  const at = nowSec()
  const results = {}
  await Promise.all(
    RELAYS.map(async (relay) => {
      const socket = await open(relay)
      for (const item of state.items.filter((entry) => entry.relay === relay && entry.ok)) {
        results[item.id] = socket ? await holds(socket, item) : null
        await wait(1000)
      }
      socket?.close()
    }),
  )
  state.checks.push({ at, results })
  await save(state)
}

function show(state) {
  const days = (at) => ((at - state.startedAt) / DAY_SEC).toFixed(1)
  console.log(`Published ${new Date(state.startedAt * 1000).toISOString()}, day ${days(nowSec())} now.`)
  console.log(`Asked to expire on ${new Date(state.expiresAt * 1000).toISOString()}.`)
  const header = state.checks.map((entry) => `d${days(entry.at)}`.padEnd(7)).join('')
  console.log(`${'relay'.padEnd(32)}${'size'.padEnd(7)}${header}`)
  for (const item of state.items) {
    const name = item.relay.replace('wss://', '')
    if (!item.ok) {
      console.log(`${name.padEnd(32)}${item.size.padEnd(7)}refused: ${item.reason}`)
      continue
    }
    const row = state.checks.map((entry) => {
      const held = entry.results[item.id]
      return (held === true ? 'held' : held === false ? 'GONE' : '?').padEnd(7)
    })
    console.log(`${name.padEnd(32)}${item.size.padEnd(7)}${row.join('')}`)
  }
}

const command = process.argv[2]
if (command === 'start') await start()
else if (command === 'check') await check()
else if (command !== 'show') throw new Error('usage: probe-retention.mjs start | check | show')
const state = await load()
if (state) show(state)
process.exit(0)
