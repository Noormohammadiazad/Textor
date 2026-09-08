#!/usr/bin/env node
/**
 * Probe candidate public TURN servers, to decide whether any could ship as a
 * default fallback (ADR-068).
 *
 * Sends one unauthenticated TURN Allocate request (RFC 8656) to each host over
 * UDP, TCP and TLS on the ports TURN is usually offered on. A live TURN server
 * answers every such request with 401 Unauthorized and its realm, so the reply
 * says, without any credentials, whether a TURN service is there at all and on
 * which transports — 443 over TLS being the one that passes strict firewalls.
 * It does not say whether an operator offers the service to anyone: that is in
 * their terms, and ADR-068 records what each candidate's are.
 *
 * Usage: node scripts/probe-turn.mjs [host ...]
 */

import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_CANDIDATES = [
  // Open Relay: shared password, then a published shared secret.
  'openrelay.metered.ca',
  'staticauth.openrelay.metered.ca',
  'freestun.net',
  'freeturn.net',
  'relay.backups.cz',
  'eu-0.turn.peerjs.com',
  // An account-only service, as a check that the probe sees a live server.
  'global.relay.metered.ca',
]

const PLAIN_PORTS = [80, 443, 3478]
const TLS_PORTS = [443, 5349]
const TIMEOUT_MS = 5000
const MAGIC_COOKIE = 0x2112a442

/** An Allocate request asking for a UDP relay, with no credentials. */
function allocate() {
  const message = Buffer.alloc(28)
  message.writeUInt16BE(0x0003, 0)
  message.writeUInt16BE(8, 2)
  message.writeUInt32BE(MAGIC_COOKIE, 4)
  randomBytes(12).copy(message, 8)
  message.writeUInt16BE(0x0019, 20) // REQUESTED-TRANSPORT
  message.writeUInt16BE(4, 22)
  message.writeUInt8(17, 24) // UDP
  return message
}

/** What came back: a STUN error and the server's realm and software, or what it was instead. */
function describe(reply) {
  if (reply.length < 20 || reply.readUInt32BE(4) !== MAGIC_COOKIE) {
    return `not TURN (${JSON.stringify(reply.subarray(0, 12).toString('latin1'))})`
  }
  const parts = []
  for (let at = 20; at + 4 <= reply.length;) {
    const type = reply.readUInt16BE(at)
    const length = reply.readUInt16BE(at + 2)
    const value = reply.subarray(at + 4, at + 4 + length)
    if (type === 0x0009) parts.push(`error ${value[2] * 100 + value[3]}`)
    if (type === 0x0014) parts.push(`realm ${value.toString()}`)
    if (type === 0x8022) parts.push(`software ${value.toString()}`)
    at += 4 + length + ((4 - (length % 4)) % 4)
  }
  return parts.join(', ') || `STUN message 0x${reply.readUInt16BE(0).toString(16)}`
}

function overUdp(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      resolve('no answer')
    }, TIMEOUT_MS)
    socket.on('message', (reply) => {
      clearTimeout(timer)
      socket.close()
      resolve(describe(reply))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      socket.close()
      resolve(error.code ?? error.message)
    })
    socket.send(allocate(), port, host)
  })
}

function overStream(host, port, secure) {
  return new Promise((resolve) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('no answer')
    }, TIMEOUT_MS)
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(allocate()))
    socket.on('data', (reply) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(describe(reply))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve(error.code ?? error.message)
    })
  })
}

async function probe(host) {
  const checks = [
    ...PLAIN_PORTS.map((port) => ['udp', port, () => overUdp(host, port)]),
    ...PLAIN_PORTS.map((port) => ['tcp', port, () => overStream(host, port, false)]),
    ...TLS_PORTS.map((port) => ['tls', port, () => overStream(host, port, true)]),
  ]
  const results = await Promise.all(
    checks.map(async ([transport, port, run]) => [transport, port, await run()]),
  )
  return results
}

const hosts = process.argv.slice(2)
for (const host of hosts.length > 0 ? hosts : DEFAULT_CANDIDATES) {
  console.log(host)
  for (const [transport, port, result] of await probe(host)) {
    console.log(`  ${transport.padEnd(4)}${String(port).padEnd(6)}${result}`)
  }
}
