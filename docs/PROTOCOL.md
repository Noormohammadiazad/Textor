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

| Field     | Value                                                          |
| --------- | -------------------------------------------------------------- |
| `content` | UTF-8 plaintext, 1 … 16 000 characters                         |
| `tags`    | `["p", <recipient hex>]`, one per recipient, sorted (required) |
|           | `["ms", "<epoch ms>"]` (optional, see below)                   |
|           | `["subject", "<group name>"]` (groups, optional; §3.3)         |
|           | `["e", <rumor id>, "", "root" \| "reply"]` (optional)          |

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
{ "v": 1, "t": "rtc",     "kind": "offer", "media": "audio"|"video", "sdp": "…",
                          "fingerprint": "…" }                       // opens a call (§5.1)
{ "v": 1, "t": "rtc",     "call": "<rumor id of that offer>",
                          "kind": "ringing"|"answer"|"offer"|"candidate"|"bye",
                          "sdp": "…", "candidate": {…}, "reason": "busy" }
{ "v": 1, "t": "profile", "name": "…", "about": "…", "avatar": "data:image/…",
                          "relays": ["wss://…"] }
{ "v": 1, "t": "blob",    "id": "<sha256 of plaintext>", "copy": "<32 hex>", "seq": 0,
                          "total": 3, "data": "<base64 chunk ciphertext>" }
{ "v": 1, "t": "blobreq", "id": "<sha256 of plaintext>", "copy": "<32 hex>", "need": [0, 2] }
{ "v": 1, "t": "redact",  "refs": ["<rumor id>", …] }
{ "v": 1, "t": "vote",    "poll": "<rumor id>", "choices": ["o0", …] }
{ "v": 1, "t": "check",   "list": "<rumor id>", "item": "i0", "done": true }
{ "v": 1, "t": "check",   "list": "<rumor id>", "item": "x3f9a…", "label": "Sunscreen" }
```

An `rtc` frame is for the direct channel when it has a `sid` and for a call when it has
none; one with both a `sid` and any call field is invalid. A call frame carries exactly the
payload its kind needs — a description for `offer` and `answer`, a candidate for
`candidate`, nothing for `ringing` and `bye` — and a `reason` only on `bye`.

Every field is bounded on parse: SDP ≤ 64 KB, ICE candidate ≤ 1 KB, avatar ≤ 64 KB and
must match `data:image/(png|jpeg|webp|gif);base64,…`, receipt batches ≤ 64 refs, relay
hints ≤ 12, chunk data ≤ 64 KB and must be base64, `seq` must address a real chunk of the
declared `total`, and a resend request may name at most 256 indexes. A ballot names at
most 10 distinct option ids, and a checklist change must either tick (`done`) or add
(`label`, one line of ≤ 120 characters) — ids are `[a-z0-9]{1,12}`. Anything outside
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

Payload bytes follow as `blob` frames. Each chunk is 16 KiB of plaintext encrypted with
XChaCha20-Poly1305 under a random key, with a STREAM-style nonce (16-byte salt ‖ 8-byte
chunk index) and an AAD binding `textor/blob/v1|<blob id>|<index>|<total>`. That AAD is
what makes reordering, truncation, and cross-payload splicing authentication failures
rather than corruption. After reassembly the SHA-256 of the plaintext is re-checked
against the declared id, which catches a sender whose descriptor disagrees with what they
sent.

**Copies.** The id names the bytes, so one file sent twice, or by two people, is one id
under two keys. Each sealing is a **copy**, named by
`copy = hex(SHA-256("textor/blob/copy|" ‖ key ‖ salt))[0..32]`. Chunks are stored,
pushed and requested by id **and** copy (ADR-052):

- `blob` and `blobreq` frames carry `copy`. A receiver files a chunk under the copy it
  names, and still checks that it authenticates under that copy's key.
- A chunk with no `copy` comes from a client that predates it. It goes to whichever
  expected copy of that id its key opens. Early chunks without a copy are held until one
  opens them, rather than dropped at the first copy described.
- A `blobreq` with no `copy` is answered with every copy held of that id. The requester
  keeps only the one its key opens.
- A key seals exactly one plaintext. Sending a sticker sends the pack's own copy again —
  the same ciphertext under the same key — rather than sealing another.

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
could delete your own words out of your own conversation. A call is the exception: it has
no author, so either person in it may withdraw it, and a withdrawal naming a call is
honoured when it comes from the other person in that call — which is to say, when the
record is in the direct conversation with the sender (§5.1).

Every deletion leaves a tombstone keyed by rumor id and author, blinded and kept with the
seen marks for 45 days. A copy of the rumor that arrives afterwards is dropped: a sender's
outbox re-wraps on every retry, so the seen marks, which name wraps, would not recognise
it. A withdrawal naming a rumor this device does not yet have is kept as a tombstone under
the sender's name, because wrap timestamps are fuzzed and a catch-up read can return the
withdrawal first; it can only ever stop what that sender wrote, or a call with them.
Withdrawing something that was still unread takes it off the unread count.

This is a tombstone, not an erasure: a modified client can ignore it, and a relay may
still hold the wrap. See ADR-035 and ADR-047.

## 3.3 Groups

NIP-17 has no group object. A conversation **is** the set of people a rumor names: its
author plus every `p` tag. Two people is a direct conversation; three to eight is a group.

- **Sending.** One rumor names every other member in sorted `p` tags and is sealed and
  wrapped once per member, plus the self-copy. Every copy has the same rumor id, which is
  what receipts, replies, reactions and deduplication all key off.
- **Placing on arrival.** A receiver computes the set, removes itself, and files the
  message under a conversation keyed by that set (`blind("convo", sort(set))` — for two
  people, exactly the id a direct conversation has always had). A rumor that names
  recipients but not the receiver is dropped as misdelivered.
- **Size.** Rooms of more than **8 people, sender included**, are refused on arrival as
  well as on creation: each extra member is another wrap on every message, and a stranger
  must not be able to make this client fan its replies out to hundreds of keys.
- **Membership is fixed.** A different set of people is a different conversation. There
  is no "add member" message to forge or to race.
- **Name.** An optional `subject` tag carries the group's name; a receiver adopts it only
  if the message is newer than the one that set the current name.
- **Requests.** A group is shown as a request unless we sent into it ourselves or its
  author is an accepted contact. Strangers in a group are not added to the address book.
- **Blocking** is by author in a group: a blocked person's messages are dropped, the group
  is not.
- **Plumbing stays person to person.** Receipts, typing, signalling, profiles and
  attachment chunks are always addressed to one person. Only `redact`, `vote` and `check`
  may be addressed to a whole group; anything else addressed to one is ignored.

## 3.4 Polls and checklists

Both are kind 14 messages. The structure is in tags and `content` is a plain-text
rendering, so a client without polls shows a readable question:

```jsonc
["poll", "Where should we hike?"]
["polltype", "singlechoice" | "multiplechoice"]   // NIP-88's names
["option", "o0", "Tochal"]                        // NIP-88's shape: id, label
["checklist", "Packing list"]
["item", "i0", "Water"]
```

Votes and ticks are `vote` and `check` control frames, sent to every participant and
**copied to the sender's own inbox** so a second device shows them. Every participant
counts them itself; there is no tally authority, so the rules are deterministic:

- only frames addressed to the poll's own conversation count — someone outside the room
  can name a poll's id, but their frame lands in a different room;
- each voter's newest ballot stands (ties on time break on rumor id); an empty ballot
  withdraws the vote; unknown options are dropped; a single-choice poll keeps only the
  first valid choice;
- a checklist applies additions before ticks, so transit order does not matter, then each
  item takes its newest tick; additions stop at 50 items, in arrival order.

A public NIP-88 poll would publish who asked what of whom. See ADR-045.

## 3.5 Forward-secret groups (MLS over Nostr, as Marmot)

A second kind of group, chosen when the group is made. It uses MLS (RFC 9420) in the
shapes [Marmot](https://github.com/marmot-protocol/marmot) defines, with ciphersuite
0x0001 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`). Up to **100 people**, text only.
ADR-049 gives the reasoning and every place this differs from Marmot.

