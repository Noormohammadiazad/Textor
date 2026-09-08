# Textor — System Architecture

**Status:** implemented and running · **Target:** static deployment, zero self-operated backend.

This describes the system as built. Where implementation contradicted the original
design — and it did, in five places — the reasoning is recorded in
[`DECISIONS.md`](DECISIONS.md) rather than quietly rewritten here.

---

## 1. Constraints

|        |                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | 100% static assets. We operate no servers, databases, signalling services, TURN relays, or push infrastructure.                                 |
| **C2** | Works in evergreen browsers, desktop and mobile, with no extensions.                                                                            |
| **C3** | All third-party infrastructure must be public, free, redundant, and user-swappable. No single external party can kill the app or read messages. |

Goals in priority order: **confidentiality** → **metadata minimisation** →
**reliability** (messages must be deliverable when the recipient is offline; "both online
simultaneously" is a toy assumption) → **usability** → **sovereignty** (the user owns
their identity and data; hosting is fungible).

Explicit non-goals for v1: anonymity against a global passive network adversary, voice
and video, large groups, live multi-device sync.

---

## 2. Overview

```
┌───────────────────── Browser (installable PWA, static assets) ─────────────────────┐
│                                                                                    │
│  React UI ─────────────▶ Zustand store ─────────────▶ Messenger (engine)           │
│   screens, i18n, RTL      UI projection only            delivery state machine,    │
│                                                         dedup, receipts, retry     │
│                                    │                          │                    │
│                        ┌───────────┴──────────┐    ┌───────────┴────────────┐      │
│                        │  VaultRepo           │    │  Transport             │      │
│                        │  typed records       │    │  ┌──────────────────┐  │      │
│                        │       │              │    │  │ NostrTransport   │  │      │
│                        │  Vault (keys, lock)  │    │  │ kinds & filters  │  │      │
│                        │       │              │    │  └────────┬─────────┘  │      │
│                        │  Dexie / IndexedDB   │    │  ┌────────┴─────────┐  │      │
│                        │  every body sealed,  │    │  │ RelayPool        │  │      │
│                        │  every key blinded   │    │  │ health, ranking  │  │      │
│                        └──────────────────────┘    │  └────────┬─────────┘  │      │
│                                                    │  ┌────────┴─────────┐  │      │
│  Service worker (offline shell, update prompt)     │  │ DirectManager    │  │      │
│                                                    │  │ WebRTC, opt-in   │  │      │
│                                                    └──┴────────┬─────────┘──┘      │
└────────────────────────────────────────────────────────────┬───┼───────────────────┘
                                                      wss:// │   │ DTLS/SCTP (P2P)
                                           ┌─────────────────┴─┐ │
                                           │ Public Nostr      │◀┘  signalling rides
                                           │ relays (6 default,│    the same relays
                                           │ user-editable)    │
                                           └───────────────────┘
```

**One sentence.** Identity is a secp256k1 keypair; messages are NIP-17 gift-wrapped
ciphertexts held by redundant public relays; a direct WebRTC channel opportunistically
accelerates delivery without ever being trusted to guarantee it; everything is stored in
an encrypted local vault; the site is only code.

---

## 3. Layering

Strictly one direction. `src/core/` is framework-free and fully testable in Node.

```
src/
  app/        shell, hash router, Zustand store, PWA update prompt
  ui/         screens and components — no transport or database access
  styles/     design tokens, then components; no framework, no runtime cost
  media/      browser capture and processing — voice recording, waveforms,
              image re-encoding. Browser APIs, so deliberately outside core/
  i18n/       en + fa dictionaries, compile-time-checked keys
  core/
    crypto/   gift wrap, NIP-44, vault sealing, KDF (+ worker), safety numbers,
              chunked attachment encryption
    identity/ keygen, mnemonic, invite binary codec
    models/   protocol frames and validation, domain types
    vault/    Dexie schema, key hierarchy, typed repository, export/import
    transport/ relay pool + health, Nostr kinds/filters, WebRTC session manager
    engine/   Messenger — the orchestrator, the connection-state derivation,
              and the chunked attachment transfer engine
    util/     bytes, time, emitter, mutex, logging
```

