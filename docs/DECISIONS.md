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

**Update.** Forward-secret groups (ADR-049) bring MLS in for the conversations that opt
into it. Direct messages and small groups are unchanged, and this decision still covers
them.

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

**Update.** ADR-054 turns the one KEK into many: any number of keyslots each seal the same
data key, which is what this hierarchy was built to allow.

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

**Update.** Since ADR-054 the parameters are stored per passphrase slot, and a passphrase
is one way to open the vault among several rather than the only one. The cost measured
here is paid only by people who choose it.

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

**Update.** ADR-054 adds a way to open the vault with nobody present: the device key of a
vault set to open instantly. A worker could, in principle, now decrypt. It is deliberately
not given one. Background sending would be a real gain, but it would also make every
device that opens instantly a device that decrypts while closed, and that is a new
surface to decide on its own, not a side effect of a login choice.

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

**Update.** ADR-060 took the controls out of the gutter on a touch screen, which has no
hover to reveal them and, on a phone, no gutter to spare. There, holding the bubble opens
its menu, measured against the bubble. ADR-061 changed that to Telegram's arrangement: a
tap opens the menu, and holding selects.

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

**Update.** ADR-061 widened who may ask. Between two people, either may delete anything in
their conversation for both. In a group, only the author may delete their own message.

---

## ADR-036 — Own the relay sockets · **found by measurement**

**Problem.** "Connecting…" lingered, and messages sent after a pause took seconds to show
as sent. Measured from a slow international link against the six default relays, the time
from pressing send to "sent" was 9.3 s on a fresh session, 0.4 s while warm, and 10.4 s
after 21 seconds of doing nothing. Warm acknowledgements arrived in about 290 ms, so the
relays were not the bottleneck; the connection handling was.

`nostr-tools`' `SimplePool` is built for a feed reader that opens relays on demand and lets
them go. Driven through a scriptable fake WebSocket, version 2.25.0 showed four defaults
that are each wrong for a messenger:

| Behaviour                                                                    | Effect on a messenger                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closes any socket idle for 20 s                                              | The next message pays a fresh TLS handshake. Cold handshakes to healthy relays measured 0.8–10 s.                                                                         |
| Subscriptions get 3 s to connect; a failed first connection is never retried | With a 5 s handshake: **one** attempt in ten minutes, and the live inbox on that relay delivered nothing all session. Messages appeared only when the app regained focus. |
| First reconnect waits 10 s                                                   | Every relay restart or network blip is a ten-second hole in the inbox.                                                                                                    |
| On reconnect, `since` jumps past the newest event seen                       | NIP-59 backdates wraps by up to two days, so a message wrapped during the outage with an earlier timestamp was **never delivered** by the resumed subscription.           |

Zombie sockets — open to the browser, dead on the wire after sleep or a network switch —
went unnoticed for up to 49 s by the library's own constants (a ping every 29 s, 20 s to
answer), and then waited on a close handshake a dead network never completes.

**Decision.** A small socket layer of our own (`relaySocket.ts`), with the pool on top:

- **Kept connected while wanted.** Configured relays connect the moment the vault unlocks
  and stay connected. A contact's inbox relays are pre-warmed when their conversation
  opens and released three minutes after last use.
- **Reconnects in about a second.** Decorrelated-jitter backoff from 400 ms to 30 s. A
  relay that has failed eight times in a row without opening is treated as down and
  retried every five minutes at most, until something wakes the transport. While the browser reports no network, retries wait at the
  cap.
- **Resumes subscriptions exactly as defined.** A subscription's filter is a function,
  re-evaluated on every reconnect, so the inbox resumes from the sync cursor with its
  three-day rewind rather than from the newest event a relay happened to send.
- **Proves liveness adaptively.** A keepalive probe — a request for an event that cannot
  exist — goes out after 25 s of silence. If it goes unanswered, the interval halves and
  never grows back to the length that killed the connection. Against an 18 s NAT timeout
  it settles at 16 s after two losses. A publish that goes unanswered triggers a probe
  immediately, so a zombie is found in ten seconds on the critical path, not a minute.
  Anything sent but unacknowledged is resent on the new connection; relays deduplicate by
  event id, so a resend cannot double a message.
- **Wakes on the browser's word.** `online`, `visibilitychange`, `focus`, `pageshow` from
  the back/forward cache, the Page Lifecycle `resume`, and an outbox heartbeat that
  arrives far later than scheduled (the device slept) all wake the transport. Stale
  backoff timers are discarded, open sockets are probed (not on mere focus), retries
  waiting out a backoff are brought forward, and a catch-up read runs if a read relay has
  dropped since the last one.
- **Cheap on duplicates.** Every relay delivers the same event. Duplicates are recognised
  from the raw frame and skipped before JSON parsing and Schnorr verification. Frames over
  1 MiB are dropped unparsed. Nothing reaches the app unless it matches the filter asked
  for and carries a valid signature.

**Not done: connecting before unlock.** It would save the handshake on the lock screen,
but the relay list lives inside the vault. Connecting to the defaults instead would reach
exactly the relays a privacy-conscious user may have removed, before they had typed a
passphrase. The pre-warm starts at unlock.

**Measured after**, same relays, same link, same method:

| Scenario                           | Before    | After    |
| ---------------------------------- | --------- | -------- |
| Send the instant the vault unlocks | 9,253 ms  | 1,185 ms |
| Warm sockets                       | 402 ms    | 304 ms   |
| After 21 s idle                    | 10,372 ms | 330 ms   |

The first row includes the handshakes themselves; the pre-warm removes them from every
send after that.

**Cost.** About 1,060 lines of transport code we now own (1,560 with comments), replacing a
344-line wrapper around a dependency we did not have to maintain, plus a fake WebSocket
network to test it against. In the bundle, the `nostr` vendor chunk shrank from 24.4 kB to
6.3 kB and the app chunk grew by 13.7 kB — net 4.5 kB smaller raw, level gzipped.

**Revisit if** `SimplePool` gains configurable idle closing, first-failure retries,
reconnect backoff, and owner-defined resumed filters — at which point this layer is a
fork of it and should go.

---

## ADR-037 — "Sent" means a quorum, not every relay

**Problem.** A message was marked sent only once every targeted relay had answered —
up to ten, including one black-holed address that answers only by timing out after ten
seconds. The first acknowledgement had long since arrived. Two of the six defaults were
broken on the day this was measured — one refused connections, one rejected every write
with a full disk — so the slowest answer was always a timeout.

**Decision.** `RelayPool.dispatch` publishes to every target at once and resolves twice:
at a **quorum**, which is when the message is called sent, and when everything has
**settled**, which updates the acknowledgement count afterwards. Nothing is cancelled.

- **Quorum size.** Two acknowledgements from four or more targets, otherwise one. One
  proves the message left the device; a second from an independent operator makes it
  durable against that relay restarting or quietly discarding the event. With three or
  fewer targets a quorum of two would often wait on the slowest, which is the stall this
  removes.
- **Failover to hot standbys.** If the quorum has not formed within 2.5× the expected
  latency of the relay that would complete it (bounded to 1–4 s), the event also goes to
  configured relays that are already connected and healthy but were not targeted. If every
  target has already failed or cannot connect, that happens at once. Failover costs a
  send, not a handshake.
- **Scoring that forgets.** Lifetime counters could not tell a relay that failed last
  year from one failing now: 200 good publishes followed by a full disk still read as 98%.
  Health now carries a recency-weighted reliability, and the score is
  `reliability² × latency factor`, plus a bonus for an open socket. Squared, because a
  failure costs twice — the attempt and the relay that carries the message instead;
  linear weighting let a relay refusing 40% of writes at 150 ms outrank one keeping 98% at
  1.2 s. Existing health records seed reliability from their counters, so an upgrade
  resets nothing.
- **Circuit breaker.** Three failed publishes in a row open a relay's circuit for 15 s,
  doubling to five minutes. Open does not mean excluded: the relay may be the only one the
  recipient reads, so it still receives the event — it is just not forced to reconnect,
  and it sinks below working relays.
- **Relays ranked at delivery, not at queueing,** so a retry does not lead with a relay
  that failed in the meantime.

**Also fixed.**

- The self-addressed copy went to every target, including the recipient's inbox relays,
  and to attachment chunks and withdrawals as well as chat messages. The receiving side
  discards control-frame self-copies unread, so **every attachment was uploaded twice**.
  Self-copies are now chat messages only, sent to our own inbox relays — the one place a
  restored vault or second device reads. Where the two peers' relay sets differ, a
  recipient's relay also no longer receives a wrap for the sender from the same connection
  at the same instant. Where they overlap, as on the defaults, it still does.
- A delivered status could be overwritten back to "sent", and a retry could demote a
  message the peer had already acknowledged over a direct channel back to "queued" or
  "failed". Status now only advances.

**Cost.** A message can show as sent while one of its relays is still going to reject it.
That was always true of any single relay's acknowledgement; delivery receipts remain the
signal that the recipient has it.

**Revisit if** relays commonly acknowledge and then drop events, which would argue for a
larger quorum at the price of latency.

---

## ADR-038 — The outbox has lanes

**Problem.** The outbox delivered one item at a time, each waiting on every relay. A text
typed after sending a photo waited behind all of the photo's chunks — and each chunk
behind the slowest relay's timeout. Receipts and WebRTC signalling queued behind them
too, so a direct connection took longer to open precisely when a large payload made it
worth opening. The due list was also capped at 32 rows ordered by schedule, so a message
queued behind 32 chunks was not even considered until they had gone.

**Decision.** Two lanes with their own concurrency. Messages, receipts, signalling and
withdrawals share a **priority** lane of six. Attachment chunks get a **bulk** lane of two,
so a payload cannot starve messages or saturate the uplink. Launching is coalesced and
never waits on a delivery; each completion launches the next.

The lane is read from the outbox id, whose prefix is plaintext: choosing the next two
chunks must not mean decrypting every 55 KB chunk row, and the scheduler runs after every
delivery. The prefix reveals no more than the ciphertext's size already does. The due
list is read as primary keys straight off the index, without loading row bodies.

**Also.** When a direct channel opens, everything queued for that peer is handed to it —
including items waiting out a retry backoff, which are exactly the ones the relay path has
been failing on. Receipts and profile updates the channel accepts leave the queue.
"Sending N messages…" counts messages a person wrote, not the receipts and chunks behind
them. A catch-up read no longer waits for the outbox to drain, which had held the app in
"Checking for new messages…" for the length of an upload, and is skipped entirely when no
read relay has dropped since the last one — the live subscription saw everything.

**Cost.** Up to eight deliveries in flight at once instead of one.

**Revisit if** relays start rate-limiting per connection at that concurrency.

---

## ADR-039 — Unread is decided when the message arrives · **found in use**

**Problem.** A message arriving in the conversation being read still incremented that
conversation's unread count. Nothing cleared it until the conversation was opened again,
so going back to the list showed a badge for a conversation the reader had just been
looking at.

**The tempting fix is wrong.** Clearing the badge after the fact — on the incoming-message
event, or when the list regains focus — writes the count and then clears it in two
separate transactions. Anything reading the database in between sees a badge for an open
conversation, which is a visible flicker; and the two writes race, so a refresh already in
flight can restore the count after it was cleared and leave it on screen until something
else happens to refresh. Both are the reported defect in a smaller window.

**Decision.** The engine knows which conversation is on screen, so a message that arrives
there is never counted at all. `setActiveConversation` is called when a conversation opens
and closes, and whenever the window's visibility or focus changes; `#ingestChat` skips the
increment when the message belongs to the conversation being watched, and sends a read
receipt instead of a delivery receipt, batched so a burst of ten costs one frame.

"Being watched" needs the window as well as the route: a message arriving in a background
tab or an unfocused window has not been read, so it is counted, and coming back clears it.
Opening a conversation is the exception — that is an act of reading, so it clears the
badge whatever the window is believed to be doing. A browser that reports a blur without a
matching focus must not be able to strand a badge on the conversation being read.

**Also fixed.** Several database reads can be in flight at once — a message arriving, a
conversation opening, a refresh on a timer — and they do not finish in the order they
started. An older read landing last put a stale snapshot on screen: a badge that had been
cleared, or the previous conversation's messages. Both reads now take a ticket and are
discarded if a newer one has started. And an `openConversation` that finished after the
conversation had already been closed used to leave the engine watching a closed
conversation, which stopped it counting anything that arrived there afterwards.

**Cost.** The engine holds one more piece of UI state. The alternative — the UI clearing
the count itself — is what produced the defect.

**Revisit if** a conversation can ever be on screen twice at once, which would make a
single "the conversation being watched" too narrow.

---

## ADR-040 — The precache is a budget, and lazy chunks are how it is kept

**Problem.** Everything in the service worker's precache manifest is downloaded before
the app is usable at all, so the manifest is the cold-start cost on a slow link. Adding a
feature most sessions never open — a picker, a codec, a group-crypto stack — spends that
budget on everyone. The obvious answer, "split it with `import()`", does not work on its
own: Workbox globs `**/*.js`, so a dynamically imported chunk lands in the manifest
exactly like the shell.

**Decision.** Chunks reached only through `import()` are named `lazy-*`, excluded from the
manifest by `globIgnores`, and served by a `CacheFirst` runtime rule — so they cost
nothing at install and still work offline once used. The names are content-hashed, so a
cached entry can never be stale.

`scripts/check-bundle.mjs` enforces it against the built output rather than the config
that was meant to produce it: nothing lazy may be precached, every shell asset must be,
the total must stay inside 800 KiB, no lazy chunk may be reached by a static import or
preloaded by `index.html`, and a runtime rule must exist to serve them. The policy lives
in `scripts/precachePolicy.mjs` as pure functions so each failure has a unit test — in a
real build those are reachable only by breaking it on purpose.

**What the enforcement found immediately.**

- `vite-plugin-pwa` adds every icon named in the web app manifest to the precache _after_
  `globIgnores` is applied, so excluding them there did nothing: three PNGs and a second
  copy of the favicon were downloaded before the app could start. The install cost was
  **804.7 KiB — already over the 800 KiB budget** — while the plugin's own figure said
  788.4, because it does not count what it injects. `includeManifestIcons: false` fixes
  it; the manifest itself stays precached, and the icons are fetched by the operating
  system at install time, which by definition happens online.