**KeyPackage** — kind 30443, addressable, signed by the account, published to its write
relays while invitations are on (Settings → Privacy):

```jsonc
{
  "kind": 30443,
  "content": "<base64 MLSMessage(mls_key_package)>",
  "tags": [
    ["d", "<random 32-byte hex slot, kept across refreshes>"],
    ["mls_protocol_version", "1.0"],
    ["i", "<KeyPackageRef, hex>"],
    ["mls_ciphersuite", "0x0001"],
    ["mls_extensions", "0x0006"],
    ["mls_proposals", "0x0001", "0x0002", "0x0003", "0x0007"],
    ["app_components", "0x0001", "0x8001", "0x8003", "0x8004", "0x8009"],
  ],
}
```

- The leaf's credential is `basic`, naming the account's 32-byte key. The leaf carries an
  **identity proof** (component 0x8009, v2): a kind-450 event, signed by the account,
  authorising that leaf's Ed25519 key. A leaf without a valid proof is refused, in a
  KeyPackage, a Welcome or a commit.
- **Lifetime.** 83 days. It is replaced when it has 14 days left, or once a Welcome has
  used it. A replaced package's private keys are kept 7 days for a Welcome already in
  flight, then deleted.
- **Withdrawal.** Turning invitations off publishes a NIP-09 deletion (`e`, `a` and
  `k: 30443` tags) and deletes the private keys.

