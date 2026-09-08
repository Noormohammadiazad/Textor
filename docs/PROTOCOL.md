# Textor Wire Protocol

**Version 1.** Everything here is what a second implementation would need in order to
interoperate with Textor, and what an auditor would need in order to check it.

Textor speaks standard [Nostr](https://github.com/nostr-protocol/nips) private
messaging. It is not a proprietary protocol with a Nostr veneer: a Textor user can
exchange messages with any NIP-17 client (0xchat, Amethyst, …) and can move their
identity to one at any time. That is deliberate — a privacy tool whose users cannot
leave is not offering much.

---

## 1. Identity

An identity is a secp256k1 keypair.

| Item         | Value                                              |
| ------------ | -------------------------------------------------- |
| Curve        | secp256k1, BIP-340 (Schnorr)                       |
| Public form  | `npub1…` (NIP-19 bech32)                           |
| Derivation   | BIP-39 mnemonic → NIP-06 path `m/44'/1237'/0'/0/0` |
| Registration | none                                               |

The twelve-word mnemonic is a complete backup and restores in any NIP-06 client.

---

## 2. Message layering (NIP-17 / NIP-44 / NIP-59)

Every message — chat text and control frames alike — is wrapped three times:

```
┌─ kind 1059  gift wrap ─────────────────────────────────────────┐
│  author : single-use ephemeral key (discarded after sending)   │
│  tags   : ["p", <recipient>], ["expiration", <unix>]           │
│  created_at : now − random(0 … 2 days)                         │
│  content: NIP-44 v2 (ephemeral → recipient) of ↓               │
│  ┌─ kind 13  seal ────────────────────────────────────────────┐│
│  │  author : sender's real key, signed                        ││
│  │  tags   : []                                               ││
│  │  created_at : now − random(0 … 2 days)                     ││
│  │  content: NIP-44 v2 (sender → recipient) of ↓              ││
│  │  ┌─ rumor  (unsigned) ───────────────────────────────────┐ ││
│  │  │  kind 14 chat, or kind 20014 Textor control           │ ││
│  │  │  created_at : the real send time (whole seconds)      │ ││
│  │  │  tags : ["p", <recipient>], ["ms", <epoch ms>], …     │ ││
│  │  │  content : plaintext, or a control-frame JSON object  │ ││
│  │  └───────────────────────────────────────────────────────┘ ││
│  └────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────┘
```

**What each layer buys.**

- The **rumor is unsigned**. A leaked plaintext therefore proves nothing: anyone could
  have authored it. This is the deniability property, and it is why Textor refuses any
  rumor that arrives carrying a `sig`.
- The **seal** is signed by the sender's real key, so the recipient — and only the
  recipient, who alone can decrypt it — knows who wrote the message.
- The **gift wrap** is signed by a throwaway key that is generated per wrap and never
  reused. A relay sees an author it cannot link to anything, a recipient, and an opaque
  blob. Two wraps of the same rumor to the same person are unlinkable to each other.
- **Timestamps** on the seal and wrap are randomised backwards by up to two days, which
  defeats "who sent something at the same moment X received something" correlation.
  Backwards only: relays reject events dated in the future.
- **NIP-44 padding** rounds ciphertext to power-of-two-ish buckets, so message length
  leaks a size class rather than a byte count.

### 2.1 Validation on receipt

A wrap is rejected unless **all** of the following hold. Each check exists because
skipping it lets a peer or relay lie:

| Check                                  | What it prevents                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Wrap kind is 1059                      | Processing an unrelated event as a message                                                                              |
| Wrap content ≤ 512 KB                  | CPU exhaustion from an oversized blob                                                                                   |
| Wrap signature verifies                | Accepting a forged or mutated event                                                                                     |
| Seal kind is 13                        | Layer confusion                                                                                                         |
| Seal signature verifies                | Forged authorship                                                                                                       |
| `rumor.pubkey == seal.pubkey`          | A sealing a rumor attributed to B                                                                                       |
| Rumor has no `sig`                     | Loss of deniability; a signed rumor is a red flag                                                                       |
| `rumor.id == sha256(serialised rumor)` | Dedup, receipts and reply threading all key off this id, so a forged id could suppress or overwrite a different message |
| `rumor.created_at ≤ now + 24 h`        | Parking a message far in the future to pin it to the top                                                                |
| Tags are arrays of strings             | Type confusion downstream                                                                                               |

Signature verification is recomputed from scratch every time. `nostr-tools` memoises
`verifyEvent` on the event object under a symbol key, and symbol properties survive
object spread and structured clone — so an object carrying a stale `true` would skip
verification entirely. Textor never consults that cache.

---

## 3. Rumor kinds

### kind 14 — chat message (NIP-17)

| Field     | Value                                        |
| --------- | -------------------------------------------- |
| `content` | UTF-8 plaintext, 1 … 16 000 characters       |
| `tags`    | `["p", <recipient hex>]` (required)          |
|           | `["ms", "<epoch ms>"]` (optional, see below) |
|           | `["e", <rumor id>, "", "reply"]` (optional)  |

**The `ms` tag.** Nostr `created_at` is whole seconds, so five messages typed inside one
second sort arbitrarily — which shows up immediately as a scrambled burst in a chat.
The tag carries millisecond precision inside the encrypted rumor, so only the recipient
sees it, and other clients ignore an unknown tag. It is **ignored unless it agrees with
`created_at` to within one second**, so a peer cannot use it to reorder history or jump
to the top of a conversation.

### kind 20014 — Textor control frame

`content` is a JSON object with a `v` (protocol version) and a `t` discriminator. A
frame whose `v` is unknown is dropped, never guessed at — that is what allows a future
`v: 2` to ship without older clients misreading it.

```jsonc
{ "v": 1, "t": "receipt", "refs": ["<rumor id>", …], "state": "delivered" | "read" }
{ "v": 1, "t": "typing",  "active": true }
{ "v": 1, "t": "presence","online": true, "expires": 1788000000, "rtc": true }
{ "v": 1, "t": "rtc",     "sid": "…", "kind": "offer"|"answer"|"candidate"|"bye",
                          "sdp": "…", "candidate": {…}, "fingerprint": "sha-256 AB:CD:…" }
{ "v": 1, "t": "profile", "name": "…", "about": "…", "avatar": "data:image/…",
                          "relays": ["wss://…"] }
{ "v": 1, "t": "blob",    "id": "<sha256 of plaintext>", "seq": 0, "total": 3,
                          "data": "<base64 chunk ciphertext>" }
{ "v": 1, "t": "blobreq", "id": "<sha256 of plaintext>", "need": [0, 2] }
{ "v": 1, "t": "redact",  "refs": ["<rumor id>", …] }
```

Every field is bounded on parse: SDP ≤ 64 KB, ICE candidate ≤ 1 KB, avatar ≤ 64 KB and
must match `data:image/(png|jpeg|webp|gif);base64,…`, receipt batches ≤ 64 refs, relay
hints ≤ 12, chunk data ≤ 64 KB and must be base64, `seq` must address a real chunk of the
declared `total`, and a resend request may name at most 256 indexes. Anything outside
these limits makes the whole frame invalid.

Receipts are **batched** — one wrap acknowledging many messages. One wrap per
acknowledged message would roughly double relay traffic for an active conversation, and
every extra wrap is another row of metadata about who is talking to whom.

A `read` receipt implies everything the peer received before that message has also been
read, so the sender advances all earlier outgoing messages in that conversation.

Textor v1 does **not** emit `presence` beacons (see §5), but it parses and acts on them,
because another client — or a later version — may send them.

---

## 3.1 Attachments

An attachment is described by a tag on an ordinary kind 14 rumor, not by a separate kind:

```jsonc
["textor-attachment", "{\"kind\":\"voice\",\"id\":\"<sha256>\",\"key\":\"<hex>\",…}"]
```

The rumor's `content` stays human-readable ("Voice message · 0:12"), so a client that
does not know the tag shows a sensible message instead of an empty bubble — unknown tags
are ignored, content is not, which is the whole NIP-17 interoperability contract.

The descriptor carries everything needed to render the bubble before any payload arrives
(name, size, duration, waveform, blurred preview) **and** the key that decrypts it. It is
therefore only ever read from inside an already-decrypted rumor. The tag is capped at
8 KB, since it travels in every copy of the message on every relay.

Payload bytes follow as `blob` frames. Each chunk is 32 KiB of plaintext encrypted with
XChaCha20-Poly1305 under a random single-use per-blob key, with a STREAM-style nonce
(16-byte per-blob salt ‖ 8-byte chunk index) and an AAD binding
`textor/blob/v1|<blob id>|<index>|<total>`. That AAD is what makes reordering,
truncation, and cross-payload splicing authentication failures rather than corruption.
After reassembly the SHA-256 of the plaintext is re-checked against the declared id,
which catches a sender whose descriptor disagrees with what they sent.

Chunks are 16 KiB of plaintext, not larger, because a chunk expands about 3.35x before it
reaches the wire: base64 into the frame, base64 again in the NIP-44 seal, and base64 once
more in the gift wrap. A 32 KiB chunk measures 109,732 bytes as a wrap, past the 64 KiB
ceiling most public relays enforce; 16 KiB measures 55,112.

Payloads up to 512 KB go over relays (32 events) and therefore reach a recipient who is
offline. Larger ones require the direct WebRTC channel, and are refused rather than queued
if it is not available. See ADR-028 through ADR-033.

## 3.2 Withdrawing a message

A `redact` frame asks the peer to delete messages, and takes any attachment payload with
it on both devices. It is queued durably, so an offline peer honours it on reconnect.

A client only sends a withdrawal for messages it authored, and only honours one for
messages the _sender_ authored. Without the second rule anyone who could reach your inbox
could delete your own words out of your own conversation.

This is a tombstone, not an erasure: a modified client can ignore it, and a relay may
still hold the wrap. See ADR-035.

## 4. Delivery

### 4.1 Where messages are published

Each user publishes a **NIP-17 kind 10050** replaceable event listing the relays where
they read their inbox. Senders publish to the union of the recipient's announced inbox
relays and their own write relays. Without this, delivery degrades to "hope we happen to
share a relay", which is how Nostr DMs used to get lost.

### 4.2 Self-addressed copies

Every chat message is wrapped **twice**: once to the recipient, once to the sender's own
key. The self-copy is what lets a restored vault — or a second device — reconstruct the
sent side of a conversation. Control frames get no self-copy; they are not worth the
extra publish.

### 4.3 Delivery states

```
queued ──▶ sending ──▶ sent ──▶ delivered ──▶ read
   │                     ▲
   └──▶ failed ──────────┘   (manual retry)
```

- `sent` — at least one relay acknowledged the publish.
- `delivered` — the peer's device acknowledged with a receipt frame.
- `read` — the peer opened the conversation (only if they have read receipts on).

State only ever moves **forward**. A `delivered` receipt arriving after a `read` receipt
does not downgrade the tick.

### 4.4 Retry

Messages that no relay accepted stay in an encrypted outbox and retry with exponential
backoff and full jitter (2 s base, 5 min cap, 12 attempts) before being marked failed.
A message is idempotent across retries because the rumor — and therefore its id — is
built once and stored, not rebuilt per attempt.

### 4.5 Subscription and rewind

```
{ "kinds": [1059], "#p": ["<my pubkey>"], "since": <lastSync − 3 days> }
```

The three-day rewind exists because wrap timestamps are fuzzed up to two days into the
past: a subscription anchored exactly at "when I last synced" would miss anything whose
fuzz pushed it behind that mark. The overlap is free — duplicates are deduplicated by
event id.

---

## 5. Direct connections (WebRTC)

Strictly an accelerator. Every chat message is published to relays **regardless** of
whether a direct channel is open, because SCTP accepting a frame says nothing about the
peer having stored it. A failed direct connection therefore costs latency, never a
message.

- **Signalling** travels as `rtc` control frames through the normal gift-wrapped relay
  path, so an offer is authenticated by the sender's identity key before any SDP is
  applied.
- **Payloads** on the data channel are NIP-44 encrypted between the two identity keys.
  DTLS is _not_ treated as the confidentiality boundary; a compromised DTLS handshake
  still yields ciphertext.
- **Fingerprints** are carried inside the encrypted frame and cross-checked against the
  SDP that was applied. A mismatch aborts the session.
- **Glare** is resolved by perfect negotiation: the peer with the lexicographically
  smaller public key is polite and yields.
- **ICE** uses public STUN only. There is no TURN, because running one would mean
  running a server. Users may add their own in settings.

**There is no presence protocol.** An offer _is_ the presence probe: if the peer is
online they answer within a second or two, and if they are not, nothing happens. This
removes a whole class of periodic beacons — and the metadata they would publish about
when each user is awake — for no loss in behaviour.

---

## 6. Invites

A binary payload, base64url-encoded, carried in a URL **fragment** (`#/i/…`) so it never
reaches a web server.

```
u8      version = 1
[32]    pubkey
u32be   created_at (unix seconds)
u8 + …  display name (UTF-8, ≤ 96 bytes)
u8      relay count (≤ 6), then per relay:
          u8  scheme flag (0 = wss://, 1 = ws://, 2 = literal)
          u8 + … host and path (UTF-8, ≤ 160 bytes)
[64]    BIP-340 signature over sha256(everything above)
```

Binary rather than JSON because the result goes into a QR code: ~150 bytes here versus
~400 for equivalent JSON, which is the difference between a code that scans instantly
across a table and one that does not.

The signature does not make the channel trustworthy — whoever hands you an invite could
have invented the whole thing. It stops a _forwarding party_ from rewriting the relay
hints inside an otherwise genuine invite, which would silently black-hole the
conversation. Real key verification is the safety-number ceremony.

Invites older than 180 days are flagged as stale, since their relay hints have probably
moved.

---

## 7. Safety numbers

```
digest  = sha256("textor/safety-number/v1" ‖ sort(pubkeyA, pubkeyB))
digits  = 12 groups of 5, each from a distinct 20-bit window of the digest
emoji   = 8 glyphs from a 64-entry table, from bytes 24…31
```

Identical for both parties regardless of argument order, so it can be compared aloud.
This is the only step that turns "encrypted to some key" into "encrypted to the person I
mean" — no amount of cryptography can detect having been handed the wrong key in the
first place.

---

## 8. Local storage

| Layer              | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Passphrase → KEK   | scrypt, N=2¹⁶, r=8, p=1, 32 bytes (params stored per vault)            |
| KEK → data key     | XChaCha20-Poly1305 wrap of a random 32-byte key                        |
| Data key → subkeys | HKDF-SHA256: `record`, `index`, `identity`                             |
| Record bodies      | XChaCha20-Poly1305, random 24-byte nonce, AAD = `textor/<table>/<id>`  |
| Primary keys       | `HMAC-SHA256(indexKey, "<domain> <value>")`, truncated to 32 hex chars |
| Indexed timestamps | truncated to the hour                                                  |

The passphrase never encrypts records directly, so changing it rewraps 32 bytes instead
of rewriting the database. The AAD binds each ciphertext to its row, so an attacker with
write access to IndexedDB cannot graft one contact's sealed metadata onto another's.
Blinded primary keys mean the index structures — which IndexedDB stores in the clear —
reveal nothing about who the user talks to.

The only plaintext stored anywhere is the KDF salt, the KDF parameters, the wrapped data
key, and (outside the vault, by design) the chosen language and theme so the lock screen
can render correctly before unlock.

---

## 9. Backup files

```jsonc
{
  "format": "textor-vault-export",
  "version": 1,
  "createdAt": 1788000000000,
  "kdf": { "algo": "scrypt", "N": 65536, "r": 8, "p": 1, "salt": "<hex>" },
  "compression": "gzip" | "none",
  "payload": "<base64 of  version ‖ nonce(24) ‖ ciphertext+tag>"
}
```

Encrypted under its own passphrase, independent of the vault's: a backup travels, and
should not inherit the threat model of a passphrase typed daily on one device. KDF
parameters travel with the file so it can still be opened by a build with different
defaults.

Import **merges** rather than replaces, keyed by rumor id, so re-importing the same
backup twice is a no-op. Conversation ids are recomputed under the importing vault's
index key rather than trusted from the file.
