# Architecture Decision Records

Each record states the decision, why it was taken, what it costs, and what would make us
revisit it. Records marked **revised** changed during implementation because measurement
or live testing contradicted the original plan; the original reasoning is kept, because
an ADR that quietly rewrites history is worthless.

---

## ADR-001 — Nostr relays as the transport

**Decision.** Async delivery, discovery, and WebRTC signalling all ride on public Nostr
relays over plain WebSockets.

**Why.** The hard constraint is a static site with no server we operate. That rules out
running a signalling service, a mailbox, or a user directory. Alternatives considered:

| Option                          | Why it fails                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Pure WebRTC + manual signalling | Requires both peers online simultaneously and a human-copied offer/answer per session. A toy.                                  |
| Matrix                          | Needs a homeserver. Using someone else's makes them the operator.                                                              |
| WebTorrent / DHT                | No offline mailbox; tracker dependence; browser DHT support is poor.                                                           |
| GitHub as a database            | Requires a write token in the client, i.e. handing every user push access. Rate-limited, public, and an abuse of the platform. |
| libp2p / IPFS pubsub            | No durable per-recipient mailbox; heavy bundle; browser transports need relays anyway (which is just Nostr with more steps).   |
| Email bridges                   | Requires SMTP credentials in the client, or a server.                                                                          |

Nostr uniquely provides identity, discovery, offline mailboxes, and a signalling
rendezvous, from a static page, over infrastructure that is permissionless, redundant,
and user-swappable.

**Cost.** Relays learn that a given public key receives mail, and roughly when. The
relay set is visible to a network observer. Both are documented in the threat model and
in the in-app "what leaves your device" page.

**Revisit if.** A comparable permissionless network with better metadata properties
reaches similar deployment.

---

## ADR-002 — NIP-17 gift wrapping, not a custom envelope

**Decision.** Use NIP-59 gift wrapping with NIP-44 v2 encryption, exactly as specified,
and interoperate with other Nostr DM clients.

**Why.** The alternative — a Textor-specific envelope — would be unreviewed,
untested against other implementations, and would lock users in. NIP-17 is deployed at
ecosystem scale and has had real scrutiny. Interoperability is a feature: a user can
move to another client and keep their identity and contacts.

**Cost.** We inherit NIP-44's limits, including no forward secrecy (ADR-003).

---

## ADR-003 — Ship without forward secrecy, and say so

**Decision.** v1 uses NIP-44's static ECDH. If a long-term key is compromised, an
attacker who also retained old ciphertexts can read past messages.

**Why.** A double ratchet over relays needs a published prekey store, strict session
ordering, and careful handling of out-of-order and duplicate delivery. That is a large
custom protocol surface, and a subtly wrong ratchet is worse than an honestly stated
static-key scheme: it produces confident claims that do not hold. The Nostr ecosystem's
ratchet and MLS work is not yet stable enough to adopt.

**Mitigations.** Gift wraps carry a NIP-40 `expiration` tag (30 days by default) so
honest relays drop old ciphertext; the local vault is encrypted; the protocol is
versioned so a ratchet can land as `v: 2` without breaking old clients.

**Disclosure.** Stated in the threat model, in `README`, and in the in-app privacy page —
not buried.

**Revisit when.** MLS-over-Nostr stabilises, or a reviewed double-ratchet NIP lands.

---

## ADR-004 — Two-level key hierarchy for the vault

**Decision.** The passphrase derives a KEK; the KEK wraps a random data key; the data
key derives three purpose-specific subkeys via HKDF (`record`, `index`, `identity`).

**Why.** Encrypting records directly under a passphrase-derived key means a passphrase
change re-encrypts the entire database — slow, and a failure mid-way leaves a vault in a
mixed state. With this hierarchy a change rewraps 32 bytes and is instant regardless of
history size. Separating the identity subkey leaves room for a read-only unlock or an
external signer (NIP-46) later.

**Cost.** One extra indirection.

---

## ADR-005 — Blinded primary keys

**Decision.** Every primary key in IndexedDB is `HMAC-SHA256(indexKey, domain ‖ value)`
truncated to 32 hex characters. Indexed timestamps are truncated to the hour.

**Why.** IndexedDB stores index structures in the clear. Keying contacts by public key
would hand anyone who copies the database off a locked device the user's entire social
graph — without breaking a single ciphertext. Blinding keeps lookups O(1) while making
the index meaningless without the vault key.

