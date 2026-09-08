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
│  author : a key derived for this wrap alone (§2.2)             │
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
- The **gift wrap** is signed by a key of its own, derived for it (§2.2). A relay sees an
  author it cannot link to anything, a recipient, and an opaque blob. Two people's wraps
  of one rumor are unlinkable to each other.
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

The inbox also refuses a wrap past its own `expiration`, whatever a relay offers: what withdrew
it asked to last at least as long, so a relay still offering it may be offering it without the
withdrawal (§4.5).

Signature verification is recomputed from scratch every time. `nostr-tools` memoises
`verifyEvent` on the event object under a symbol key, and symbol properties survive
object spread and structured clone — so an object carrying a stale `true` would skip
verification entirely. Textor never consults that cache.

### 2.2 Everything a wrap leaves to chance is derived (ADR-074)

```
okm      = HKDF-SHA256(ikm = sender's secret key, salt = rumor id,
                       info = "textor/wrap/v1|" ‖ recipient hex, 88 bytes)
signer   = okm[0..48] mapped to a secp256k1 scalar
nonceKey = okm[48..80]
fuzz     = okm[80..84] and okm[84..88], big-endian, each mod two days: seal, then wrap
nonce    = HMAC-SHA256(nonceKey, plaintext), for each NIP-44 layer
```

The rumor goes into the seal as `id, pubkey, created_at, kind, tags, content`, in that order,
and the seal's signature takes `HMAC-SHA256(nonceKey, seal id)` as its auxiliary randomness.
So the same arguments give the same wrap, on any device of the sender's: a retry is the same
event, and a device holding the rumor can work out its wraps' ids.

Timestamps and `expiration` count from `rumor.created_at`. A wrap that would expire within five
minutes of being sent counts from now instead.

A renewal (§4.4) is the same with its times moved on by 25 days per `generation`, from the
same signer.

Nothing here is visible to a reader. A wrap opens as any NIP-59 wrap does, and a wrap whose
signer was random is handled the same.

**Asking relays to delete.** A kind 5 signed by the wrap's signer, the one signature relays were
measured to honour on a wrap (ADR-073), naming it under each lifetime it may have had:

```jsonc
{
  "kind": 5,
  "pubkey": "<the wrap's signer>",
  "content": "",
  "tags": [
    ["e", "<wrap id at 7 days>"],
    ["e", "<wrap id at 30 days>"],
    ["k", "1059"],
    ["expiration", "<now + 31 days>"],
  ],
}
```

---

## 3. Rumor kinds

### kind 14 — chat message (NIP-17)

| Field     | Value                                                          |
| --------- | -------------------------------------------------------------- |
| `content` | UTF-8 plaintext, 1 … 16 000 characters                         |
| `tags`    | `["p", <recipient hex>]`, one per recipient, sorted (required) |
|           | `["ms", "<epoch ms>"]` (optional, see below)                   |
|           | `["hlc", "<epoch ms>"]` (optional, see below)                  |
|           | `["subject", "<group name>"]` (groups, optional; §3.3)         |
|           | `["location", …]`, `["place", …]`, `["live", …]` (§3.4.1)      |
|           | `["e", <rumor id>, "", "root" \| "reply"]` (optional)          |

**The `ms` tag.** Nostr `created_at` is whole seconds, so five messages typed inside one
second sort arbitrarily — which shows up immediately as a scrambled burst in a chat.
The tag carries millisecond precision inside the encrypted rumor, so only the recipient
sees it, and other clients ignore an unknown tag. It is **ignored unless it agrees with
`created_at` to within one second**, so a peer cannot use it to reorder history or jump
to the top of a conversation.

**Where an entry sits: a hybrid logical clock (ADR-063).** Two times travel with a message,
and they answer different questions.

- **When it was sent.** The `ms` tag, or `created_at`, is the author's own clock in UTC epoch
  time. It is what the bubble shows, in the reader's time zone, and it is never adjusted.
- **Where it sorts.** The `hlc` tag is the conversation's causal clock when it was sent.

Each device keeps one clock per conversation, a high-water mark past every entry it has
held. A message is keyed `max(now, mark + 1 ms)`, and the mark moves to that key.
Receiving an entry moves the mark past the entry's key.

So anything sent after seeing an entry sorts after it, on every device, however far apart
the clocks: a reply from a clock an hour behind comes after its question. The order is by
key, then by rumor id, and every device holds the same keys, so every device shows the same
order. Messages that neither author had seen sort by their keys, which is near their
authors' clocks.