**Welcome** — a kind 444 rumor, gift-wrapped to the invitee exactly like a message (§2):

```jsonc
{
  "kind": 444,
  "content": "<base64 MLSMessage(mls_welcome)>",
  "tags": [
    ["e", "<KeyPackage event id>"],
    ["relays", "wss://…", "…"],
  ],
}
```

It is accepted only from a member the group names as an admin, and only once. From
someone not accepted it arrives as a request; from someone blocked it is dropped.

**Group events** — kind 445, published to the group's relays (its routing component):

```jsonc
{
  "kind": 445,
  "pubkey": "<fresh throwaway key, one per event>",
  "tags": [["h", "<nostr_group_id, 32-byte hex>"]],
  "content": "<base64( nonce(12) ‖ ChaCha20-Poly1305(key, nonce, MLSMessage) )>",
}
```

`key = MLS-Exporter("marmot", "group-event", 32)` of the epoch the message belongs to.
Commits and proposals are MLS PublicMessages; everything else is a PrivateMessage. An
event with any other tag shape is ignored.

**Group state** lives in the GroupContext, in the app-data dictionary extension (0x0006):
the list of required components (0x0001), the profile (0x8001: name and description),
the admins (0x8003) and routing (0x8004: `nostr_group_id` and relays). Integers are QUIC
varints, canonical only.

**Inside a PrivateMessage** is one unsigned Nostr event, serialised as JSON:

| kind | Meaning  | Tags                                                            |
| ---- | -------- | --------------------------------------------------------------- |
| 9    | message  | `["ms", …]`; a reply adds NIP-10 `e` tags (`root` / `reply`)    |
| 7    | reaction | `["e", <message id>]`, `["k", "9"]`; `content` is the emoji     |
| 5    | deletion | `["e", <id>]`, `["k", "9" \| "7"]` — only one's own is honoured |

Its `id` is checked against its content, and its `pubkey` must be the account of the
leaf MLS says sent it. There are no `p` tags: the group is the MLS group.

**Rules every member applies**, so a commit refused by one is refused by all:

- Only an admin may add or remove someone else, or change the profile or the admins.
  Anyone may commit an update of their own leaf, or a member's request to leave.
- Leaving is a standalone Remove proposal for one's own leaf, committed by an admin. An
  admin must first hand the role on (a GroupContextExtensions commit). An admin is taken
  off the list before being removed, in a separate commit.
- A GroupContextExtensions proposal is committed on its own, never with other proposals.
- A commit whose resulting state breaks these invariants is ignored: every admin must be a
  member, and every leaf must carry a valid identity proof.
- External commits, PSKs, ReInit and anything but Add, Update, Remove and
  GroupContextExtensions are refused.

**Epoch races.** A member publishes its own commit before applying it. Two commits for the
same epoch are ordered by (0 for admin-only work, 1 otherwise), then the committer's
account key, then the SHA-256 of the commit. Every member ends on the lower one. The state
one commit back is kept for 24 hours to roll to the winner if it arrives second. A
member's messages from the losing branch are sent again.

**Key lifetime.**

- Message keys are deleted when used.
- Two past epochs are kept for late messages. A message from an older epoch is
  unreadable by design.
- Each member commits a fresh leaf 1–10 minutes after joining, and at least every 7
  days.
- The **security code** shown to members is the epoch authenticator. Everyone in the
  same epoch sees the same code.

**Reading the group** — one subscription for all groups, per relay:

```
{ "kinds": [445], "#h": [<nostr_group_id>, …], "since": <min over groups of mark(relay) − 1 h> }
```

