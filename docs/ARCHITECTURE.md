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

Explicit non-goals for v1: anonymity against a global passive network adversary, group
calls, groups beyond a hundred people, live multi-device sync. One-to-one voice and video calls are in scope
(§8.1), with no server of ours in the path.

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
accelerates delivery without ever being trusted to guarantee it; calls are WebRTC media
signalled through the same sealed frames; everything is stored in an encrypted local
vault; the site is only code.

---

## 3. Layering

Strictly one direction. `src/core/` is framework-free and fully testable in Node.

```
src/
  app/        shell, hash router, Zustand store, PWA update prompt, idle
              warm-up of lazy chunks; `callsChunk.ts`, the one door into
              calling, which is never warmed
  ui/         screens and components — no transport or database access.
              `lazyViews.tsx` is the one table of `import()` split points;
              `chunks/` holds their entry modules (settings, verify, qr,
              backup, access, people, groups, interactive, calls), and
              `access/`, `groups/`, `interactive/`, `emoji/` and `calls/`
              exist only inside lazy chunks. `access` is onboarding,
              restoring a backup and Settings → Security; `people` is adding
              a contact, an invite link's page and a contact's own page. The
              lock screen, its PIN field and its pattern pad stay in the
              shell
  styles/     design tokens, then components; no framework, no runtime cost
  media/      browser capture and processing — voice recording, waveforms,
              image re-encoding. Browser APIs, so deliberately outside core/
  i18n/       en + fa dictionaries, compile-time-checked keys
  core/
    crypto/   gift wrap, NIP-44, vault sealing, KDF (+ worker), safety numbers,
              chunked attachment encryption, the biometric gate (and, for
              the access chunk only, setting it up)
    identity/ keygen, mnemonic, invite binary codec
    models/   protocol frames and validation, rooms (who a rumor is between),
              poll and checklist specs and their deterministic tallies,
              domain types
    vault/    Dexie schema, key hierarchy and its keyslots, typed repository,
              export/import
    transport/ relay sockets, pool, scoring + health, Nostr kinds/filters,
              NIP-77 negentropy, WebRTC session manager
    engine/   Messenger — the orchestrator, the connection-state derivation,
              inbox sync (a plan per relay, ADR-050), and the chunked
              attachment transfer engine
    mls/      forward-secret groups: the ciphersuite on @noble, Marmot's
              event shapes and components, one group's state machine, and the
              runtime the engine loads on demand — the `lazy-runtime` chunk,
              reached only through `import()` in the engine (ADR-049)
    calls/    the call state machine, its peer connection (perfect
              negotiation), ICE failure diagnosis, device access, and the
              network test — reached only from the calls and settings chunks
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
NIP-06 client can restore. They also open the vault on this device, and any backup file
made from it, whichever everyday way in was chosen (ADR-054).

The recovery-phrase ceremony is driven by **persisted state** (`mnemonicBackedUp`), not
by a step in a wizard. Someone who abandons it halfway — or closes the tab — is asked
again next time, rather than silently ending up with an unrecoverable identity. Deferring
it downgrades to a dismissible reminder.

Contact exchange uses a signed binary invite (~150 bytes, QR-friendly) carried in a URL
**fragment**, so the payload never reaches a web server. See
[`PROTOCOL.md §6`](PROTOCOL.md).

---

## 5. Cryptography

| Purpose            | Primitive                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Message encryption | NIP-44 v2 (secp256k1 ECDH → HKDF-SHA256 → ChaCha20 + HMAC-SHA256, padded)                              |
| Envelope           | NIP-59 gift wrap: unsigned rumor → signed seal (kind 13) → wrap from an ephemeral key (kind 1059)      |
| Signatures         | BIP-340 Schnorr, recomputed on every verification                                                      |
| Vault records      | XChaCha20-Poly1305, 24-byte random nonce, AAD = table + primary key                                    |
| Keyslots           | the data key sealed once per way in: passphrase, recovery phrase, PIN, biometrics, device key          |
| Passphrase         | scrypt N=2¹⁶ r=8 p=1, in a Web Worker, params stored per slot                                          |
| PIN or pattern     | scrypt N=2¹⁵ r=8 p=1, erased after ten wrong tries — a lockout, not an offline defence                 |
| Recovery phrase    | HKDF-SHA256 of the normalised twelve words: 128 random bits need no stretching                         |
| Biometrics         | AES-GCM under a local non-extractable key, opened after a WebAuthn user-verified assertion             |
| Open instantly     | AES-GCM under a non-extractable WebCrypto key — no protection at rest, and never beside another way in |
| Subkeys            | HKDF-SHA256 from a random data key                                                                     |
| Blinded indexes    | HMAC-SHA256 truncated to 32 hex characters                                                             |

All primitives come from audited `@noble/*` packages — pure TypeScript, no WASM, which
keeps the CSP strict and the bundle self-contained. The one exception is the local key
behind biometrics and opening instantly: it has to be one the browser holds and will not
hand to script, so those slots use the browser's own AES-GCM. WebAuthn supplies no key at
all, only its verification of the person (ADR-058).

Two implementation notes that matter:

- **Signature verification never trusts a cache.** `nostr-tools` memoises `verifyEvent`
  on the event object under a symbol, and symbols survive object spread — so a tampered
  copy would inherit `verified: true`. Textor recomputes from the serialised event every
  time (ADR-011).
- **Every received rumor is validated identically** whether it arrived over a relay or a
  direct channel. There is no weaker path an attacker could steer onto.

Direct messages and small groups have **no** forward secrecy. This is a deliberate,
disclosed trade-off (ADR-003), mitigated by 30-day expiration tags and versioned so a
ratchet can land as `v: 2`.

Forward-secret groups have it, from MLS (RFC 9420) in Marmot's shapes (ADR-049):

| Purpose         | Primitive                                                                          |
| --------------- | ---------------------------------------------------------------------------------- |
| Ciphersuite     | 0x0001: DHKEM(X25519), HKDF-SHA256, AES-128-GCM, Ed25519 — all `@noble`            |
| Group messages  | MLS PrivateMessage, then ChaCha20-Poly1305 under the epoch's exporter secret       |
| Member identity | Ed25519 leaf key, authorised by the account's Nostr key in a signed identity proof |
| Healing         | a joiner commits a fresh leaf within ten minutes, and every member weekly          |

HPKE (RFC 9180) is the one construction composed here rather than imported. It is checked
against the reference implementation in both directions.

---

## 6. Storage

```
meta          k, v                                    ← plaintext: the keyslots, each a sealed copy of the data key
identity      id, enc                                 ← sealed with the identity subkey
contacts      id*, enc, addedAt, lastSeenAt, blocked
conversations id*, enc, lastActivity, unread, pinned   ← kind, members and group name sealed in enc
messages      id, convoId*, tsCoarse, dir, status, enc
outbox        id, convoId*, attempts, nextAttemptAt, enc
reactions     id, messageId, convoId*, enc
updates       id, targetId, convoId*, enc              ← poll votes and checklist changes
packs         id, createdAt, enc
seen          id*, ts, enc                            ← blinded event ids by created_at hour, and tombstones (ADR-051)
relays        id*, enc, enabled
settings      id, enc                                 ← includes the sync state: per-relay marks and the dedup floor
mlsGroups     id*, enc                                ← a forward-secret group's MLS state, never exported
mlsKeys       id*, enc                                ← KeyPackage private keys, deleted when replaced or withdrawn
```

`*` = HMAC-blinded. `tsCoarse` is hour-granular; exact timestamps live inside the
ciphertext. The result is that copying the database off a locked device reveals message
_counts_ and rough activity hours — not who the user talks to.

The one deliberate exception is language and theme, cached in `localStorage` so the lock
screen renders correctly before unlock (ADR-014). Nothing else is ever written there.

**Opening the vault (ADR-054, ADR-058, ADR-059).** The data key is random, so any number of
secrets can each hold a sealed copy of it — LUKS-style keyslots in `meta`. At most one of
each kind:

| Slot         | Opens with                                                                      | Protects a copied or stolen device         |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `biometric`  | a local key, once the device's authenticator or a security key verifies someone | no — the key sits beside the vault         |
| `pin`        | a PIN or a pattern, through scrypt; ten wrong tries erase it                    | no — minutes for a GPU                     |
| `passphrase` | the passphrase, through scrypt                                                  | as well as the passphrase resists guessing |
| `device`     | nothing: a non-extractable key beside it, and no other everyday slot            | no — this is "open instantly", and says so |
| `recovery`   | the twelve words                                                                | yes — 128 random bits, kept offline        |

A cold start tries them in order of convenience: the device key silently, then one
biometric prompt once the page is seen, then the PIN or pattern, then the passphrase field.
"Use your recovery phrase instead" is always there. Adding or removing a slot, or showing
the recovery phrase, first asks the person to open Textor again. Opening instantly stands
alone: every write of the slot list drops it beside a biometric, PIN or passphrase slot,
and adding it beside one is refused. The vault is as strong as its weakest slot, and Settings →
Security shows that level. Biometrics are a gate in front of a local key: WebAuthn is asked
only to verify the person, a `Presence` proof made by `biometricGate.ts` is spent to open
the slot, and no key comes from the authenticator, so where it keeps its credential does
not matter. Where the device has no authenticator of its own to use — Linux, or one not set
up — a FIDO2 security key can stand at the gate instead. A PIN or pattern is offered only
where the recovery phrase or a passphrase can open the device after a lockout. At start,
before anything opens, `Vault.tidy()` drops what this build does not allow: an instant slot
beside another way in, and the retired PRF slots of ADR-054 to ADR-057, which the lock
screen then mentions. Vaults made before
keyslots are read as one passphrase slot and moved the first time they open; the recovery
slot is added then too.

---

## 7. Delivery

- **Inbox model.** Each user publishes a NIP-17 kind-10050 list of their DM relays.
  Senders publish to the union of the recipient's inbox relays and their own, so delivery
  is deterministic rather than "hope we share a relay".
- **Connections.** Textor owns its relay sockets (ADR-036). Configured relays connect at
  unlock and stay connected; a contact's inbox relays are pre-warmed when their
  conversation opens. Reconnects start at 400 ms, an adaptive keepalive finds dead
  sockets, and `online`, visibility, focus, back/forward-cache restores and resume from
  sleep all wake the transport at once.
- **Redundancy.** A publish goes to every target at once and the message is sent at a
  quorum — two acknowledgements from four or more targets, otherwise one. The rest settle
  in the background. A slow quorum brings in healthy, already-connected standby relays
  (ADR-037).
- **Groups.** A conversation is the set of people a rumor names (NIP-17), keyed by a
  blinded hash of that set; two people is the direct case of the same thing. A group
  message is one rumor wrapped once per member, each copy judged on its own relay quorum
  and retried on its own, and the message's state is the least advanced member's. Up to
  eight people, enforced on arrival as well as on creation (ADR-044).
- **Self-copy.** Each chat message is also wrapped to the sender's own key and published
  to the sender's own inbox relays, which is what makes vault restore reconstruct the sent
  side of a conversation. Reactions, votes and checklist changes are copied too; other
  control frames are not.
- **Outbox.** Offline sends queue encrypted and retry with exponential backoff and full
  jitter. Retries reuse the original rumor, so they are idempotent. Messages and
  attachment chunks travel in separate lanes, so a photo never holds up a text (ADR-038).
- **Sync.** One subscription, a plan per relay (ADR-050).
  - A relay that speaks NIP-77 is subscribed live-only, then reconciled by negentropy
    against the wraps this device holds, and asked only for what is missing.
  - Any other relay is read from its own high-water mark, less a three-day rewind, since
    wrap timestamps are fuzzed up to two days backwards.
  - A mark moves only once that connection is proven complete.
  - Duplicates are free: dedup is by event id, and a duplicate is skipped before it is
    even parsed. The seen table behind it is compacted, and nothing older than the point
    it was compacted to is processed (ADR-051).
  - A catch-up runs on start and after a read relay drops.
- **Forward-secret groups.** Invitations are gift wraps. Everything after is kind-445
  events on the group's own relays, read through one subscription for all groups, with a
  mark per group per relay. Each group's operations run one at a time, and its state is
  written back before anything is published (ADR-049).
- **Health.** Recency-weighted publish reliability, latency, and a circuit breaker drive
  relay ranking and a visible relay panel. A relay that accepts reads but rejects writes
  becomes visible instead of silently swallowing messages (ADR-012, ADR-037).
- **Read state.** A message that arrives in the conversation on screen is never counted as
  unread, rather than counted and cleared afterwards — the engine is told which
  conversation is being watched, and whether the window is visible and focused, so the
  question is settled as the message is stored (ADR-039).
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

### 8.1 Calls

One-to-one voice and video (ADR-046). A call is a second, separate peer connection,
signalled through the same sealed `rtc` frames — shaped after the NIP-AC draft, with the
opening offer's rumor id naming the call — and it carries DTLS-SRTP media whose keys are
bound to the identity keys by that signalling. Unlike the direct channel it is not an
accelerator: there is no relay fallback for live audio, so when ICE cannot connect the
call fails, and says why (§8.2).

```
 ChatView ── startCall ──▶ store ── import() ──▶ lazy-calls chunk
                             ▲                    CallManager ── CallSession ── RTCPeerConnection
 Messenger ── callSignal ────┘                         │
   ▲  #routeCall: accepted contact? fresh offer?       └── sendCallSignal / recordCall ──▶ Messenger
```

The engine does three small things eagerly: it routes call frames from accepted contacts
to whoever listens for `callSignal`, writes an offer too old to ring as a missed call,
and exposes `sendCallSignal`, `recordCall` and the ICE configuration. Everything else —
the state machine, the peer connection, device access, the in-call screen, its styles and
its words — is the `lazy-calls` chunk, fetched when a call is placed or an offer rings
and never warmed: a call needs the network by definition, so an offline session gains
nothing from having it cached. `scripts/check-bundle.mjs` fails the build if calling code
turns up in a shell chunk.

While a call is live the vault is kept open against the idle timer, and lock-on-hide
waits for the call to end; locking hangs up. Each side writes the call into the
conversation as a local record, and a missed call counts as unread.

### 8.2 When the network is in the way

Textor runs no TURN server, so a call between two symmetric NATs, or out of a network
that blocks UDP, cannot connect without one the user provides. What each side gathered
decides what the screen says: a configured TURN server that allocated nothing, a network
that learned no public address, the same on the other side, or two public addresses that
still could not meet — which, with the two STUN operators the defaults name, can be told
apart from an ordinary NAT by the ports each was shown. Settings → Calls takes STUN and
TURN servers, can test the network without calling anyone, and can force every call
through TURN so the other person never sees this device's address.

---

## 9. Deployment

A single GitHub Actions workflow — the one file in `.github/workflows/` — runs on push:
a `verify` job — typecheck → lint → format check → token check → tests, with coverage
thresholds → dependency audit — followed by a `deploy` job that only runs on `main` and
only after `verify` passes, and which builds, checks bundle integrity, and publishes to
Pages. One workflow rather than
two so a push produces one run, and a build that fails its own tests is never deployed.

The file moves to a new name on every push (`npm run rotate:workflow`, which names it
`<name>-<UTC date>-<UTC time>.yml` after its own `name:`), so every push is that
workflow's run #1 (ADR-048). The test suite fails if the directory holds anything but one
workflow under a name the rotation gave it.

The Content-Security-Policy is injected at build time (`script-src 'self'`, no `eval`, no
remote origins) rather than written into `index.html`, so the dev server's looser needs
can never weaken production (ADR-015). `scripts/check-bundle.mjs` verifies in CI that the
policy is intact, no inline script exists, no remote subresource is referenced, and the
service worker precaches only local assets — and it is itself verified against
deliberately injected regressions.

The precache is a budget (800 KiB), and it holds only what a returning user needs before
they can read and answer a message. Everything else is a `lazy-*` chunk, excluded from the
precache and fetched in the background once the app is idle, so it is cached for offline
use after one online session without costing anything at install (ADR-040, ADR-043).
Calling is the one lazy chunk that is not warmed: it loads only when a call is placed or
rings, since a call needs the network anyway (§8.1, ADR-046). The MLS runtime is loaded
by the engine rather than a screen: when the device holds a forward-secret group, when an
invitation arrives or a group is made, or 20 s after start when a KeyPackage needs
upkeep. The check fails the build if MLS code reaches a shell chunk too (ADR-049).

`SOURCE_DATE_EPOCH` is pinned to the commit so the bundle is reproducible from a tag, and
every deployed file's SHA-256 is recorded in `BUILD-INFO.txt`.

---

## 10. Roadmap

1. **Forward secrecy for direct messages** — forward-secret groups have it through MLS
   (ADR-049); a two-person MLS group, or a `v: 2` ratchet, could bring it to direct
   conversations.
2. **File transfer** — chunked over WebRTC, encrypted blob hosts as fallback.
3. **Media in forward-secret groups** — up to a hundred people is shipped, text only
   (ADR-049). Attachments need Marmot's encrypted media over a host the user picks.
   Group calls likewise: a mesh is fine for three or four, and beyond that needs a
   selective forwarding unit the user runs — calls are one to one today (ADR-046).
4. **Live multi-device** — the self-copy format already supports it.
5. **Notifications** — a documented, user-self-hosted bridge; nothing we operate.
6. **Hardware / remote signer** — NIP-46, for keeping keys out of the browser entirely.