A received key is taken if it is at least the rumor's own stamp and at most a day ahead of
the receiving clock, the same bound the unwrap enforces (§2.1). Otherwise the entry sorts by
its stamp. So does a rumor from another client, which carries no key, and an entry stored
before keys existed. The gift wrap's `created_at` is never used for either time: NIP-59
backdates it at random.

The index holds only the hour of each entry's key (§6), and inside one hour IndexedDB orders
rows by their blinded id — at random. A page of history therefore reads the hour it stops in whole,
and settles the exact order after decryption.

### kind 20014 — Textor control frame

`content` is a JSON object with a `v` (protocol version) and a `t` discriminator. A
frame whose `v` is unknown is dropped, never guessed at — that is what allows a future
`v: 2` to ship without older clients misreading it.

```jsonc
{ "v": 1, "t": "receipt", "refs": ["<rumor id>", …], "state": "delivered" | "read", "caps": 2 }
{ "v": 1, "t": "typing",  "active": true }
{ "v": 1, "t": "presence","online": true, "expires": 1788000000, "rtc": true }
{ "v": 1, "t": "rtc",     "sid": "…", "kind": "offer"|"answer"|"candidate"|"bye",
                          "sdp": "…", "candidate": {…}, "fingerprint": "sha-256 AB:CD:…" }
{ "v": 1, "t": "rtc",     "kind": "offer", "media": "audio"|"video"|"radio", "sdp": "…",
                          "fingerprint": "…" }                       // opens a call (§5.1)
{ "v": 1, "t": "rtc",     "call": "<rumor id of that offer>",
                          "kind": "ringing"|"answer"|"offer"|"candidate"|"bye",
                          "sdp": "…", "candidate": {…}, "reason": "busy" }
{ "v": 1, "t": "profile", "name": "…", "about": "…", "avatar": "data:image/…",
                          "relays": ["wss://…"], "at": 1788000000000 }  // §4.8
{ "v": 1, "t": "blob",    "id": "<sha256 of plaintext>", "copy": "<32 hex>", "seq": 0,
                          "total": 3, "data": "<base64 chunk ciphertext>" }
{ "v": 1, "t": "blobreq", "id": "<sha256 of plaintext>", "copy": "<32 hex>", "need": [0, 2] }
{ "v": 1, "t": "redact",  "refs": ["<rumor id>", …] }
{ "v": 1, "t": "vote",    "poll": "<rumor id>", "choices": ["o0", …] }
{ "v": 1, "t": "check",   "list": "<rumor id>", "item": "i0", "done": true }
{ "v": 1, "t": "check",   "list": "<rumor id>", "item": "x3f9a…", "label": "Sunscreen" }
{ "v": 1, "t": "loc",     "ref": "<rumor id>", "seq": 4, "lat": 35.6892, "lon": 51.389,
                          "acc": 9, "hdg": 38, "spd": 1.4 }            // a live location (§3.4.1)
{ "v": 1, "t": "loc",     "ref": "<rumor id>", "seq": 5, "end": true } // …ended
{ "v": 1, "t": "sync",    "dev": "<16 hex>", "read": [{ "with": ["<pubkey>"], "key": 1788000000000 }],
                          "clear": […], "gone": [{ "id": "<rumor id>", "by": "<author>" }],
                          "block": [{ "pk": "<pubkey>", "on": true, "at": 1788000000000 }],
                          "call": [{ "id": "<call id>", "with": "<pubkey>" }],
                          "me": { "name": "…", "about": "…", "at": { "name": 1788000000000 } },
                          "people": [{ "pk": "<pubkey>", "on": true, "at": 1788000000000, "id": "<id>" }] } // §4.7
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
(`label`, one line of ≤ 120 characters) — ids are `[a-z0-9]{1,12}`. A `loc` frame
counts from 1, carries a whole position or `end: true` (which may carry one), with
latitude in ±90, longitude in ±180, accuracy 0 … 100 000 m, heading 0 … 360° and speed
0 … 350 m/s. Anything outside these limits makes the whole frame invalid.

Receipts are **batched** — one wrap acknowledging many messages. One wrap per
acknowledged message would roughly double relay traffic for an active conversation, and
every extra wrap is another row of metadata about who is talking to whom.

A receipt may say `caps`, what the sender's client can do: 2 reads attachments from the relays
(§3.1.1). A receipt with none is from an earlier Textor. Another client sends no receipts.

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

Payload bytes go to the relays at the copy's own address (§3.1.1), or to a client that
cannot read those, as `blob` frames. Each chunk is plaintext encrypted with
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

Chunks in frames are 16 KiB of plaintext, not larger, because such a chunk expands about
3.35x before it reaches the wire: base64 into the frame, base64 again in the NIP-44 seal, and
base64 once more in the gift wrap. A 32 KiB chunk measures 109,732 bytes as a wrap, past the
64 KiB ceiling most public relays enforce; 16 KiB measures 55,112.

Payloads up to 1 MiB go over relays and therefore reach a recipient who is offline, up to
512 KiB if in frames. Larger ones require the direct WebRTC channel, and are refused rather
than queued if it is not available. See ADR-028 through ADR-033, and ADR-075.

### 3.1.1 At a copy's own address (ADR-075)

A descriptor naming `relays` says its chunks are on those relays, up to four, and `chunkBytes`
says how they were cut (48,640 bytes of plaintext, when not 16 KiB; `chunks` must then be
`ceil(size / chunkBytes)`).

```
secret  = HKDF-SHA256(ikm = copy's key, salt = copy's salt, info = "textor/blob/drop/v1", 52 bytes)[0..48],
          mapped to a secp256k1 scalar