Each group keeps its own high-water mark per relay, starting at when this device joined.
The hour allows for senders' clock skew; group events are not fuzzed.

## 4. Delivery

### 4.1 Where messages are published

Each user publishes a **NIP-17 kind 10050** replaceable event listing the relays where
they read their inbox. Senders publish to the union of the recipient's announced inbox
relays and their own write relays. Without this, delivery degrades to "hope we happen to
share a relay", which is how Nostr DMs used to get lost.

### 4.2 Self-addressed copies

Every chat message is wrapped once per recipient and once more to the sender's own key.
The self-copy is what lets a restored vault — or a second device — reconstruct the sent
side of a conversation. Reactions, votes and checklist changes get one too, since they
are content. Other control frames get none; they are not worth the extra publish.

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

In a group each member has their own state — their copy reaches the relays, is received
and is read on its own — and the message shows the **least advanced** of them. A receipt
changes only the state of the member who sent it, and only if the message was sent to
them: a receipt names a message by id alone, so without that check anyone who learned an
id could mark it read.

### 4.4 Retry

Messages that no relay accepted stay in an encrypted outbox and retry with exponential
backoff and full jitter (2 s base, 5 min cap, 12 attempts) before being marked failed.
A message is idempotent across retries because the rumor — and therefore its id — is
built once and stored, not rebuilt per attempt. A manual retry after that does rebuild
it, from the stored message, with every tag in the same fixed order (recipients, `ms`,
`subject`, attachment, poll or checklist, thread), so it keeps its id.

Each recipient's copy is judged on its own relay quorum. When some members' copies reach
the relays and others do not, only the missing members are retried; nobody receives a
group message twice because somebody else's relays were down.

### 4.5 Subscription and rewind

```
{ "kinds": [1059], "#p": ["<my pubkey>"], "since": <mark(relay) − 3 days> }
```

The three-day rewind exists because wrap timestamps are fuzzed up to two days into the
past: a subscription anchored exactly at "when I last synced" would miss anything whose
fuzz pushed it behind that mark. The overlap is free — duplicates are deduplicated by
event id.

Each relay is caught up on its own terms (ADR-050):

- **A relay that speaks NIP-77** gets a live-only subscription (`"limit": 0`, since three
  days ago), then a negentropy reconciliation over the same filter. The item set is the
  wraps this device already holds, from the sealed seen marks (§8). Only the ids it lacks
  are then fetched, 200 per REQ.
- **A relay that does not** gets the filter above, from its own high-water mark rather
  than a cursor shared by every relay. A relay that was down for a week is asked for the
  whole week.
- **Deciding which.** A NOTICE saying the command is unknown, a CLOSED before any
  answer, or no reply within 6 s marks a relay as not speaking NIP-77, for a week. Any
  other failure falls back for ten minutes. Falling back re-sends that relay's window
  REQ.
- **Moving a mark.** It moves only when the current connection is proven complete — its
  EOSE, or a finished reconciliation. After that it follows the last frame received
  while the connection stays up.
- **The floor.** No filter reaches below the dedup floor (§8), and a wrap created before
  it is refused however it arrives.

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
  running a server. Users may add their own in Settings → Calls; the direct channel uses
  them too.

**There is no presence protocol.** An offer _is_ the presence probe: if the peer is
online they answer within a second or two, and if they are not, nothing happens. This
removes a whole class of periodic beacons — and the metadata they would publish about
when each user is awake — for no loss in behaviour.

## 5.1 Calls