The UI never touches Dexie or a socket. It reads the store; the store calls the
repository and the engine. When domain logic drifted into a screen during development
(`verdictFor`, the relay health verdict) it was moved back into `core/` — see
`core/transport/relayHealth.ts`.

`media/` is the one place that touches `MediaRecorder`, `AudioContext`, and canvas.
It sits outside `core/` precisely because `core/` must stay runnable in Node: the maths
that has edge cases — waveform bucketing, normalising a silent recording, fitting an image
— is pure and unit-tested, and the browser wrappers around it are thin.

`styles/` follows the same one-way rule. `theme.css` defines raw colour ramps, maps them
to semantic roles per theme, and sets the shared metrics; `app.css` and `chat.css` style
components and may reference only the roles, never a ramp step or a literal colour.
`scripts/check-tokens.mjs` enforces the contrast targets across all three theme
resolutions on every `npm run verify` — see ADR-023 and ADR-024.

---

## 4. Identity

A secp256k1 keypair, derived from a BIP-39 mnemonic along NIP-06's path. No registration,
no phone number, no email. The twelve words are a complete, portable backup that any
NIP-06 client can restore.

The recovery-phrase ceremony is driven by **persisted state** (`mnemonicBackedUp`), not
by a step in a wizard. Someone who abandons it halfway — or closes the tab — is asked
again next time, rather than silently ending up with an unrecoverable identity. Deferring
it downgrades to a dismissible reminder.

Contact exchange uses a signed binary invite (~150 bytes, QR-friendly) carried in a URL
**fragment**, so the payload never reaches a web server. See
[`PROTOCOL.md §6`](PROTOCOL.md).

---

## 5. Cryptography

| Purpose            | Primitive                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Message encryption | NIP-44 v2 (secp256k1 ECDH → HKDF-SHA256 → ChaCha20 + HMAC-SHA256, padded)                         |
| Envelope           | NIP-59 gift wrap: unsigned rumor → signed seal (kind 13) → wrap from an ephemeral key (kind 1059) |
| Signatures         | BIP-340 Schnorr, recomputed on every verification                                                 |
| Vault records      | XChaCha20-Poly1305, 24-byte random nonce, AAD = table + primary key                               |
| Passphrase         | scrypt N=2¹⁶ r=8 p=1, in a Web Worker, params stored per vault                                    |
| Subkeys            | HKDF-SHA256 from a random data key                                                                |
| Blinded indexes    | HMAC-SHA256 truncated to 32 hex characters                                                        |

All primitives come from audited `@noble/*` packages — pure TypeScript, no WASM, which
keeps the CSP strict and the bundle self-contained.

Two implementation notes that matter:

- **Signature verification never trusts a cache.** `nostr-tools` memoises `verifyEvent`
  on the event object under a symbol, and symbols survive object spread — so a tampered
  copy would inherit `verified: true`. Textor recomputes from the serialised event every
  time (ADR-011).
- **Every received rumor is validated identically** whether it arrived over a relay or a
  direct channel. There is no weaker path an attacker could steer onto.

Forward secrecy is **not** provided in v1. This is a deliberate, disclosed trade-off
(ADR-003), mitigated by 30-day expiration tags and versioned so a ratchet can land as
`v: 2`.

---

## 6. Storage

```
meta          k, v                                    ← plaintext: salt, KDF params, wrapped data key
identity      id, enc                                 ← sealed with the identity subkey
contacts      id*, enc, addedAt, lastSeenAt, blocked
conversations id*, enc, lastActivity, unread, pinned
messages      id, convoId*, tsCoarse, dir, status, enc
outbox        id, convoId*, attempts, nextAttemptAt, enc
seen          id*, ts                                 ← blinded relay event ids, pruned at 45 days
relays        id*, enc, enabled
settings      id, enc
```