address = its public key
```

```jsonc
{ "kind": 1059, "pubkey": "<signer>", "created_at": <message time, less up to two days>,
  "tags": [["p", "<address>"], ["expiration", "<message time + lifetime>"], ["seq", "<index>"]],
  "content": "<base64 of the chunk's ciphertext>" }
```

- **Signer.** Derived, as `okm = HKDF-SHA256(ikm = sender's secret key, salt = copy,
info = "textor/blob/signer/<floor(seq / 10)>/v1", 52 bytes)`: the first 48 bytes mapped to a
  scalar, and the next four, big-endian mod two days, how far back `created_at` goes. So any
  device of the sender's holding the chunks gets the same events, and can delete them.
- **Reading.** `{"kinds": [1059], "#p": ["<address>"]}`, one relay at a time. An event is kept
  only if its `seq` is in range and its ciphertext opens at that index.
- **Who gets this.** Anyone whose receipts say `caps` of 2 or more (§3). Others get frames.
- **A relay named by a stranger** is not connected to, only those this device already reads.
- **Missing chunks** are asked for with `blobreq`, as ever. The sender publishes them again,
  counted from now, to where the asker reads.

A deletion for everyone also goes to them: a kind 5 from each signer, naming its chunks' ids
under each lifetime (§2.2).

## 3.2 Withdrawing a message

A `redact` frame asks the peer to delete messages, and takes any attachment payload with
it on both devices. It is queued durably, so an offline peer honours it on reconnect.

**Between two people, either may withdraw anything in their conversation**, as Telegram
allows (ADR-061). That covers what the sender wrote, what the receiver wrote, and calls.
A withdrawal is honoured when the message is in the direct conversation with its sender.

**In a group, a client withdraws and honours withdrawals only for what the sender wrote.**
A group has no one whose conversation it is.

Nothing else is honoured: a stranger, or one member of a group, cannot delete anything
from any other conversation. A reaction is only ever withdrawn by the person who placed it.

**On every device, and on the relays.** A `redact` is copied to the sender's own inbox, and
honoured from their own key within the conversation it names, so their other devices take it
out too. It goes by relay even with a direct channel open, and asks to last 30 days whatever
the setting says, so it outlives what it withdraws. Whoever wrote the message also asks relays
to delete its wraps (§2.2), on either person's withdrawal. Deleting for oneself alone goes to
one's other devices as `gone` (§4.7), with our own copy retracted if we wrote it.

Every deletion leaves a tombstone keyed by rumor id and author, blinded and kept with the
seen marks for 45 days. A copy of the rumor that arrives afterwards is dropped: a sender's
outbox re-wraps on every retry, so the seen marks, which name wraps, would not recognise
it. A withdrawal writes its tombstone under the sender's name before it looks for the rumor,
because wrap timestamps are fuzzed and a catch-up read can return the withdrawal first, and a
rumor being stored looks for a tombstone again once it is stored, so that of two read at once,
one always sees the other (ADR-078). A rumor is dropped for a tombstone under its author, under
our own key, which only we write, or, in a direct conversation, under the other person, for whom
anything in it is theirs to take out. Nobody else's can stop it, so a stranger cannot silence
anyone. Withdrawing something that was still unread takes it off the unread count.

The copy of a withdrawal to our own inbox goes to every relay of ours and is retried like anyone
else's, since it is what stops a restore showing what was deleted. Relays are asked to delete
wraps until each one has answered, whatever it says: the usual tries, then every six hours until
the request itself expires. A device asks again whenever a relay offers it a copy of something
of ours that has been deleted.

A device restored from the twelve words holds back messages, reactions, receipts, votes and
locations it reads, without marking them as read, until its first catch-up is done and it has
heard what the records of §4.7 hold, or 20 seconds have passed. Withdrawals are acted on as they
arrive. So nothing deleted is committed or shown, and being closed part way loses nothing.

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

## 3.4.1 Locations (ADR-064)

A place, or the start of a live location, is a kind 14 message. Its content is a `geo:`
URI (RFC 5870), which other clients show and a maps application opens —
`📍 Café Naderi\ngeo:35.70123,51.41987`, `📡 geo:35.6892,51.389;u=12` — and its
structure is in tags:

```jsonc
["location", "35.6892", "51.389", "12"]   // WGS 84 degrees, ≤ 6 decimals; accuracy in m, optional
["place", "Café Naderi"]                  // a named place: one line of ≤ 80 characters
["live", "900"]                           // shared live for this many seconds, 60 … 604 800;
                                          // "0" until turned off
