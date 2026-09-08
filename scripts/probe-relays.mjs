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
 *   - The largest event the relay says it takes (NIP-11), against the 64 KiB
 *     an attachment chunk needs, and whether it speaks NIP-77 negentropy
 *
 * The probe wrap is dated two days back, as NIP-59's timestamp fuzz can date a
 * real one: a relay that refuses old timestamps refuses real messages too.
 * Relays are probed one at a time unless PROBE_CONCURRENCY says otherwise:
 * handshakes run side by side over a slow or proxied link start failing in
 * bulk after the first ten or so, and read as a list of dead relays.
 *
 * Usage: node scripts/probe-relays.mjs [relay-url ...]
 */

const DEFAULT_CANDIDATES = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.oxtr.dev',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
  'wss://offchain.pub',
  'wss://purplerelay.com',
  'wss://nostr.mom',
  'wss://relay.nos.social',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.azzamo.net',
  'wss://nostr.21crypto.ch',
  'wss://relay.coinos.io',
  'wss://nostr.data.haus',
  'wss://relay.ditto.pub',
  'wss://relay.angor.io',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.minibits.cash',
  'wss://nostr.sathoarder.com',
  // Disqualified when last probed, kept to notice if that changes:
  'wss://relay.damus.io', // NIP-42 AUTH for gift-wrap reads
  'wss://relay.0xchat.com', // name no longer resolves
  'wss://relay.nostr.net', // AUTH for gift-wrap reads
  'wss://yabu.me', // refuses some countries outright
  'wss://nostr.einundzwanzig.space', // NIP-05 needed to publish
  'wss://relay.nostrplebs.com', // NIP-05 needed to publish
  'wss://nostr.wine', // paid, AUTH
]

const TIMEOUT_MS = 8000
/** NIP-59 dates a wrap up to this far back; the probe takes the worst case. */
const FUZZ_SEC = 2 * 24 * 60 * 60
/** An attachment chunk's wrap, with room to spare. */
const CHUNK_EVENT_BYTES = 64 * 1024
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY) || 1

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
      created_at: Math.floor(Date.now() / 1000) - FUZZ_SEC + 120,
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
      max_content_length: json.limitation?.max_content_length,
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

/** Run `task` over `items`, `limit` at a time, keeping the input order. */
async function pooled(items, limit, task) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const rows = await pooled(relays, CONCURRENCY, async (url) => {
  const [nip11, sock] = await Promise.all([fetchNip11(url), probeSocket(url, probeEvent)])
  const nips = nip11.supported_nips ?? []
  const maxEvent = Math.min(nip11.max_message_length ?? Infinity, nip11.max_content_length ?? Infinity)
  return {
    url,
    // Usable means: reads work, writes are accepted, no AUTH, no payment,
    // and an attachment chunk fits.
    ok:
      sock.eose &&
      sock.writeOk === true &&
      !sock.authChallenged &&
      !nip11.payment_required &&
      maxEvent >= CHUNK_EVENT_BYTES,
    eose: sock.eose,
    ms: sock.firstResponseMs,
    auth: sock.authChallenged || nip11.auth_required === true,
    paid: nip11.payment_required === true,
    write: sock.writeOk,
    writeError: sock.writeError,
    nip17: nips.includes(17),
    nip44: nips.includes(44),
    nip59: nips.includes(59),
    nip77: nips.includes(77),
    // Unstated is not a refusal: many relays publish no limits at all.
    chunks: maxEvent >= CHUNK_EVENT_BYTES,
    software: (nip11.software ?? '').split('/').pop(),
    // Node's built-in WebSocket sends a Node User-Agent, which some
    // Cloudflare-fronted relays reject. If NIP-11 answered but the socket
    // did not, the relay is almost certainly fine from a real browser.
    uaBlocked: !sock.connected && !nip11.error,
    note: sock.writeError ?? sock.notice ?? sock.error ?? nip11.error ?? '',
  }
})

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
    pad('NEG', 5) +
    pad('64K', 5) +
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
      pad(r.nip77 ? 'yes' : '', 5) +
      pad(r.chunks ? '' : 'NO', 5) +
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