`*` = HMAC-blinded. `tsCoarse` is hour-granular; exact timestamps live inside the
ciphertext. The result is that copying the database off a locked device reveals message
_counts_ and rough activity hours — not who the user talks to.

The one deliberate exception is language and theme, cached in `localStorage` so the lock
screen renders correctly before unlock (ADR-014). Nothing else is ever written there.

---

## 7. Delivery

- **Inbox model.** Each user publishes a NIP-17 kind-10050 list of their DM relays.
  Senders publish to the union of the recipient's inbox relays and their own, so delivery
  is deterministic rather than "hope we share a relay".
- **Redundancy.** Publishing goes to every healthy relay; one acknowledgement is success.
- **Self-copy.** Each chat message is also wrapped to the sender's own key, which is what
  makes vault restore reconstruct the sent side of a conversation.
- **Outbox.** Offline sends queue encrypted and retry with exponential backoff and full
  jitter. Retries reuse the original rumor, so they are idempotent.
- **Sync.** Subscription rewinds three days past the last cursor, because wrap timestamps
  are fuzzed up to two days backwards. Duplicates are free — dedup is by event id.
- **Health.** Per-relay connect/publish success and latency drive publish ordering and a
  visible relay panel. A relay that accepts reads but rejects writes becomes visible
  instead of silently swallowing messages (ADR-012).
- **Reading.** Conversations page backwards through the `[convoId+tsCoarse]` index so
  opening one decrypts a screenful rather than a lifetime (ADR-018). Unsent drafts are
  stored encrypted alongside the conversation.

**No background sync.** The outbox is encrypted under a key that exists only in the
page's memory, so a service worker has nothing to decrypt with — and storing plaintext
wraps instead would leak exactly what the vault protects. Consequently **no push
notifications** either. This is the largest usability cost of being serverless and is
stated plainly in the app (ADR-007).

---

## 8. Direct connections

A latency accelerator, never a delivery guarantee. Messages go to relays regardless
(ADR-008), which is precisely why no TURN server is needed: when NAT traversal fails,
nothing breaks.

Signalling rides the gift-wrapped relay path, so SDP is authenticated by the peer's
identity key before it is applied. Data-channel payloads are NIP-44 encrypted on top of
DTLS. Glare is resolved by perfect negotiation. There are **no presence beacons** — an
offer is the presence probe (ADR-009).

---

## 9. Deployment

A single GitHub Actions workflow (`.github/workflows/pipeline.yml`) runs on push: a
`verify` job — typecheck → lint → format check → token check → tests → dependency audit —
followed by a `deploy` job that only runs on `main` and only after `verify` passes, and
which builds, checks bundle integrity, and publishes to Pages. One workflow rather than
two so a push produces one run, and a build that fails its own tests is never deployed.

The Content-Security-Policy is injected at build time (`script-src 'self'`, no `eval`, no
remote origins) rather than written into `index.html`, so the dev server's looser needs
can never weaken production (ADR-015). `scripts/check-bundle.mjs` verifies in CI that the
policy is intact, no inline script exists, no remote subresource is referenced, and the
service worker precaches only local assets — and it is itself verified against
deliberately injected regressions.

`SOURCE_DATE_EPOCH` is pinned to the commit so the bundle is reproducible from a tag, and
every deployed file's SHA-256 is recorded in `BUILD-INFO.txt`.

---

## 10. Roadmap

1. **Forward secrecy** — `v: 2` double ratchet, or MLS-over-Nostr when it stabilises.
2. **File transfer** — chunked over WebRTC, encrypted blob hosts as fallback.
3. **Small groups** — sender fan-out first, MLS later.
4. **Live multi-device** — the self-copy format already supports it.
5. **Notifications** — a documented, user-self-hosted bridge; nothing we operate.
6. **Hardware / remote signer** — NIP-46, for keeping keys out of the browser entirely.