```

A message carries `place` or `live`, never both, and a `live` tag that is not one of those
values makes the whole location invalid rather than static. A message carries a poll, a
checklist or a location, never two; in that order.

A live location then moves by `loc` frames (§3 above) from its author to the same people.

- **Who and where.** A frame is honoured only from the message's author, and only when it
  was sealed to the message's own conversation.
- **Order.** `seq` counts up from 1 per share. A frame at or below the last one folded in,
  or after the end, changes nothing. A frame that arrives before its message is held for
  it: the newest per share, for up to 64 shares.
- **Folding.** A position replaces the last one whole, and the last one joins a trail of up
  to 24 points. Every time is the author's, taken from the rumor's `ms` tag.
- **Delivery.** An update is ephemeral, replaces any update to the same share still in the
  outbox, uses the direct channel when one is open, gets no self-addressed copy, and its
  wrap carries an `expiration` one hour out. The end is durable, always goes by relay, and
  is copied to the sender's own inbox. A share still running resends its position at
  least every ten minutes.
- **Shown by the reader's clock.** Its times are moved onto the reader's clock by the
  least delay any of its frames seemed to take (`lag`). A share runs until
  `ts + seconds + lag`, or until its end.

Locations are not carried in forward-secret groups (§3.5).

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
| 9    | message  | `["ms", …]`, `["hlc", …]`; a reply adds NIP-10 `e` tags         |
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

The list is the read relays in use (ADR-067), never one set aside as down or refusing the
inbox. It is looked over at start and again whenever that set changes, at most every ten
minutes. Up to four relays are in use per role; senders' own write relays are those in
use too.

The list belongs to every device of an identity, so it is read before it is changed (ADR-073).
A device takes up what is announced, adding relays it has never had unless this person removed
them, and leans on those while they work. It publishes only to add what it reads, or to drop
what it has evidence cannot be used. A relay it merely has standing by stays, up to six.

### 4.2 Self-addressed copies

Every chat message is wrapped once per recipient and once more to the sender's own key.
The self-copy is what lets a restored vault — or a second device — reconstruct the sent
side of a conversation. Reactions, votes and checklist changes get one too, since they
are content, and so does the end of a live location, so the device sharing it stops.
Other control frames get none, a live location's updates included; they are not worth
the extra publish.

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
does not downgrade it.

**Ticks follow Telegram (ADR-061).** A clock means not yet sent. One tick means `sent` or
`delivered`; two mean `read`, and nothing else. When each receipt came is kept on the
message (`deliveredAt`, `readAt`, and per member `receiptsAt`) and shown in its details.
It is the receipt's own time, never earlier than the message and never later than its
arrival.

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
`hlc`, `subject`, attachment, poll or checklist, location, thread), so it keeps its id. A message
stored before keys existed is rebuilt without an `hlc` tag, as it was first sent.

Each recipient's copy is judged on its own relay quorum. When some members' copies reach
the relays and others do not, only the missing members are retried; nobody receives a
group message twice because somebody else's relays were down.

**Sending again what stayed unconfirmed (ADR-076).** A message still at `sent` from day 25 and
again from day 50 is wrapped anew, to whoever has not confirmed it and has sent a receipt before.
The wrap's timestamps and `expiration` move on 25 days a time. The rumor is the same, so a
receiver that has it drops it. Not when the setting is 7 days. At most 20 wraps every twelve
hours.

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
- **Reading past a relay's limit.** A relay's replay stops at its own limit and ends in an
  ordinary EOSE (`primal` at 500, `wirednet` at 200). A replay of 20 or more, duplicates
  included, is read on backwards with `until` from its oldest event, until a page comes back
  empty. A page that ends any other way than EOSE proves nothing.
- **One download at a time.** Reconciliations run side by side. Fetching what they found is one
  relay at a time, leaving out what another has handed over by each batch.
- **Moving a mark.** It moves only when the current connection is proven complete — its
  EOSE, its last page, or a finished reconciliation. After that it follows the last frame
  received while the connection stays up.
- **The shared cursor** moves only once a relay has been read. A device with no history waits
  for relays still connecting, and starts at the 45-day horizon.
- **Standing by.** A relay not in use is looked in on once a day, one an hour.
- **The floor.** No filter reaches below the dedup floor (§8), and a wrap created before
  it is refused however it arrives.

### 4.6 Testing a relay

Before a relay is offered or added (ADR-067), the device tests it over a fresh
connection:

```
["REQ", "probe", { "kinds": [1059], "#p": ["<random pubkey>"], "limit": 1 }]
["EVENT", <kind 1059, from a throwaway key, p-tagged to another,
           created_at fuzzed up to two days back, NIP-40 expiration in one hour,
           content NIP-44 ciphertext of padding>]