- Naming is not grouping. The first attempt pointed an `advancedChunks` group at the
  picker's directory; a group claims a module _and its dependency subtree_, so it swallowed
  the store and half the engine, and the shell ended up statically importing the "lazy"
  chunk. The check caught it. Chunks are now named by whether they are a dynamic entry,
  which splits exactly on the `import()` boundary.
- `workbox-window` is itself dynamically imported, so it became lazy too. That is correct:
  it exists to check for updates, which needs the network anyway, and a failed import
  offline is already routed to `onRegisterError`. It saves 5.7 KiB of install cost.

**Cost.** The shell now sits at 798.5 KiB of 800 KiB. That is deliberate — the budget is
meant to bind — but it means the next feature to touch the shell has to bring its own
savings. Route-level splitting of the settings screens is the obvious next candidate, and
the infrastructure for it is now in place. _(Done in ADR-043, which found a larger saving
than settings.)_

**Revisit if** the budget stops reflecting a real cold start — if, say, HTTP/3 and a
better cache story make install size the wrong thing to optimise.

---

## ADR-041 — Rich payloads travel inside the envelope

**Problem.** Reactions and threading are solved problems on Nostr: NIP-25 defines a kind 7
reaction, NIP-10 defines thread markers. Both are designed to be _public_. A kind 7
published openly tells every relay that this key reacted to that event — which is exactly
the conversation graph NIP-17 and NIP-59 exist to hide. Adopting the transport would undo
the product.

**Decision.** Adopt the semantics, reject the transport. A reaction is a NIP-25 kind 7
rumor — same `e`, `p` and `k` tags, same content — sealed inside the gift wrap like every
other rumor, so a client that understands sealed reactions reads ours without special
cases and a relay sees one more indistinguishable wrap. Threading uses NIP-10 markers
written in the current form (`root` and `reply`) and read in both the current and the
deprecated positional form, because other clients still send both. `mention` is
deliberately ignored: quoting a message is not replying to it, and treating it as a
parent would graft unrelated messages into a thread.

Three rules make reactions behave:

- **One per person per message.** Reacting again with the same emoji withdraws it; a
  different one replaces it. NIP-25 says nothing about duplicates, but a reaction bar that
  can show the same person three times is noise.
- **Withdrawal reuses `redact`,** the frame that already unsends a message, so taking a
  reaction back removes it from the other side rather than leaving one the person who
  placed it can no longer reach.
- **Stored even when the message has not arrived.** Relays deliver wraps in whatever order
  they like and a restored history arrives as a batch; a reaction row keyed by message id
  simply becomes visible when the message lands. Dropping it would lose it for good.

Reactions live in their own table rather than as a field on the message: they are written
by the other side, arrive long after, and rewriting the sealed message record on every
thumbs-up would race the delivery-status updates to that same row. Aggregation into
"👍 3" happens at render time, so what is stored stays the thing that actually arrived.

**Bodies are validated, not trusted.** A reaction must be a short emoji sequence or
NIP-25's `+`/`-`: no letters, digits, whitespace or control characters, and at most 16
characters. The check is by codepoint range rather than an allow-list, because Unicode
adds emoji every year and a list would reject next year's while pretending to be complete.
Without it, "reaction" is a second message field that renders in a bar nobody can moderate.

**Cost.** A reaction costs a gift wrap per recipient plus a self-copy, where a public
kind 7 would cost one event. That is the price of the graph staying hidden.

---

## ADR-042 — Sticker packs are vault-local

**Problem.** NIP-30 custom emoji are remote image URLs. Textor's policy is
`img-src 'self' data: blob:`, which blocks them — deliberately, because a remote image is
a tracking pixel with extra steps, and relaxing the policy would hand every pack author a
way to log who opened which conversation and when. Blossom and NIP-96 blob hosts have the
same problem twice over: they need an HTTPS origin `connect-src` forbids, and they
reintroduce an operator.

**Decision.** A pack is local. The images are sealed and chunked by the same code that
carries an attachment — one blob per sticker, addressed by the hash of its plaintext — and
the manifest is an encrypted row naming them. Nothing is fetched from anywhere: a pack is
built from files already on the device.

Sending a sticker sends an **ordinary image attachment**, not a new message type. The
person receiving it needs no pack, no shared vocabulary and no new code, and it travels
over the chunk transport that already carries photos. That also means a sticker is exactly
as private as a photo, which is the property that matters.

The picker is the first subsystem built on ADR-040: everything under `src/ui/emoji/` is
the `lazy-emoji` chunk, fetched the first time somebody opens it. The emoji list is
curated rather than generated — a full Unicode database with names and search keywords is
larger than the entire application shell.

What _is_ taken from Unicode is the shape. The list is grouped into the eight standard
CLDR categories in their published order — Smileys & Emotion, People & Body, Animals &
Nature, Food & Drink, Activities, Travel & Places, Objects, Symbols — so the picker reads
the way the platform keyboard beside it reads, and nobody has to learn where Textor
decided to file a cat. Flags are the one group left out: they are 270-odd entries whose
weight is spent almost entirely on glyphs nobody reacts with, and curating a subset of
them means choosing which places are worth listing. Every offered glyph is checked
against `isReactionBody` by a test, so the picker cannot offer something the protocol
layer would then reject.

**A bug this found.** Blobs are addressed by the hash of their plaintext, but each call to
`sealBlob` picks a fresh key. Importing the same picture into two packs therefore produced
one blob id under two keys, and storing the second set of chunks left the first pack
holding a key that no longer opened them. Importing now reuses the envelope the vault
already holds for that content, which stores the bytes once and keeps both packs readable.

**The same root cause is reachable on the attachment path** and is _not_ fixed here: two
people sending you the identical photo produce the same blob id with different keys, and
the second one received makes the first unreadable. It is reproducible today. Fixing it
means keying chunk rows by content _and_ key, which the resend protocol — which asks for a
payload by id alone — cannot currently express. It is written down rather than quietly
left, and wants its own change.

**Update.** Fixed by ADR-052, which also found that the pack path was not safe either:
sending a sticker sealed the picture again and overwrote the pack's own copy.

**Revisit if** a pack ever needs to travel between people as a pack rather than as a
series of pictures, which would need a manifest frame and a way to request a pack by id.

---

## ADR-043 — Secondary screens are lazy, and warmed while idle

**Problem.** ADR-040 left the shell at 798.5 KiB of an 800 KiB budget, and it had reached
799.2 by the time groups were planned. A feature of any size would breach it. The obvious
move — split the settings screens — was worth less than it looked.

**Measured first.** A build instrumented to report each module's rendered size put the
largest single item in the shell at **77.6 KiB before minification: the `qr` package**,
imported by exactly two screens, Add Contact (to show or scan an invite) and safety-number
verification. The four settings screens together were 43 KiB, and `exportImport` — used
only when a backup is written or read — another 5.7.

**Decision.** Everything that is not on the path from a cold start to answering a message
is a lazy chunk: settings (one chunk for the four screens, since whoever opens one opens
another), verification, QR encoding and scanning, the recovery-phrase ceremony, restoring
a backup, backup export/import itself, starting a group and its info screen, and the
poll and checklist cards and forms. What stays is the lock screen, the chat list, a
conversation, and the contact list. All the split points live in one table,
`src/ui/lazyViews.tsx`.

**Offline is kept, not traded.** Excluding a chunk from the precache would, on its own,
make that screen unavailable the first time it is needed offline — and "restore a backup"
or "export before wiping" is exactly when that happens. So `src/app/warmup.ts` fetches
every chunk in that table once the page is idle, one at a time, after first paint and
never before it; the runtime cache keeps them. Install cost stays low, start-up does not
compete with them, and after one online session the app is as complete offline as if they
had been precached. It is skipped entirely under Save-Data. Because the warm-up reads the
same table the lazy components are built from, a new split point is warmed without anyone
listing it twice.

**What building it found.**

- **Shared modules leak back into the precache.** `exportImport` was imported statically
  by both the settings chunk and the restore chunk, so the bundler hoisted it into a
  shared chunk — named without the `lazy-` prefix, and therefore precached. It is now
  imported at the moment of export or import, which makes it a lazy chunk of its own.
  Verification screen and Add Contact both reach QR through the lazy table for the same
  reason.
- **A placeholder must hold the space.** The QR code and the camera viewfinder load behind
  a fixed-size placeholder, so the invite text below them does not jump when they arrive.
- **The spinner waits.** A lazy route almost always comes straight from the runtime cache,
  so its spinner is held back by 180 ms of CSS and a fast load shows nothing at all.
- **The first visit was not warmed at all.** Checked in a production build, not assumed:
  every chunk was fetched, and none reached the runtime cache. The service worker was
  configured not to claim the page that installed it, so on a first visit every fetch
  went around it — and the app only became complete offline on the _second_ visit. That
  was already true of the emoji picker. The worker now claims the page on first install,
  and the warm-up waits until the page is controlled (at most 20 s) before fetching;
  a fresh install in a production preview now ends its first session with all nine
  chunks cached. Updates are unaffected: a new worker still waits for the user to accept
  the prompt.

**Cost, measured.** The precache went from 799.2 KiB to **729.7 KiB** with the split
alone. Groups, polls and checklists were then added to the shell — the engine, store and
conversation-view changes they need — and it stands at **756.7 KiB**, 43.3 KiB of
headroom. The shell also became several chunks rather than one, because the bundler will
not have a lazy chunk import from the entry; they are all precached and preloaded, so this
costs requests, not availability.

**Revisit if** Save-Data users report screens missing offline, which would mean warming
the few that matter most (restore, export) even under Save-Data.

**Update.** ADR-058 moved Add Contact, the page an invite link opens, and a contact's own
page into a lazy `people` chunk, to pay for the lock screen's PIN field and pattern pad.
The contact list stays in the shell.

---

## ADR-044 — Small groups are sets of people

**Problem.** Groups on Nostr come in three shapes. NIP-29 groups live on a relay that
enforces membership, which is a server we would be trusting with the member list. MLS
(NIP-EE, Marmot) gives one encryption per message regardless of size and forward secrecy,
but it is a large dependency still settling, and needs state kept in step across devices.
NIP-17 groups need nothing new at all: a message names several people and is wrapped to
each.

**Decision.** NIP-17 groups, up to eight people. A conversation is the set of people a
rumor names — its author plus every `p` tag — and is stored under a blinded hash of that
set. Two people is the ordinary direct conversation: the formula gives exactly the id a
direct conversation always had, so nothing was migrated and every existing conversation
kept its id. That shape is what let one send path, one receive path and one outbox serve
both.

- **One rumor, one wrap per member.** A group message has one id on every device, which
  is what receipts, replies, reactions and deduplication key off.
- **Quorum per recipient.** Each member's wrap goes to that member's inbox relays and is
  judged on its own relay quorum. When some reach the relays and some do not, the outbox
  item keeps only the missing members and retries them; nobody receives a message twice
  because somebody else's relays were down. The test for it counts the wraps addressed to
  the member who already had theirs.
- **State per member.** Delivered and read are per person, and a message shows the least
  advanced member — read when everyone has read it. The tick's label says the rest ("Read
  by 2 of 5"). A receipt moves only its sender's state, and only if the message was sent
  to them.
- **Eight, enforced both ways.** Each member is another wrap on every message, another
  relay write, another receipt coming back, and another key to verify; eight keeps all of
  those small on a phone on a slow link. The limit is stated on the create screen with that
  reason, before anyone is picked. It is also enforced on arrival: accepting a larger room
  would let a stranger make this client fan every reply out to hundreds of keys, and a
  group that can be read but never answered is worse than a clear refusal. A Textor user in
  a larger group started by another client does not see it — a real interoperability gap,
  accepted.
- **Membership is fixed**, because a different set of people is a different conversation.
  There is no "add member" message, and therefore none to forge or to race.
- **Requests.** A group is taken if we sent into it or its author is an accepted contact;
  otherwise it is a request, with Accept and Delete, as a first message from a stranger
  is. Strangers in a group are not added to the address book. Blocking is by author: a
  blocked member's messages are dropped, the group is not.
- **Plumbing stays person to person.** Receipts, typing, signalling, profiles and
  attachment chunks are only ever addressed to one person. A profile frame addressed to a
  whole group — which would add everyone in a stranger's group to the address book — is
  ignored; only withdrawal, votes and checklist changes are accepted group-addressed.
- **No direct channel for groups.** One already open to a member is used as a head start;
  none is opened. Attachments in a group must therefore fit the relay path (512 KB), and
  typing indicators are not sent.
- **Addresses.** A group's address in the URL is its blinded id. Unlike a direct
  conversation's, which is the peer's public key, it names nobody, and it means nothing on
  another device — which is why a group address that names nothing here shows "not on
  this device" rather than an empty conversation with a composer that cannot send.

**Bugs this found.**

- **Retrying an attachment made a different message.** A manual retry rebuilt the rumor
  from the stored message without its attachment tag, so it had a new id: the recipient
  got the caption without the attachment, and receipts for it never matched. Chat tags
  are now built by one function, in one fixed order, from the stored message — so a retry
  of any message, an attachment or a poll included, reproduces the original id. The group
  name is stored on each outgoing group message for the same reason: a group renamed
  between sending and retrying must not change what the retry hashes to.
- **Receipts were trusted from anyone.** A receipt names a message by id alone, and the
  direct path advanced whatever message it named. It now requires the sender to be
  someone the message was sent to.
- **Backups would have lost group history.** Import re-derived conversation ids from the
  peer's key, which a group does not have; it now re-derives them from the member set.

**Cost.** A group message costs one wrap per member plus the self-copy, and a relay that
sees them published together can guess that the recipients share a conversation and how
many there are (THREAT-MODEL §3.4). No forward secrecy, as for direct messages.

**Revisit if** groups larger than eight are asked for. That is the point at which MLS
stops being a heavy dependency and starts being the only design that scales.

**Update.** ADR-049 adds forward-secret MLS groups beside these rather than in place of
them. Small groups keep attachments, voice, polls, checklists and receipts; the new kind
carries text only, for up to a hundred people.

---

## ADR-045 — Polls and checklists are counted by everyone

**Problem.** NIP-88 defines polls, and they are public events: who asked what, and who
answered, visible to every relay. There is no NIP for a shared checklist. And there is no
server here to hold a tally.