**Cost.** No range queries over real timestamps. Conversation loads read by hour bucket
and sort precisely in memory after decryption, which is cheap at 1:1 conversation sizes.

---

## ADR-006 — scrypt N=2¹⁶, r=8, p=1 · **revised**

**Original plan.** N=2¹⁷, r=8, p=1, described as "~300 ms on mid mobile".

**What measurement showed.** Node reported 241 ms for N=2¹⁷ — but browsers run this
workload roughly **8× slower**. Measured in desktop Chrome:

| Parameters | Desktop browser | Peak memory |
| ---------- | --------------- | ----------- |
| N=2¹⁶, p=1 | 0.87 s          | 64 MB       |
| N=2¹⁷, p=1 | 1.78 s          | 128 MB      |
| N=2¹⁶, p=4 | 3.52 s          | 64 MB       |

A mid-range phone is several times slower again. Unlock happens on every auto-lock
timeout, so anything past a couple of seconds pushes people towards disabling auto-lock
entirely — a net loss for security. 128 MB peak is also a real out-of-memory risk on
mobile Safari.

**Decision.** N=2¹⁶, r=8, p=1. Parameters are stored per vault, so this can be raised
for new vaults without breaking old ones, and a passphrase change re-derives under the
current default.

**Lesson recorded.** Benchmark the runtime you actually ship to.

---

## ADR-007 — No background sync, and therefore no push · **revised**

**Original plan.** Flush the outbox from a service worker via the Background Sync API.

**Why it cannot work.** The outbox holds gift wraps encrypted under the vault key, and
that key exists only in the page's memory while unlocked. A service worker has nothing
to decrypt with. Storing the key where a worker could reach it would mean persisting it
outside the vault, which defeats the point of locking.

Storing _unencrypted_ ready-to-send wraps instead is no better: a wrap is p-tagged to
its recipient, so a plaintext outbox would leak exactly the thing the vault protects —
who the user is messaging.

**Decision.** No background sync. The outbox flushes when the app is open: on unlock, on
focus, on regaining connectivity, and on a 5-second timer while running.

**Consequence.** No push notifications either — Web Push additionally requires an
application server, which we do not run. This is the single largest UX cost of being
serverless, and it is stated plainly in the app rather than glossed over.

---

## ADR-008 — Direct connections are an accelerator, never a delivery path

**Decision.** Every chat message is published to relays even when a WebRTC data channel
is open.

**Why.** `RTCDataChannel.send()` returning without throwing means the frame entered the
SCTP buffer — not that the peer received or stored it. Treating that as delivery would
silently lose messages whenever a session drops mid-flight. Publishing regardless costs
one small extra write and buys durability plus the self-addressed copy that makes vault
restore work.

**Cost.** Roughly doubles publish volume for actively-connected pairs. Acceptable:
messages are kilobytes and arrive at human typing speed.

**Consequence.** No TURN server is needed. When NAT traversal fails — around 10% of peer
pairs — nothing breaks; the conversation stays on the relay path and the only difference
is latency.

---

## ADR-009 — No presence beacons

**Decision.** Do not broadcast periodic "I am online" events. Opening a conversation
sends a WebRTC offer, and an answer within a couple of seconds _is_ the presence signal.

**Why.** Periodic beacons to every contact publish a detailed record of when each user is
awake, in exchange for information the connection attempt already provides. The offer is
throttled to once per minute per peer.

**Note.** `presence` frames remain in the protocol and are parsed on receipt, because
another client or a later version may send them.

---

## ADR-010 — Millisecond ordering tag · **added during testing**

**Problem found in testing.** Five messages sent inside one second arrived in random
order on both ends. Nostr `created_at` is whole seconds, so all five compared equal and
the tiebreak fell to the rumor id, which is effectively random.

**Decision.** Carry an `["ms", "<epoch ms>"]` tag inside the encrypted rumor. It is
visible only to the recipient, ignored by clients that do not know it, and **rejected
unless it agrees with `created_at` to within one second** so it cannot be used to
reorder history.

**Rejected alternative.** Sorting by local arrival order — it makes sender and recipient
disagree about the order of the same conversation.

---

## ADR-011 — Recompute signatures instead of trusting the library cache · **added during testing**

**Problem found in testing.** A test that tampered with an event's signature still
passed verification. `nostr-tools` memoises `verifyEvent` on the event object under a
symbol key, and symbol properties survive object spread — so the mutated copy inherited
`verified: true`.