```

It passes on an EOSE for the REQ and `OK true` for the EVENT. A `CLOSED`, an `OK false`, a
failed connection or ten seconds of silence fails it, and the relay's own words are kept
as the reason. Neither key is kept; nobody can read the event.

NIP-66 relay reports (kind 30166) are read, when asked, with
`{"kinds": [30166], "#R": ["!auth"], "since": <a day ago>, "limit": 100}` from the best
read relay in use. A relay reported by two or more monitors, as needing neither sign-in
nor payment, on the open internet, is a candidate for testing — nothing more.

### 4.7 Other devices of one identity

Every device holds the same key (§1), so what is addressed to the key reaches them all. What is
not a message goes in a `sync` frame (ADR-073), a kind 20014 rumor naming only the sender, wrapped
to the sender's own key, and asking to last 30 days. A frame is honoured only from our own key
and naming nobody else. Its parts are bounded on parse: at most 64 entries a list, a mark naming
one to seven people, a `dev` of 16 hex characters.

| Part     | Means                                                   | Merges                |
| -------- | ------------------------------------------------------- | --------------------- |
| `read`   | Entries at or before `key` (§3) have been read          | The highest key       |
| `clear`  | Entries at or before `key` are deleted                  | The highest key       |
| `gone`   | This message was deleted for this person; `by` wrote it | Deleted stays deleted |
| `block`  | This person was blocked or unblocked at `at`            | The latest `at`       |
| `call`   | A call was answered or declined on another device       | Deleted stays deleted |
| `me`     | This identity's own profile, without the picture        | Each part's stamp     |
| `people` | The contact list, as below                              | Each part's stamp     |

`with` names a conversation by who is in it, leaving out ourselves, since a conversation's id
differs from device to device. A mark is the key of the newest entry read, never the
conversation's clock. Any order works: a message arriving after a `read` that passed it does not
count as unread, one arriving after a `clear` or `gone` does not arrive, and a call offer arriving
after a `call` does not ring.

A device sends a frame naming only `dev` once a week. Read marks and calls wait until another
`dev` has been heard from in the last 30 days. A `dev` not heard from before, or not for 25 days,
is told what has been read, this profile, the whole contact list and who is blocked, within five
minutes. Forward-secret groups take no part (§9).

**`people`** (ADR-077). Each entry is one person, whole:

| Field                          | Means                                                   | Merges          |
| ------------------------------ | ------------------------------------------------------- | --------------- |
| `pk`, `on`, `at`               | Whether they are a contact, and when that was decided   | The latest `at` |
| `name`, `nameAt`               | The name given to them, at most 128 characters          | The latest      |
| `pin`, `pinAt`                 | Whether the conversation with them stays at the top     | The latest      |
| `remote`, `about`, `profileAt` | What they call themselves, as of their own stamp (§4.8) | The latest      |
| `relays`                       | Where they read, at most 8                              | Added up        |

Two fields of a pair come together or the frame is refused. Stamps come from one clock per device
that only moves forward, past anything it has heard; a tie goes by value, so every device picks
the same; a stamp over a day ahead is ignored. A device keeps its stamps after someone is removed,
so a late frame cannot bring them back. Someone with no stamp yet counts from when they were
added here, and a name never given counts as nothing. A frame carries at most 10,000 bytes of
people, and a long list takes several: wrapped, a frame must stay under 64 KiB.

**The records** (ADR-077, ADR-078). The profile, the contact list and what was deleted are also
kept where a restore can read them, as events of kind 30078 (NIP-78, replaceable), published to
every write relay and asked of each until it has answered:

```
HKDF-SHA256(secret key, no salt, "textor/profile/v1") → 144 bytes
  bytes   0..48  the records' signing key, reduced as NIP-59 wrap signers are (§2.2)
  bytes  48..80  the NIP-44 conversation key
  bytes  80..96  `d` of the record holding the name and about
  bytes  96..112 `d` of the record holding the picture
  bytes 112..144 key for the `d` of each part of a list: first 16 bytes of
                 HMAC-SHA256(key, "<slot>/<part>"), as hex

