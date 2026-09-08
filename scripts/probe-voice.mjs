#!/usr/bin/env node
/**
 * Can these relays carry relay voice (ADR-069)? Publish a run of ephemeral
 * events of a voice packet's size, at its pace, from a throwaway key, receive
 * them on a second connection, and time each one.
 *
 * Measured this way, a relay either carries the whole run, throttles after a
 * burst ("rate limited"), refuses keys outside its web of trust, or blocks the
 * ephemeral range outright — and relay voice drops a relay at its first
 * refusal. Each event is an ephemeral one, which relays forward and do not
 * keep, signed by a key made for the run.
 *
 * Usage: node scripts/probe-voice.mjs [relay-url ...]
 *   COUNT (25), EVERY_MS (400), BYTES (664, a sealed packet), KIND (21690)
 */

import { randomBytes } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://offchain.pub',
  'wss://purplerelay.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]

const KIND = Number(process.env.KIND ?? 21690)
const COUNT = Number(process.env.COUNT ?? 25)
const EVERY_MS = Number(process.env.EVERY_MS ?? 400)
const BYTES = Number(process.env.BYTES ?? 664)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('no connection')), 10_000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve(socket)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('connection failed'))
    }
  })
}

async function probe(url) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const [listener, sender] = await Promise.all([open(url), open(url)])
  const sentAt = new Map()
  const latencies = []
  const refusals = new Set()
  let accepted = 0
  listener.onmessage = ({ data }) => {
    const [type, , event] = JSON.parse(data)
    if (type === 'EVENT' && sentAt.has(event.id)) latencies.push(performance.now() - sentAt.get(event.id))
  }
  sender.onmessage = ({ data }) => {
    const [type, , ok, reason] = JSON.parse(data)
    if (type !== 'OK') return
    if (ok) accepted += 1
    else refusals.add(reason)
  }
  listener.send(
    JSON.stringify([
      'REQ',
      'voice',
      { kinds: [KIND], authors: [pubkey], since: Math.floor(Date.now() / 1000) - 5 },
    ]),
  )
  await wait(800)
  for (let i = 0; i < COUNT; i++) {
    const event = finalizeEvent(
      {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: randomBytes(BYTES).toString('base64'),
      },
      secret,
    )
    sentAt.set(event.id, performance.now())
    sender.send(JSON.stringify(['EVENT', event]))
    await wait(EVERY_MS)
  }
  await wait(2000)
  listener.close()
  sender.close()
  latencies.sort((a, b) => a - b)
  const at = (share) =>
    latencies.length ? Math.round(latencies[Math.floor(share * (latencies.length - 1))]) : '-'
  return { accepted, delivered: latencies.length, p50: at(0.5), p90: at(0.9), refusals: [...refusals] }
}

const relays = process.argv.slice(2)
for (const url of relays.length > 0 ? relays : DEFAULT_RELAYS) {
  try {
    const { accepted, delivered, p50, p90, refusals } = await probe(url)
    console.log(
      `${url.padEnd(34)} accepted ${accepted}/${COUNT}  delivered ${delivered}/${COUNT}  p50 ${p50} ms  p90 ${p90} ms` +
        (refusals.length ? `  refused: ${refusals.join(' | ')}` : ''),
    )
  } catch (err) {
    console.log(`${url.padEnd(34)} ${err.message}`)
  }
}