**Decision.** Verify Schnorr signatures directly from the serialised event every time,
never consulting the library's cache. Events reaching the crypto layer come from relays,
peers, and decrypted blobs; none of those provenances justify a cached verdict.

---

## ADR-012 — Test relay _writes_, not just reads · **added during testing**

**Problem found in testing.** `offchain.pub` shipped as a default relay. It answers
reads from anyone, so the original read-only probe passed it. Live delivery statistics
then showed 6 of 14 publishes failing with _"Policy violated and pubkey is not in our web
of trust."_

**Decision.** `scripts/probe-relays.mjs` now publishes a real, expiring gift wrap from a
throwaway key and requires an `OK: true`. That immediately disqualified three more
candidates: `relay.nostrplebs.com` (NIP-05 required), `nostr21.com` (blocks kind 1059),
`relay.momostr.pink` (proof-of-work required).

**Lesson recorded.** For a messenger, read access is not the capability that matters.

---

## ADR-013 — Hand-rolled router and i18n

**Decision.** No `react-router`, no `i18next`. A 90-line hash router and a 60-line
translator with compile-time-checked keys.

**Why.** Total surface is six routes and two locales. In an app whose security depends on
no third-party code executing, every dependency is something an auditor must read. These
two would have been larger than the code they replace.

**Cost.** No nested routes or lazy route loading. Neither is needed at this size.

---

## ADR-014 — Language and theme cached outside the vault · **added during testing**

**Problem found in testing.** Settings live encrypted, so the lock screen rendered in
English and dark mode for a user who had chosen Persian and light — every single time
they returned. For an app whose primary audience reads right-to-left, that is a poor
welcome.

**Decision.** Cache exactly two display values (`locale`, `theme`) in `localStorage`.
Nothing else is ever written there, and the encrypted record remains authoritative once
unlocked.

**Cost, stated plainly.** Someone with access to the browser profile learns which
language and theme the user prefers. They already have the device.

---

## ADR-015 — CSP injected at build time, not written into `index.html`

**Decision.** A build plugin injects the production Content-Security-Policy meta tag;
the dev server gets none.

**Why.** GitHub Pages cannot set response headers, so the CSP has to ship as a meta tag.
But Vite's dev server needs an inline script and a websocket to localhost for HMR. If
one policy had to serve both, it would be the dev policy — permanently weakening
production. Two policies, one of which never ships.