{ "kind": 30078, "pubkey": "<signing key's>", "tags": [["d", "…"], ["expiration", "<a year on>"]],
  "content": nip44({ "slot": "me", "name": "…", "about": "…", "at": { "name": 1788000000000 } }) }

{ "kind": 30078, …,
  "content": nip44({ "slot": "people", "s": 1788000000000, "i": 0, "n": 1, "data": "<base64>" }) }
```

A list, `people` or `gone`, is JSON cut into parts of at most 30,000 bytes, at most eight, `i` of
`n`, all with the stamp `s`. Only the newest `s` is ever used, and only once all of it is found:
part of it missing means looking again, not settling for an older one, which may name someone
since removed. A shorter list writes its parts past the end empty, so nothing is left behind.

`people` holds `{ "people": [SyncPerson…], "block": […] }`: everyone who is a contact now, without
`about` and with at most three relays, and who is blocked. **Nobody removed is in it**, nor any
mark that they were. A device restored from it sets a floor at `s`, and nobody it left out is taken
from any frame or message of ours older than that. On a device already running, being left out
is not a removal: its writer may not have heard of them, and frames carry removals. Only a device
away for 25 days, which frames may have missed, takes it as one, and only for those in a record it
had read before. A device restored writes no list until it has seen one, or most of its relays have
answered that there is none, since relays would keep what it wrote for being newer.

`gone` holds `{ "ids": [[rumor id, time]…], "clear": [{ "with": […], "key": …, "at": … }…] }`:
what was deleted for everyone or for ourselves, and conversations deleted, for 90 days, at most 2,500
and 200. It only adds up. A restored device reads it first, and files each id under our own key.

Nothing in them names the identity. Only the seal proves a record ours, so anything that does not
open is ignored, and a stale one changes nothing. A picture travels only here, as a frame's `me`
holds only its stamp; a stamp newer than held means look again, up to three times. A record holds
a picture of at most 40,800 characters: NIP-44 pads in 8 KiB steps, and the next is over 64 KiB.

A device reads the records weekly, when told of a newer picture, and after a change. It reads
before it writes, because relays keep the event with the latest `created_at` whatever is inside:
it merges what it finds, then writes only what the relays lack, or what is a month old, each
write later than anything seen. If no relay said EOSE, it writes nothing. A stamp of 1 marks a
profile not known yet, on an identity just restored: it loses to anything, and is never told or
written.

### 4.8 What a contact says of themselves

A `profile` frame's `at` is when that profile last changed, by the sender's clock, not when it
was sent, so a device of theirs yet to catch up says so. Without it, from an older client or
another, the rumor's own time stands in. A frame older than the one held is dropped, and one over
a day ahead is ignored. One of the same age changes only `relays`. A frame with `at` is the whole
profile: an `about` or `avatar` it leaves out was removed. Older clients ignore `at`.

---

### 4.9 Textor IDs

A Textor ID (ADR-079) is ten characters that find someone. Every identity has one, worked out
from its secret key. There is no registry: anyone given an ID checks it themselves.

For secret key `s` with public key `P` in lower-case hex, one **run** over a password and a label is:

```
run(password, label) = SHA-256(scrypt(password, SHA-256(label 0x00 "0"), N = 32768, r = 8, p = 1, dkLen = 32)
                            ‖ scrypt(password, SHA-256(label 0x00 "1"), N = 32768, r = 8, p = 1, dkLen = 32))
```

The two may be worked out side by side, and should be: each takes 32 MiB and a core. Then:

```
w  = hex(HKDF-SHA256(s, no salt, "textor/id/v1/salt", 16))
K  = run(P ":" w, "textor/id/v1/claim")
ID = the first 50 bits of K, as 10 symbols of 0123456789ABCDEFGHJKMNPQRSTVWXYZ, leading zeros kept
```

It is shown as `XXXXX-XXXXX`. On reading, case and separators do not count, `O` is `0`, `I` and `L`
are `1`, and Persian and Arabic-Indic digits are digits. In a link it is `#/id/XXXXXXXXXX`.

