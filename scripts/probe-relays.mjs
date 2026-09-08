#!/usr/bin/env node
/**
 * Probe candidate Nostr relays for suitability as Textor DM relays.
 *
 * Checks, per relay:
 *   - NIP-11 relay information document (name, supported NIPs, limitations)
 *   - Whether NIP-59 gift wrap (kind 1059) queries are accepted
 *   - Whether a gift wrap from an unknown key is actually ACCEPTED for
 *     publishing. This is the check that matters: several relays serve reads to
 *     anyone but silently reject writes from keys outside a web of trust, which
 *     makes them useless as a DM inbox and is invisible from reads alone.
 *   - Whether NIP-42 AUTH is required to read/write (disqualifying for us:
 *     an anonymous static app must be able to fetch its own inbox)
 *   - Connect + first-response latency
 *
 * Usage: node scripts/probe-relays.mjs [relay-url ...]
 */

const DEFAULT_CANDIDATES = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://relay.0xchat.com',
  'wss://auth.nostr1.com',
  'wss://purplerelay.com',
  'wss://nostr.bitcoiner.social',
  'wss://relay.nostr.bg',
  'wss://nostr21.com',
  'wss://relay.mostr.pub',
  'wss://nostr.oxtr.dev',
  'wss://relay.nsec.app',
  'wss://relay.momostr.pink',
  'wss://eden.nostr.land',
  'wss://relay.fountain.fm',
  'wss://nostr.land',
  'wss://relay.nostrplebs.com',
  'wss://nostr-pub.wellorder.net',
]

const TIMEOUT_MS = 8000

/**
 * Publish a real, throwaway gift wrap to test write acceptance.
 *
 * Built with nostr-tools so the event is genuinely well-formed; it is addressed
 * to a random key nobody holds, so it is undeliverable noise that expires in an
 * hour rather than anything meaningful.
 */
async function buildProbeEvent() {
  const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools/pure')
  const nip44 = await import('nostr-tools/nip44')
  const sk = generateSecretKey()
  const recipient = getPublicKey(generateSecretKey())
  const conversationKey = nip44.getConversationKey(sk, recipient)
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000) - 60,
      tags: [
        ['p', recipient],
        ['expiration', String(Math.floor(Date.now() / 1000) + 3600)],
      ],
      content: nip44.encrypt(JSON.stringify({ probe: 'textor relay capability check' }), conversationKey),
    },
    sk,
  )
}

/** Random 32-byte hex, used as a bogus recipient pubkey for the probe REQ. */
function randomHex32() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
}

async function fetchNip11(url) {
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  try {
    const res = await fetch(httpUrl, {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const json = await res.json()
    return {
      name: json.name,
      software: json.software,
      supported_nips: json.supported_nips,
      auth_required: json.limitation?.auth_required ?? false,
      payment_required: json.limitation?.payment_required ?? false,
      max_message_length: json.limitation?.max_message_length,
      created_at_lower_limit: json.limitation?.created_at_lower_limit,
    }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

function probeSocket(url, probeEvent) {
  return new Promise((resolve) => {
    const started = Date.now()
    const result = {
      connected: false,
      connectMs: null,
      firstResponseMs: null,
      eose: false,
      authChallenged: false,
      writeOk: null,
      writeError: null,
      notice: null,
      error: null,
    }
    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      result.error = String(err?.message ?? err)
      return resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }, TIMEOUT_MS)

    const finish = () => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }

    ws.onopen = () => {
      result.connected = true
      result.connectMs = Date.now() - started
      // A gift-wrap inbox query for a key nobody has ever written to:
      // valid, cheap, and exercises the exact filter shape Textor uses.
      ws.send(JSON.stringify(['REQ', 'probe', { kinds: [1059], '#p': [randomHex32()], limit: 1 }]))
      ws.send(JSON.stringify(['EVENT', probeEvent]))
    }
    ws.onmessage = (ev) => {
      if (result.firstResponseMs === null) result.firstResponseMs = Date.now() - started
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg[0] === 'OK') {
        result.writeOk = msg[2] === true
        if (!result.writeOk) result.writeError = String(msg[3] ?? '').slice(0, 90)
        if (result.eose) finish()
        return
      }
      if (msg[0] === 'EOSE') {
        result.eose = true
        // Wait a moment for the OK, which usually follows.
        if (result.writeOk !== null) finish()
        return
      } else if (msg[0] === 'AUTH') {
        result.authChallenged = true
      } else if (msg[0] === 'NOTICE') {
        result.notice = String(msg[1]).slice(0, 120)
      } else if (msg[0] === 'CLOSED') {
        result.notice = String(msg[2] ?? '').slice(0, 120)
        finish()
      }
    }
    ws.onerror = () => {
      result.error = result.error ?? 'socket error'
    }
    ws.onclose = () => {
      if (result.firstResponseMs === null) result.error = result.error ?? 'closed early'
      finish()
    }
  })
}

