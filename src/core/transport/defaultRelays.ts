/**
 * Default relay set.
 *
 * Verified with `npm run relays:probe` (see scripts/probe-relays.mjs): each
 * accepts anonymous kind-1059 reads *and writes* — a wrap dated two days back,
 * as NIP-59 dates them — requires no NIP-42 AUTH, and takes no payment.
 * Testing writes matters: `offchain.pub` once read fine for anyone but
 * rejected publishes from keys outside its web of trust, which made it a
 * silently bad default until live delivery stats exposed it (ADR-012).
 *
 * Diversity across operators, software and continents matters more than raw
 * count — the failure mode we are guarding against is one operator going down
 * or deciding to filter, not a global outage. Primal, oxtr (Germany), offchain
 * and purplerelay run strfry; all but primal, which turns it off, answer NIP-77
 * negentropy (ADR-050). Wellorder runs nostr-rs-relay, so one software bug
 * cannot take every relay at once; wirednet is in Japan. A new install uses four
 * of them and keeps the others standing by; which four is settled by its own
 * measurements (ADR-067), not by this order.
 *
 * Measured November 2026 (ADR-073): the largest wrap all of them store is
 * 64 KiB, and offchain takes only short ones from a key it does not know, so it
 * carries no attachments and no long messages.
 *
 * Relay policy drifts, and defaults go stale. Re-probed October 2026:
 * `relay.damus.io` now demands NIP-42 AUTH for gift-wrap reads, as `nos.lol`
 * and `nostr.mom` once did, and `relay.0xchat.com` no longer resolves. Both
 * were defaults. Textor is anonymous and does not authenticate to relays, so
 * neither could deliver mail; an install that still lists them now turns them
 * off and replaces them on its own evidence (ADR-067).
 *
 * Users can replace every entry. Nothing here is privileged: these are defaults,
 * not infrastructure we run or control.
 */
export const DEFAULT_DM_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://offchain.pub',
  'wss://purplerelay.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.wirednet.jp',
]

/**
 * Public STUN only. Running a TURN server would mean running a server, which
 * this project does not do; when NAT traversal fails the conversation simply
 * stays on the relay path, which always works. Users can add their own TURN
 * server in settings.
 */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun.cloudflare.com:3478'] },
]