| `s`            | `P`                 | `w`                                | ID           |
| -------------- | ------------------- | ---------------------------------- | ------------ |
| 32 bytes of 01 | `1b84c556…d5dd078f` | `64edf4353e796219de4976c24e289628` | `NT0VBCW75F` |

**Record.** Kind 30078, at an address only someone with the ID can work out:

```
A       = run(ID, "textor/id/v1/address")
drawn   = HKDF-SHA256(A, no salt, "textor/id/v1/record", 48)
d       = hex(drawn[0..16]),  sealKey = drawn[16..48]
signer  = from HKDF-SHA256(s, no salt, "textor/id/v1/signer", 48), as §4.7's records are
content = NIP-44 with sealKey over { "k": P, "w": w, "r": [up to 6 relays], "t": unix seconds, "s": sig }
sig     = hex of Schnorr by P over SHA-256(JSON ["textor/id/v1/signature", ID, P, w, r, t])
tags    = ["d", d], ["expiration", now + 1 year]
```

To look one up, ask for `{ "kinds": [30078], "#d": [d], "limit": 64 }` with no author, on the
relays in use and the defaults. For each record that opens and whose signature holds, keep the newest
`t` per key, newest first, and check at most 4 by recomputing the ID from `k` and `w`. Say so if
there were more. Everyone left holds the ID; if more than one does, show them all rather than choose.

It is written to the relays in use and the defaults once a relay has answered, without being asked,
and again monthly while any device runs. Every device of an identity writes the same thing, so it
travels in no frame and no other record.

**Telling a contact.** A public key does not give an ID, so a contact is told `w` in a control
frame, `{ "v": 1, "t": "id", "w": "<32 hex characters>" }`, sealed like any other. It is sent when
someone is added or accepted, with the first message written to them and again with a message a
month after it was last sent, and when theirs has just been learned if ours was last sent over a day
ago. It is never sent to everyone at once.

The reader works out `run(P ":" w, "textor/id/v1/claim")` from the key the frame is sealed by, and
holds the ID that gives. Once it has one it takes no other. From someone not accepted, `w` is kept
and not worked out until they are. A known ID travels in the contact list as `id` (§4.7), in the
frames and in the sealed record.

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
- **ICE** uses public STUN only, and the user's own STUN servers. There is no TURN,
  because running one would mean running a server — and a TURN server the user adds for
  calls is not used here either (ADR-068).

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

Answering or declining also tells this identity's other devices (§4.7), which stop ringing, say
nothing to the caller, and write no record.

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
- **Falling back to TURN** is the one exception. If the call has not connected four
  seconds after the caller applied the answer (one second when the candidates already
  rule out a direct path), or ICE has failed, the caller sends an ICE-restart `offer` with
  its TURN servers added. Only the caller does: it holds the answer, so the callee holds
  both descriptions too and nothing can be overtaken. A receiver recognises a restart by
  a changed `a=ice-ufrag` and adds its own TURN servers before answering. Any ICE restart
  brings TURN in, before or after the call connects (ADR-068).
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

**Call records.** The opening offer carries an `hlc` tag. Both sides enter the call at that
key, and move their conversation's clock past it when the offer is sent or received. Both
therefore show the call in the same place, before anything either says after it
(ADR-063). Each side writes its own entry into the conversation under the call id:
media, outcome (`completed`, `missed`, `declined`, `unanswered`, `cancelled`, `busy`,
`failed`) and, for a completed call, its length. It is local and never sent. It is never
acknowledged either: its id is the caller's offer, which the caller would recognise in a
receipt. A missed call counts as unread, like a message. Because both records share that
id, a `redact` naming it takes the call out of both conversations, and either person may
send one (§3.2). A call that has been deleted neither rings nor is recorded again when its
offer is replayed.

**ICE servers.** Public STUN from two operators by default — which is also what makes
symmetric NAT visible, as each server is shown a different port. A user can add STUN and
TURN servers (`stun:`, `turn:`, `turns:`), and "always relay calls" sets
`iceTransportPolicy: "relay"`, so this device's address is never offered; with no TURN
server usable, a call is refused rather than quietly placed directly. No public TURN
server ships (ADR-068).

A TURN server takes a username and password, or its shared secret. With a secret, each
call gets credentials by the TURN REST scheme coturn implements (`use-auth-secret`):