Production policy: `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
`frame-ancestors 'none'`, `form-action 'none'`, `connect-src 'self' wss:`,
`img-src 'self' data: blob:`.

---

## ADR-016 — A frame guard, because `frame-ancestors` cannot be delivered · **found in production build**

**Problem found in production testing.** The built page logged: _"The Content
Security Policy directive 'frame-ancestors' is ignored when delivered via a `<meta>`
element."_ Browsers only honour that directive in an HTTP response header, and a static
host cannot set headers. The clickjacking protection the policy appeared to provide did
not exist.

**Decision.** Remove `frame-ancestors` from the meta policy — leaving it in only emits a
console error on every page load, which trains people to ignore the console — and add a
`window.top !== window.self` guard in `src/main.tsx` that refuses to render inside a
frame. `scripts/check-bundle.mjs` asserts the guard survives minification, so a refactor
cannot silently drop it.

**Cost.** A frame guard runs after script load rather than being enforced by the browser
before it. Self-hosters behind a real web server should send the header as well, and the
threat model says so.

---

## ADR-017 — Ship source maps to production

**Decision.** `build.sourcemap` stays on for the deployed bundle.

**Why.** The largest risk in the threat model is a malicious or modified build (§2.2),
and the answer to it is verifiability. Source maps let anyone open DevTools on the live
site and read the actual code running, without reproducing the build. For an app that
asks users to trust bytes they did not compile, that is worth far more than the bandwidth
— and the maps are only fetched when a developer opens DevTools.

**Cost.** Larger deployment artifact. No runtime cost for ordinary users.

---

## ADR-018 — Page conversations instead of loading them whole · **found in review**

**Problem.** Opening a conversation decrypted every message it had ever contained.
Each message is an individual XChaCha20-Poly1305 open, so a long history meant a long
pause before the first paint — the cost falling hardest on the users with the most to
lose from being told to disable encryption features.

**Decision.** Walk the `[convoId+tsCoarse]` index backwards and stop once a page is
filled, with a fixed 64-row over-read so hour-bucket boundaries cannot drop or scramble
messages. "Load earlier" extends the window. Export keeps a separate full-history method
rather than passing an enormous limit — which, incidentally, is what surfaced this: a
limit of `Number.MAX_SAFE_INTEGER` overflows IndexedDB's unsigned-long range and threw.

**Verified by test.** `tests/repo.test.ts` counts actual decryptions and asserts that
loading 50 of 400 messages decrypts at most 114, not 400.

---

## ADR-019 — Request persistent storage, and say when it was refused · **found in production audit**

**Problem.** Nothing asked the browser to keep the database. IndexedDB is
best-effort storage by default: browsers evict it under disk pressure, and Safari's
Intelligent Tracking Prevention deletes all script-writable storage after roughly seven
days without a visit. For an ordinary site that loses a cache. Here it loses the user's
identity, contacts, and entire history — with no server-side copy, because there is no
server.

**Decision.** Call `navigator.storage.persist()` at boot and again immediately after
vault creation (browsers weigh engagement, and the second moment is far likelier to be
granted). Whether it was granted is shown on the Data screen, beside the backup control,
in plain words.

**Why not just request it silently.** Granting is at the browser's discretion and often
refused. A user whose storage is _not_ persistent needs to know that their backup is the
only thing standing between them and losing the account — so the honest answer is to
state the outcome rather than assume the request worked.

---

## ADR-020 — Subscribe per relay, not per pool · **found in production audit**

**Problem.** `nos.lol` and `nostr.mom` — two of six default relays — began requiring
NIP-42 `AUTH` for gift-wrap inbox reads. Textor is anonymous by design and does not
authenticate to relays, so those relays could no longer deliver mail.

Far worse than the policy change was that the app reported them as **healthy**. Two
compounding causes:

1. `SimplePool` invokes the pooled `onclose` only once _every_ relay's subscription has
   closed, so one relay's refusal among five healthy ones never surfaced at all.
2. Relay health tracked publish outcomes only. A relay can accept every publish while
   refusing to serve the inbox, which is precisely what these do.

**Decision.** Fan the inbox subscription out to one subscription per relay, so each
relay's close reason is attributable. Track read failures separately from write failures,
treat a refused subscription as decisive when computing the verdict, and tell the user in
words that the relay cannot deliver messages to them.

**Also fixed.** Health records written by earlier builds have no `readFail` counter, and
`undefined += 1` is `NaN` — which silently disabled the new check on exactly the
installations that would upgrade into it. Stored health is now merged onto a full default.

**Lesson recorded.** An honesty surface that cannot see a failure is worse than none: it
converts an outage into a confident green tick.

---

## ADR-021 — Precache the interface fonts, runtime-cache the rest · **found in production audit**

**Problem.** The font packages ship unicode-range subsets precisely so a browser
downloads only the script it renders. Precaching `**/*.woff2` defeated that entirely,
pushing 314 KB — including Cyrillic, Greek, and Vietnamese — onto every first load.

**Decision.** Precache only the two subsets the interface itself needs (Inter Latin for
English, Vazirmatn Arabic for Persian) and add a `CacheFirst` runtime rule for the rest.
A Cyrillic contact name still renders and is cached after first use. Precache dropped
from 947 KB to 740 KB with no loss of coverage.

---

## ADR-022 — Test only the capabilities actually used · **found in production audit**

**Problem.** Startup refused to run unless `crypto.subtle` existed. Nothing in Textor
uses WebCrypto — every primitive comes from `@noble` in pure JavaScript, and Dexie guards
its own optional use. Since `crypto.subtle` is exposed only in secure contexts, the check
would have refused to start on a plain-http LAN address for a capability never reached.

**Decision.** Gate on the genuine hard requirements — IndexedDB, `crypto.getRandomValues`,
`WebSocket`, `TextEncoder` — and name the missing one on screen. Everything else (WebRTC,
notifications, camera, compression, storage persistence) stays guarded at its call site
and degrades instead of blocking startup.

---

## ADR-023 — A token layer instead of a UI framework

**Problem.** The interface needed to move from serviceable to enterprise-grade —
sharp typographic hierarchy, layered surfaces, real press states, consistent focus
rings — without breaking the constraints the whole project rests on: no CDN, a strict
CSP, a sub-800 KB precache, and an instant cold start. The obvious routes both cost
something. Radix UI is genuinely headless and accessible, but it is runtime JavaScript
shipped for a handful of controls this app already implements (a focus-trapped modal, a
segmented control). Tailwind costs nothing at runtime, but adopting it means rewriting
roughly 1,400 lines of working, all-logical-property CSS into utility classes across
twenty screens — enormous churn, real regression risk, and no design improvement of its
own. Its actual value is its defaults: a spacing grid, a type scale, and colour ramps.

**Decision.** Take the defaults, not the dependency. `theme.css` is now three ordered
layers — raw ramps, semantic roles mapped from them, and shared metrics — so a colour
change happens in exactly one place and no component ever names a hex value. Components
stay hand-authored CSS with zero runtime cost. The design discipline comes from four
rules enforced by review: structure is 1px rules and alignment rather than shadows or
heavy rounding; every offset is a `--space-*` step on a 4px grid; every interactive
element defines rest, hover, active, and focus-visible; and every direction-sensitive
property is logical.

**Cost.** +1.9 KB gzipped CSS, +1.1 KB gzipped JS, +14.6 KB precache (740.5 → 755.1 KiB),
and no new runtime dependency.

---

## ADR-024 — The token layer is a build gate, not a comment

**Problem.** The old token file claimed "body text >= 7:1, secondary text >= 4.5:1" in a
comment. Nothing checked it, and nothing could: the dark palette was written out twice —
once for `[data-theme="dark"]` and once under `prefers-color-scheme` — so the two could
drift silently, and a reader with a system dark preference would get different colours
from one who picked dark explicitly. Darkening one ramp step to fix a border is exactly
the kind of change that pushes a text pair under threshold in one theme only.

**Decision.** `scripts/check-tokens.mjs` parses `theme.css`, resolves every semantic
role through its `var()` chain in all three theme resolutions (light, explicit dark,
system dark), and checks 38 real foreground/background pairs against their WCAG minimums —
7:1 for body text, 4.5:1 for secondary and for text on tinted fills, 3:1 for focus rings
and control boundaries. It also asserts the two dark maps resolve identically, and that
every `var(--x)` across the stylesheets, components, and `index.html` names a token that
exists — an undefined custom property does not throw, it silently renders invisible text
or a collapsed border. It runs in `npm run verify`.

It earned its place immediately: on first run it caught a magenta typo in a neutral ramp
step, tertiary text at 4.37:1 on the light canvas, input borders at 1.87:1 (well under the
3:1 that WCAG 1.4.11 requires for a control boundary), and a dark hover state where
lightening the accent had dropped white label text to 4.03:1. The duplicated dark block
stays — `light-dark()` would collapse it but would raise the browser floor to Safari
17.5, which nothing else in the app requires — and the parity assertion is what makes
keeping it safe.

---

## ADR-025 — Language and theme belong on the entry screens

**Problem.** Both settings lived only behind the vault. A Persian reader who opened
Textor for the first time, or who returned to a lock screen, got whatever the browser
guessed, in a layout they might not read, with no way to change it before typing a
passphrase. Worse, a choice made before unlocking was thrown away the moment a vault
opened: `createVault` carried the locale into the new vault but not the theme, and
`unlock` replaced both with whatever the vault remembered.

**Decision.** Welcome, onboarding, restore, lock, and the unsupported-browser screen all
share an `EntryLayout` carrying a wordmark and two segmented controls. They write through
`setDisplayPreference`, which persists to the vault when one is open and to the small
unencrypted display cache when one is not, and records the change as pending. A pending
choice is written into the vault as the session starts, so an explicit selection always
wins over a remembered one.

`main.tsx` applies the cached language and theme to `<html>` before React mounts. An
effect-only approach paints one frame of light-theme, left-to-right layout first — least
forgivable on the lock screen, which a returning user sees several times a day.

The privacy cost is unchanged and still small: local storage already held these two
values, and holds nothing else.

---

## ADR-026 — One mark, three shapes, drawn from shared numbers

**Problem.** The old icon was a "T" with a dot below it. At 16px the crossbar and stem
merged into a grey smudge and the dot vanished, so the favicon was a blue square with
noise in it. It also said nothing about what the app is. Worse, the SVG favicon and the
`generate-icons.mjs` PNG renderer described the mark twice, in two different languages,
with nothing keeping them in agreement — and the renderer tested one point per pixel, so
every curved edge shipped visibly stepped.

**Decision.** The mark is a message bubble containing a link between two nodes: a message
that goes from you to them, not through anyone's server. Three shapes, two colours, no
gradient and no shadow — at favicon size that is all that survives, and the link degrades
into a single dark band rather than into mud.

Both renderers are driven by the same numbers on the same 64-unit grid, expressed as
analytic primitives (rounded rectangles, a triangle, two circles) rather than as a path,
so the PNG generator can reproduce the vector exactly instead of approximating it. The
renderer now supersamples 16 points per pixel, which is what makes the badge corners and
the bubble read as drawn rather than as stepped.

Each touchpoint gets the shape it actually needs, which is not the same shape:

| Asset                            | Form                                    | Why                                                        |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `favicon.svg`, `icon-32/192/512` | rounded, transparent outside            | the badge supplies its own corners                         |
| `apple-touch-icon`               | full bleed, no rounding                 | iOS applies its own mask; pre-rounded corners render black |
| `icon-maskable-512`              | full bleed, mark at 75%                 | survives a circular crop of 80%                            |
| `mask-icon.svg`                  | bubble silhouette only, cropped viewBox | Safari recolours it at ~16pt, where the link is sub-pixel  |

Verified by rendering a contact sheet at 16/20/24/32/48/64/128, magnifying the 32px raster
8× to inspect the anti-aliasing pixel for pixel, and applying circular, squircle and iOS
masks to the maskable and touch icons.

**Cost.** +7 KB of precache for two new assets and the extra entropy that anti-aliasing
adds to the PNGs.

---

## ADR-027 — Say something about the connection only when there is something to say

**Problem.** Connection state was a single badge in the conversation-list header, invisible
from every other screen — including an open conversation, which is exactly where knowing
you are offline matters. A separate warning banner reported offline, so two components
described the same fact in different words. Nothing reported the case that actually loses
messages: relays that connect and accept publishes while refusing to serve your inbox.

**Decision.** `core/engine/connectionStatus.ts` collapses the browser's online flag, the
open socket count, per-relay verdicts, and in-flight work into one ordered state —
`offline`, `connecting`, `degraded`, `sending`, `syncing`, `connected`. It is a pure
function of two inputs, so the ordering that matters is unit-tested rather than argued
about: `degraded` outranks `sending` and `syncing`, because a relay that silently drops
your mail is worth interrupting for and a transient sync is not.

Two presentations share that state. A thin strip below the app chrome appears on every
screen, but only while there is something to report, and leaves once it has said so. A
badge in the conversation-list header is always present and answers the different
question — how well am I connected — which for a serverless messenger only relay count
can answer honestly.

The timing is the design. Relay sockets flap, and an indicator that reports every blip
trains people to ignore it, so a problem must persist 700 ms before the strip appears.
Losing the network skips that delay: it is not a blip. When a problem clears the strip
stays for 1.8 s showing "Connected", so every episode gets an ending rather than
vanishing and leaving the user unsure whether it recovered. A blip nobody saw gets no
confirmation, and costs no render at all.

Losing the network also now republishes the sync state directly from the browser's
`offline` event. Waiting for relay sockets to time out left the app claiming to be
connected for seconds after it demonstrably was not.

---

## ADR-028 — Attachments travel as chunks, not as links

**Problem.** Every mainstream way to attach a file to a Nostr message points at a server.
NIP-96 and Blossom both work by uploading a blob somewhere and putting a URL in the
message. Even with the payload encrypted, that means an availability dependency on a host
we do not run, and an upload that leaks our IP, the exact byte length, and the timing to
that host — and Blossom's auth event ties the upload to our pubkey unless a throwaway key
is used. For an app whose entire pitch is "no server we operate", reaching for someone
else's server the moment a photo is involved is the wrong default.

**Decision.** Payloads move as encrypted chunks over the two transports the app already
has. The message and the payload are separate: the rumor carries a descriptor — name,
size, duration, waveform, blurred preview — and arrives immediately, while the bytes
follow as `blob` control frames. A payload that never finishes leaves a readable message
rather than a hole, and one interrupted halfway resumes rather than restarts.

Which transport carries it is a function of size. Up to 1 MB the relay path will do it in
about 32 events, which works whether or not the recipient is online — the property that
matters most in a messenger. Beyond that it needs the direct WebRTC channel, and the
send is refused with a clear message rather than queued into something that can never
complete. Re-encoding is what makes the common case fit at all: a 1.8 MB phone photo
came out of the canvas at 47 KB in testing, comfortably inside the relay budget, and
re-encoding drops EXIF location and camera serial on the way.

A third tier — a user-configured Blossom or NIP-96 host, off by default — remains
possible and is deliberately not built yet. It would be the only part of this app that
talks to a server, so it should be an explicit, informed choice rather than a default
nobody notices.

---

## ADR-029 — Chunks are independently decryptable, but not independently trustworthy

**Problem.** Chunks have to decrypt on arrival, in any order, or a transfer cannot resume
and cannot show progress. Independent chunks invite three attacks that a single sealed
blob does not: replaying a chunk at the wrong index, truncating the tail and passing it
off as a shorter payload, and splicing in chunks from a different payload.

**Decision.** Each chunk is XChaCha20-Poly1305 with a STREAM-style nonce — a random
16-byte per-blob salt concatenated with the chunk index — and an AAD binding the blob id,
the chunk index, and the total chunk count. All three attacks become authentication
failures. The blob id is the SHA-256 of the plaintext and is re-checked after reassembly,
which catches the one case per-chunk tags cannot: a sender whose descriptor disagrees
with what they actually sent.

Chunks are verified _before_ they are stored, not after, so a peer cannot fill the
database with garbage that only fails at the end. A chunk for a payload we were never
told about is dropped rather than kept: without the descriptor there is no key, so it is
undecryptable noise, and storing it would be free disk consumption for an attacker.

The per-blob key is random, single-use, and travels inside the NIP-44-encrypted rumor —
so the ciphertext is useless both at rest and in flight without the conversation it
belongs to. That also means no double encryption at rest: chunks are stored exactly as
they travelled, and the vault key protects the descriptor that unlocks them.

---

## ADR-030 — The receiver drives the transfer

**Problem.** The relay path drops events. A relay may be down, may refuse a publish, or
may simply not have been subscribed at that moment. If the sender owned completion it
would have to track per-relay acknowledgement for every chunk and retry blindly, and a
transfer interrupted by a reload would restart from zero.

**Decision.** The sender pushes the payload once and stops caring. The receiver knows
what it is owed from the descriptor, and when a transfer goes quiet for 8 seconds it asks
for exactly the indexes still missing. Progress is rearmed on every arrival, so a healthy
transfer never costs a redundant round trip, and a bounded round counter stops a peer
that has genuinely gone away from costing unlimited relay events.

All of the state lives in the database rather than in the transfer object, which is what
makes a transfer survive a reload, a lock, or a week offline: reopening the app recomputes
what is missing from the chunks on disk rather than trusting a counter.

Chunk rows are keyed individually rather than held as an array on the manifest. Rewriting
a multi-megabyte record on every arriving chunk is O(n²) of IndexedDB writes, which is
slow enough to feel on a phone.

---

## ADR-031 — The sender's own copy must exist before the message does

**Problem.** Found by testing the real thing in a browser rather than by reading the code:
sending a file produced a permanently broken bubble on the sender's own screen. The
message was written and emitted, the UI rendered it, and the bubble read the payload back
out of storage — before the chunks had been written, because storing was fired off
without being awaited. The read failed, the component latched its error state, and
nothing ever re-tried.

**Decision.** Two fixes, because there were two faults. Storing an outgoing payload is now
a separate, awaited step that completes before the message referencing it is created, so
the sender and the receiver read from the same store with the same guarantee. And the
attachment view derives its failure state instead of storing it, so a payload that is not
readable _yet_ renders as still-arriving rather than as broken — an error that can latch
is worse than one that waits, because the bytes usually do turn up.

The unit tests could not have caught this: they exercised the transfer engine correctly
and in isolation. It took driving the actual UI to see the ordering.

---

## ADR-032 — What actually stopped photos arriving

**Problem.** Photos marked "sent" and never appeared for the recipient, over relays and
over WebRTC alike. Voice notes arrived. That asymmetry was the clue, and there turned out
to be four independent faults, each sufficient on its own.

**One: an ingest guard that predated attachments.** `#ingestChat` dropped any rumor whose
content was empty, as noise. An uncaptioned photo _is_ an empty kind 14 — the payload is
in a tag. So every photo was discarded on arrival while the sender saw "sent". Voice notes
survived only because they happened to carry a caption. Attachments now count as content,
and the composer additionally captions every attachment so other Nostr clients show
something rather than an empty bubble.

**Two: chunks were three times larger on the wire than assumed.** Base64 is applied three
times over — into the frame, again by the NIP-44 seal, again by the gift wrap. Measured,
a 32 KiB chunk became a **109,732-byte** event, past the 64 KiB ceiling most public relays
enforce, so every chunk was accepted by the publish call and silently discarded. 16 KiB
measures 55,112 bytes. The constant now carries the measurement and the arithmetic.

**Three: resends sent the wrong chunk count.** `serve()` inferred the total from
`max(need) + 1`, which is right only when the last chunk is among the missing. Otherwise
the resent frames declared a total the receiver rejected — and, because the total is bound
into each chunk's AAD, one it could not have decrypted anyway. The total now comes from
the sender's own manifest.

**Four: chunks were queued as ephemeral.** They shared a lane with typing indicators,
expiring after two minutes and three attempts, and were explicitly skipped when a direct
channel opened. Chunks are the payload of a real message and are now queued durably.

**How they were found.** Not by reading the code. The unit tests for the transfer engine
all passed throughout; the faults were at the seams between layers. Two browser instances
on different ports — different origins, so genuinely separate storage — talking over live
public relays showed the recipient holding `seen: 9` events and zero messages, which
pointed straight at ingest. The test suite now has a two-peer attachment section and a
fake relay that can refuse oversized events, which reproduces fault two exactly.

---

## ADR-033 — Chunks that arrive before their message are kept, not dropped

**Problem.** The sender publishes the message and starts pushing chunks in the same
breath, and relays deliver in whatever order suits them. Chunks therefore routinely arrive
before the descriptor that explains them — the console showed two of every three lost this
way. They were dropped, on the sound reasoning that an unverifiable chunk must never touch
the database, leaving resend requests to rebuild most of the payload.

**Decision.** Hold them in memory instead. They cannot be verified without the key, so
they are never persisted unchecked; the buffer is capped at 4 MB with oldest-first
eviction so a peer cannot spend our memory by sending chunks for a message they never
send. When the descriptor lands, each held chunk is verified and either stored or
discarded.

Separately, nothing re-registered interest in a payload after a reload: the chunks were on
disk but the watcher that asks for the missing ones lives in memory, so an interrupted
transfer stayed interrupted forever. Opening a conversation now resumes its incomplete
attachments.

---

## ADR-034 — Menus are measured, not placed

**Problem.** The action bar sat inside the bubble at the top corner, over the first line of
text — worst on a short incoming message, where it covered most of it. The dropdown was
absolutely positioned inside the bubble with a fixed alignment, so on a narrow incoming
bubble it ran off the screen edge, and because the message list is a scroll container it
was clipped by that container's overflow as well.

**Decision.** The action bar moves into the gutter beside the bubble, where it cannot
collide with content and the row already has room. The menu becomes a `Popover` portalled
to the body and positioned with `fixed`, which puts it above every clipping ancestor. It
measures the trigger and itself, flips above when there is no room below, and clamps both
axes to the viewport — so a corner trigger on a 320px phone still produces a fully visible
menu. Alignment follows the writing direction: the panel's trailing edge tracks the
trigger's, which is the right edge in English and the left edge in Persian.

A `ResizeObserver` re-measures the panel. The first measurement is taken before the
content has finished laying out and reads narrower than the panel ends up, and clamping
against that stale width left it flush against the screen edge — the exact overflow the
component exists to prevent.

---

## ADR-035 — Deletion is a tombstone, and says so

**Problem.** Deleting a message removed it from one device. Nothing asked the other to
delete its copy, and nothing removed the attachment payload — so "delete" could leave
megabytes of the deleted photo on disk.

**Decision.** A `redact` control frame naming the rumor ids to withdraw, carried over the
same encrypted envelope as everything else and queued durably, so a peer who is offline
honours it when they next connect rather than keeping the message because they missed one
event.

Two rules make it safe. A client only sends a withdrawal for messages it authored, and a
client only honours one for messages the sender authored — without the second, anyone who
could reach your inbox could delete your own words out of your own conversation. Both are
tested, including a forged request.

Deletion takes the payload with it on both devices, but only when no surviving message
references the same blob: payload ids are content hashes, so forwarding shares them, and
deleting the bytes out from under a surviving message would leave a permanently broken
bubble no resend could fix.

The name is deliberate. This is a tombstone the other client is asked to honour, not an
erasure anyone can enforce — a modified client can ignore it and a relay may still hold
the wrap. The confirmation says exactly that rather than promising more.