**Decision.** Borrow the shape, keep everything sealed, and count locally.

- A poll or checklist is an ordinary kind 14 message. Its structure is in tags — `poll`,
  NIP-88's `polltype` and `option` (id, label) — and its content is a plain-text rendering
  ("📊 Lunch? ○ Yes ○ No"), so a client without polls shows a readable question. Symbols
  rather than words, so it reads the same in any language.
- Votes and checklist changes are `vote` and `check` control frames, sent to every
  participant, queued durably, and copied to the sender's own inbox so another device
  shows them. A ballot carries the whole choice, not a delta, so a voter's newest frame
  simply is their vote and an empty one withdraws it.
- Every participant counts for themselves, with rules that give the same answer whatever
  order frames arrive in: newest ballot per voter, ties broken on rumor id; unknown
  options dropped; a single-choice poll counts one choice. A checklist applies additions
  before ticks and then takes each item's newest tick; additions stop at 50 in arrival
  order.
- **Only the poll's own room counts.** Frames are stored under the conversation they were
  sealed to. Someone outside can learn a poll's id and address a vote to it, naming the
  members too — but that is a set of people that includes them, a different room, and the
  vote is stored and never counted. Reactions are now filtered the same way when a page of
  messages is loaded.
- Validation is shared: the forms call the same `makePoll`/`makeChecklist` the engine
  uses, and the engine round-trips every poll through the parser every receiver runs, so
  this side cannot send something the other side would refuse. The two mistakes a person
  can actually make — no question, fewer than two options — are reported in the reader's
  language before the shared check runs.
- The cards and forms are a lazy chunk. Until it loads, the message shows its plain-text
  content — exactly what a client without polls shows.

**Cost.** Polls are not anonymous: ballots are sealed to every participant, so everyone
in the conversation can see who chose what, and the interface does not suggest otherwise.
A member can backdate a vote or tick by up to a second to win a tie on it. Each vote is a
wrap per member.

**Revisit if** anonymous polls are wanted — that needs a blind-signature or commitment
scheme, not a flag.

---

## ADR-046 — Calls are sealed NIP-AC signalling, a lazy chunk, and nobody's TURN but yours

**Problem.** One-to-one voice and video, with no server of ours anywhere in the path.
Calls differ from the direct channel (ADR-008) in two ways that matter. There is no relay
fallback for live audio, so a connection that fails is a call that fails. And ringing is
presence: a phone that rings tells the caller the device is on.

**Decision.**