```
username   = <unix seconds now + 86 400>[:<name the user gave>]
credential = base64(HMAC-SHA1(secret, username))
```

Without "always relay calls", a call is placed with STUN servers only, and TURN servers
join at the fallback above, ordered by how each has done before.

A host or reflexive candidate in global IPv6 space counts as a public address for these
decisions: when both sides have one, direct paths get their full time whatever the IPv4
NATs do (ADR-069).

**Walkie-talkie.** Push-to-talk over the relays (ADR-069, ADR-070), started only from
the conversation's header. A voice or video call never turns into one (ADR-071). It is a
call with `media: "radio"`, whose offer and answer carry, in the `sdp` field, a
description of their own:

```json
{ "radio": 1, "nonce": "<64 hex: 32 random bytes>", "listen": ["wss://…", …] }
```

The keys come from the call id, the opening offer's rumor id, and both nonces:

```
ikm        = utf8(<call id> "|" <caller's nonce> "|" <callee's nonce>)
key        = HKDF-SHA256(ikm, salt = "textor relay voice v1", info = "key",    32)
caller sk  = HKDF-SHA256(ikm, salt = "textor relay voice v1", info = "caller", 32)
callee sk  = HKDF-SHA256(ikm, salt = "textor relay voice v1", info = "callee", 32)
```

`listen` names at most eight `wss:` relays the sender subscribes on. There is no peer
connection: ringing, declining, busy and `bye` are a call's, and the callee answers only
once its microphone has opened. A side that cannot read the other's
description, or whose browser cannot encode Opus, or whose microphone will not open, says
`bye` with the reason `failed`.

**Where the two sides meet.** Each side subscribes to two filters on its own read relays
and on the meeting relays, `wss://relay.primal.net`, `wss://nostr-pub.wellorder.net` and
`wss://purplerelay.com`:

```
{ kinds: [21690], authors: [the other side's key] }
{ kinds: [1059],  "#p":    [this side's key]      }
```

It publishes kind **21690**, an ephemeral kind, signed with its own session key, with no
tags. A relay may refuse that with a message naming the ephemeral range or the kind.
That relay gets the same content as kind **1059** instead, tagged
`["p", <the other side's key>]` and `["expiration", <now + 60>]` (NIP-40). A relay that
refuses for any other reason is sent nothing more in that session.

**Which relay gets each packet.** The candidates are, in order:

1. relays the other side's hellos say have delivered this side's packets;
2. relays it says it listens on;
3. the meeting relays;
4. its announced inbox relays.

Each packet goes to one of them, rotating with its sequence number, and best first:

1. relays the hellos name, which are known to reach the other side;
2. the rest;
3. relays that need kind 1059, or took over a second to accept a packet, a relay's first
   answer not counting, since it includes connecting. If those are all the hellos name,
   they come first instead.

While the other side has acknowledged nothing new for four seconds, a packet goes to two,
in the plain order above. Hellos and `bye` go to two. A relay is sent at most ten events
at once, and after that one every four seconds, counting only what it is actually sent.
When none has budget left, the packet is not sent.

**Packets.** The content is Base64 of a 24-byte nonce and the XChaCha20-Poly1305
sealing, under `key`, of:

| Bytes | Field                                                                                  |
| ----- | -------------------------------------------------------------------------------------- |
| 0     | version, 2                                                                             |
| 1     | type: 1 hello, 2 audio, 3 bye, 4 audio that starts a press                             |
| 2–5   | sequence number, big-endian: audio counts from 0, hellos and `bye` count on their own  |
| 6     | frame count                                                                            |
| 7…    | audio: each frame as one length byte and that many bytes of 20 ms Opus                 |
| 7…    | hello: JSON `{ "l": [listen relays], "h": [relays heard via], "a": <last audio seq> }` |
| …     | zeros: an audio packet is padded to at least 1,280 bytes                               |

Audio is Opus at 48 kHz, mono, 12 kbit/s constant bitrate, forty frames (800 ms) to a
packet. A press sends for at most thirty seconds.

A hello goes out on joining and every six seconds. It goes every three while there is
audio of the other side's to acknowledge, and at once to a side newly heard from. A
side not heard from for twenty seconds is gone. A `bye` says so at once.

On receiving, audio is played in sequence. A packet that comes early waits up to
five seconds for one missing ahead of it, and nothing before a type-4 packet is waited for.
A packet older than the last one played is dropped.

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
| Indexed timestamps | the hour of each entry's sort key (ADR-063)                            |

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

- marks older than 45 days go, and a device with no history starts at that horizon;
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