One-to-one voice and video, over WebRTC, signalled through the same sealed `rtc` frame as
the direct channel and shaped after the NIP-AC draft
([nostr-protocol/nips#2461](https://github.com/nostr-protocol/nips/pull/2461)):

| NIP-AC (draft)                                         | Textor, inside the gift wrap                             |
| ------------------------------------------------------ | -------------------------------------------------------- |
| kind 21603, offer                                      | `kind: "offer"`, `sdp`                                   |
| kind 21604, answer                                     | `kind: "answer"`, `sdp`                                  |
| kind 21605, ICE candidate                              | `kind: "candidate"`, `candidate` (`RTCIceCandidateInit`) |
| `e` tag: the id of the event that opened the handshake | `call`: the rumor id of the opening offer                |
| — (hang-up, reject and busy are left to applications)  | `ringing`, and `bye` with a `reason`                     |

NIP-AC recommends NIP-59 wrapping where who connects to whom should stay off the relays;
here every frame is sealed, always, so a relay sees one more gift wrap and nothing else.

**The session id.** The opening offer carries no `call`: its own rumor id names the call,
exactly as NIP-AC names a session by the event that opened it, and every later frame in
either direction carries that id. The opening offer also carries no `sid`, and that is
deliberate: every client that predates calls requires `sid` on an `rtc` frame, so it
drops a call at parse time instead of mistaking the offer for a direct-channel offer and
answering it.

```
caller                                           callee
offer {media, sdp}          ───────────────────▶ rings: accepted contact, offer ≤ 60 s old
                            ◀─────────────────── ringing {call}
                            ◀─────────────────── answer {call, sdp}      after accepting
candidate {call}            ◀──────────────────▶ candidate {call}        trickled
                 DTLS-SRTP audio and video, directly or through a TURN server
bye {call, reason}          ───────────────────▶
```

`reason` is one of `hangup`, `declined`, `busy`, `unanswered`, `failed`.

- **Who can ring.** Only an accepted, unblocked contact, and only one to one: a call frame
  addressed to a group is dropped. Anyone else gets no reply at all — not even `busy` —
  so a stranger cannot learn that the device is online.
- **Stale offers.** Relays replay what a device missed while it was away, so an opening
  offer more than 60 s old does not ring; it is written into the conversation as a missed
  call instead.
- **The callee reveals nothing until it answers.** No peer connection is created, no STUN
  server is asked, and no candidate is sent before the person accepts. `ringing`, which
  says only that the app is open, is all an unanswered call learns.
- **Candidates.** The opening offer and answer wait up to one second for ICE to gather,
  so the first candidates ride inside the SDP rather than costing a wrap each; later ones
  trickle. Relay events arrive in any order, so a candidate that overtakes its
  description is held and retried when the description arrives.
- **Renegotiation** — a camera turned on in a voice call, a shared screen, an ICE restart
  after a network change — is another `offer`/`answer` pair naming the call, resolved by
  perfect negotiation with the lexicographically smaller key polite. It starts only once
  the call has connected, because an offer that overtook the answer opening the call would
  find the other side still waiting for it, and it is capped at ten a minute. Turning a
  camera off or on, flipping it, or swapping it for a screen reuses the sender and needs
  no negotiation at all.
- **Both at once.** When two people call each other in the same moment, the polite side
  abandons its own call and answers the other with the camera and microphone it already
  has open; the impolite side ignores the colliding offer. Nobody hears busy.
- **Busy.** A call that arrives during another gets `bye` with `reason: "busy"`, and is
  kept as a missed call.
- **Transport.** Call signals go over relays only, never over the direct channel — a
  channel can look open to a device that has gone. They are queued like other control
  frames and given up after two minutes, never copied to the sender's own inbox, and each
  carries the DTLS `fingerprint` of its description, cross-checked on receipt.
- **Mute and camera state** travel over a data channel negotiated inside the call
  (`call-state`, stream id 0), within the same DTLS session as the media, never over
  relays.

**Call records.** Each side writes its own entry into the conversation under the call id:
media, outcome (`completed`, `missed`, `declined`, `unanswered`, `cancelled`, `busy`,
`failed`) and, for a completed call, its length. It is local and never sent. It is never
acknowledged either: its id is the caller's offer, which the caller would recognise in a
receipt. A missed call counts as unread, like a message. Because both records share that
id, a `redact` naming it takes the call out of both conversations, and either person may
send one (§3.2). A call that has been deleted neither rings nor is recorded again when its
offer is replayed.

**ICE servers.** Public STUN from two operators by default — which is also what makes
symmetric NAT visible, as each server is shown a different port. A user can add STUN and
TURN servers (`stun:`, `turn:`, `turns:`, with credentials for TURN), and "always relay
calls" sets `iceTransportPolicy: "relay"`, so this device's address is never offered; with
no TURN server configured, a call is refused rather than quietly placed directly.

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
| Keyslot → KEK      | per slot, below                                                        |
| KEK → data key     | XChaCha20-Poly1305 wrap of a random 32-byte key, once per slot         |
| Data key → subkeys | HKDF-SHA256: `record`, `index`, `identity`                             |
| Record bodies      | XChaCha20-Poly1305, random 24-byte nonce, AAD = `textor/<table>/<id>`  |
| Primary keys       | `HMAC-SHA256(indexKey, "<domain> <value>")`, truncated to 32 hex chars |
| Indexed timestamps | truncated to the hour                                                  |

**Keyslots (ADR-054, ADR-058).** `meta.keyslots` holds one entry per way the vault
opens, each a sealed copy of the same data key under AAD `textor/keyslot/v1|<type>|<id>`,
`id` being 8 random bytes in hex:

| `type`       | KEK                                                                              | Stored beside it                                                       |
| ------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `passphrase` | `scrypt(NFKC(passphrase), salt, N, r, p)`, 32 bytes                              | `salt`, `params`                                                       |
| `recovery`   | `HKDF-SHA256(ikm = normalised words, salt, info = "textor/keyslot/recovery/v1")` | `salt`                                                                 |
| `pin`        | `scrypt(digits, salt, N, r, p)`, 32 bytes; `N = 2^15` by default                 | `style`, `salt`, `params`, `failures`                                  |
| `biometric`  | a non-extractable AES-256-GCM `CryptoKey`; the data key is sealed with AES-GCM   | `key`, `iv`, `credentialId` (base64url), `authenticator`, `transports` |
| `device`     | a non-extractable AES-256-GCM `CryptoKey`; the data key is sealed with AES-GCM   | `key`, `iv`                                                            |

The words are normalised as the identity layer reads them: NFKD, lower case, single
spaces. A PIN is 6–16 digits, and Persian and Arabic-Indic digits are read as ASCII; a
pattern (`style: "pattern"`) is 4–9 distinct dots of a 3×3 grid, numbered 1 to 9 left to
right and top to bottom in every language, written as their digits in the order drawn.
Each wrong PIN adds one to `failures` before it is reported; a right one sets it to 0; the
tenth erases the slot, unless no other slot is left.

**The biometric gate (ADR-058, ADR-059).** A `biometric` slot opens only with a proof that
its credential's authenticator verified the person moments ago. `authenticator` is
`platform` — the device's own, and the value read for a slot without the field — or
`security-key`. The credential is made with:

| Option                   | `platform`                                                           | `security-key`                                                             |
| ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `authenticatorSelection` | `platform`, `userVerification: required`, `residentKey: discouraged` | `cross-platform`, `userVerification: required`, `residentKey: discouraged` |
| `hints`                  | `["client-device"]`                                                  | `["security-key"]`                                                         |
| `attestation`            | `none`                                                               | `none`                                                                     |
| `extensions`             | none                                                                 | none                                                                       |
| `user`                   | a random 16-byte id, named `Textor`                                  | a random 16-byte id, named `Textor`                                        |

`transports` is what `getTransports()` reported, limited to `usb`, `nfc`, `ble`,
`smart-card`, `hybrid` and `internal`. Where `getAuthenticatorData()` exists, the new
credential's UV flag must be set. Setup then asks once, exactly as unlocking will, and a
credential that cannot answer — or answers without the UV flag — never becomes a slot and
is signalled unknown.

Unlocking calls `navigator.credentials.get` with a random challenge, that credential alone
in `allowCredentials` with its `transports`, the same `hints`, and `userVerification:
required`. The answer must come from the same credential and carry the UV flag (`0x04`) in
its authenticator data. Its signature is not checked, since only code in the page could
forge an answer, and that code could skip the check. The proof is spent once, within 60
seconds. No key comes from WebAuthn: the slot's key is the local `CryptoKey`, and wherever
the platform keeps the credential, it carries no secret.

**Opening instantly is exclusive (ADR-059).** No stored list holds a `device` slot beside
a `biometric`, `pin` or `passphrase` one. Every rewrite of `meta.keyslots` drops the
`device` slot when one of those is present, adding a `device` slot beside one fails, and a
`device` slot found beside one is not opened. At start, before any slot is opened, the
list is rewritten if it breaks this rule or holds a retired entry.

A `webauthn-prf` entry, written by builds from ADR-054 to ADR-057, is recognised only to
say it is retired: it is not opened, and the rewrite at start drops it. A vault written
before keyslots holds `kdfSalt`, `kdfParams` and `wrappedDataKey` (AAD
`textor/meta/dataKey`) instead; it is read as a passphrase slot, and rewritten as one,
under the same KEK, the first time it opens.

No slot ever encrypts records directly, so adding, replacing or removing one seals or
drops 32 bytes instead of rewriting the database. The AAD binds each ciphertext to its
row, so an attacker with write access to IndexedDB cannot graft one contact's sealed
metadata onto another's. Blinded primary keys mean the index structures — which
IndexedDB stores in the clear — reveal nothing about who the user talks to. A group's id
is the same blinded key over its member set, and it doubles as the group's address in the
URL (`#/g/<id>`): unlike a direct conversation's address, which is the peer's public key,
it names nobody, and it means nothing on any other device.

**Attachment payloads.** Chunks and their manifest are stored under
`blind("blob", "<id>:<copy>")`. The manifest also seals `{id, copy}`, so a request naming
only the id can be served without an index that would show which rows hold the same file.
Payloads stored under the id alone, before ADR-052, are moved once, at the first start
after upgrading: each goes to the copy whose key its chunks open under.

A copy is kept while anything on the device refers to it — a message's attachment, or a
sticker in a pack — and freed when nothing does (ADR-053):

- **Deleting a message or a conversation** deletes its copies, except any a surviving
  message (a forward) or a sticker still uses.
- **Retention** deletes old messages, then sweeps every copy nothing refers to. The sweep
  runs only when retention removed something, since it reads every message.
- **Nothing written in the last hour is swept.** A sender stores the payload before the
  message naming it, so a younger copy may be one whose message is still being written.
  Rows not yet moved from before ADR-052 are left for the migration.
- **A lock stops the scan.** If the vault locks mid-scan, the deletion or sweep that
  depends on it is abandoned, rather than taking unread rows to refer to nothing.

**Seen marks.** Every event received leaves a mark: a blinded id filed under its
`created_at` hour. Inbox marks also seal the real id and `created_at`, which are the
item set for NIP-77. The table is compacted by the rules below (ADR-051):

- marks older than 45 days go;
- past 100 000 rows it is trimmed to 80 000, oldest first, never inside seven days and
  never a deletion tombstone;
- every deletion raises the **floor**, and a wrap created before the floor is refused
  rather than risk being processed twice.

**Forward-secret groups.** Each group's MLS state and each KeyPackage's private keys are
sealed records like any other (`mlsGroups`, `mlsKeys`). They are written back after every
operation, before anything is published, so no message key is used twice across a
restart. A group's conversation id is `blind("mls-group", nostr_group_id)`, which differs
from device to device like every other id.

The only plaintext stored anywhere is the keyslots — which kinds of unlock are set up,
their salts, parameters, credential id and count of wrong PINs, and the sealed data key in
each — and (outside
the vault, by design) the chosen language and theme so the lock screen can render
correctly before unlock.

---

## 9. Backup files

```jsonc
{
  "format": "textor-vault-export",
  "version": 2,
  "createdAt": 1788000000000,
  "slots": [
    {
      "type": "passphrase",
      "kdf": { "algo": "scrypt", "N": 65536, "r": 8, "p": 1, "salt": "<hex>" },
      "key": "<base64 of the sealed file key>"
    },
    { "type": "recovery", "salt": "<hex>", "key": "<base64 of the sealed file key>" }
  ],
  "compression": "gzip" | "none",
  "payload": "<base64 of  version ‖ nonce(24) ‖ ciphertext+tag>"
}
```

The payload is sealed under a random file key with AAD `textor/export/v2`. Each slot seals
that key with AAD `textor/export/v2|<type>`: under `scrypt(passphrase)`, and — when the
identity has a recovery phrase — under
`HKDF-SHA256(normalised words, salt, "textor/backup/recovery/v1")`, domain-separated from
the vault's recovery slot. The passphrase is the backup's own, independent of how any
device opens: a backup travels, and should not inherit the threat model of a device. The
recovery slot is what lets a new device restore everything from the file and the twelve
words (ADR-054). KDF parameters travel with the file so it can still be opened by a build
with different defaults.

A version 1 file has `kdf` in place of `slots`, and its payload is sealed directly under
`scrypt(passphrase)` with AAD `textor/export/v1`. It still imports, with its passphrase.

Import **merges** rather than replaces, keyed by rumor id, so re-importing the same
backup twice is a no-op. Conversation ids are recomputed under the importing vault's
index key rather than trusted from the file.

A forward-secret group's MLS state is **never** in a backup. Two devices holding the same
leaf would break the group for everyone. Its history is restored read-only, marked as
left, unless the importing device is still in that group — then its own state stands.