- **Signalling is the sealed `rtc` frame, aligned with NIP-AC.** The draft
  ([nostr-protocol/nips#2461](https://github.com/nostr-protocol/nips/pull/2461)) signals a
  peer connection with three events — offer, answer, candidate — whose content is the
  browser's own description or candidate object, correlated by the id of the event that
  opened the handshake, and recommends NIP-59 wrapping where connection metadata matters.
  That is the frame: the three kinds, the browser's own objects, and `call` set to the
  rumor id of the opening offer. NIP-AC stops short of a call state machine; `ringing`,
  and `bye` with a reason, are ours. Everything stays inside gift wraps.
- **Deployed clients drop calls rather than answer them.** The opening offer carries no
  `sid`, which every client that predates calls requires on an `rtc` frame. A client
  that instead parsed it would treat a call as a data-channel offer and answer it — the
  caller's screen would say "connected" to a device that never rang. A frame with both a
  `sid` and a call field is invalid, so a frame is never routed two ways.
- **Only accepted contacts ring, and the callee reveals nothing before answering.** No
  peer connection, no STUN request and no candidate exist on the receiving side until the
  person accepts; `ringing` says only that the app is open. Strangers and message requests
  get no reply at all. An offer more than a minute old is history a relay replayed, and
  becomes a missed-call entry instead of a ringing phone.
- **Perfect negotiation, but only once the call is up.** Renegotiation — video added to a
  voice call, a shared screen, an ICE restart — follows the direct channel's polite and
  impolite rule. It waits until the call has first connected, because relay events arrive
  in any order and an offer that overtook the answer opening the call would find the other
  side still waiting for it. The tests found both halves of this: without the wait, a
  camera turned on while ringing was never negotiated; without clearing the flag once the
  opening description is made, every ordinary call paid for a second offer and answer. It
  is capped at ten a minute, so two browsers that disagree cannot flood the relays.
- **Two people calling each other at once** resolve the same way: the polite side
  abandons its own call and answers the other's with the camera and microphone it already
  opened, so nothing blinks and nobody hears busy.
- **A failure says why.** What each side gathered decides the message — a TURN server
  that allocated nothing, a network that learned no public address, the same on the
  other side, or two public addresses that still could not meet. The defaults name STUN
  servers run by two operators, and behind a symmetric NAT each is shown a different port,
  which is what makes that case recognisable rather than guessed.
- **TURN is the user's.** Settings → Calls takes STUN and TURN servers, validated before
  they are saved, tests the network by gathering candidates without calling anyone, and
  offers "always relay calls": `iceTransportPolicy: "relay"`, so this device's address is
  never offered. With no TURN server it refuses to call at all rather than quietly going
  direct — the one thing the setting exists to prevent — and it switches itself off when
  the last TURN server is removed.
- **The whole subsystem is one lazy chunk,** loaded when a call is placed or an offer
  rings, and deliberately not in `LAZY_CHUNKS`, so the idle warm-up never fetches it: a
  call needs the network by definition, so an offline session gains nothing from having
  it cached. Its stylesheet is named `lazy-` too — Vite named it after its chunk, so it
  went into the precache until `assetFileNames` was taught otherwise — and its words, like
  the Calls settings page's, live in the chunk that shows them rather than in the
  dictionaries every cold start downloads. The engine carries only the routing, the
  records and the configuration. `scripts/check-bundle.mjs` fails the build if calling
  code turns up in a shell chunk.
- **Version skew is handled, not hoped away.** After a deployment, a page still running
  the previous shell can find its call chunk gone from the host. An incoming call is then
  written as a missed call with a prompt to reload; placing one says to reload.
- **A live call holds the vault open.** The idle timer is held off and lock-on-hide waits
  for the call to end — sharing a screen means switching away. Locking hangs up.
- **Each side records the call** in the conversation under the call id: local, never
  sent, never acknowledged (a receipt naming it would name the caller's own offer), and
  unread when missed — with no push notifications, the conversation list is where someone
  learns they were called while away.

**Cost.** Answering a call reveals your IP address to the caller, and calling reveals
yours at ring time, unless calls are relayed. Ringing reveals that the app is open. A
TURN server sees both parties' addresses and the call's timing and volume, never its
content. A call rings only while Textor is open (ADR-007), which the caller's screen says
after eight seconds without `ringing`. One device per identity: a second open device
rings too, and only the first to answer connects. In the shell: 10.6 KiB, taking the
precache from 756.7 to 767.3 KiB and leaving 32.7 KiB of the budget; the chunk is 39.0 KB
of script (13.3 KB compressed) and 7.8 KB of styles.

**Revisit if** NIP-AC is merged with a call state machine of its own — then speak it
alongside — or when group calls are wanted: a mesh is fine for three or four, and beyond
that needs a selective forwarding unit the user runs.

---

## ADR-047 — A call is an entry either person may delete, and a deletion stays deleted

**Problem.** A call was drawn as a centred line with nothing to act on but "call back".
It could not be deleted at all, and the rules in ADR-035 would have refused half of the
obvious request anyway: each device writes its own record of a call under the id of the
offer that opened it, so on the caller's side the record names the caller as its author,
and a withdrawal from the person who was called — the one most likely to want a missed
call gone — would be refused as an attempt to delete someone else's words.

Two older gaps showed up on the way, and they applied to every message, not only calls:

- **A deletion could be undone by a retry.** Deduplication after a delete rested on the
  seen marks, and those name wraps. A sender's outbox wraps the same rumor afresh on each
  attempt, and a relay replays an offer it still holds, so a copy arriving a minute after
  "delete for me" put the message — or the missed call — straight back.
- **A withdrawal could arrive before what it withdraws.** Wrap timestamps are fuzzed by
  up to two days, and a catch-up read returns them in any order. A device coming back
  online could process the withdrawal first, find nothing to delete, drop it, and then
  record the missed call the other person had already taken back.

**Decision.** A call record is a bubble on the side of whoever placed it: what it was, the
time, the length or why it never connected, and a call-back button at its end. Its menu
has "Delete for me" and "Delete for everyone". Reply, reactions and delivery ticks are
left off, because the record was never sent.

- **Either person may withdraw a call.** A `redact` naming a call id is honoured when it
  comes from the other person in the call, which is checked by where the record lives —
  the direct conversation with the sender — rather than by the author on it. Someone who
  was not in the call is refused, and so is anyone asking to delete a message they did
  not write, exactly as before.
- **Every deletion leaves a tombstone** keyed by rumor id and author, blinded like every
  index, stored in the seen table and pruned with it at 45 days, by which time every wrap
  that could carry the rumor has expired. Chat messages, reactions, recorded calls and
  ringing offers are all checked against it on arrival. It is written before the delete,
  so an interruption can lose the delete but never bring the message back.
- **A withdrawal that finds nothing becomes a tombstone under its sender's name.** Keyed
  by author, it can only ever stop what that sender wrote, or a call with them. A stranger
  who learns a message id cannot use it to keep someone else's message from arriving.
- **Withdrawn unread entries come off the badge.** Unread is a count, not a per-message
  mark (ADR-039), so an entry was unread if fewer than `unread` counting entries are newer
  than it. When the listing cannot see that far back, the count is left alone rather than
  guessed down.

On an incoming bubble, colour marks the outcome: green when the call connected, red when
it did not, and a missed call named in red. The outgoing bubble is the accent, on which
neither green nor red holds contrast, so there the words carry the outcome alone. The
token check now covers each incoming pairing.

**Cost.** Either person in a call can remove it from the other's history. That is the
point, and it is also a new thing a peer can do to your device, so the threat model says
so. Each deletion costs one seen-table row for 45 days. The engine, the bubble and the
words add 4.8 KiB to the shell: the precache goes from 767.3 to 772.1 KiB, leaving
27.9 KiB of the budget. The call chunk is unchanged.

**Revisit if** calls become multi-party, where "the other person" becomes "a member" and
a deletion for everyone would need the group rules of ADR-044. Revisit too if tombstones
ever need to outlive the seen table: a backup restored after 45 days can still bring back
a message that was deleted, just as it always could.

**Update.** ADR-061 applied this rule to every entry between two people, not only calls.
The check was already where the entry is kept, the direct conversation with the sender,
so it now simply asks nothing more.

---

## ADR-048 — Every push deploys from a workflow file GitHub has never seen

**Problem.** The history is one rolling root commit, rewritten on every push, but the
Actions tab still counted: `Pipeline #6`, then `Deploy #7`. Renaming the workflow did not
help, because GitHub numbers runs by the workflow's file path, not its display name. The
public API shows it: one workflow, `.github/workflows/pipeline.yml`, whose runs carry the
names `Pipeline` and `Deploy` in one sequence.

**The obvious fix does not work.** Alternating between two file names restarts the count
once, and then resumes it. A path GitHub has seen keeps its record, so returning to it
continues from where it stopped: #1, #1, #2, #2. Only a path that has never existed
starts at #1.

**Decision.** Before each push, `scripts/rotateWorkflow.mjs` moves the one workflow file
to `<slug of its name:>-<UTC YYYYMMDD>-<UTC HHMMSS>.yml`. That name is always later than
the one it replaces, even for two pushes in one second or a clock that has gone back. The
contents are untouched, so the pipeline is exactly what it was. The script refuses to run
if it finds no workflow or more than one. The test suite holds the repository to the same
rule: exactly one workflow file, under a name the rotation produced. So nothing is left
behind in the tree, and a second workflow cannot creep back in to double every run.
CLAUDE.md runs the rotation as the first step of every push.

**Cost.** Each earlier file becomes a deleted workflow in GitHub's records. The Actions
sidebar keeps listing it, with its one run, until the owner deletes that run or GitHub's
retention removes it. Pruning runs by script is deliberately not part of the push. Badge
URLs that name the workflow file go stale on every push, so none are used. Anything that
names the file path goes stale the same way — a required status check configured by
workflow, or a link to it — so documentation names the directory, never the file.

**Revisit if** GitHub makes the run number resettable, or numbers runs by display name,
or the sidebar clutter outweighs the numbering. Then a fixed file name comes back and this
step is deleted.

---

## ADR-049 — Forward-secret groups are MLS, spoken as Marmot, in a lazy chunk

**Problem.** Nothing Textor sent had forward secrecy (ADR-003), and small groups stop at
eight because every message is one wrap per member (ADR-044). MLS (RFC 9420) answers
both: one encryption per message whatever the size, keys that move on with every change,
and post-compromise security once a member refreshes. Marmot defines how MLS travels over
Nostr. The costs are a large dependency, group state that must stay in step on every
device, and a KeyPackage published so that someone can be invited while offline.

**Decision.** A second kind of group, chosen on the New group screen, beside small groups.

- **MLS is ts-mls 1.6.4**, pure TypeScript, pinned exactly, behind `core/mls/`. The
  engine sees a runtime with `createGroup`, `addMembers`, `removeMember`, `rotate`,
  `leave` and a chat surface. Nothing outside `core/mls/` imports ts-mls.
- **Ciphersuite 0x0001 on `@noble`** (`suite.ts`). ts-mls's providers use WebCrypto
  X25519 and Ed25519, which not every supported browser has. HPKE (RFC 9180, base mode)
  is composed from noble primitives in the RFC's order, and checked against `@hpke/core`
  in both directions. No WebCrypto curve, no WASM, nothing new in the CSP.
- **Marmot's wire shapes, byte for byte**:
  - a kind 30443 KeyPackage with the `d`, `mls_protocol_version`, `i`, `mls_ciphersuite`,
    `mls_extensions`, `mls_proposals` and `app_components` tags, valid for 83 days;
  - a kind 444 Welcome rumor (`e` names the KeyPackage event, `relays` the group's
    relays), gift-wrapped like any message;
  - kind 445 group events, each with one `h` tag and a fresh throwaway signer, whose
    content is `base64(nonce ‖ ChaCha20-Poly1305(MLS-Exporter("marmot", "group-event")))`
    over the MLS message;
  - group state in the app-data dictionary extension (0x0006): app components, profile,
    admin policy and routing;
  - an identity proof (v2, component 0x8009) on every leaf, binding its Ed25519 key to the
    Nostr account. The spec's test vector passes.
- **Inside a message** is an unsigned Nostr event: kind 9 chat, 7 reaction, 5 deletion.
  MLS authenticates the sending leaf; the receiver also requires the event's `pubkey` to be
  that leaf's account, so a member cannot write as another.
- **Policy runs on every device**, so a commit one member would refuse, all refuse:
  - only an admin adds or removes others, or changes the name or the admins;
  - anyone refreshes their own keys;
  - leaving is a request that an admin commits, 1–5 s later so that two admins do not race;
  - an admin hands the role on before leaving, and the last person simply goes;
  - a commit whose result breaks group state (an admin who is not a member, a leaf with no
    valid proof) is refused whoever signed it.
- **Publish, then apply.** Our commit is applied once a relay has it. When two commits race
  for one epoch, everyone keeps the one that sorts first by Marmot's order: admin work
  before ordinary, then committer, then digest. Each device keeps the state one commit
  back for 24 h and rolls to the winner if it arrives second. Messages sent in the losing
  branch are sent again.
- **Forward secrecy and healing.**
  - Message keys are deleted as they are used.
  - Two past epochs are kept, for messages that arrive after a commit, and nothing older.
  - A joiner replaces the leaf its KeyPackage gave it 1–10 minutes after joining, since
    that package sat on relays for weeks.
  - Every member refreshes at least weekly, or at once with "Refresh keys".
  - Everyone sees a security code (the epoch authenticator) that they can compare.
- **Up to 100 people, text only**: messages, replies, reactions and deleting your own. No
  attachments, voice, polls, checklists, calls, receipts or typing. Those are refused
  rather than sent a way that would leave the group.
- **State.**
  - Each group's MLS state and each KeyPackage's private keys are sealed in the vault
    (`mlsGroups`, `mlsKeys`).
  - State is written after every step and before anything goes on the wire, so a message
    key is never used twice across a restart.
  - A backup never carries MLS state: a second copy of a leaf would break the group for
    everyone. A restored group's history comes back read-only.
- **Invitations are a setting**, on by default. Turning it off withdraws the KeyPackage
  (NIP-09, with `e`, `a` and `k` tags) and deletes its keys.
- **A lazy chunk.**
  - `core/mls/`, ts-mls and the MLS-only noble modules (Ed25519, AES-GCM) are
    `lazy-runtime`, 127 kB (40 kB gzipped), outside the precache.
  - The shell's `crypto` chunk excludes those modules explicitly, and
    `scripts/check-bundle.mjs` fails if MLS code turns up in a shell chunk.
  - The engine loads the runtime when the device holds a group, an invitation arrives, or
    one is created — or 20 s after start, off the start-up path, when a KeyPackage needs
    publishing, refreshing or withdrawing.
  - The screens' words are a dictionary in the groups chunk. The shell gained four
    strings.
  - Precache: 793.1 KiB of 800.

**Where this differs from Marmot.** Each one is something ts-mls cannot do yet, or a
simplification with a stated limit.

- **No `AppDataUpdate` or `SelfRemove` proposals**, which ts-mls 1.6.4 lacks. Settings
  change through RFC 9420 GroupContextExtensions, and leaving is an ordinary Remove
  proposal for one's own leaf. `required_capabilities` lists no proposal types to match.
- **Convergence looks back one commit**, not Marmot's full window. A fork deeper than one
  commit is not healed automatically.
- **No KeyPackage relay list (kind 10051).** Packages go to the account's write relays.
  They are looked for on a contact's known inbox relays and on ours.

**Bugs this found.**

- **ts-mls 1.6.4 cannot open a commit that carries both a GroupContextExtensions proposal
  and an update path**, which every other member tries to do. The sender encrypts the
  path under the old GroupContext; receivers decrypt under the new one. So settings change
  in a commit of their own, which needs no path, and removing an admin is two commits:
  off the admin list, then out of the group.
- **Wiping what a commit "consumes" broke every confirmation tag.** Those are the current
  epoch's secrets, which the state needs until the commit is published, and the rollback
  anchor needs after. Only message keys are wiped on use; the rest goes when the state
  holding it is replaced.
- **A member who asked to leave could not follow the commit that let them go.** The
  proposal was not kept in their own state. It is now.
- Coverage tests found two more:
  - a settings change with a leave request pending threw, when it should commit the
    request first;
  - an admin leaving chose who inherits the role before committing pending requests, so
    it could name someone already on their way out.

**Cost.**

- **A published KeyPackage says this account can be invited**, and when it last
  refreshed (THREAT-MODEL §3.4).
- **A group's events share one `h` tag.** A relay can count one group's messages and see
  when they are sent, and who asks for them — though not who sent them, or who is in the
  group.
- **ts-mls has not been audited**, and the HPKE composition is ours.
- **127 kB** for those who use it, and per-group state of tens of kilobytes.

**Revisit if** ts-mls gains `SelfRemove` and `AppDataUpdate`, or fixes the path bug —
then settings and leaving move to Marmot's own proposals. Also revisit if Marmot settles
kind 10051, or if media in groups is asked for (Marmot's encrypted media, over a host the
user picks).

---

## ADR-050 — The inbox catches up by set reconciliation where relays speak it

**Problem.** Every start and every dropped relay downloaded three days of wraps from
every read relay — the rewind that wrap fuzzing needs (PROTOCOL §4.5). It did so twice: a
subscription from the last cursor, then a separate fetch of the same window. One cursor
for all relays also meant a relay unreachable for ten days was asked only from the
shared cursor, and so skipped what it alone held.

**Decision.** `InboxSync` owns the inbox subscription, one plan per relay:

- **NIP-77 where the relay speaks it.**
  - The subscription is live-only (`limit: 0`, since three days back for the fuzz), so
    the relay replays nothing.
  - Then a negentropy reconciliation runs over the relay's window, against the wraps
    this device holds (the sealed seen marks, ADR-051).
  - Only the missing ids are fetched, 200 per REQ.
  - The initiator is ours, checked byte for byte against the one in nostr-tools.
- **Negotiated per relay, and remembered.**
  - A NOTICE saying the command is unknown, a CLOSED before any answer, or silence for
    6 s means the relay does not speak NIP-77. It is asked again in a week.
  - Any other failure falls back for ten minutes: no convergence in 64 rounds, a message
    that does not parse, or 30 s without finishing.
  - Falling back re-sends that relay's window REQ on the same connection.
- **A high-water mark per relay.** A relay without NIP-77 is asked from its own mark,
  less the rewind, never from a shared cursor.
- **A mark moves only on a connection proven complete**: the EOSE of this connection's
  REQ, or a finished reconciliation, then the last frame received while it stays up. A
  reconnect that has not caught up yet proves nothing.
- **A catch-up waits for every relay**, or for half of them and 1.2 s more, or 8 s. The
  live subscription keeps running, so a straggler's wraps still arrive.
- **State** (`lastSyncSec`, `floorSec`, and a mark and NIP-77 verdict per relay) is sealed
  in settings and written at most every 30 s. An older bare cursor is read forward.

**Measured.** A restart after two wraps arrived, against a NIP-77 relay holding fifty
more, receives exactly those two events. Before, it received all fifty-two twice. The
test is `tests/syncEfficiency.test.ts`.

**Cost.** A reconciliation shows a relay fingerprints of the inbox wraps this device
holds from the last three days, including wraps it got from other relays. Those are
already addressed to this key, and a relay learns nothing it could open.

**Revisit if** NIP-77 support becomes universal — then the window path is only a
fallback for the rest — or relays start limiting negentropy sessions per connection.

---

## ADR-051 — The seen table is compacted, and its floor is a promise

**Problem.** The seen table is what makes a duplicate free. It is also the one table
that grows with every event received — wraps, receipts, attachment chunks, group
messages. It was pruned at 45 days by arrival time. That measured the wrong clock:
relays filter by `created_at`, which is fuzzed up to two days back. And it could drop the
mark of a wrap a relay still serves. A forgotten mark makes a handled wrap look new, and a
deleted message comes back.

**Decision.**

- **A mark is filed under its wrap's `created_at` hour**, the clock relays filter by.
  Inbox marks also carry a sealed `{id, created_at}`, which is the item set NIP-77
  reconciles against (ADR-050). Group-stream marks do not.
- **Compaction.**
  - Anything older than 45 days goes.
  - Past 100 000 rows, the table is trimmed to 80 000, oldest delivery marks first.
  - Nothing inside the last seven days is trimmed for size, and no deletion tombstone
    ever is.
  - Deletes run in batches of 2000, so a large prune never holds one long transaction.
- **Every deletion raises a floor**, and the floor is kept:
  - no REQ asks for anything older;
  - a wrap created before it is refused on arrival, and leaves no mark.
    If this device cannot tell whether it handled a wrap, it does not handle it.
- **The janitor runs at start and every twelve hours**, off the caller's path. A failure
  is logged, and the next run tries again.

**Cost.** A wrap older than the floor is never shown, however it arrives. The floor
trails the present by at least 45 days (seven under a pathological flood), and wraps ask
relays to expire them at 30. Only a message delayed longer than that is lost.

**Revisit if** the cap proves too small for heavy users, or a relay is found serving
wraps for months — then the horizon, not the floor, should move.

---

## ADR-052 — A payload is stored and requested by copy, not by id

**Problem.** An attachment's id is the SHA-256 of its bytes, and each sending seals it
under a fresh key. So the same file sent twice, or by two people, is one id under two
keys, and chunks were stored and requested by the id alone. Whichever copy arrived last
overwrote the other, and the other message could never be opened. ADR-042 recorded this
for attachments and left it open. Reproducing it found a third case, and the most common
one: sending a sticker sealed the picture again, and that overwrote the pack's own copy.
Sticker packs broke the first time a sticker was sent.

**Decision.** A payload is identified by its id **and** its copy:
`copy = hex(SHA-256("textor/blob/copy|" ‖ key ‖ salt))[0..32]`. The copy commits to the
key without revealing it, so it can travel in a frame and sit in an index.

- **Storage.** Chunks and manifests are keyed by `blind("blob", "<id>:<copy>")`, so two
  copies never share a row. The key stays blinded as before: holding the database still
  does not let anyone test whether a known file is present. A manifest also seals
  `{id, copy}`. That serves a request naming only the id, without an index that would
  show which rows hold the same file.
- **Frames.** `blob` and `blobreq` carry `copy`. A receiver files a chunk under the copy it
  names, and still checks that it authenticates under that copy's key.
- **Older clients**, which name no copy, keep working:
  - Their chunks go to whichever expected copy of that id they authenticate under.
    Held early, they wait for a copy that opens them rather than being dropped at the
    first one described.
  - Their requests are answered with every copy held of that id, and the requester
    keeps the one its key opens. It is almost always the only one.
- **A key seals one plaintext.** Sending a sticker sends the pack's own copy — the same
  ciphertext, again — rather than sealing another. So sending one a hundred times stores
  nothing new, and a pack's copy is never touched by sending it.
- **Deleting** a message removes its payload only when nothing else uses the same copy.
  Another copy of the same file is a different payload. _(As first written, this checked
  other messages but not sticker packs, so deleting a sent sticker deleted the pack's
  picture. ADR-053 fixes it.)_
- **Migration.** Payloads stored by id alone are moved once, when the engine first starts
  after upgrading:
  - each legacy row goes to the copy whose key its chunks authenticate under, among
    every message and sticker naming that id;
  - a row no key opens is unreadable by anything on the device, and is dropped;
  - the copies it overwrote were never there to move, and are fetched again like any
    missing payload;
  - every step is safe to repeat, and a sealed marker records that it is done;
  - a failure is logged and retried at the next start. Messages carry on meanwhile.
- **Progress is per copy** in the interface too, so two transfers of one file show two
  bars rather than one shared.

**What building it found.**

- **Stopping during a resend request could still send it.** The stall handler read the
  missing chunks and then asked for them, even if the transfer was stopped or completed
  during the read. It now checks the transfer is still current before sending anything.
- **An impossible chunk emptied the early-chunk buffer.** A chunk larger than the whole
  buffer evicted everything held before being refused. It is now refused first.

**Cost.**

- 42 characters per `blob` and `blobreq` frame (`"copy":"…"` with 32 hex): about 75
  bytes on the wire per chunk once sealed and wrapped, against a 16 KiB chunk.
- One SHA-256 per descriptor, cached in the interface.
- A request from an older client costs a scan of the manifests. Such requests are rare
  and bounded by the resend rounds.
- In the shell: 2.6 KiB, taking the precache from 793.1 to 795.7 KiB of 800. The next
  change to the shell has 4.3 KiB left, and will need to bring its own savings.
- `blobTransfer.ts` and `blobCrypto.ts` are now held to 100% coverage with the group and
  sync code.

**Revisit if** payloads ever need to be deduplicated across senders — one stored copy of
a file that two people sent. That would mean re-sealing on receipt, and is not worth it
for the sizes that travel here.

---

## ADR-053 — A payload lives as long as something refers to it

**Problem.** Retention deleted old messages and left their photos and files on the device.
`pruneOrphanBlobs` existed to sweep them, and its comment said it ran after retention, but
nothing called it. Deleting a conversation had the same leak. A setting that says "keep
message history for 7 days" was keeping the heaviest part of that history for ever.

**Decision.** A payload copy (ADR-052) lives as long as a message or a sticker refers to
it.

- **Deleting a message or a conversation** deletes the copies it named, unless a
  surviving message (a forward) or a sticker in a pack still uses them. The copies are
  noted before the messages go, while they can still be read.
- **Retention sweeps by reachability.** After it deletes messages, every copy nothing
  refers to is dropped. That also collects anything an earlier interruption left behind.
  It runs only when retention removed something: finding out what is referred to means
  reading every message.
- **A copy written in the last hour is never swept.** Sending stores the payload before
  the message that names it, and importing a pack stores its pictures before the pack.
  A sweep in between would otherwise delete a payload about to be referred to.
- **Rows from before ADR-052** that have not been moved yet are never swept. Nothing
  can refer to them by copy until the migration has run.
- **A lock stops everything.** A message that cannot be opened while the vault is
  unlocked is corrupt, and its payload unreadable anyway. One that cannot be opened
  because the vault locked mid-scan would look like a message that refers to nothing,
  and its payload would be deleted. So a lock during the scan fails the deletion or
  sweep that depends on it, and deleting a conversation that has messages while locked
  fails the same way.

**What building it found.**

- **Dexie drops an error thrown inside an `each` callback.** The scan does not reject;
  it ends quietly, part-way through. The first version checked for a lock by throwing
  from the callback, and its test only passed because the sticker-pack scan, which runs
  outside `each`, threw instead. With no packs, a lock mid-scan would have left the sweep
  believing nothing was referred to. The callback now only records what it saw, and the
  scan throws after `each` returns. ADR-052's migration used the same scan, and is fixed
  with it. Any code that relies on an error escaping `each` is wrong in the same way.
- **Deleting a sent sticker deleted the pack's picture.** ADR-052 made a sticker send the
  pack's own copy. Deleting that message then checked other messages for the copy, but
  not packs. Every deletion now asks the same question of messages and packs together.

**Cost.** A retention run that removed messages reads every message once more. Deleting
a conversation with attachments does the same. In the shell: 0.5 KiB, taking the precache
from 795.7 to 796.2 KiB of 800.

**Revisit if** reading every message becomes slow enough to notice on a large history.
Then a sealed reference count per copy, kept as messages are written and deleted, would
replace the scan.

---

## ADR-054 — The vault opens by keyslots, and the recovery phrase is always one of them

**Problem.** The vault opened with a passphrase and nothing else, on every cold start:
keys live only in page memory, so closing the tab was a lock. That charged everyone about
a second of scrypt plus typing, many times a day, for protection that varied wildly and
went unexplained — a ten-character human passphrase falls to one GPU in about two days,
four random words take millennia, and the interface treated both alike. Meanwhile the
twelve words, which reconstruct the identity, did not open the vault at all: forgetting
the passphrase cost the whole local history.

**Decision.** The data key (ADR-004) is sealed once per way in — LUKS-style keyslots in
`meta` — and opening any one slot opens the vault. At most one slot of each kind:

- **`recovery`** — HKDF-SHA256 of the normalised twelve words. Every vault gets one: at
  creation, and for vaults made before this, the first time they open. A forgotten
  passphrase or a replaced fingerprint no longer loses anything. No scrypt: the words are
  128 random bits, and stretching slows the guessing of a secret a person chose. What it
  would buy against someone who knows most of the words, they can buy more cheaply
  against the public key the words derive.
- **`webauthn-prf`** — HKDF-SHA256 of the platform authenticator's PRF output. Touch ID,
  Face ID, Windows Hello, an Android screen lock: about a second, nothing to remember,
  and the secret never leaves the authenticator, which rate-limits it. The credential is
  made with user verification required. Its challenge is random and its signature is
  never checked, because nothing depends on it: the output is the key, and a wrong output
  opens nothing. Offered where `getClientCapabilities` or the attempt itself shows PRF
  works; an authenticator that makes a credential but cannot derive is told to forget it.
- **`device`** — the data key sealed with AES-GCM under a non-extractable WebCrypto key
  kept beside the vault. This is "open instantly": no unlock step at all. A
  non-extractable key keeps it from script, not from a copy of the browser profile, so
  it is described as no protection at rest, in those words.
- **`passphrase`** — scrypt as ADR-006, now one choice among four.

**Onboarding** asks one question in outcomes, not mechanisms: use the authenticator
(chosen by default where the browser says PRF works), open instantly (with what that gives
away), or use a passphrase. **The lock screen** tries, on a cold start: the device key
silently, then one authenticator prompt with nobody having to tap, then the passphrase
field. "Use your recovery phrase instead" is always there. After a lock the prompt waits
for a tap: the person may have walked away, and a biometric prompt appearing on its own
then is a prompt to whoever is passing. Opened with the recovery phrase, the app offers to
set a new everyday way in. **Settings → Security** lists every way in with what it
protects against, shows the level of the weakest, adds and removes them, and keeps
auto-lock and lock-on-hide as session settings.

**Rules the design depends on.**

- **The vault is as strong as its weakest slot.** Settings says so, and shows that level.
  There is no numeric PIN: behind scrypt alone, a six-digit PIN falls in minutes.
- **Adding a way in asks for an existing one first**, and so does showing the recovery
  phrase. Otherwise a passer-by at an unlocked device could enrol a way back in, or
  switch it to open instantly. A vault that already opens instantly has nothing to ask
  with, and does not pretend to.
- **Removing a slot is not retroactive.** A copy of the device taken earlier keeps the
  slot. Only a new data key would change that, and it is not offered, because every
  record and every blinded index would have to be rewritten. The interface says so where
  the button is.
- **No key in `sessionStorage`** to survive a reload. Browsers persist it for session
  restore; it would be the device slot with worse properties.
- **Each sealed key is bound to its slot** by AAD `textor/keyslot/v1|<type>|<id>`, so a
  sealed key cannot be moved between slots, and `meta` — the one table in the clear — is
  parsed rather than trusted: a damaged slot is skipped, and its neighbours still open.

**Backups.** A backup (PROTOCOL.md §9, version 2) seals its payload under a random file
key, sealed in turn under the backup passphrase and, when the identity has one, under the
recovery phrase — domain-separated from the vault's slot. A new device restores the whole
history from the file and the twelve words. Restoring asks the same question onboarding
does. Version 1 files still open with their passphrase.

**What building it found.**

- **Locking during a slow derivation would have sealed zeros.** Adding a passphrase slot
  runs scrypt for a second; a lock in that second wipes the data key in place. The slot
  is sealed from a copy, and saved only if the vault is still open under the same key.
- **Backups of group conversations had never been restored under test.** The import
  path that recomputes a group's id from its members was untested; it is now, and
  `exportImport.ts` is held to 100% with the rest of the vault.
- **An explicit IndexedDB transaction fails under fake timers.** fake-indexeddb schedules
  its callbacks on timers, so with them faked a transaction commits before its first
  write. The keyslot rewrite is the first explicit transaction in the codebase; tests that
  reach it run on real timers.

**Cost.**

- In the shell: the keyslots, the authenticator adapter and the new lock screen. Paid for
  by moving onboarding, restoring a backup and Settings → Security into one lazy `access`
  chunk that carries its own words (ADR-046), and the passphrase meter's styles with them.
  The precache went from 796.2 to 795.4 KiB of 800. `SettingsPage` became a module of its
  own, 0.7 KiB and precached, since two chunks now need it.
- Opening instantly is the first use of WebCrypto; it is offered only where WebCrypto
  exists, and nothing else needs it.
- `vault.ts`, `keyslots.ts`, `webauthnPrf.ts` and `exportImport.ts` are held to 100%
  coverage.

**Update.** Testing on real devices found the biometric slot failing on Windows, macOS
and phones, and found the claim that its secret never leaves the authenticator true only
of a device-bound passkey. ADR-055 records the fixes and what a web page cannot fix.

**Revisit if** re-keying becomes worth its cost — a new data key after a device is known to
be copied — or if roaming security keys gain PRF broadly enough to offer them beside the
platform authenticator. A PIN, if ever wanted, belongs on top of the authenticator's secret,
never beside it.

**Update.** ADR-059 revised the rules above: opening instantly is no longer one slot among
several. It is offered only while nothing else guards the device, and setting anything
else up deletes it.

**Update.** ADR-058 retired the `webauthn-prf` slot. Biometrics now guard a key kept on
the device, and WebAuthn supplies only its verification of the person. It also added a
`pin` slot, a PIN or a pattern erased after ten wrong tries, against the rule above: a
device without biometrics otherwise had a long passphrase or nothing.

---

## ADR-055 — The authenticator is asked directly, what it returns is checked, and a synced passkey says so · **found on real devices**

**Problem.** ADR-054's biometric slot failed three ways on real devices.

- **Windows: no option at all.** Where no authenticator was set up, or the browser reported
  that its authenticator cannot derive a key, the option was hidden and nothing was said.
- **macOS: Bitwarden's prompt instead of Touch ID**, then "this device cannot keep a key".
  Password-manager extensions replace `navigator.credentials.create` and `.get` on every
  page, so the request went to the extension. Its passkey could not derive a key, and the
  error blamed the device.
- **Phones: a synced Google passkey rather than a local key.** On Android and Apple devices
  the platform authenticator _is_ the passkey manager, and its passkeys sync. No WebAuthn
  option asks for a device-only key. Nor did the app know which it got: it never read the
  flag that says so.

**Decision.**

- **Ask the browser, not the page.** The ceremonies are called from
  `CredentialsContainer.prototype`, on the container `Navigator.prototype`'s getter returns,
  each checked to be the browser's own code. A page-level replacement leaves those alone.
  A password manager's passkey cannot be what this slot describes: most cannot derive a
  key, and one that can keeps it in the manager's vault. Where an extension replaced the
  prototype too, its methods are used, and a refusal names the extension as the likely
  cause.
- **Check what comes back.** A passkey on a phone or security key
  (`authenticatorAttachment: "cross-platform"`), one made without verifying the person (the
  UV flag clear), and one with no PRF output are each refused, with their own explanation,
  and the authenticator is asked to forget them. An unlock answered without verification
  is refused too. Both ceremonies carry `hints: ["client-device"]`, so browsers that honour
  it go straight to this device's authenticator rather than offering a phone or a key.
- **Say why it is unavailable.** Support is five states: yes, maybe, nothing set up to
  verify the person, no PRF by the browser's own account, and no WebAuthn. The middle two
  keep the option on screen, disabled, saying what to do. A capability answer from anything
  but the browser's own code is not believed.
- **A synced passkey says so before it is kept.** The authenticator data's backup-eligible
  flag is read at enrolment and stored with the slot. When it is set, the person is told
  that their passkey manager syncs the passkey, and chooses: keep it, or use a passphrase.
  Settings → Security describes a synced passkey as one, and no longer claims its key never
  leaves the device.

**What a web page cannot fix, and says instead.**

- Where the browser reports that Windows Hello cannot derive a key, the key cannot live
  behind it. The option shows that answer rather than disappearing.
- A passkey manager registered with the operating system, rather than as a browser
  extension, appears in the system's own sheet beside iCloud Keychain or Google Password
  Manager. The choice is the person's. If the one they pick cannot derive a key, the
  refusal asks them to save it to the device's own passkeys.
- On phones there is no device-only passkey to ask for. What is offered is honest instead:
  a synced passkey, said to be one, or a passphrase.

**Cost.** Enrolment moved to its own module, `webauthnEnrol.ts`, which only the lazy
access chunk loads; the shell keeps what unlocking needs. The precache went from 795.4 to
795.5 KiB of 800. `webauthnEnrol.ts` is held to 100% coverage with the rest.

**Revisit if** browsers offer a way to ask for a device-bound credential, or once Windows
Hello derives keys wherever Windows runs.

**Update.** ADR-056 revised this. Asking the platform authenticator by default led to
Apple's, Google's and Samsung's clouds, which the threat model has no room for, and
stepping around every extension shut out the managers people choose for privacy. The
person now chooses where the passkey lives, and the route follows the choice.

**Superseded** by ADR-058, which stopped deriving keys from passkeys altogether.

---

## ADR-056 — The person chooses where a passkey lives, and no key is kept in Apple's, Google's or Samsung's cloud

**Problem.** ADR-055 asked the platform authenticator and stepped around every extension.
On Apple and Android devices the platform authenticator is iCloud Keychain, Google
Password Manager or Samsung Pass, so the key went to a cloud account the company can
recover and the person cannot audit, and the app could only say so afterwards. And the
bypass that kept Bitwarden from answering in Touch ID's place also shut Bitwarden out
when that was the manager the person wanted.

**Decision.**

- **Three places a passkey can live, chosen by the person**, beside the passphrase (now
  the default) and opening instantly:
  - _A security key_ — a YubiKey or another FIDO2 key, asked for as `cross-platform` with
    `hints: ["security-key"]`, through the browser's own WebAuthn.
  - _This device only_ — `platform` with `hints: ["client-device"]`, through the browser's
    own WebAuthn, non-discoverable, which is how a platform that can make a device-bound
    key is asked for one.
  - _A password manager you chose_ — no attachment, discoverable, through the page's
    WebAuthn, so the manager's extension answers.
- **One rule for what is kept**, applied to every choice (`passkeyPolicy.ts`):
  - a passkey whose backup-eligible flag is clear is kept, whoever made it — the secret
    stays on that hardware;
  - a synced passkey is kept only from a manager named as independent in the AAGUID table,
    only when the person asked for a password manager, and only after they have read that
    it syncs, and through whom;
  - one that syncs to Apple, Google or Samsung is refused, and named;
  - one that syncs through anything unnamed is refused: it could be any of those three,
    and Apple's passkeys have long carried a zero AAGUID.
- **Every refusal says why and offers what needs no passkey** — a passphrase, or opening
  instantly.
- **The route follows the choice.** The slot records `kind`, `via` and `provider`, so the
  lock screen asks the same way — "Unlock with your security key", "Unlock with
  Bitwarden" — and a manager's passkey is reached through its extension again.
- **Passkeys from before this** keep working. One that said it syncs is shown as synced
  through a manager Textor no longer accepts, with the advice to replace it.

**What this cannot do, and says.**

- **"Zero cloud" is only true of a device-bound key.** A chosen manager syncs through the
  person's account with it. The difference from the refused three is who the person
  trusts, and the screen says which they chose.
- **Apple and Android devices have no device-only passkey to offer.** There, "this device
  only" is refused with the reason, and a security key, a chosen manager, a passphrase or
  opening instantly remain.
- **The flag and the name are the authenticator's own report.** Nothing asks for
  attestation, which passkey managers mostly do not give. The table can only fail closed:
  a manager missing from it, or listed under the wrong AAGUID, is refused as unidentified.

**Cost.** In the shell: the route and hints, and one lock-screen word. The policy and the
provider table travel in the access chunk. The precache went from 795.5 to 796.1 KiB of 800. `passkeyPolicy.ts` is held to 100% coverage with the other vault modules.

**Revisit if** passkey managers begin to offer attestation worth checking, or browsers give
pages a way to ask for a device-bound credential by name.

**Update.** Real devices found two things this decision did not foresee, and a mistake in
its table. ADR-057 records them.

**Superseded** by ADR-058. With no key coming from a passkey, where one lives no longer
matters, and the choice, the routes and the table went with PRF.

---

## ADR-057 — A passkey is kept on what it does when used, not what it says when made · **found on real devices**

**Problem.** On real hardware the prompt appeared, the person was verified, and Textor
turned the passkey down: "Bitwarden cannot hold a key for Textor" on a Mac, "That
authenticator cannot hold a key" on Android. Tracing both found three causes.

- **Bitwarden's browser extension gives third-party sites no PRF output.** It makes the
  passkey and returns no key from it, at creation or at use. The feature request
  (bitwarden discussion #13838) is still under review. Dashlane's extension behaves the
  same, and NordPass answers `enabled: false`. The refusal was right, but it left a
  useless passkey in the person's vault without saying so.
- **On Android, "this device only" asked for a credential that cannot give a key.** A
  non-discoverable request is answered by Android's older, hardware-bound credentials,
  which derive no key. The discoverable ones that can derive one are Google Password
  Manager's, which sync to Google. The same holds on a Mac: Chrome's own device-bound
  authenticator derives no key, and Apple's syncs to iCloud. So on Apple and Android
  devices there is no device-only passkey that opens Textor. The error said "That
  authenticator" because the credential carried no AAGUID the table knew, did not sync,
  and gave no key.
- **Textor judged PRF at registration, which is the wrong moment.** Published measurements
  (Corbado's PRF matrix, 2026) show Samsung Pass, KeePassXC, and Windows Hello under Chrome
  or Edge 146 reporting no PRF result when the passkey is made, and giving one when it is
  used. Microsoft's manager does the reverse: a result at creation, and a `NotAllowedError`
  on every use. Refusing on registration's word turned away some that work. Accepting it
  would have kept one that never opens.
- **The table had an error.** It listed `b5397666-…`, the Chromium browser's own
  authenticator, as NordPass. Checked against the community list at commit `5efd28d67528`
  (2026-09-21): NordPass is `b84e4048-…`, `fbfc3007-…` is now named Apple Passwords, and
  Microsoft Password Manager (`d3452668-…`) syncs to a Microsoft account.

**Decision.**

- **Every new passkey is asked for its key a second time**, with `get`, exactly as
  unlocking asks. The key sealed into the slot is that output, and a result from `create`
  must equal it. No output is a refusal, and so is a different one (`unstable`). Nothing is
  judged on registration's PRF result. Setting up therefore asks for the fingerprint, key
  or manager twice, and the screen says so beforehand.
- **"This device only" is refused on Apple and Android before anyone is asked**, with the
  reason and what works there: a security key, or a password manager such as KeePassDX,
  which keeps its database on the device. On Windows it is offered, and works with Windows
  11 from the February 2026 update and Chrome or Edge 147, or Firefox 148.
- **The browser's `extension:prf` capability is a warning, never a refusal.** Chrome has
  reported `false` where PRF worked. A manager is offered whatever it says, since a
  manager brings its own WebAuthn.
- **A manager that gave no key is named, and the person told to delete the passkey it
  saved.** Neither a browser extension nor the refusal can remove it from that vault.
- **The table is rebuilt from the community list**: 41 password managers, six browser and
  operating-system authenticators (kept when device-bound, refused when they sync to their
  owner), and five clouds — Apple's two, Google's, Microsoft's and Samsung's. A test tool
  and app SDKs are left out, and fail closed.
- **Transports are recorded** when the passkey is made, and passed back at unlock, so the
  browser goes to the key or authenticator that holds it.
- **A manager that keeps a passkey on the device** — not backed up — is described as local,
  not as synced.

**Cost.** One extra prompt when a passkey is set up, never when unlocking. The precache
went from 796.1 to 796.3 KiB of 800. The larger table ships in the lazy access chunk.

**Revisit if** Android or Chrome give device-bound credentials a key, Bitwarden's
extension returns PRF output, or the community list changes. It is refreshed about every
ten days.

**Superseded** by ADR-058: what this found is why PRF was retired.

---

## ADR-058 — Biometrics guard a key kept on the device, and passkeys no longer hold one · **found on real devices**

**Problem.** ADR-054 to ADR-057 tried, four times, to make a WebAuthn passkey hold the
vault key through PRF. On real hardware each attempt still failed, and each fix added
machinery.

- **What works nowhere common.** Bitwarden's and Dashlane's extensions return no PRF
  output. Android's device-bound credentials derive no key, and Chrome's own on a Mac
  derive none either. The passkeys that do derive one, Apple's and Google's, sync to those
  companies' clouds. Microsoft's manager answers at creation and fails every use.
- **What it cost to keep keys out of those clouds.** Textor read the backup-eligible flag
  and kept a 52-entry AAGUID table copied from a community list that needs refreshing
  every ten days. It routed requests around extensions or through them, recorded
  transports, disclosed syncing, and asked twice at setup.
- **The outcome.** On the devices most people own — an iPhone, an Android phone, a Mac —
  "use biometrics" could not be offered at all. Where it was offered, it often failed after
  the fingerprint. A device without biometrics had a passphrase to type every time, or no
  protection.

**Decision.**

- **PRF is gone.** `webauthnPrf.ts`, `webauthnEnrol.ts` and `passkeyPolicy.ts` are
  deleted, and the AAGUID table, routes, transports, sync disclosure and cloud refusals
  with them.
- **A `biometric` slot** seals the data key with AES-GCM under a non-extractable
  WebCrypto key generated on this device and stored beside the vault, as the `device`
  slot does. It also records the id of a platform credential: `platform` attachment, user
  verification required, non-discoverable, `hints: ["client-device"]`, no attestation,
  no extensions.
  - The vault opens the slot only with a `Presence`: a proof that only
    `biometricGate.ts` makes, after a `get` for that credential answered with the UV flag
    set. It is spent once, within a minute.
  - Setting it up makes the credential, then asks it once, exactly as unlocking will. A
    credential that cannot answer never becomes a way in.
- **Where the platform keeps the credential no longer matters.** It carries no secret of
  Textor's; the key never leaves this device.
  - If iCloud Keychain or Google Password Manager syncs the credential, what syncs is a way
    to say "the person is here", to devices that hold no copy of this vault.
  - If Bitwarden answers in Touch ID's place, Bitwarden's unlock becomes the gate, and it
    works.
  - So nothing needs to be refused, named or explained after the fact.
- **A `pin` slot**, one at a time, sealed like a passphrase slot:
  - _A PIN_: 6–16 digits. Persian and Arabic-Indic digits are read as ASCII, so a PIN
    typed on a Persian keyboard is the same PIN.
  - _A pattern_: 4–9 distinct dots of a 3×3 grid. The grid never mirrors in a
    right-to-left interface, so a pattern set in English opens in Persian.
  - _Derivation_: scrypt at N=2¹⁵, half the passphrase's cost.
  - _Lockout_: each wrong try is counted in the slot before it is reported, including
    tries made to confirm the person in Settings. The tenth erases the slot — unless it is
    the only way in, which a lockout must never destroy.
  - _Where it is offered_: only where the recovery phrase or a passphrase will open the
    vault afterwards.
- **Choosing.** Onboarding offers five ways, each saying what it stops and what it does
  not:
  - biometrics — the default where a platform authenticator is set up, and shown
    disabled, with the reason, where it is not;
  - a PIN — the default otherwise;
  - a pattern;
  - a passphrase;
  - opening instantly.
- **Unlocking** tries the device key silently. Then it prompts once for biometrics on a
  cold start, then offers the PIN or pattern, then the passphrase. The recovery phrase is
  always one tap away.
- **Retired slots.** A `webauthn-prf` slot from an earlier build cannot be opened. The lock
  screen says so. The first unlock by any other way drops it, and the app then offers to
  choose a new way in.

**What this gives up, and says.**

- **Biometrics are a gate, not a lock.** PRF's key lived in the authenticator; this one
  lives beside the vault. Someone who copies the browser profile, or runs code in the page,
  can open a biometric slot without anyone's finger, exactly as they can open an instant
  one.
  - Against someone holding the device and using Textor's own screen, it holds, and the
    platform's own lockout covers the fingerprint.
  - The assertion's signature is not checked, for the same reason. Only code already in
    the page could forge an answer, and that code could skip the check.
  - Settings → Security and THREAT-MODEL.md §3.11 say this in those words.
- **A PIN is not a passphrase.** Against a copy of the data, six digits or a pattern fall
  in minutes, whatever the derivation costs. So the derivation is sized for waiting, and
  the protection is the lockout, which holds only against someone using Textor's own
  screen.
  - ADR-054 ruled a PIN out on these grounds. It is back because the people who chose
    nothing were the ones at risk, and they are better served by a lockout than by an
    unlocked vault.
  - It is described as what it is.
- **Only a passphrase protects a copy of the device's data.** The passphrase choice now
  says so.

**What building it found.**

- **Two wrong tries at once, at the tenth.** Two tabs raced. The first erased the slot, and
  the second then found it gone, and reports it erased rather than counting past it. This
  is tested.
- **The shell grew by the lock screen's PIN field, pattern pad and gate**: they must work
  offline. Removing PRF freed only 2.2 KiB of the shell, because its enrolment code was
  already lazy. Setting biometrics up (`biometricEnrol.ts`) is lazy too.

**Cost.** To pay for the shell's growth, Add Contact, the page an invite link opens and a
contact's own page moved into a lazy `people` chunk. None is on the way from a cold start
to answering a message (ADR-043). The precache went from 796.3 to 794.2 KiB of 800.
`biometricGate.ts` and `biometricEnrol.ts` are held to 100% coverage with the vault
modules.

**Revisit if** browsers gain a way to bind a WebCrypto key to user verification, or PRF
becomes dependable on the platforms people use. Either would make the gate a lock again.

**Update.** ADR-059 made opening instantly exclusive of every other everyday way in, and
checked the gate against each system's authenticator. It added a security key as a gate
where the device has no authenticator of its own to use.

---

## ADR-059 — Opening instantly stands alone, and the gate is checked against every system · **found by audit**

**Problem.** Two gaps, one in the rules and one in the configuration.

- **Opening instantly sat beside the ways that guard the device.** ADR-054 let a device
  slot coexist with a passphrase, a PIN or biometrics. Then the device opened with nothing
  asked at every start, and the other way guarded nothing — while Settings listed it as a
  way in. Someone who added a PIN to a device that opened instantly could fairly believe
  it now asked for the PIN.
- **The gate's WebAuthn request was written against the specification, not against each
  system's authenticator.** Checked against each, it would have failed in these ways:
  - _iOS 26.2_: `isUserVerifyingPlatformAuthenticatorAvailable()` answered false in
    Chrome, Edge and Firefox on iOS, though passkeys worked there (a WebKit fault, fixed
    in 26.3). Textor would have said Face ID was not set up.
  - _Apple, from 26.2_: the same call answers true only once a passkey manager is set up.
    "Turn it on in your system settings" was the wrong advice: what is missing is
    Passwords or another passkey provider.
  - _Windows Hello_: a synced passkey has been reported answering with the UV flag clear
    after a correct PIN (Microsoft Tech Community, 2026). Such a credential would refuse
    every unlock.
  - _Safari before iOS 17.4_ wants a tap for each WebAuthn call, allowing one call per
    page load without one from iOS 16. _Chrome_ refuses WebAuthn to a page without focus,
    so the cold-start prompt in a tab opened in the background was simply lost. A refused
    prompt that nobody had asked for still showed "Unlocking was cancelled".
  - _Linux_: no browser there reaches a fingerprint reader. Firefox has no platform
    authenticator; Chrome's is Google Password Manager, a cloud account behind its own
    PIN. The screen still told the person to turn something on in system settings.

**Decision — opening instantly is exclusive.**

- **Every write of the slot list keeps them apart.** If a biometric, PIN or pattern, or
  passphrase slot remains, the device slot is dropped, key and all, in the same
  transaction. Setting any of those up therefore deletes instant opening at once.
- **Adding the device slot beside one is refused** (`InstantOpenError`). The check runs
  inside the write, because another tab may have added a way in meanwhile.
- **Leftovers open nothing.** A device slot found beside a guarded one — written by an
  earlier build, or by another tab still running one — is refused when asked to open.
  `tidy()` drops it at start, before anything is opened, and after every unlock. The same
  pass drops retired PRF slots (ADR-058), so those now go at start rather than at the
  first unlock; the lock screen still says one was there.
- **Settings offers "Open instantly" only while nothing else guards the device**, and
  otherwise says why. To get there, the other ways in can be removed. The last one can go
  too, now, where the recovery phrase still opens the device. Removing a way in first asks
  the person to open Textor again, as adding one does. A device that only the recovery
  phrase opens is confirmed with the phrase, so a passer-by cannot clear the way to
  opening instantly either.
- **Setting a guarded way up on a device that opens instantly says so first**, and
  confirms afterwards that it no longer does.

**Decision — the gate, system by system.**

| System      | What answers                                                                                                  | Verifies with                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| macOS       | Apple Passwords (iCloud Keychain); in Chrome also Chrome's own Secure Enclave key, or Google Password Manager | Touch ID through LocalAuthentication, or the Mac's password |
| iOS, iPadOS | Passwords or an installed provider, in every browser (all are WebKit)                                         | Face ID or Touch ID, or the passcode                        |
| Windows     | Windows Hello, TPM-backed; in Chrome possibly Google Password Manager, gated by Hello                         | Face, fingerprint or the Hello PIN                          |
| Android     | A non-discoverable credential in the Android keystore — TEE or StrongBox, as the device decides               | BiometricPrompt: fingerprint or face, or the screen lock    |
| ChromeOS    | The device's own authenticator, bound to its TPM                                                              | Fingerprint or PIN                                          |
| Linux       | Nothing a browser can reach                                                                                   | — a security key instead                                    |

- **Support is asked twice.** `getClientCapabilities().userVerifyingPlatformAuthenticator`
  is asked first, then `isUserVerifyingPlatformAuthenticatorAvailable()`; either saying
  yes is enough. Linux is never offered the device's own.
- **A security key can stand at the gate.** It is asked as `cross-platform`, with
  `hints: ["security-key"]` and user verification required, which is its PIN or its
  fingerprint. It is the way to hardware verification on Linux, and on any device whose
  own authenticator is not set up. Onboarding offers it there; Settings offers it
  whenever no gate is set up. The slot records `authenticator` and the credential's
  reported `transports`, and unlocking asks by both, so the browser goes straight to the
  right prompt.
- **Unavailability says what to do on that system.**
  - Apple: turn on a passkey manager, which keeps nothing that opens the messages.
  - Windows: set up Windows Hello.
  - Android: set a screen lock.
  - Linux: use a security key, a PIN, a pattern or a passphrase.
  - Everywhere: a private window cannot use it either.
- **Setup still asks twice, and is honest about the second ask.** The confirming `get`
  is what catches an authenticator that answers without the UV flag, before it becomes a
  way in. Where the browser shows the new credential's flags, those are checked too. If
  the second ask is dismissed or refused for want of a tap, the screen says one more tap
  finishes, and that tap asks the credential already made.
- **The unprompted request waits for the page to be seen.** On a cold start it waits
  until the page is visible and has focus. If refused, it says nothing: nobody asked.

**What no web page can do, and the documents say.**

- **WebAuthn cannot ask for a biometric alone.** Every system accepts its own PIN,
  password, passcode or pattern as user verification, and a device without a fingerprint
  reader verifies that way. "Biometrics" means the platform's own verification.
- **A page cannot choose TEE or StrongBox, Secure Enclave or keychain, or which provider
  keeps the credential.** It does not need to: the credential holds no secret of
  Textor's.
- **A page cannot fix a platform's fault.** It can catch one at setup and refuse
  honestly, which it now does.
- **"Deleted" means removed from the database.** Like any deleted IndexedDB data, the
  bytes of a dropped instant key may stay on disk until the browser compacts its storage;
  ADR-054 already says removal is not retroactive against a copy.

**Cost.** In the shell: the exclusivity rule, the tidy pass, the gate's transports and
hints, and the lock screen's waiting prompt. The precache went from 794.2 to 796.3 KiB,
of 800. `biometricGate.ts`, `biometricEnrol.ts`, `keyslots.ts` and `vault.ts` stay at
100% coverage.

**Revisit if** Windows fixes the UV flag on synced passkeys, a Linux browser gains a
platform authenticator, or WebAuthn gains a way to ask for biometric verification alone.

---

## ADR-060 — A conversation is one column, and a wide window shows the list beside it · **found in use**

**Problem.** The app had one layout, the phone's, and a wide window stretched it.

- **A conversation read as two lists.** It spanned the whole window: what was received
  hugged the left edge and what was sent the right, 34rem at most each, with some 900
  pixels between them on a 1440-pixel screen. The two sides read as parallel columns, one
  per person, not as one exchange. The two-pane styles in `chat.css` (`.split`,
  `.sidebar`, `.detail`) had never been wired to anything, so the chat list, contacts and
  settings stretched across the window as well.
- **A row was a flex row**, so anything said about a bubble stood beside it. A failed
  message's "Not delivered — Retry sending" became a third column, and on a phone it
  squeezed the bubble to a word per line.
- **On a touch screen, three controls sat beside every bubble**, shown at half opacity
  because there is no hover. A phone has no gutter for them: at 320 pixels they ran past
  the edge, and the conversation scrolled sideways.
- **Two notices sat above every screen.** The backup reminder and the recovery notice
  were drawn above every screen, conversations included, pushing the header down. The
  header kept the top safe-area inset, so beneath a notch the notice sat under the
  status bar. The connection bar did the same.
- **Smaller faults, found on the way:**
  - A long name wrapped the conversation header to four lines.
  - A picture collapsed to the width of its timestamp. The bubble is as wide as what is
    in it, and the picture was sized as a share of the bubble, so neither had a width to
    go by.
  - A reply preview, or a composer growing a line, hid the newest message.
  - A removed contact's page had no header and no way back.

**Decision — one column.**

- **The list scrolls one stream.** Every date, message and call is a child of it, in the
  order it happened, and nothing else is.
- **The row carries the side.** A row spans the column and stacks its bubble and
  whatever is said about it. The side is the row's alignment: the end edge for what was
  sent, the start edge for what was received. Both are logical, so Persian mirrors them.
- **Past a reading width the column stays in the middle.** Past `--chat-max` (46rem), as
  Telegram's and Signal's do. The notices above it, the reply preview and the composer
  share its gutter, so they line up with it.
- **A short conversation sits at the bottom**, beside the composer, and grows upwards.
- **The list stays at the newest message** when it shrinks under a reply preview, a
  growing composer or an on-screen keyboard, for whoever was reading it.

**Decision — two panes on a wide window.** From 60rem, as Telegram, Signal and WhatsApp
lay out a desktop:

- **The list beside what it opened.** The list the person is in (chats, contacts or
  settings) sits down the side with the tabs under it, and what they opened from it sits
  beside it. The open item is marked in the list.
- **A list's own address** shows a quiet "Choose a conversation" in the second pane.
- **Back buttons.** A first-level page drops its back button, which only led to the list
  beside it; deeper pages keep theirs.
- **Pages with more than one parent.** Adding a contact, verifying one, or an invite
  stays beside the list it was opened from.
- **Resizing keeps the conversation.** The route is drawn at the same place in the tree
  in both layouts. A window resized across the breakpoint keeps the conversation mounted,
  with its draft, its reply and its scroll position.

**Decision — touch, notices, and the rest.**

- **Holding a message opens its menu** (`useHold`: 450 ms, 10 px of drift). A right click
  opens the same menu, except over a link, a picture or a selection. The menu now leads
  with the quick reactions and carries reply.
- **The buttons beside a bubble are for a mouse.** On a touch screen they stay in the
  page for a keyboard or a screen reader, and show when one reaches them.
- **No text selection on touch.** A held finger would start one; the menu copies the text
  instead.
- **The notices live at the top of the chat list**, which the person keeps coming back
  to. While the connection bar shows, it takes the top inset.
- **The smaller faults are fixed.** The header truncates a long name. A picture has a
  definite width, capped by the bubble. A missing contact's page has a header and a way
  back.

**Verified.** In a browser, in English and Persian:

- the conversation at 320 pixels, at 900 and 1440;
- every other screen at 320, with no horizontal overflow;
- the menu opened by a held finger;
- a resize across the breakpoint with a draft typed.

`tests/chatLayout.test.ts` pins the single stream, the row order, the failed notice's
place, the hold, and which list each route sits beside.

**Cost.** The two-pane shell, the hold and the layout rules are in the shell. Re-encoding
a picture and recording a voice note moved out of it, into a `media` chunk loaded when a
file is picked or the microphone pressed. Only the check that decides whether to offer
the microphone stays. The precache went from 796.3 to 795.6 KiB, of 800.

**Revisit if** something in a conversation needs the full width, such as a wide table,
or people ask to resize the list.

**Update.** ADR-061 changed what touch does, to match Telegram. A tap opens a message's
menu, and holding it selects it, starting a selection that the header then acts on.

---

## ADR-061 — A conversation keeps the order things were said, and handles a message as Telegram does · **found in use**

**Problem.** An audit of the timeline against NIP-59, and of the conversation against
Telegram Web's two open-source clients (Web A/Z, Web K).

- **Ingest was sound.** Every entry takes its time from the rumor: the `ms` tag, or its
  `created_at`. NIP-59's randomised wrap time was never used. A test now pins that
  entries interleave correctly when caught up in wrap order.
- **Three things still broke the order.**
  - _A busy hour came back as a scattering of itself._ The index holds hour buckets, and
    inside one IndexedDB orders rows by their blinded id — at random. A page read
    `limit + 64` rows and cut there. In any hour with more than 124 messages (a page is
    60), the page showed older messages and left newer ones out. A test with 300 in one
    hour reproduced it.
  - _A clock running behind put a message just sent in the middle of the history._ Sent
    entries were stamped with the local clock. Answering a peer whose clock ran ahead
    placed the answer above the question, on both devices.
  - _A stamp from later today held the bottom._ Rumors up to a day ahead were accepted
    at face value and sat below everything said until then.
- **Two ticks did not mean read.** One tick meant a relay had it, two meant their device
  had it, and two in another colour meant read. People read two ticks as "seen", as
  Telegram taught them.
- **Deleting for both was the author's alone, and asked in `window.confirm`.** Telegram
  lets either person delete anything in their conversation. Ten confirmations across the
  app used the browser's own dialog, which blocks the page, reads as the browser rather
  than the app, and is suppressed outright by some embedded browsers.
- **Selecting, forwarding and a message's details did not exist.** Nor did Telegram's
  runs of bubbles with a tail, history loading as the reader scrolls back, or the way
  back to the newest message.

**Decision — order (`core/models/timeline.ts`).**

- **One order.** By the rumor's own time, then by id, on every device.
- **Sent after everything held.** A message is stamped `max(now, newest + 1 ms)`. The
  newest comes from the conversation's `lastActivity`, so nothing is decrypted to find
  it. It is capped at 10 minutes ahead of this clock, which receivers accept. Briar
  stamps the same way.
- **Placed on arrival past the slack.** A rumor stamped more than 10 minutes ahead is
  placed when it arrived. More than a day ahead is still refused at unwrap.
- **A page reads its edge hours whole.** The hour the walk stops in, and the hour
  `beforeTs` falls in, are read in full, then decrypted and sorted. Exact times stay out
  of the index, which is why it holds hours in the first place.

**Decision — ticks and details.** One tick for sent or delivered, two for read only.
When each receipt came is kept (`deliveredAt`, `readAt`, per member `receiptsAt`). It is
the recipient's own time, never before the message and never after it arrived. A sent
message's details, opened from its menu, show sent, delivered and read — and in a
group, each member's state.

**Decision — deleting, between two and in a group.**

- **Between two people, either may delete anything in their conversation for both**:
  what they wrote, what the other wrote, calls. It is honoured when the message is in the
  direct conversation with the sender, which is where ADR-047 already checked calls.
- **In a group, only what one wrote.** A group has no one whose conversation it is.
- **Nothing else is honoured.** A stranger, or a group member reaching into another
  conversation, is still refused.
- **The cost, said plainly.** Your copy of your own words is no longer something the
  other person cannot remove. The threat model says to keep a backup or screenshot of
  anything you may need to show.

**Decision — handling a message as Telegram does.**

- **Touch.** A tap opens the menu; holding selects. A right click opens the menu too.
- **The menu.** Reactions first, then Reply, Copy, Forward, Select, Details, Delete.
- **Selecting.** A check at each row's start edge, received bubbles moved over for it.
  The header becomes the selection's bar: how many, Forward, Delete. Escape, or
  unpicking the last one, ends it.
- **Delete asks how.** "Delete for me and {name}" or "Delete for me" — Telegram's mobile
  wording, as two answers rather than Web A's checkbox, so nothing rides on a box left
  ticked. In a group, "Delete for everyone" only for one's own.
- **Every confirmation is the app's own dialog.** It opens on Cancel; no
  `window.confirm` or `alert` is left.
- **Forward sends a copy, naming nobody.** Telegram names the original author; that
  would tell someone who said it to a person they never told. Attachments are sent
  afresh, sealed for their new readers; a payload still arriving is left out, and said
  so.
- **Runs, history and the way back.** Runs of bubbles use Web A's metrics: 15 px corners,
  6 px where two meet, and a tail on the last. Earlier history loads as the reader nears
  the top, holding their place; the button remains for a keyboard. A button returns to
  the newest message once the reader is a screen or more above it.

**Adapted, not copied.** Both Telegram clients are GPL-3.0; Textor is AGPL-3.0. Their
behaviour and metrics were studied and written anew here, not their code. The ledger in
`docs/UI-PARITY.md` lists each pattern, where it lives, and what was left out and why.

**Not done.**

- _A windowed timeline._ Windowing drops rows far from view. The window here grows only
  as someone scrolls back, 60 at a time. Windowing variable-height rows reintroduces
  jumps and gaps — the class of fault this decision fixes — and Safari has no scroll
  anchoring to lean on.
- _Deleting on one's own other devices._ Control frames go person to person, so another
  device of one's own keeps what this one deleted, as before.

**Cost.** In the shell: the timeline rules, selection, the dialog and the delete flow. To
pay for them, three things left the shell for their chunks: the verify screen's words,
most of the poll and checklist words, and the About screen's account; so did the
picker's, the polls' and the safety number's styles. Forwarding and details are a new
`conversation` chunk. The precache went from 795.6 to 793.1 KiB, of 800.
`timeline.ts` is held to 100% coverage.

**Revisit if** a group gains admins, who in Telegram may delete others' messages. Revisit
too if Safari gains scroll anchoring, which would make a windowed timeline safe, or if
people ask for a setting to refuse deletion by the other person.

**Update.** ADR-062 removed the two clock rules above: the send-time bump and its 10-minute
cap, and placing far-future arrivals on arrival. It also removed the clamping of receipt
times. The busy-hour paging fix stands.

---

## ADR-062 — Time is UTC epoch from end to end, and a stamp is taken as given · **found by audit**

**Problem.** Messages between a device in Los Angeles (UTC−7) and one in Tehran (UTC+3:30)
were reported out of order. The suspicion was that a local time zone had leaked into how
stamps are made, bucketed, parsed or sorted. Separately, ADR-061 had added rules that
adjusted stamps when clocks disagree.

**The audit found no time zone anywhere in the order.**

- **Stamps** are `Date.now()`, and `created_at` is `Math.floor(ms / 1000)`. The `ms` tag
  is compared with `created_at` in epoch time.
- **Index buckets** are `Math.floor(ms / HOUR) * HOUR`, so UTC hours. Relay `since` and
  `until` filters, sync marks and the dedup floor are epoch seconds.
- **Nothing parses a date string.** No `Date.parse`, and no `new Date(string)`.
- **Local time appears only in display.** It sets the time shown, which is the reader's
  own, and which day a separator names. Neither affects where an entry sorts.

Two devices with correct clocks agree on every stamp in any zones. A misorder that
follows a time zone is a clock set wrong, which moves `Date.now()` itself. Iran is a
common case: it ended daylight saving time in 2022. A device with old time-zone data then
shows an hour too late in summer, and a person who corrects the clock by hand, rather
than the zone, puts it an hour behind UTC.

**ADR-061's clock rules were arbitrary, and made devices disagree.**

- _The send-time bump_ stamped a message `max(now, newest + 1)`, capped at 10 minutes. That
  cap was too small for exactly that one-hour error.
- _The arrival rule_ placed a rumor more than 10 minutes ahead at the moment it arrived.
  It moved that entry on one device and not on the other.
- _The receipt clamps_ kept a receipt's time between the message and its arrival. That
  showed a time the recipient never gave.

**Decision.**

- **One canonical order.** By the author's UTC stamp, then by id, taken as given with no
  adjustment on any device. `core/models/timeline.ts` is that comparator alone.
- **Receipts too.** A receipt's time is what the recipient's device stamped.
- **What stays.** The busy-hour paging of ADR-061 stays: it was a fault in reading the
  index, not a heuristic. The refusal of rumors more than a day ahead stays; it predates
  both decisions (§2.1 of the protocol).
- **What this means for a wrong clock.** A device whose clock is wrong stamps wrongly,
  and every device sorts those stamps the same. An answer from a clock an hour behind
  sits above its question on both sides alike. Nothing on another device can know the
  clock was wrong.

**Verified.** `tests/timeline.test.ts` acts out both zones in one process, since Node
re-reads `TZ` when it is assigned:

- A device in Los Angeles and one in Tehran take turns across Tehran's half-hour and its
  midnight. Both sides show the same order, with stamps equal to the UTC send times.
- The same holds when one side catches up later, in the relay's order.
- A device that moves between the zones pages its history exactly.
- The index bucket is the UTC hour in every zone.

Two faults were planted to check the tests: buckets made by the local hour, and stamps
shifted by the zone offset. Both failed them.

**Cost.** Code removed, none added. The precache fell with it.

**Revisit if** people with wrong clocks keep seeing answers above questions. The one fix
that works without a trusted clock is an uncapped causal stamp, `max(now, newest + 1)`,
which is how Briar orders a conversation. It is a deliberate adjustment of the stamp, and
it would be decided as one.

**Update.** Real devices did keep showing it, and ADR-063 made the decision. The causal key
is a separate time from the stamp, which is still shown as given.

---

## ADR-063 — A conversation is ordered by a causal clock, and shown by its authors' clocks · **found on real devices**

**Problem.** Windows and macOS machines in different time zones showed the timeline
inverted: answers above questions, and the two sides interleaved wrongly.

- **Real clocks are wrong in ordinary ways.** They drift between synchronisations.
  Windows keeps the hardware clock in local time and macOS in UTC, so a machine booting
  both is off by its zone's offset. Stale zone data puts a clock an hour out, and people
  correct the hour by hand.
- **ADR-062 ordered by each author's stamp as given.** That is deterministic, and right
  only while clocks agree. An answer from a clock an hour behind sorted above its
  question, on every device alike.

**Options weighed.**

| Model                        | Causal? | Stays near real time? | Carried per message  | Verdict                   |
| ---------------------------- | ------- | --------------------- | -------------------- | ------------------------- |
| The author's stamp (ADR-062) | No      | Yes                   | Nothing new          | Replaced                  |
| The stamp, bumped (ADR-061)  | Capped  | Yes                   | Nothing new          | Mixed up shown and sorted |
| Lamport clock                | Yes     | No                    | One counter          | Loses time                |
| Vector clock                 | Exactly | No                    | One entry per member | Still needs a tie-break   |
| Hybrid logical clock (HLC)   | Yes     | Within the skew       | One number           | Chosen                    |

A Lamport clock orders two messages nobody had seen by counter, which can be far from when
they were said. A vector clock gives only a partial order, which a timeline must still
break by something. It also grows with every member, and travels with every message.

**Decision — two times, one of them for sorting.**

- **`ts` is shown, never adjusted.** It is when the author sent it, by the author's
  clock, in UTC epoch milliseconds, displayed in the reader's time zone.
- **`order` is sorted by.** It is a hybrid logical clock with the logical counter folded
  into the millisecond, so the key one past a mark is `mark + 1`.
- **One clock per conversation, not per device.** Each conversation keeps a sealed
  high-water mark, `clock`. A conversation from before keys existed starts at its newest
  entry, `lastActivity`. A skewed peer therefore moves only the conversations it is in,
  and no conversation's keys carry anything from another.
- **Sending** keys a message `max(now, clock + 1)`. The key is taken and stored in one
  transaction, so two sends never share one.
- **Every entry stored moves the clock past its key**: sent, received, a call, or
  restored from a backup.

**Decision — carried, checked and used.**

- **Carried.** The key travels in an `hlc` tag in chat messages (kind 14), forward-secret
  messages (kind 9) and opening call offers. Both sides enter a call at its offer's key.
  A retry rebuilds the tag, and a message from before keys existed is rebuilt without it,
  so every id is unchanged.
- **Checked.** A received key is taken if it is at least the rumor's own stamp and at
  most a day ahead of this clock. That is the bound the unwrap already enforced, now one
  constant, `MAX_CLOCK_AHEAD_MS`. Otherwise the entry sorts by its stamp, as does a
  rumor from another client.
- **Used for everything that means "after".** The index buckets each entry by the hour
  of its key, so paging and retention read keys. A read receipt covers what sorts before
  the message it names, and unread counts compare keys.
- **The screen.** Times are shown as their authors' clocks gave them. Down a
  conversation whose clocks disagree they need not rise, so a day separator is announced
  only when the day moves forward, and a run's pause is measured either way.
- **Removed.** The calls subsystem clamped a missed call's time to now. That clamp is
  gone: the time shown is the offer's own.

**The guarantee.** If B's author had received A before sending B, B's key is greater than
A's, and every device sorts them that way. That holds however far apart the two clocks
are, provided neither is more than a day ahead of the device reading them. Two messages
neither author had seen sort by their keys, which are near their authors' clocks, and
every device agrees on that order too.

**Limits, said plainly.**

- _"Seen" means arrived on the author's device._ A message can sort after one its author
  never looked at.
- _A clock more than a day ahead is still refused._ That is the bound the unwrap enforced
  before this decision, and a clock that far out is not drift.
- _A contact can choose a key up to a day ahead._ Such a message sits at the bottom only
  until someone answers it.

**Verified.** `tests/timeline.test.ts` covers:

- a reply from an hour behind;
- a question from an hour ahead;
- a group chain across clocks an hour apart each way;
- two messages neither author had seen;
- catching up in the relay's order;
- a rumor with no key, and one with a forged key;
- a call between skewed clocks;
- the time-zone cases of ADR-062.

`mlsMessenger.test.ts` covers the same for forward-secret groups, and a retried message
from before keys existed. Four faults were planted, and each broke these tests:

- sending ignoring the clock;
- receiving ignoring the key;
- calls ignoring their offer's key;
- forward-secret ingest ignoring it.

**Cost.** The precache went from 792.9 to 794.2 KiB, of 800. `timeline.ts`, `mls/**`,
`exportImport.ts`, `vault.ts` and `keyslots.ts` stay at 100% coverage.

**Revisit if** reactions or votes, which are not timeline entries and still resolve by
their own stamps, ever need causal order too.

---

## ADR-064 — Locations are sealed like messages, drawn on the device, and moved live by the sender

**Problem.** Share a place, or where you are going for a while, as Telegram does: a map in
the bubble, a pulse while it moves, a countdown, and Stop one tap away. Three things
Telegram relies on are not available here.

- **No server.** There is no server time to agree on, and nobody to hold a live session.
- **No remote images or requests.** The content policy lets the app reach relays and
  nothing else: `img-src 'self' data: blob:`, and `connect-src` with no `https:`, which
  `check-bundle` enforces. Map tiles would need both loosened.
- **A map service learns what it is asked.** A tile server asked for the streets around a
  point learns the point; a place search or a reverse geocoder learns more.

**Options weighed for the map.**

| Option                              | Why not                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Tiles from OpenStreetMap or similar | Loosens the policy, and the tile server learns every place looked at      |
| Tiles through a proxy we run        | A server                                                                  |
| A bundled world map                 | Streets are gigabytes; a coastline says nothing at street level           |
| Drawn from the positions (chosen)   | No streets. What it shows — distance, direction, accuracy, path — is true |

**Decision — what travels.**

- **A place, and the start of a live share,** is an ordinary kind 14 message. Its
  coordinates are in a `location` tag with the accuracy, then `place` (a name) or `live`
  (seconds; `0` until turned off). Its content is a `geo:` URI (RFC 5870), which other
  clients show and a maps application opens. A retry rebuilds the rumor from what it
  carried, so its id holds.
- **A live share moves** by `loc` control frames to the same people: the message's id, a
  sequence number, and the whole position — latitude, longitude, accuracy, heading and
  speed — or an `end`. Every receiver folds them into the message's `live` state, kept
  apart from what the rumor carried.
- **Only its author moves a share, and only in its room.** Anyone can name a message id,
  so a frame from someone else, or sealed to other people, changes nothing. An older frame,
  overtaken in transit, changes nothing either.
- **An update can overtake its share,** since relays deliver in any order. The newest
  such frame is held for the share, for up to 64 shares — an end above all, which is what
  stops a share "until turned off" from looking live for ever.
- **Not in forward-secret groups,** which carry text only (ADR-049).

**Decision — relay traffic.**

- **Updates are worth only their newest.** Each replaces any still waiting in the outbox,
  goes over the direct channel when one is open, is not copied to the sender's inbox, and
  asks relays (NIP-40) to drop it after an hour.
- **The end is the opposite:** queued durably, always by relay, and copied to the sender's
  inbox, so the sender's device that is sharing stops, whichever one pressed Stop.
- **A heartbeat** resends the position every ten minutes while nothing moves, so a reader
  arriving late finds one inside the relays' hour.

**Decision — sharing, and sparing the battery.**

- **One watch serves every share.** It asks for satellites and allows an update every ten
  seconds while the app is looked at and the person moves. Once the app is hidden, or they
  have stood still for three minutes, it takes the cheapest position the device has and
  allows one a minute.
- **An update is sent** when the position has moved further than it is vague (at least
  20 m), when a guess is corrected (accuracy halved from worse than 20 m), when the heading
  turns 35° or more at walking pace, and at every heartbeat.
- **A share is remembered** in a sealed state record, which a backup does not carry, so a
  restored vault never takes up what another device was doing. Locking pauses it, and the
  next unlock resumes it, ending any whose time ran out in between.
- **It ends** at its time, on Stop, when the message is deleted here or by the other
  person, and when the browser refuses location — each time for everyone it went to.
- **A bar says a share is running,** above the chat list and in its conversation, with
  Stop beside it: a position is too personal to share by accident.

**Decision — clocks.** A reader has only the author's clock to go by, and it may be
hours out (ADR-063). The share keeps `lag`: the least time any of its frames seemed to
take to arrive. Nothing arrives before it was sent, so `lag` is at least how far this
clock runs ahead of theirs, and the author's times plus `lag` never show a share as ended
before it has — which a phone an hour behind would otherwise cause the moment it began.
An end the author sent is believed at once. With no news for fifteen minutes, a running
share stops pulsing and says when it was last heard from.

**Decision — the map, and picking a place.**

- **Drawn in SVG on the device.** A grid fixed to the ground, a scale and a north arrow,
  the accuracy halo, a heading beam, the last 24 positions as a path, and the sharer's
  colour and initials. North stays up in Persian too: a map does not mirror.
- **Where the reader is** is shown only when they ask, only on their screen, and never
  sent: distance and direction, "2.5 km north-east".
- **No search:** a search by name is a question to a map service. A place is picked by
  tapping the map, or by pasting coordinates (decimal or degrees-minutes-seconds, in
  Persian digits too), a `geo:` URI, or an OpenStreetMap, Google or Apple Maps link.
- **Handing a place on** — to a maps application with `geo:`, or to OpenStreetMap — is
  offered, and said to be the one step that tells anyone outside the conversation.

**Decision — the precache.** Everything but the wire format and the engine's paths is in
a lazy `location` chunk: the map, card, sheet, picker, bar, the sharer and the geometry
(27.7 KB of script, 5.4 KB of styles). `check-bundle` looks for `watchPosition` in the
shell. To make room, two things only lazy chunks used left the shell:

- building and counting polls, into `interactiveForms.ts`, which travels with the polls
  chunk;
- voice-note waveform maths, which travels with the recorder; `formatDuration` moved to
  `ui/format.ts`.

**Limits, said plainly.**

- _The browser finds the position,_ and may ask its maker's location service to. That is
  outside Textor, and the picker says so.
- _Relays see a rhythm._ While a share runs, wraps go to the people it is shared with
  every ten seconds to ten minutes. That says something is going on, not what or where.
- _Only while the app is open._ A browser that puts a hidden page to sleep stops it moving,
  and readers see how old the newest position is.
- _No streets._ The map shows where, not what is around it; a maps application is one tap
  away for that.
- _A position is a claim,_ like any message. Nothing proves someone is where they say.

**Verified.**

- `tests/location.test.ts`: the tags, the frame and the fold, including out-of-order,
  repeated and post-end frames; what a reader sees across an hour's skew; the geometry;
  and reading pasted positions.
- `tests/liveSharer.test.ts`: the throttle, heartbeat, idle and hidden precision, expiry,
  stop, pause and resume, refusal, and the browser adapter against a fake
  `navigator.geolocation`.
- `tests/locationMessenger.test.ts`: real engines on one relay network. It covers places
  and live shares in direct and group conversations, a coordinate never on the wire
  unsealed, updates from the wrong author or room, updates and an end that overtook their
  share, an hour's skew, offline coalescing and expiry, outbox retries, the end reaching
  the sharer's other device, and deleting a share.
- `tests/locationUi.test.ts`: the map, card, sheet, picker and bar.

Twelve faults were planted, and each broke these tests: moves from anyone, moves from any
room, early frames dropped, the lag learned as the most, the lag ignored, stale updates
left queued, updates kept as long as messages, the end not copied, deletion leaving a
share live, the gap ignored, ran-out shares never ended, and satellites kept on when
hidden.

**Cost.** The precache went from 794.2 to 798.6 KiB of 800 (798.9 with the Pages base
path). `models/location.ts` and `core/location/**` are held to 100% coverage.

**Revisit if** tiles could be had that teach nobody anything — packaged for a region and
served from our own origin, say. They would belong in the lazy chunk.