const relays = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CANDIDATES
const probeEvent = await buildProbeEvent()

const rows = await Promise.all(
  relays.map(async (url) => {
    const [nip11, sock] = await Promise.all([fetchNip11(url), probeSocket(url, probeEvent)])
    const nips = nip11.supported_nips ?? []
    return {
      url,
      // Usable means: reads work, writes are accepted, no AUTH, no payment.
      ok: sock.eose && sock.writeOk === true && !sock.authChallenged && !nip11.payment_required,
      eose: sock.eose,
      ms: sock.firstResponseMs,
      auth: sock.authChallenged || nip11.auth_required === true,
      paid: nip11.payment_required === true,
      write: sock.writeOk,
      writeError: sock.writeError,
      nip17: nips.includes(17),
      nip44: nips.includes(44),
      nip59: nips.includes(59),
      software: (nip11.software ?? '').split('/').pop(),
      // Node's built-in WebSocket sends a Node User-Agent, which some
      // Cloudflare-fronted relays reject. If NIP-11 answered but the socket
      // did not, the relay is almost certainly fine from a real browser.
      uaBlocked: !sock.connected && !nip11.error,
      note: sock.writeError ?? sock.notice ?? sock.error ?? nip11.error ?? '',
    }
  }),
)

rows.sort((a, b) => Number(b.ok) - Number(a.ok) || (a.ms ?? 1e9) - (b.ms ?? 1e9))

const pad = (s, n) =>
  String(s ?? '')
    .padEnd(n)
    .slice(0, n)
console.log(
  pad('RELAY', 34) +
    pad('OK', 4) +
    pad('WRITE', 7) +
    pad('ms', 7) +
    pad('AUTH', 6) +
    pad('PAID', 6) +
    pad('SOFTWARE', 16) +
    'NOTE',
)
console.log('-'.repeat(120))
for (const r of rows) {
  console.log(
    pad(r.url, 34) +
      pad(r.ok ? 'yes' : 'no', 4) +
      pad(r.write === null ? '?' : r.write ? 'yes' : 'NO', 7) +
      pad(r.ms ?? '-', 7) +
      pad(r.auth ? 'yes' : '', 6) +
      pad(r.paid ? 'yes' : '', 6) +
      pad(r.software, 16) +
      (r.uaBlocked ? 'likely UA-blocked from Node; verify in a browser. ' : '') +
      r.note,
  )
}
const good = rows.filter((r) => r.ok)
const maybe = rows.filter((r) => !r.ok && r.uaBlocked)
if (maybe.length) {
  console.log(`\nReachable over HTTPS but not over Node's WebSocket (browser-only, re-verify manually):`)
  console.log(maybe.map((r) => `  ${r.url}`).join('\n'))
}
console.log(`\n${good.length}/${rows.length} usable. Suggested set:`)
console.log(
  good
    .slice(0, 8)
    .map((r) => `  '${r.url}',`)
    .join('\n'),
)
