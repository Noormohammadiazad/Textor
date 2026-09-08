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
is latency. Since ADR-068 the direct channel uses STUN only, even when the user has a TURN
server for calls.

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

**Update (ADR-065).** `img-src` also names `https://tile.openstreetmap.org`, for street
maps someone turns on. `scripts/cspPolicy.mjs` fails the build on any other remote source
in any directive, on any wildcard, and on that host anywhere but `img-src`.

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

**Update.** Refined by ADR-080: the link climbs from lower left to upper right, the tail
continues the bubble's left edge, the maskable mark is at 80%, and the SVGs are written by
the same generator as the PNGs rather than kept in step by hand.

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

**Update.** ADR-075 moved the relay path out of the inbox, and raised its limit to 1 MiB.

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
  the last TURN server is removed. **Revised by ADR-068:** a TURN server is brought into
  a call only once direct paths fail, and none ships, because no public one is offered
  and works.
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
The project's instructions run the rotation as the first step of every push.

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

**Update.** ADR-073 found the window read stopping at each relay's own limit, and a first
catch-up downloading everything once per relay, and fixed both.

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

**Update.** Relays do serve wraps with no expiry for years (ADR-073). The horizon stays: a
wrap that asks to expire goes when it asks, and Textor's ask no longer exceeds it.

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

**Update (ADR-066).** The sides are no longer mirrored in Persian. What was sent is on
the right and what was received on the left in both languages, and only the words inside
a bubble read right to left.

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
  device of one's own keeps what this one deleted, as before. _(Done in ADR-073.)_

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

**Update (ADR-065).** Streets are now drawn from OpenStreetMap's tiles for someone who
turns them on, and only then: the content policy names that one host for images. The
drawn map stays the default and the fallback.

---

## ADR-065 — Streets from OpenStreetMap's tiles, for someone who turns them on

**Problem.** The map of ADR-064, drawn from positions alone, shows distance, direction,
accuracy and the path behind a share. It does not show streets, landmarks or cities,
which is what people find their way by. Telegram shows a real map.

**Options weighed.**

| Option                                    | Cost in the app                    | What the policy must allow    | Verdict                        |
| ----------------------------------------- | ---------------------------------- | ----------------------------- | ------------------------------ |
| Vector tiles and a renderer (MapLibre GL) | ~800 KB of script, a worker, WebGL | Workers, and fetches to tiles | Too heavy, and a second engine |
| OpenStreetMap's raster tiles, as images   | A few hundred lines, no dependency | One origin, in `img-src`      | Chosen                         |
| Tiles through a proxy we run              | —                                  | —                             | A server                       |
| A commercial tile provider                | An API key in a public page        | One origin                    | The key is public; they track  |
| Tiles packaged with the app               | Gigabytes                          | Nothing                       | Out of the question            |

**Decision — off until someone turns them on.**

- **A setting, `streetMaps`, off by default.** Its switch is in Settings → Privacy, and
  "What leaves your device" lists what turning it on sends.
- **The layers button on a map** turns streets off in one tap. To turn them on, it first
  says, in place under the map, what the tile servers will see, and asks.
- **A location's card follows the setting.** The person on the other end decides for their
  own device, and a sender cannot tell whether a reader's map fetched anything.

**Decision — what is fetched, and how.** The operator's tile policy is followed to the
letter.

- **The URL it gives,** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, over HTTPS.
- **Only what is on screen.** Images load lazily, at most 16 per map, and nothing is
  prefetched or kept for offline use, which the policy forbids.
- **The page's origin as referrer.** The page sends no referrer (`no-referrer`), and the
  policy may block browser traffic that strips it. So tiles alone carry
  `referrerpolicy="origin"`: the scheme and host of the deployment, never its path or
  fragment.
- **The browser's own cache,** which honours the server's caching headers. There is no
  service-worker cache for tiles: it would be one more store of places looked at.
- **Attribution on every map with streets,** "© OpenStreetMap" at the bottom right. The
  sheet and the picker link it to the licence; a card's map is itself a button, so its
  credit is words.

**Decision — drawing them.** The tiles are plain images under the SVG drawing. Each is
placed by projecting its own corners with the map's projection, so it lies exactly under
the markers. Over a map's few kilometres the local projection and Web Mercator agree to a
fraction of a pixel. The zoom draws tiles nearest their own size, so street names read as
lettered. In the dark theme they are inverted and their hues turned back. A tile that will
not load — offline, blocked — puts the drawn map back.

**Decision — the policy.** `img-src 'self' data: blob: https://tile.openstreetmap.org`;
`connect-src` is unchanged. `scripts/cspPolicy.mjs`, tested, fails the build on:

- any other remote source in any directive;
- any wildcard;
- the tile host anywhere but `img-src`.

A message cannot name a URL to load: tile addresses are computed from coordinates. A peer
can choose the coordinates, which tells OpenStreetMap — not the peer — which area the
reader looked at.

**What the tile servers learn,** as the app says before anything is fetched:

- the device's IP address;
- which squares of the map it looks at, which is often where a contact is or was;
- when;
- the browser, and the deployment's origin.

Not the conversation, a name, a key or a message. The OSMF's privacy policy says its tiles
are served through a CDN, and does not list what each tile request logs.

**Limits, said plainly.**

- _Fetched tiles stay in the browser's HTTP cache,_ outside the vault. Someone with the
  browser profile can see which areas were looked at. "Wipe this device" cannot clear that
  cache; the browser's own "clear site data" does.
- _A live share watched with streets on fetches new tiles as it moves._ The tile servers see
  the area followed, for as long as it is on screen.
- _The operator may change its policy or refuse heavy use._ The drawn map then returns, and
  moving to another tile operator is one constant and one line of policy.

**Verified.**

- `tests/tiles.test.ts`: the Mercator arithmetic against values computed independently,
  across the antimeridian and the poles, and the content-policy check.
- `tests/locationUi.test.ts`:
  - nothing is fetched while the setting is off;
  - tiles carry `referrerpolicy="origin"` and load lazily, with a credit;
  - a broken tile brings the drawn map back;
  - the consent appears in place, "Not now" changes nothing, and off is one tap;
  - the Settings switch works, and "What leaves your device" lists the tile servers.

Eight faults were planted, and each broke these tests:

- the full page address sent as referrer;
- tiles fetched before they are on screen;
- streets on by default;
- streets turned on without asking;
- the credit hidden;
- a broken tile leaving a blank map;
- any remote image let through the policy check;
- no cap on the tiles asked for.

In a browser, against the production build's policy, a tile loaded and an image from
another host and a `fetch` to the tile host were both refused.

**Cost.** The precache grew by 0.1 KiB: the policy string and the setting's default. The
tile layer, the consent and its words are in the lazy `location` chunk, and the switch's
words in the settings chunk.

---

## ADR-066 — A bubble's side is physical: sent on the right, received on the left, in Persian too · **found in use**

**Problem.** Switching to Persian moved every bubble to the other side: what you sent to
the left and what you received to the right. ADR-060 had chosen that on purpose — rows
aligned by logical edges, so the conversation mirrored with the language. People who read
Persian in Telegram and WhatsApp expect otherwise: sent on the right, received on the
left, whatever the language, with only the words reading right to left.

**Decision — the row is physical, what is in it is not.**

- **A row lays out left to right.** `.bubble-row` is `direction: ltr`, so its alignment
  puts sent bubbles on the right and received on the left. The check while selecting sits
  at its left too.
- **Everything in a row reads in the language's direction.** In Persian each of its
  children is `direction: rtl`:
  - the bubble, its text, quote, time and ticks;
  - a poll, a checklist, a call, a location;
  - a failure and its retry.
    Body text keeps `dir="auto"`, so an English line in a Persian conversation still reads
    left to right, full stop and all.
- **The bubble's shape is written in physical sides:**
  - the corners where a run's bubbles meet, and the squared corner under the tail: right
    for sent, left for received;
  - the tail points out of that side, with no flip for the language;
  - the controls beside a bubble sit in the gutter, left of a sent bubble and right of a
    received one.
- **Someone else typing** shows on the left, like their bubbles.
- **Reactions** stay inside their bubble, where its text starts, so they travel with it.
- **The rest of the screen still mirrors with the language:** the header, the composer,
  the list beside the conversation, and the way back to the newest message. Only the
  conversation's two sides are fixed.

**Verified.**

- `tests/chatLayout.test.ts` loads the real stylesheet. In English and in Persian, every
  row lays out left to right, sent bubbles align right, received align left, and each
  bubble reads in the language's direction. In Persian:
  - the squared tail corners are on the right for sent and the left for received;
  - the side controls are in the right gutters;
  - someone typing is on the left;
  - message text keeps `dir="auto"`.
- Against the previous stylesheet, the three Persian tests fail and the English one
  passes.
- In a browser at 1024 and 320 pixels, in both languages, bubble edges were measured
  against the column:
  - every received bubble was flush left and every sent one flush right;
  - tails and side controls were on their bubble's side;
  - selection checks were at the left;
  - nothing overflowed;
  - an English sentence in a Persian bubble kept its full stop at its end.

**Cost.** Stylesheet rules only. The precache is unchanged.

**Revisit if** people who read Persian ask for the mirrored conversation back: it would
be a setting, not a default.

---

## ADR-067 — The pool leans on the four relays that work, and replaces one only on evidence that it died · **found by measurement**

**Problem.** Re-running `npm run relays:probe` showed two of the six default relays
broken. `relay.damus.io` now answers a gift-wrap inbox query with
`auth-required: requested filter requires authentication`, so it can never deliver mail
to an anonymous client. `relay.0xchat.com` no longer resolves. The pool could not see
either for what it was:

- Every configured relay was connected at unlock and kept connected. A dead one was
  handshaken with eight times in quick succession every session, then every five minutes.
- A relay that refused the inbox stayed in the announced inbox list (kind 10050), so
  contacts kept writing there. It also took self-copies, and stayed marked degraded
  forever, even after its policy changed back, as `nos.lol`'s has.
- Every one-off read went to every read relay.
- Health was publish latency and success only: nothing on how fast a relay hands over
  the inbox, or how often it drops a connection.
- **And a bug:** relay health was saved through `upsertRelay` for every relay the pool
  had touched — a contact's inbox relays, a group's. Each time the app was hidden, each
  of those was added to this person's own list, read and write, and a relay they had
  removed came back.

The probe itself misled. Run against thirty-odd relays at once over a slow, proxied
link, every handshake after about the tenth failed, and read as a list of dead relays.

**Decision — a seed that works.** Re-probed one relay at a time, with the test wrap dated
two days back as NIP-59 dates real ones. Twenty of twenty-seven candidates pass. The
defaults keep the four that still work — primal, oxtr, offchain, purplerelay; all strfry,
three advertising NIP-77 — and add `nostr-pub.wellorder.net` (nostr-rs-relay, so one
software bug cannot take every relay at once) and `relay.nostr.wirednet.jp` (Japan). The
other passing relays are offered as suggestions. The probe now runs one relay at a time
by default (`PROBE_CONCURRENCY` raises it) and reports NIP-77 support and the largest
event a relay says it takes, against the 64 KiB an attachment chunk needs.

**Decision — telemetry, in the health record.**

- `eoseMs`: rolling time from asking for the inbox to the relay's EOSE. An EOSE also
  clears any earlier refusal.
- `drops` and `churn`: connections lost, and the recency-weighted share lost within two
  minutes of opening, which is what rate limiting looks like.
- `connectStreak`: failed connections in a row, counted only while another relay is
  reachable, so a device that is offline does not condemn every relay. Persisted.
- `readFailAt`: when the inbox was last refused. `readFail` now counts refusals since
  the last successful read, and only of the inbox; a group's subscription refused
  somewhere says nothing about mail.

**Decision — an active set.** `chooseRelays` picks up to four read relays and four write
relays to use. The rest stand by, unconnected.

- **Usable** means not down (two failed connections in a row), not refusing the inbox in
  the last six hours, and — for writing — not with an open publish circuit. A relay that
  refuses the inbox is no use for writing either: Textor never signs in, so mail left
  there for a Textor user is never collected.
- **Hysteresis.** A relay in use stays while it works. A free place goes to the best of
  the rest by score: reading by `eoseMs` where measured, writing by publish latency,
  either halved at most by churn. A slightly better score never displaces a working
  relay, which would only churn sockets. If nothing is usable, the best-scoring are tried
  anyway.
- **Follows it:** the inbox subscription (a relay brought in is subscribed at once and
  catches up from its own mark, so a failover loses nothing), one-off reads, the
  announced inbox list, self-copies, invites and profile frames, and the "n of m relays"
  count.
- **Down is set aside.** A relay that is down is not connected to. It is tried again
  once, 30 seconds after its last failure, doubling to an hour — and only while a place is
  empty. The streak is persisted, so a relay down last session costs no handshake at the
  start of this one.
- **Refusal is retried.** A relay that refused the inbox is asked again after six hours.
- **A write relay whose circuit opens** gives up its place. A relay dropped from use is
  disconnected unless a publish is still waiting on it.
- **Announced when it changes.** The engine looks over the set every minute and
  re-announces kind 10050 when the read relays in use have changed, at most every ten
  minutes, so contacts stop writing to a relay that went down.

**Decision — discovery, weighed against the constraints.**

| Paradigm                              | Verdict                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NIP-65 kind 10002 (outbox model)      | For public notes. NIP-17's kind 10050 is the inbox list, which Textor already publishes and reads.                                                                                                                                                                                                                                              |
| Contacts' inbox relays (10050 gossip) | **Used, first.** Already on the device; relays people actually read gift wraps on; sharing them means hot sockets. Added automatically only once two contacts use one, so a single contact cannot steer this inbox onto a relay they run. Blocked contacts, and strangers who wrote first, are not consulted.                                   |
| Textor's vetted list                  | **Used, second.** The defaults and the suggestions, re-probed for this decision.                                                                                                                                                                                                                                                                |
| NIP-66 monitors (kind 30166)          | **Nominations only, and only when asked.** Measured: 124–302 KiB per query, for 67–185 reports. Their `!auth` comes from NIP-11 and was wrong for damus. Their round-trip times are from the monitor's vantage point, not this device's. Anyone can publish them, so two monitors must agree, and every nominee is tested before it is offered. |
| NIP-11 over HTTPS                     | Rejected. `connect-src` would have to allow `https:` to any host, and `auth_required` is relay-wide where the refusals that matter are per filter.                                                                                                                                                                                              |
| A hosted directory or crawler         | Rejected: a server.                                                                                                                                                                                                                                                                                                                             |

**Every relay is judged by a test from this device.** `probeRelay` opens a socket made by
the pool, asks for a stranger's gift wraps, and publishes a gift wrap from one throwaway
key to another, expiring within the hour. It passes only if the relay connects, answers
the inbox query without demanding sign-in, and accepts the wrap. Tests run two at a time,
ten seconds each.

**Decision — repair, on evidence.** A configured relay is **dead** when it is down, has
failed at least six connections, and has not succeeded at anything for three days — or
never has, which a relay that was never once reached in six tries satisfies at once. It is
also dead when it has refused the inbox twice in a row within six hours. With "Replace relays that stop
working" on (the default), the engine checks for that every minute and loads the lazy
relay scout only when it finds one, at most every half hour. The scout:

- turns the dead relay off rather than deleting it, so the list still shows it and it can
  be turned back on;
- adds tested replacements from contacts' relays and Textor's list while fewer than four
  read relays would work — never more than the person chose to read from;
- never turns off the last relay when nothing working can be found;
- never adds back a relay the person removed;
- logs what it did, and Settings → Relays says so until dismissed.

**Decision — the settings screen.** Each relay is shown as in use, standing by, not
answering, refusing your inbox, unreliable or turned off, with connect, inbox and
acknowledgement times, delivered and failed counts, and drops. "Find relays" tests
contacts' relays and Textor's list from the device, and the monitors too if switched on,
showing the best first. About → What leaves your device says what testing reveals.

**Also fixed.**

- `saveRelayHealth` updates only relays already in the list.
- Reloading the list after an edit saves the pool's health first, rather than winding it
  back to whatever was last stored.

**Budget.** The relay settings' words moved from the main dictionaries into the settings
chunk, which paid for the shell's share. The scout is a lazy chunk of its own (4.3 kB),
and the settings screen imports it the way the engine does. It opens probe sockets through
the pool: importing the socket class itself split `giftwrap`, `time` and `log` out of the
shell into chunks of their own, which cost 0.8 KiB in import glue. The precache is
799.5 KiB of 800, 799.7 with the deployment's base path, and the bundle gate now fails if
discovery code reaches the shell.

**Verified.**

- In the browser, the real pool against an in-page relay network, in English and in
  Persian at 320 pixels:
  - six defaults, four held open, two standing by;
  - a relay refusing connections set aside within three tries and replaced, and still
    set aside after a reload and unlock;
  - a relay demanding AUTH for the inbox taken out of use, its own words shown;
  - after six failures, never once connected, turned off by the minute check;
  - "Test relays" ranking the passing candidates fastest first, the failing ones with the
    relay's reason, and adding one with its measured times;
  - nothing wider than the screen.
- `tests/relayScore.test.ts`: the policy as pure functions — streaks, trial times,
  usability, death, the choice of the set.
- `tests/relayPool.test.ts`, over the fake WebSocket network:
  - six relays, four held open;
  - failover the moment one goes down, with the inbox following;
  - nothing set aside when every relay fails at once;
  - a relay down last session not connected at start, then tried and brought back;
  - one trial per wait, the wait doubling;
  - a refused inbox out of use and asked again six hours later;
  - a failing write relay replaced, churn counted, reads only to relays in use, a
    demoted relay held until its publish settles.
- `tests/relayScout.test.ts`:
  - every way a test fails, by real relay wording;
  - candidates' order and exclusions;
  - NIP-66 aggregation;
  - every repair rule, including never the last relay and never more than chosen.
- `tests/relayTending.test.ts`: announcement on change and its spacing, the repair
  trigger and its spacing and switch, and the lazy scout loading.
- `tests/relaySettings.test.ts`: the screen, in both languages.
- The pool, its scoring and verdicts, the defaults and the scout are held to 100%.

**Cost.**

- A message a contact sends with a stale copy of the announced list, only to a relay
  standing by, waits until that relay is next in use. Senders also publish to their own
  relays, and the announcement follows every change.
- Each relay tested sees this device's address and holds one small unreadable event for
  up to an hour.
- Repair changes the stored list without asking, within the rules above; it can be turned
  off.

**Revisit if** more relays come to demand NIP-42 for gift-wrap reads, which would make
signing in to read one's own inbox worth its metadata cost; or if NIP-66 gains
attestations from monitors a person can choose to trust.

**Update.** The announced list now belongs to every device of an identity, and each reads
it before changing it (ADR-073). Relays standing by are looked in on once a day.

---

## ADR-068 — A call goes direct first and brings TURN in only once that fails; no public TURN ships, because none is offered and works · **found by measurement**

**Problem.** Calls fail behind symmetric NAT, carrier-grade NAT and strict firewalls when
neither side's direct candidates can meet, and only a TURN relay gets them through. Textor
runs none (ADR-008), and ADR-046 left TURN to the user. The request was for a curated pool
of free public TURN and STUN servers as a guaranteed fallback, with adaptive selection,
health tracking and disclosure.

Before anything was built, the candidates were measured on 30 October 2026, two ways. One
was an unauthenticated TURN Allocate over UDP, TCP and TLS, which any live TURN server
answers with 401 and its realm (`npm run turn:probe`). The other was a real browser
gathering candidates with each server and the credentials it publishes.

| Candidate                                                                                                     | Found                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Relay, shared password (`openrelay.metered.ca`)                                                          | Resolves to 192.0.2.1, documentation space that is never routed. Switched off.                                                                                                              |
| Open Relay, published shared secret (`staticauth.openrelay.metered.ca`)                                       | No TURN answer on 80, 443, 3478 or 5349 over UDP, TCP or TLS; the browser gathered no relay with credentials made from the secret.                                                          |
| freestun.net (`free`/`free`)                                                                                  | Now behind a web proxy that answers HTTP and nothing else.                                                                                                                                  |
| rstream's generator                                                                                           | One-hour credentials from a web page, offered for evaluation. Not for an app, and `connect-src` would have to allow its origin.                                                             |
| Metered, Cloudflare, Turnix and ExpressTURN free tiers                                                        | Alive — Metered's `global.relay.metered.ca` answers 401 over UDP, TCP and TLS 443 — but each is an account. Its password or API key would be published in a static app for anyone to spend. |
| Another app's servers (VDO.Ninja asks people to set up their own), or open coturn instances found by scanning | Not offered to anyone. Using one takes a server its owner did not offer, and hands both people's addresses to an operator nobody chose.                                                     |

**Decision — no public TURN ships.** A list of dead servers would add failed allocations
to every hard call and fix none. An unsanctioned server would take what was not offered.
Settings → Calls says plainly that Textor includes no TURN server, and why. It also says
what works instead: one's own coturn, or the username and password from a free account
with a TURN provider. (**Revised by ADR-072:** Settings no longer suggests an account.)
`npm run turn:probe` re-runs the check, so the question can be asked again with evidence.

**Decision — direct first, TURN on failure.** A call starts on STUN alone. Every TURN
server, the user's own included, is held back:

- **The caller restarts ICE with TURN added** if the call has not connected within four
  seconds of the answer arriving, or at once if ICE reports `failed`. The wait shortens to
  one second when the candidates already rule out a direct path across the internet: a
  side that learned no public address, or this side behind symmetric NAT.
- **The callee adds its own TURN servers** when that restart offer reaches it, so either
  side's server can carry the call. The caller restarts even with no server of its own,
  since the callee may have one.
- **Only the caller restarts before the call connects.** The callee made the answer, so
  once the caller holds it, both sides hold both descriptions, and the restart offer
  cannot overtake the answer that opened the call. That overtaking is the reason
  renegotiation otherwise waits until the call is up (ADR-046).
- **A restart in mid-call brings TURN in too,** after a network change, say. It makes a
  relay available, not obligatory: ICE still prefers a direct pair that works.
- **"Always relay calls" is unchanged.** TURN is used from the start with
  `iceTransportPolicy: "relay"`. The call is refused when no TURN server can be used,
  which now includes one whose password could not be made.
- **The direct message channel uses STUN only.** It is an accelerator (ADR-008). A TURN
  server would otherwise learn of every session two contacts open just by both being
  online.

The browser applies new servers at the next gathering, which the restart starts
(`setConfiguration`, then an ICE restart). A browser that refuses to change servers in
mid-call still restarts, on the direct paths it had.

**Decision — learnt, not probed.** Nothing is probed on the way to a call, so selection
adds nothing to how long one takes to connect. Each TURN server's health is kept in the
vault's own state (`turn-health`), never in a backup:

- relays produced and requests failed, and failures in a row;
- the rolling time to a relay, and the round trip and bandwidth through it measured ten
  seconds into a relayed call, once the browser's estimates have settled;
- the last error: 401 for wrong credentials, 486 or 508 for a server that is full, 0 for
  no answer.

It is learnt from:

- each relay candidate, attributed to its server by the URL the browser reports;
- each ICE error, from 401 to the browser's own 701;
- silence, once a server has had ten seconds to answer;
- the Settings test.

A call brings in its TURN servers best first: reliability, smoothed and squared, times
speed, halved for a relay too narrow for video. The order matters because browsers prefer
relays in the order their servers are listed. A server that fails twice in a row rests
for ten minutes, doubling to a day, unless every server is resting, since a call that
cannot go direct has nothing else to try.

**Decision — shared secrets.** A TURN server can now be added with its shared secret in
place of a password: coturn's `use-auth-secret`, as set up for Nextcloud Talk or Matrix.
For each call the device makes a username that is an expiry time a day ahead, and a
password that is an HMAC-SHA1 of it under the secret, using WebCrypto. The server checks
both without asking anyone, and the secret never leaves the device. The password works
for any call and for nothing a day later.

**Decision — Settings and the call screen.** Each TURN server shows how it has been doing:
its relay time and round trip, or why it last failed and whether it is resting. A list
whose every TURN address is UDP gets a note that a network blocking UDP blocks those
too. The test records what each server did. While a call tries again through a relay,
the call screen says so.

**Content-Security-Policy.** Unchanged, and checked. In the production build, under
`connect-src 'self' wss: blob:`, the browser gathered public addresses from both STUN
operators with no policy violation: ICE traffic is not fetched, and `connect-src` does not
govern it. Nothing else here crosses the network. Passwords from shared secrets are made
on the device, and no credential service is called — which is also why provider APIs that
mint credentials over HTTPS are not supported: each would need its origin allowed for
everyone.

**Also fixed.** A call that connected while its answer was still being applied had the
connect timeout armed after it connected, and was failed 25 seconds into a working call.
Browsers run checks as soon as they hold a description, so this was a real race. The
timeout, and now the TURN escalation, are armed only for a call not yet connected.

**Budget.** TURN selection is a lazy chunk of its own (2.3 kB). The call chunk first
imported it statically and Settings with `import()`; the bundler hoisted it into a shared
chunk the shell precached, 802.3 KiB. The bundle gate caught it with a new lazy-only
marker. Now both load it with `import()`: the call chunk only when a TURN server is
configured, and a call goes ahead without TURN should the chunk be gone after a
deployment. Importing the byte helpers into it regrouped the shell's shared chunks for
another 158 bytes, so its Base64 is written by hand. The messenger's call configuration
moved into the call chunk. The precache is 799.4 KiB, 799.7 with the deployment's base
path — 59 bytes smaller than before.

**Verified.**

- In the browser:
  - against the real networks above, and under the production CSP;
  - Settings → Calls in English and in Persian at 320 pixels: a password server and a
    shared-secret one added, the UDP-only note shown and then gone, the test making a
    password from the secret on the device, and each server shown as not answering;
  - About → What leaves your device, with the TURN section;
  - from this network the test reported likely symmetric NAT — each STUN operator was
    shown a different port — which is the case TURN exists for.
- `tests/turn.test.ts`: recognising a server however it is written; recording, resting
  and ranking; judging silence; passwords from a secret checked against Node's HMAC; a
  server whose password cannot be made left out.
- `tests/callSession.test.ts`: TURN held back, then added on the caller's early restart
  and on the callee's receipt of one, and not for a mere renegotiation; a browser that
  cannot change servers; which server gave a relay and why the others did not, wherever
  the browser reports it; the relay's round trip and bandwidth.
- `tests/calls.test.ts`, two call managers over the fake network:
  - a direct call that never touches TURN;
  - the caller's TURN and the callee's each rescuing a call;
  - hanging checks timed by what the candidates say;
  - a server never asked not blamed;
  - a failing server rested and the others offered first;
  - silence judged only after ten seconds;
  - TURN selection failing to load;
  - the connect-timeout race;
  - every other path through the call manager.
- `tests/callSettings.test.ts`: the page in both languages, adding by secret, each
  server's status, and the test keeping what it found.
- Everything under `src/core/calls` is held to 100%.

**Cost.**

- A call that needs TURN connects about four seconds later — one on a network that rules
  direct paths out — than if TURN had been there from the start.
- A TURN server still sees both people's addresses, and when and for how long they talk,
  for the calls that needed it. Before, it saw every call.
- A failing call costs one more offer and answer.
- Without a TURN server of one's own, a call between two hard networks still fails, and
  says why.

**Revisit if** an operator offers TURN for any app's use without an account — it would
then ship as a fallback through this same path, behind a setting and in About; if the CSP
`webrtc` directive ships in browsers; or if NIP-AC defines a TURN credential exchange
between peers.

---

## ADR-069 — When no path connects a call: IPv6 is let work, TCP and contacts are not made relays, and voice falls back to push-to-talk over the relays · **found by measurement**

**Problem.** Two people behind symmetric NAT, carrier-grade NAT or strict firewalls, with
no TURN server of their own, cannot connect a call (ADR-068), and no public TURN server
can be relied on. The question was what gets voice through with no infrastructure at
all, inside a browser, which cannot touch sockets or guess ports.

**Four mechanisms, weighed.**

| Mechanism                   | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPv6 end to end             | **Already works, and Textor now stops undermining it.** Browsers gather IPv6 host candidates and, once the microphone is allowed — as it is for every call — offer the real address rather than an mDNS name. No NAT translates a global IPv6 address, and ICE's checks from both sides open stateful firewalls as they open NAT bindings. Nothing selects an address family, and nothing needs to: IPv6 host pairs already rank first.                                                  |
| ICE over TCP (RFC 6544)     | **Not built.** Measured, Chromium gathered no TCP candidates at all — a host and two server-reflexive UDP ones. Between two NATs, a passive TCP candidate is a socket listening on a private address; browsers do not do TCP simultaneous open, and STUN gives no TCP mapping. TCP only helps when one side is reachable directly, which is the IPv6 case.                                                                                                                               |
| A contact relaying for both | **Not built.** DTLS-SRTP ends at each hop, and browsers cannot pass one connection's encoded frames on to another, so a relaying contact would hear the call unless frames were sealed again end to end and forwarded as data. That much is possible; the rest is not, within Textor's rules: it needs a third person online at that moment, which only presence beacons could tell (ADR-009), their consent and bandwidth, and it shows them both addresses and who is talking to whom. |
| Voice over the Nostr relays | **Built, as push-to-talk.** The relays that carried the call's signalling reach both devices by definition. Measured below.                                                                                                                                                                                                                                                                                                                                                              |

**Decision — let IPv6 work.** Textor counted only a STUN answer as a public address, so a
device reachable on IPv6 alone — IPv6-only mobile networks, where STUN over IPv4 finds
nothing — read as blocked. The call then rushed to TURN after a second, and its failure
was blamed on "a network that blocks the traffic calls use". Now:

- a host or reflexive candidate in global IPv6 space (2000::/3, not documentation) counts
  as a public address, a relay's address never does, and an mDNS name is never mistaken
  for one;
- when both sides have one, direct paths get their full four seconds, however the IPv4
  NATs look;
- the diagnosis no longer calls such a network blocked;
- the Settings test says whether this network has IPv6. Without microphone permission the
  browser hides its own addresses, but a STUN server reached over IPv6 reports the address
  back, so the test can still see it.

This machine has no IPv6, so this is verified against the fake network only.

**Measured — relays carrying a stream.** On 31 October, from a throwaway key, 25 ephemeral
events of a sealed packet's size at its pace (one per 400 ms), received on a second
connection (`npm run voice:probe`):

| Default relay             | Result                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `relay.primal.net`        | 25/25; 0.3–0.5 s publish to delivery, at times spikes near 3 s          |
| `nostr-pub.wellorder.net` | 25/25; 0.28–0.35 s                                                      |
| `purplerelay.com`         | 25/25; 0.5–0.9 s                                                        |
| `nostr.oxtr.dev`          | 15, then `rate limited` — at one event a second too                     |
| `offchain.pub`            | 15, then `not in our web of trust`; afterwards none                     |
| `relay.nostr.wirednet.jp` | none: `Blocked event by ephemeral kind range` — NIP-59's kind 21059 too |

Then the real session code over primal and wellorder in the browser, through the app's own
relay pool: eight packets of twenty frames, all played, in order, about 290 ms after
publishing. In Chromium, Opus at 12 kbit/s constant bitrate made every 20 ms frame exactly
30 bytes, silence and tone alike, and each decoded back to 960 samples.

**Decision — relay voice.** (**Revised by ADR-070:** it now also starts from the header
as a walkie-talkie, negotiates where each side is heard, and sends each 800 ms packet to
one relay within a budget per relay. **Revised by ADR-071:** it starts only from the
header, and is no longer offered when a call fails.)

- **Offered** on the screen that says a call failed with every path tried, or was lost for
  good after connecting. That screen then stays until it is closed. Not after a
  mismatched fingerprint, and not for a call that failed before trying a path.
- **No new signalling.** Both sides derive the same keys from what only they hold: the
  call's id — the hash of the sealed offer — and both descriptions' DTLS fingerprints,
  which crossed no wire unsealed, since nothing connected. HKDF-SHA256 makes one
  XChaCha20-Poly1305 key and a publishing key for each side. Relays see two throwaway
  keys, never either person's.
- **Both sides listen from the moment the call fails,** on their own read relays, so the
  screen can say when the other person joins. Joining opens the microphone and a decoder;
  a hello every five seconds says this side is there.
- **Push-to-talk.** Frames go out only while the button is held — by pointer, or Space or
  Enter — in packets of twenty (400 ms), padded to one size, as an ephemeral event of
  Textor's own kind, 21690. Relays forward it and keep nothing. This side's speaker is
  silenced while it talks, so it does not feed the other side's own voice back.
- **To the relays the other person reads** — their announced inbox, where a message to
  them goes — at most three at a time. A relay that refuses one packet carries none for
  the rest of the session, and the next one on the list takes its place. When none is
  left, the screen says the relays refused.
- **Played as it comes.** The first copy of each packet is played; a packet overtaken by a
  later one is dropped as too late. After a pause, playback starts 300 ms ahead of now, to
  leave room for late arrivals. A session ends on its own after half an hour.
- **WebCodecs for Opus,** since Opus in JavaScript would mean WebAssembly, which the
  content policy forbids. **A ScriptProcessorNode for samples,** since an AudioWorklet
  needs a module file of its own — one more asset to keep out of the precache. Where the
  browser has no Opus in WebCodecs (Safari before 26), the screen says so.

**Why not a call over relays.** It would be about a second from mouth to ear, which makes
two people talk over each other. A duplex stream doubles the load on relays that are
shared, and three of the six defaults would throttle or refuse it. Holding a button makes
the delay part of how it is used, and sends nothing in the silences.

**Budget.** Everything is in the call chunk: 41.9 to 53.5 kB (14.4 to 18.4 kB compressed),
fetched only for calls. The shell grew by 4 bytes of import map. The precache is 799.4 KiB,
799.7 with the deployment's base path. A new lazy-only marker fails the build should relay
voice reach the shell.

**Verified.**

- In the browser:
  - WebCodecs' Opus at the rate used;
  - the session over real relays through the real pool;
  - the call screen's offer, waiting, talking and listening states, in English and in
    Persian at 320 pixels, with the button answering pointer and keyboard and ignoring key
    repeat.
- `tests/relayVoice.test.ts`:
  - keys made the same on both sides, and different for any other call;
  - packets sealed, padded to one size, and refused when malformed in every way;
  - a session over fake relays that duplicate and refuse;
  - playback once, in order, with late and foreign packets dropped;
  - presence, rejoining, a microphone that will not open, joining abandoned, the
    half-hour limit, and every no-op.
- `tests/voiceAudio.test.ts`: samples cut into frames for the encoder, the context that
  will not run at 48 kHz, scheduling back to back and after a pause, muting, closing.
- `tests/calls.test.ts`:
  - a call over IPv6 between two symmetric NATs, needing no TURN;
  - relay voice offered after every path failed, and carrying voice both ways;
  - a lost call keeping its screen;
  - nothing offered after a mismatch or a failure with nothing to diagnose;
  - relays that cannot be looked up;
  - a screen closed during the lookup;
  - voice closed when the vault locks or another call begins.
- `tests/callProtocol.test.ts`: IPv6 in the diagnosis and the Settings test.
- Everything under `src/core/calls` is held to 100%.

**Cost.**

- Relays see each side's IP address, when each talks, and which address is listening.
  Packet sizes say nothing; timing says when someone speaks.
- About a second from mouth to ear, at 12 kbit/s.
- Load on shared relays while someone talks: two and a half events a second, to two or
  three relays.
- A session is not written into the conversation; the failed call is.

**Also.** Advisories published the same night against `glob` (≤ 14.0.1) and `minimatch`
(< 11.0.1) failed the dependency gate. Both are build tools — reached through eslint and
the service worker's builder, never shipped — and neither dependent has widened its range
yet, so `overrides` pins the fixed releases. The build's precache came out byte for byte
the same, and eslint still lints all 256 files.

**Revisit if** browsers can forward encoded frames between connections — a contact could
then relay sealed frames without presence beacons being the only way to find one; if
relays publish limits for ephemeral kinds; or once IPv6 can be checked on a real network
from here.

---

## ADR-070 — The walkie-talkie is a call of its own, from the header; relay voice negotiates where it is heard, and spends each relay's share sparingly · **found in real use**

**Problem.** Tested across a border, relay voice (ADR-069) worked one way only, or said
the relays refused. It was also reachable only from the screen of a failed call, and the
header said nothing about which way of calling could work.

**Why, once measured.**

- **Each side sent to the first three relays of the other's announced inbox.** For an
  install on the defaults, those can be three that refuse a throwaway key's stream:
  `nostr.oxtr.dev` throttles after 15 events, `offchain.pub` refuses keys outside its web
  of trust, and `relay.nostr.wirednet.jp` blocks every ephemeral kind. The other
  direction can land on `relay.primal.net`, which carries it — one way only.
- **Each side listened only on its own read relays in use.** A packet sent to a relay in
  the other's announced list, but not in its active set, reached nobody.
- **Load had not been measured long enough.** Measured on 31 October:

| Test                                              | Result                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25 expiring kind-1059 events from a throwaway key | `wirednet` 25/25 — it blocks ephemeral kinds, not this one. `primal` 25/25. `oxtr` 15, then `rate limited`; `offchain` 15, then its web of trust.           |
| Two minutes at 2.5 events a second                | `primal` 300/300, but delay grew to 2.1 s at p90 and 5.6 s at worst. `purplerelay` 300/300, at 6.3 s and 17.7 s. `wellorder` 60, then `spam not permitted`. |
| Then, from a fresh key, at one a second           | `wellorder` refused everything from this device's address — an ordinary gift-wrap kind too. The block was by address.                                       |

A long press could thus get a user's address blocked on a relay that carries their mail.

**Decision — two-way, by negotiation.**

- **Meeting relays.** Both sides always listen on `primal`, `wellorder` and
  `purplerelay`, measured to carry voice from a throwaway key, besides their own read
  relays. There is always somewhere they meet.
- **Hellos say what works.** Each one lists where its sender listens, which relays have
  delivered the other side's packets to it, and the last packet it heard. Each side sends
  to relays proven to deliver, then to where the other listens, then the meeting relays,
  then the other's inbox.
- **A side not heard from says hello back at once,** so neither waits for the next.
- **The gift-wrap kind where ephemeral kinds are blocked.** A relay that refuses the
  ephemeral kind gets the same packet as kind 1059, `p`-tagged to the other side's
  throwaway key and expiring in 60 seconds (NIP-40), which inbox relays take from anyone.
  It is read by `#p` as an inbox is.
- **A refusal for any other reason ends that relay's part,** and the audio it lost goes
  once more another way.

**Decision — spend each relay's share sparingly.**

- No relay gets more than ten events at once from this side, or more than one every four
  seconds after that — fifteen a minute, oxtr's own limit and a small part of what
  wellorder tolerated.
- A packet carries 800 ms of audio (forty frames, padded to 1,280 bytes) and goes to one
  relay, in turn around those that work (**revised by ADR-072:** best first). It goes to
  two only while the other side has not acknowledged anything for four seconds.
- A press transmits for at most 30 seconds, as a radio's time-out timer does.
- When every share is spent, the screen says to let go a moment. It also says whether
  the other side hears this one, has not yet, or cannot be reached by any relay.
- Single copies come by relays with different delays, so playback reorders. The first
  packet of a press is marked, and nothing before it is waited for; a gap is waited out
  for 800 ms (**revised by ADR-072:** five seconds), then passed over.

**Decision — the walkie-talkie is a call** (`media: "radio"`).

- **From the header,** beside voice and video.
- **The offer and answer** carry, where a call's carry SDP, a description of their own: a
  random nonce and the relays this side listens on. The keys are made from the call's id
  and both nonces.
- **The callee answers once its microphone has opened,** so a microphone that will not
  start is a call that could not be set up, not one hung up.
- **Everything else is a call's:** ringing, busy, declining, two pressing at once, the
  record in both conversations, the vault held open and the screen kept on. There is no
  peer connection, no STUN and no TURN, so neither person learns the other's address.
- **A browser without WebCodecs' Opus** gets a screen that says so.

**Decision — the header says what can work.** All three buttons are there whenever the
contact can be called at all. One that cannot work here and now is shown faded, and
explains itself in its tooltip and when pressed: offline, no relay connected, no WebRTC,
no WebCodecs. Nothing is guessed from the network. Whether a direct path would work
cannot be known without asking STUN servers each time a conversation opens, which would
tell them of every conversation opened. Calls are therefore never faded on a guess. On the narrowest phones the header's spacing
tightens so the name still shows.

**Evaluated, not built.**

- **Full-duplex streaming over relays** — measured above. It queues for seconds, and it
  gets the address blocked.
- **Hands-free** (an open microphone with voice detection) costs as much as talking
  continuously. Played through Web Audio, the other side's voice would also come back
  through the microphone.
- **Port prediction.** Two STUN servers saw ports 54651 and 61756 from this network: random
  allocation, nothing to predict. Carrier-grade NATs randomise ports on purpose.
- **More STUN operators** — each one more company seeing every call, for nothing the two
  in use do not already show.

**Budget.** The Privacy page's sixteen strings moved from the main dictionaries into the
settings chunk, which saved 2.6 KiB. The header's button, the walkie-talkie's records, its
icon and its styles cost 0.4 KiB. The precache is 797.3 KiB, 797.6 with the deployment's
base path. Relay voice and the walkie-talkie's screens live in the call chunk.

**Also fixed.**

- Packet numbers started from the clock in tenths of a second, and so did not fit the
  32 bits they travel in. An acknowledgement could never match what was sent; they now
  start at zero.
- "Heard" read true before anything had been acknowledged.
- The first packet of a press was lost whenever another overtook it.

**Verified.**

- In the browser:
  - the header in English and in Persian at 320, 360 and 390 pixels — nothing wider than
    the screen, and the name shown;
  - faded buttons with their reasons;
  - a walkie-talkie ringing, and talking, in both languages.
- `tests/relayVoice.test.ts`, over fake relays that are separate servers:
  - meeting on the meeting relays, wherever each side reads;
  - voice both ways, with acknowledgement;
  - one copy each, shared around;
  - the gift-wrap kind past a relay that blocks ephemeral kinds;
  - a refusing relay dropped and its audio resent;
  - relays this side cannot reach;
  - every share spent, then refilled;
  - the 30-second limit, and sending twice while unheard;
  - reordering, and a press's first packet coming late.
- `tests/calls.test.ts`: walkie-talkies ringing and talking with no peer connection
  between two networks no call gets through; unsupported on either side; a microphone
  that will not start; descriptions that cannot be read; hanging up at each stage; both
  pressing at once.
- `tests/chatHeader.test.ts`: the header in every state.
- Everything under `src/core/calls` is held to 100%.

**Cost.**

- About a second and a half from mouth to ear.
- A packet a relay takes and then drops is 800 ms of silence. One it refuses is resent.
- With few relays carrying, talking for long is capped by their shares.
- The meeting relays see both sides' addresses, as any relay does.
- During this measurement, `wellorder` blocked this device's address.

**Revisit if** relays come to publish limits for ephemeral events (NIP-11 has room for
them), or a relay offers to carry voice.

---

## ADR-071 — The walkie-talkie is separate from calls · **found in real use**

**Problem.** A failed call turned into a walkie-talkie offer, on the same screen, which
mixed two separate things.

**Decision.** A voice or video call that fails or drops shows its own ending and nothing
else. No session is made, nothing listens on the relays, and nothing is offered to press.
The walkie-talkie starts only from its button in the conversation's header, so a
walkie-talkie's record in the conversation has no call-back button either. Its keys now
come only from its own nonces, so the code that derived them from a failed call's
fingerprints and looked up the contact's relays is gone. A lost call is an ordinary
ending that closes by itself, as it was before ADR-069.

A failure's text may say the walkie-talkie is there (ADR-072). It starts nothing.

**Also built here, and withdrawn.** This ADR first let a deployment ship a TURN account,
with the workflow passing it to the build. ADR-072 removed that.

**Tested and not done: waiting after `failed`.** A relay candidate can arrive after ICE
has reported `failed`, and ending the call at that moment looked like a bug. In Chromium,
with candidates shown to connect in 4 ms, adding them after `failed` moved the state back
to `checking`, and it never connected: 12 seconds later it was still checking. Waiting
longer would only delay the failure screen, so `failed` after a restart still ends the
call at once.

**Verified.**

- **Real Chromium through a real TURN server,** written for the test, since no server had
  run this path before: direct paths blocked, `setConfiguration` and an ICE restart gathered
  relay candidates, reported by server address as the learning needs, and the connection was
  up about half a second later with data crossing, over UDP and over TCP. The server's log
  shows the allocations. This is the path someone's own TURN server takes (ADR-068). TLS
  was not run.
- `tests/calls.test.ts`: no walkie-talkie after a failed call, a lost one, a video call, or
  a mismatched fingerprint, and nothing to hold down outside one.
- `tests/callEnding.test.ts`: every ending on screen, and the walkie-talkie's own panel.
- `tests/chatHeader.test.ts`: no call-back from a walkie-talkie's record.
- Everything under `src/core/calls` is held to 100%.

---

## ADR-072 — Calls need no setup and no account; what two networks cannot carry directly, the walkie-talkie does · **a boundary, accepted after measuring**

**Decision.** Textor is turnkey for anyone who opens it. Nobody who uses it or deploys it
creates an account anywhere, or sets a variable or a secret.

- **Voice and video calls** go directly between devices, on public STUN. Textor ships no
  relay.
- **The walkie-talkie** is what remains for two networks that cannot meet, over the public
  Nostr relays that already carry the messages.
- **A TURN server stays an option in Settings → Calls,** for someone who already runs one.
  Nothing asks for it. A failure no longer offers to set one up: only a server someone
  added and that did not answer gets a button, to go and check it.

**Why not ship an account (withdrawing part of ADR-071).** It needs someone to open and
watch an account. Its password is public, so anyone can spend the allowance, and a free
allowance does not scale to a public app. When it runs out, calls fail for everyone at
once. It also hands every hard call's two addresses to an operator nobody using the app
chose. The same reasons rule out asking deployers to add one.

**Why no other relay.** Everything found that a browser could reach, measured or read on
31 October and 1 November 2026:

| Candidate                                                                                                          | Found                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freeturn.net`, `turn.anyfirewall.com`, `turn01.hubl.in`, `numb.viagenie.ca`, `freestun.tel`, PeerJS's two servers | The names no longer resolve.                                                                                                                                                                                        |
| `openrelay.metered.ca`                                                                                             | Resolves to 192.0.2.1, documentation space.                                                                                                                                                                         |
| `staticauth.openrelay.metered.ca`                                                                                  | Resolves, and answers nothing on any port.                                                                                                                                                                          |
| `freestun.net`, `relay.backups.cz`, `turn.bistri.com`                                                              | No TURN service.                                                                                                                                                                                                    |
| rstream's generator                                                                                                | Its page says it is for development and interoperability checks, and points production apps to authenticated endpoints.                                                                                             |
| Metered, ExpressTURN, Cloudflare                                                                                   | Alive, and each is an account. Cloudflare's credentials also need a token kept on a server.                                                                                                                         |
| A speed test's or another app's credentials                                                                        | Not offered to anyone else, so not used (ADR-068).                                                                                                                                                                  |
| `test.mosquitto.org`, an MQTT broker over WebSocket                                                                | The one service found that offers itself to any application with no account. Its page also asks not to rely on it, and says WebSockets are among the likeliest parts to be down. TLS to port 8081 failed from here. |
| `broker.hivemq.com`, `broker.emqx.io`                                                                              | Public test brokers, not for production. From here both names resolve to 0.0.0.0, which is what filtering looks like.                                                                                               |
| iroh's public relays, a WebSocket relay on 443                                                                     | TLS is refused from here, in Node and in curl. Their docs ask not to rely on them for production, and limits are unpublished.                                                                                       |
| Piping servers (a stream over HTTP)                                                                                | Would need their origin in `connect-src` for everyone, and upload streaming that only some browsers have.                                                                                                           |
| WebTransport                                                                                                       | Needs a server to connect to. It is not peer to peer.                                                                                                                                                               |
| Direct Sockets                                                                                                     | Chrome's own docs give it to Isolated Web Apps only. A page on GitHub Pages cannot use it, and no other browser is in sight.                                                                                        |
| The Nostr relays, full duplex                                                                                      | Queued for seconds, and one blocked this device's address after 60 events (ADR-070).                                                                                                                                |
| A contact relaying for both                                                                                        | Needs a third person online and shows them both addresses (ADR-069).                                                                                                                                                |
| Port prediction                                                                                                    | This network allocates at random (ADR-070). Guessing across the port range is a port scan, at a rate of about 20 ports a second.                                                                                    |

The WebSocket relays also could not carry a call as WebRTC. They would mean replacing it
with WebCodecs for audio and video, a jitter buffer and congestion control of our own, on a
free service asked not to be relied on, and which the networks that need it may block, as
this one does. That is the fragile thing this decision refuses.

**What a direct call can and cannot do.** A browser opens no sockets of its own and has
no TCP candidates (ADR-069), so a direct call is UDP hole punching and nothing else. Two
networks meet or not by their NATs' mapping and filtering (RFC 4787):

| One side                              | The other side                                                  | A direct call                                             |
| ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Public address, or one mapping (cone) | One mapping (cone), however it filters                          | Connects                                                  |
| Symmetric NAT                         | Public address, or a cone that filters by address or not at all | Connects: the first check opens the way back              |
| Symmetric NAT                         | A cone that filters by address and port, the commonest kind     | **Cannot:** neither learns the port the other must answer |
| Symmetric NAT                         | Symmetric NAT                                                   | **Cannot**                                                |
| Global IPv6                           | Global IPv6                                                     | Connects, unless a firewall drops the traffic             |
| Global IPv6                           | IPv4 only                                                       | IPv6 does not help; the rows above decide                 |
| UDP blocked                           | Anything                                                        | **Cannot**                                                |

So one side being open is not always enough, and IPv6 helps only when both have it.

**What the walkie-talkie is, and is not.** It needs no server of Textor's, no account and
no setup, and reaches anyone whose messages arrive, because it uses the same public relays.
Those are other people's servers, shared and free: it works within what they tolerate,
which is why it holds to fifteen events a minute per relay and thirty seconds a press. It
is voice only, one way at a time, a little over a second from mouth to ear, and several
seconds during a relay's delay spike.

**Found by running it over the real relays.** The walkie-talkie is now the only path for
these networks, and until now only fake relays had run this version. Two sessions, with
separate connections and the real negotiation, over the real public relays, with one
reading `relay.primal.net` and the other `relay.nostr.wirednet.jp`, as each press was
fixed:

| After                                                  | First side to second | Second side to first |
| ------------------------------------------------------ | -------------------- | -------------------- |
| Nothing changed, 8-second presses                      | 280 of 400 frames    | 360 of 400           |
| Budget, acknowledgements, slow relays, 2.5-second wait | 480 of 600           | 600 of 600           |
| Proven relays first, gift-wrap relays last             | 600 of 600, twice    | 440 of 600           |
| A five-second wait                                     | 600 of 600           | 600 of 600           |

A trace of every packet showed relays had delivered them all, late or on time. The code
threw them away, and the fakes, which never delay anything, could not show it:

- **Every packet was charged to every relay.** `filter` ran the budget check on the whole
  ring and kept the first, so a press ran out after a few seconds, and the hellos carrying
  acknowledgements were dropped with it. Now only the relay used pays.
- **A press counted as unheard after four seconds and doubled.** The newest packet is always
  ahead of the last acknowledgement. Now any acknowledgement that moves forward counts as
  being heard.
- **Late packets were passed over.** The wait was 800 ms, and relays were measured at 4.1 s
  and 4.4 s during delay spikes while another stayed on time. It is now five seconds. Most
  of the time nothing waits at all. When a packet is truly lost, that is a pause of five
  seconds, which is better than losing speech on something used one way at a time.
- **A slow relay got a full share.** A relay that needs the gift-wrap kind stores before it
  forwards, and took over five seconds at worst. Those now come last, as do relays over a
  second to accept. Relays the other side has confirmed come first, because a relay accepting
  a packet does not mean it reached them.

The last run: 2.3 seconds to find each other, a median of 0.8 to 1 second from speaking to
playing plus 0.3 of playout, the status right throughout, and no throttling. This ran on one
machine and one network with made-up frames, not across a border and not from a microphone.

**On a failed call.** The text says why, that Textor has no server to relay through, and
that the walkie-talkie in the conversation's header still works. It offers nothing to press
but Close, and starts nothing (ADR-071).

**Removed.** The build's `TEXTOR_TURN_SERVERS`, its parser, the workflow's use of it, the
switch in Settings and its text in About, and the 30-second clock for a restart, whose
only reason was a relay everyone would have. A call no path can carry says so about six
seconds sooner again.

**Budget.** The precache is 797.4 KiB, 797.6 with the deployment's base path.

**Verified.**

- `npm run turn:probe` and a short check of the public brokers from this network, with the
  results above. The broker check would have sent forty 200-byte messages; none connected.
- `tests/callEnding.test.ts`: each failure in both languages says why and points to the
  walkie-talkie, with nothing to set up and only Close to press; a TURN server someone added
  gets a button to go and check it.
- `tests/callSettings.test.ts`: the page says calls need no setup, and never to get an
  account.
- The walkie-talkie between two sessions over the real public relays, in the browser: the
  table above.
- `tests/relayVoice.test.ts`, for what those runs found: a relay charged only for what it
  carries; a whole press at speaking pace going once each and all of it; a hello behind the
  newest packet taken as heard; acknowledgements stopping halfway; a packet 4.1 seconds late
  played in order; a slow relay left until last and forgiven; a gift-wrap relay left until
  last; relays the other side confirmed used first, even when slow if nothing else is proven.

**Cost.**

- Two people whose networks cannot meet cannot have a video call, or a voice call in both
  directions at once, unless one of them runs a TURN server. This is the largest limit of
  being serverless after the lack of push notifications (ADR-007).
- From a network like the one measured here, a symmetric NAT, that is a large share of the
  people one might call.
- The walkie-talkie leans on public relays. If it were used heavily they could throttle it,
  and nothing Textor can do would change that.

**Revisit if** an operator offers TURN to any application with no account and intends it
to be relied on, which would then go in behind the same direct-first path; or if browsers
give ordinary pages TCP candidates or sockets.

---

## ADR-073 — An identity's devices stay in step through frames to itself; relays were measured, and the inbox reads what they really hold · **found by measurement**

**Problem.** Every device of an identity holds the same key, so messages already reached them all (PROTOCOL §4.2), and nothing else did. Deleting on one device left the message on another. So did reading, blocking and deleting a conversation. Calls rang on, unanswered, on the device nobody picked up.

Reviewing that against real relays found more, none of it about devices alone:

- **A device restored from nothing read three days of history, not thirty.** The catch-up at start found no socket connected yet and moved the shared cursor to now all the same. Every relay with no mark of its own, which on a new device is every relay, then read from there. The tests never saw it, because their sockets connect at once.
- **A relay's replay ends at its own limit and says it has finished.** `primal` stops at 500 and `wirednet` at 200, each with an ordinary EOSE. The mark then moved to now, and anything older on that relay was never asked for again. One 512 KB file is 32 wraps, so about 16 files fill it.
- **A first catch-up downloaded everything once per relay.** Reconciliations ran side by side, so each found the same wraps missing and fetched them.
- **Every device overwrote the announced inbox** (kind 10050) at start, unread. On the defaults two devices still share two relays. With custom relays, a restored device pointed contacts away from the relays the other reads.
- **Two tabs ran two engines** over one database, each taking the same outbox rows.
- **The 90 and 365-day expiry settings could not be kept.** A device raises its floor to 45 days as soon as it has anything older, and refuses wraps below the floor, however long a relay holds them.

**Measured.** Six default relays, from one network, on 1 November 2026, from throwaway keys, with events expiring within the hour. Each test ran once. Age comes from sampling `created_at`, which another client may misdate.

| Relay         | NIP-77     | Largest wrap stored | No-limit query stops at | Oldest wrap seen    |
| ------------- | ---------- | ------------------- | ----------------------- | ------------------- |
| `primal`      | turned off | at least 256 KiB    | 500                     | about 3 years       |
| `oxtr`        | yes        | 128 KiB             | not tested              | about 2 years       |
| `purplerelay` | yes        | 64 KiB              | not tested              | about 3 years       |
| `wirednet`    | yes        | 64 KiB              | 200                     | about 3 years       |
| `wellorder`   | no         | 137 KiB             | none seen (1,789)       | 3 to 7 weeks        |
| `offchain`    | yes        | under 8.4 KB        | not tested              | sparse past 30 days |

| Test                                                | Result                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| A wrap reaches its expiry                           | 6/6 removed it within about 20 s                              |
| Deleted by its signer (NIP-09)                      | 6/6 removed it, and none served it again after a re-publish   |
| Deleted by its recipient, as NIP-59 suggests        | 0/6 removed it                                                |
| Kind 30078 from a new key, replaced                 | 6/6 accepted it and kept only the newest                      |
| 32 wraps of 55 KB, a new signer each, two at a time | 32/32 on primal, oxtr, purplerelay and wirednet, in 9 to 13 s |
| 11 wraps of 65 KB, the same way                     | 11/11 on the same four                                        |

`purplerelay` and `wirednet` advertise 131,072 in NIP-11, and refuse 66,025 bytes as too large. `offchain` takes short wraps from a key it does not know and refuses long ones, whichever is sent first, and refuses short ones too after a burst. `oxtr`'s "15, then rate limited" (ADR-070) was measured from one key, and did not appear from a new key per event. `wellorder` was left out of the upload tests, having blocked this address at 60 events.

**What that says about keeping messages.** Relays are not throwing wraps away early, as far as sampling can tell: most serve wraps with no expiry for years. A wrap goes at 30 days because Textor asks it to. So no keep-alive is built. Re-wrapping everything each month would, for someone sending 100 messages, 5 photos and 3 voice notes a day, upload about 890 MB and spend 7.7 hours of open app at 15 events a minute, on an app that cannot run in the background (ADR-007). It would also have every other device download it all again under new ids, and defeat the expiry ADR-003 leans on. `npm run retention:probe` is measuring the one thing sampling cannot: whether one wrap lasts until it asked to expire, with a small and a chunk-sized wrap on each relay, published on 2 November 2026 and expiring on 3 December.

**Decision — frames to itself.** A control frame, `t: "sync"`, addressed to this identity's own key and to nobody else. Another client's device, and anyone else's frame, never gets this far: a rumor naming only ourselves, from our own key, is what `roomOf` turns away, and the seal proves the author.

- **It carries** read marks, messages deleted for this person, conversations deleted, blocks, and calls taken elsewhere.
- **Everything merges in any order, any number of times**, because a catch-up read returns frames in any order and a relay may replay them. A read mark and a deleted conversation only move forward, by causal key (ADR-063). A block goes by the latest time. A deletion stays deleted. The clock needs no change, and no vector clock or log of operations was added.
- **A read mark is the key of the newest entry read**, never the conversation's clock, which also moves for what this device sent, and would mark as read a message that crossed with it.
- **Marks are kept by the engine**, since a message may arrive before the frame or after it, and before the chunk has loaded. Either way a message a mark has passed does not count as unread, and one a deletion has passed does not arrive.
- **A device alone says almost nothing:** a hello a week. Read marks and calls wait until another device has been heard from in the last month. Deletions and blocks always go, since a device restored next week should still learn of them. A device not heard from before is answered with what has been read, at most once an hour.
- **Settings shows when another device was last heard from.** Every device holds the same key, so an unexpected one means someone has the recovery phrase. It cannot be locked out: moving to a new identity is the only remedy, and the screen says so.

**Decision — withdrawals reach every device.** A `redact` is copied to our own inbox and honoured from our own key, within the conversation it names. It always goes by relay, even with a direct channel open. It and every sync frame ask to last 30 days whatever the setting says, so a withdrawal outlives what it withdraws. Taking a reaction back works the same way. ADR-074 takes the wraps off the relays too.

**Decision — a call taken elsewhere.** Answering or declining tells the other devices, which stop ringing, say nothing to the caller, and write nothing: the device that took it holds the record. A device that was away finds a tombstone, so the offer does not come back as a missed call. If two devices answer within the same second, the caller connects to the first, and the other fails as a call that could not be set up.

**Decision — the inbox.**

- **A replay of 20 or more is read on backwards** with `until`, a page at a time, before the mark moves. Counted from the raw frames, so duplicates another relay already delivered still count. A page that ended any way but the relay's EOSE proves nothing, and the mark stays.
- **One relay downloads at a time**, asking only for what no relay has handed over by then. Reconciliations still run side by side, since they carry only fingerprints.
- **A catch-up moves the shared cursor only once a relay has been read.** A device with no history waits for relays still connecting, and starts at the 45-day horizon.
- **A wrap past its own expiry is refused.** Whatever withdrew it asked to last at least as long, so a relay offering it may be offering it without the withdrawal.
- **While a device with no history first catches up,** the interface waits, for at most eight seconds, rather than show what is about to go or notify for a month of mail.
- **A relay standing by is looked in on,** one an hour and each once a day, and the connection lapses afterwards. A contact with an old copy of the announced list may have written there.
- **A refusal for size** does not count against a relay, and it is not sent events that large for six hours, unless there is nowhere else.

**Decision — the announced inbox belongs to every device.** A device reads it first, from the relays it reads, then from the rest if they know of none. It adds relays it has never had, except any this person removed, and leans on the announced ones while they work. It changes the list only to add what it reads, or to drop what it has evidence cannot be used. One it merely has standing by stays: another device may read it. Up to six.

**Decision — one engine per browser.** Whoever holds a Web Lock runs the engine. A tab that asks while another holds it says so, waits, and takes over when that one closes or locks, or at once if told to use this tab. A browser without Web Locks goes on as before.

**Decision — expiry.** 7 or 30 days. A vault holding 90 or 365 reads back as 30.

**Not built, and why.**

- A keep-alive, as above. _(ADR-076 sends again only what stayed undelivered.)_
- A state snapshot on relays, for a device away over a month. Relays would take it, as a replaceable event under a derived key, but it would leave this person's contact list on them for good, readable by anyone who ever gets the key. A backup file does that job. _(ADR-077 keeps this person's own profile that way. ADR-078 keeps the contact list that way too, as the owner decided.)_
- Copying forward-secret group state between devices: two devices on one leaf break the group for everyone (ADR-049). A second device needs adding by an admin, and cannot read what came before.
- Per-device keys, which NIP-17 addressing has no place for.

**Verified.**

- `tests/deviceSync.test.ts`: two engines on one key and a contact, on a network that deletes as the relays were measured to. Every kind of frame in both orders, a new device answered, a device alone staying quiet, replays, the frame's bounds, and a stranger's frame refused.
- `tests/inboxCatchUp.test.ts`, over the real pool and sockets: a relay stopping at its limit, duplicates counted, a page that stalls, the same wraps on three relays fetched once, a device whose sockets were still connecting reading its whole history, expired wraps, and relays standing by.
- `tests/tabLock.test.ts`, `tests/privacySettings.test.ts`, `tests/relayPool.test.ts`,
  `tests/relayScore.test.ts`, `tests/calls.test.ts`.
- Nine faults put in by hand, such as no self-copied withdrawal or no paging, and each failed a test.
- Full engines on the live relays: a laptop, a contact, and a phone restored later from the same key. History on the phone within about 2 s, a read mark cleared the phone's badge in about 31 s, a deletion was gone from the phone and the contact within 0.5 s, and a block reached the phone in 1.5 s. Of the four relays holding the deleted wrap, three no longer served it 20 s later; `offchain`, by then refusing that address, still did. One earlier run lost every connection a minute in, including separate sockets the test had opened itself. No frame or socket count was out of line in the runs measured, and the next runs were clean, so it reads as the network, though that is not proved.
- In a browser, in both languages, at 320 pixels: the other-tab screen, using this tab, taking over when the other closes, and the expiry options.

**Not verified.** Two real devices on different networks, and how long any wrap truly lasts, which the retention probe will answer.

**Budget.** The sync engine (lazy, 7.0 kB), NIP-77 (lazy, 4.0 kB), the direct channel (lazy, 5.5 kB) and the attachment engine (lazy, 4.3 kB). The last three only ever run online, and the attachment engine loads at every start, so it is cached for a session that goes offline. The first session after a deployment, if it starts offline, cannot send attachments until it next connects. The precache goes from 797.6 to 795.4 KiB of 800, with the deployment's base path.

**Cost.**

- About 2.2 KB per frame, to each relay in use.
- Read state on another device lags by up to five minutes when reading often: marks are batched on purpose.
- A relay sees more self-addressed wraps, indistinguishable from any others.
- A device away for over a month misses deletions and read marks whose frames have expired.
- Calls still ring on both devices until one is taken.

**Revisit if** the retention probe shows wraps gone before their expiry, which would make renewing undelivered messages urgent; if relays start limiting self-addressed traffic; or if someone needs state to survive longer than a month without a backup file.

---

## ADR-074 — A wrap's signer is derived, so any device of the sender's can ask relays to delete it

**Problem.** "Delete for everyone" asked the other person's device and left the ciphertext on the relays until it expired, and direct messages have no forward secrecy (ADR-003). A relay deletes a wrap only for the key that signed it: measured, 6/6 for the signer and 0/6 for the recipient (ADR-073). That key was generated, used once, and thrown away. A retry also made a new wrap each time, so one message could be on the relays under several ids, none of them deletable.

**Decision.** What a wrap left to chance is derived from the sender's key, the rumor and the recipient:

```
okm      = HKDF-SHA256(ikm = sender's secret key, salt = rumor id,
                       info = "textor/wrap/v1|" ‖ recipient hex, 88 bytes)
signer   = okm[0..48] mapped to a secp256k1 scalar
nonceKey = okm[48..80]
fuzz     = okm[80..84] and okm[84..88], each mod two days, for the seal and the wrap
nonce    = HMAC-SHA256(nonceKey, what is being encrypted), for each NIP-44 layer
```

- **To a relay it is as random as ever.** Nobody without the sender's key can link a signer to anything. Two people's copies of one rumor have different signers, timestamps and ciphertext.
- **The same arguments give the same event, on any device.** The rumor goes into the seal in one fixed field order, and the seal's signature takes its auxiliary randomness from the same draw. A retry is the same event, which relays already hold.
- **A nonce cannot repeat across different plaintexts:** it is a keyed hash of the plaintext. Anything that changes the bytes changes the nonce.
- **Timestamps and expiry count from the rumor,** not from when it was sent. A message sent again so late that a relay would refuse it, within five minutes of expiring or past it, counts from now instead, and that one wrap cannot be worked out again by another device.
- **It is still NIP-59.** Other clients open it as before, and nothing tells them it differs.

**A retraction** is a kind 5, signed by the wrap's signer, naming the wrap under each lifetime it may have had (7 and 30 days, since each makes a different id), and asking to expire in 31 days. A relay ignores an id it does not hold.

- **Deleting for everyone** retracts every copy of what we wrote.
- **The other person withdrawing something we wrote** does the same, on our device: only we hold what signed it.
- **Deleting for me** retracts only our own copy of what we wrote. Everyone else's stays theirs.
- **It is queued in the outbox as a signed event,** so it survives being offline, and goes to the conversation's relays and all of ours, standing by included. Each relay is asked until it answers, up to the outbox's usual attempts.

**Limits.**

- Only the author's devices can ask. A message the other person wrote leaves the relays when their device honours the withdrawal, if it runs a Textor new enough to.
- Not a message sent before this, whose signer is gone, nor one from another client. Not a reaction, whose rumor is not rebuilt, nor a chunk pushed in a frame: useless without the key in the message, it goes when it expires. _(Chunks on the relays at their own address are deleted with the message: ADR-075.)_
- A relay can ignore the request, and anyone may already hold a copy. It shrinks what sits on honest relays; it does not unsend.

**Cost.**

- **The stolen-key case gets slightly worse.** Anyone with the identity key can now work out every signer, and so ask relays to delete this person's wraps. They could already read and impersonate. It also lets them show a wrap came from this key, which the seal inside already does for the recipient.
- **"Single-use key, thrown away" no longer describes a wrap.** PROTOCOL and THREAT-MODEL say what it is instead.
- Two more HMACs and an HKDF per wrap, beside two Schnorr signatures. 0.6 KiB in the shell.
- This is crypto-critical code that has had no independent review, like the rest of the application (THREAT-MODEL §4).

**Verified.** `tests/giftwrap.test.ts`: the same event whatever order a rumor's fields are in; a different signer, time and ciphertext for each recipient, rumor and sender; no signer equal to anyone's key; other clients' code opening it; different plaintexts never sharing a nonce; expiry from the rumor, and from now when too late; and retractions signed by the wrap's signer. `tests/deviceSync.test.ts`, on a network deleting only for the signer: a withdrawn message's wraps gone, and a device started afterwards never seeing it. `giftwrap.ts` is held to 100%. Live, see ADR-073.

**Revisit if** relays come to honour NIP-59's recipient deletion, which would let a recipient clear their own inbox; or if forward secrecy reaches direct messages, when a derived signer would need thought again.

---

## ADR-075 — A payload waits on the relays at an address of its own, and a message says where · **found by measurement**

**Problem.** A chunk went to each recipient's inbox, as a control frame inside a seal inside a gift wrap, which is three layers of base64 around ciphertext that needed none.

- **It cost three times what it carried:** 16 KiB became 55,149 bytes. A 512 KiB file was 32 events.
- **It went to everyone, whether wanted or not.** Each device downloaded it from every relay it read. A device catching up on a month downloaded a month of files, before it knew which wraps were chunks.
- **It went once per person.** A group of eight uploaded a file seven times.
- **It went to nobody else.** The sender's other devices had to ask the other person, and wait until they were online.
- **It stopped at 512 KiB,** so a voice note past about 2:55 needed a direct connection, though recording allows five minutes.

**Decision.** A copy has an address, the public key derived from its key:

```
secret  = HKDF-SHA256(ikm = copy's key, salt = copy's salt, info = "textor/blob/drop/v1", 52 bytes)[0..48],
          mapped to a secp256k1 scalar
address = its public key
```

Only someone holding the message can work it out. A relay sees events addressed to a key that means nothing, rather than to a person.

**A chunk is one kind 1059 event:** `content` is the base64 of its ciphertext, as sealed since ADR-029, `p` is the address, and `seq` says which it is. No seal, since only someone with the key can have made it, which `openChunk` checks before anything is kept. Chunks are 48,640 bytes of plaintext, about 65.3 KB as an event, under the 65,536 the strictest default relays allow.

| Layering                               | Plaintext per event | Events for 512 KiB | Events for 1 MiB | MiB per relay for 512 KiB |
| -------------------------------------- | ------------------- | ------------------ | ---------------- | ------------------------- |
| Before: frame in rumor in seal in wrap | 16 KiB              | 32                 | 64               | 1.68                      |
| Now: ciphertext directly in the event  | 47.5 KiB            | 11                 | 22               | 0.69                      |

**The limit over relays is 1 MiB,** which holds a five-minute voice note at 24 kbps (900 KB, 19 events).

**Sending.**

- **The descriptor says** `chunkBytes` and `relays`, the relays it was put on. Fields go in the order the parser builds them, so another device of the sender can rebuild the rumor exactly (ADR-074).
- **Which relays:** the first each person reads that takes events this large, then the sender's own, three for one person and four for a group. So someone can reach it whichever side of a border a relay is on.
- **Each chunk is queued in the bulk lane as a signed event.** It is done once a relay holds it. A relay that refuses a large event is not asked for another for six hours, and its refusal does not count against its health.
- **A new signer every ten chunks.** Measured below: `oxtr` refuses a key after 15 events. Signers are derived from the sender's key and the copy, so any device of theirs holding the chunks can ask relays to delete them. "Delete for everyone" now takes them too.

**Receiving.**

- **One relay at a time, and one download:** those named that are open already, the rest named, then the relays this device reads. A subscription stays open, so chunks still being uploaded arrive as they land. A relay that says it has nothing is left after two seconds, a silent one after eight.
- **A stranger's descriptor does not send this device to a relay of their choosing,** which would tell them its address. What they sent has to be where this device already reads, and the sender puts a copy there.
- **Two read at once.**
- **On demand.** A file that has just arrived is read at once. One from over a day ago, or arriving while a device catches up from nothing, waits until its conversation is opened, or is on screen.
- **When every relay has been tried,** the sender is asked, with the `blobreq` frame that exists already. They upload what is missing again, to where the asker reads, counted from now, at most once a minute per copy. Two rounds, then it waits until next opened. This is what covers a file past its expiry, with no keep-alive at all.

**Compatibility.** Updates wait for someone to accept them (`registerType: 'prompt'`), so old builds last. Nothing is sent to one that it cannot use:

- **A receipt now says what its client can do,** `caps: 2`. A parser from before ignores it. Receipts with no `caps` come from an earlier Textor, and other clients send none. This is kept per person, in sealed state, including someone not in the address book.
- **Anyone not known to read from relays gets frames, as before,** up to 512 KiB. So does a group with one such member. A file past that goes to the relays anyway unless a direct channel is open: frames could never carry it.
- **Frames are still taken from anyone,** and frames in flight when this shipped still arrive. Large files over a direct channel are unchanged.
- **What it costs:** a contact's first attachment goes by frames, until a receipt has come back. An old build sent a file past 512 KiB shows a bubble that never finishes, as it would have had no way to get one before.

**Measured.** Full engines on the live relays, from one network, on 2 November 2026. A random 900 KB file, 19 chunks, was in the other person's hands, intact, in 9.8 s, as its upload finished. `oxtr` held all 19. `offchain` refused them for their size, and `wellorder`, having seen a lot from this address during testing, refused them too, and was sent five. A device of the sender's, restored from nothing with the sender stopped, held no chunk until the conversation opened, then read it all in 4 s. A 300 KB file to a group of two others: 7 chunks uploaded once, and both held it in 5.6 s. Deleted for everyone: every relay that had held the chunks reported none, 20 s later.

**What measuring found.**

- **One signer for a whole copy was a mistake.** It seemed tidy, one deletion per copy. On the live relays it kept `oxtr` refusing past 15, and an upload retrying for over two minutes.
- **Retrying a refusal was worse.** With a relay refusing every chunk, one upload sent it 129 events, 7.8 MB, to no effect. That is how an address gets blocked (ADR-070). A chunk now stops once any relay holds it.

**Also fixed, found while testing this.**

- **A wrap arriving as the vault locked was lost for good.** It was marked as seen before it was opened, and then every relay's copy was refused as already seen. Now it is opened first.
- **Taking the outbox when the vault locked mid-way** failed where nothing was listening.

**Budget.** The invite code left the shell for the people chunk (2.7 KiB), which pays for this. The attachment engine is 8.4 kB and the device sync chunk 7.8 kB, both lazy. The precache is 796.3 KiB of 800, with the deployment's base path.

**Cost.**

- **A relay can count one file's events,** and so tell its size to within about 48 KiB. It could before, from a person's inbox. It no longer learns whose file it is, except from who asks.
- **A relay sees who reads an address,** and whoever uploaded it, which links those two addresses for that operator, much as a shared relay already does (THREAT-MODEL §3.4).
- **Anyone holding the message can write to the address.** Nothing they write is kept unless the key opens it, but it costs a download.
- **These events are not NIP-59.** Their content is not NIP-44, and no client but Textor asks for them, so none will try. Relays were measured to take them.
- **A file nobody has opened is gone once it has expired and its sender has been offline for it.** That was so before, for a device away that long.

**Not verified.** A real microphone: 900 KB is what 24 kbps comes to, and a browser may exceed the hint, in which case a long note needs a direct connection, as before. Two people on different networks.

**Revisit if** relays start refusing kind 1059 events whose content is not NIP-44, when a single NIP-44 layer costs 18 events per 512 KiB instead of 11; or if files need to go past 1 MiB, which needs measuring first.

---

## ADR-076 — A message nobody has confirmed is sent again before it expires, twice at most

**Problem.** A wrap asks to expire at 30 days, and relays honour that (ADR-073). So a message to someone away for 31 days was gone, with the sender's screen still saying "sent". Re-publishing everything was rejected in ADR-073 as costing hundreds of megabytes a month. Almost none of that traffic does anything, because almost everything has been delivered.

**Decision.** Only what is unconfirmed, near its end.

- **What.** A message still at `sent`, from day 25, and again from day 50. So it can wait about 80 days, and then it is gone.
- **To whom.** Only someone whose client has sent a receipt before (ADR-075). Nobody else ever confirms anything, and another client might show it twice. In a group, only the members who have not confirmed.
- **Only the message.** A file is asked for by whoever needs it (ADR-075).
- **Same rumor, new wrap.** A receiver knows the rumor by its id, so it never appears twice. The wrap's times and expiry move on by 25 days a time, so it is not below the receiver's 45-day floor (ADR-051). Being derived (ADR-074), any device of the sender's makes the same wrap, and relays hold it once. It has the signer of the first, so one deletion names them all.
- **How fast.** Checked when the app starts and every twelve hours, 20 wraps a time, not while nothing is connected. A backlog takes days.
- **Not at 7 days.** Someone who chose a short life for their messages asked for the opposite.

**Cost.** An unread message's ciphertext stays on relays for up to about 80 days rather than 30, and direct messages have no forward secrecy (ADR-003). The setting says so, and 7 days turns it off. A relay sees a little more traffic from someone with contacts who are away.

**Limits.** It only runs while the app is open (ADR-007), so a sender who is away too misses the window: a message past day 75 is not sent again. If the receipt that would have stopped it is itself lost, the message goes again, and is dropped on arrival.

**Verified.** `tests/renewal.test.ts`: a wrap sent again differs and comes from the same signer; the timing, the two-round limit and the backlog; delivered and read messages left alone; someone who never confirmed left alone; a group sent only to who has not confirmed; calls, forward-secret groups and anything that cannot be rebuilt left alone. Between engines: a message reaching someone back after five weeks with the first wrap gone, once; nothing at 7 days; nothing while offline. Not run on live relays, which would take 25 days.

**Revisit if** the retention probe (ADR-073) shows wraps gone before they ask to be, which would make day 25 too late.

---

## ADR-077 — One profile and one contact list across an identity's devices

**Problem.** A device restored from the twelve words asked for a name and knew nothing else. Each device kept its own profile and contact list, so a rename on one never reached another. And a contact's `profile` frame was applied whenever it arrived, so a catch-up read, which gives no order, could put an old name or picture back.

**Decision — the profile.** Each part (name, about, picture) has its own stamp, kept on the identity, so two changes made apart both stand. It goes two ways:

- **In a frame**, as `me`, at once, to devices that are around. Without the picture, which would not fit: a frame is sealed three times over, and 64 KiB relays allow about 16 KiB of it.
- **In a sealed record on the relays** (PROTOCOL §4.7), for whoever has only the twelve words. Kind 30078, signed by a key derived from the secret key, sealed with another, under a `d` that is derived too. So a relay holds an opaque event from a key seen nowhere else. It is never kind 0, and never names the identity. The name and the picture are separate records, so renaming does not send a picture again.

**Decision — restoring.** The name is no longer asked for on a restore. A restored identity's stamps are 1, which loses to anything and is never told or written, so it cannot overwrite the real profile on relays. It reads at once rather than after the usual 20 seconds, and looks four more times over the next minute or so if nothing is found, since sockets may still have been opening.

**Decision — writing safely.** A relay keeps the event with the latest `created_at`, whatever is inside, so a stale device writing would bury a newer record. So a device reads first, merges, and writes only what relays lack or what is a month old. If no relay answered, it writes nothing. Records ask to expire after a year, far longer than the 30 days of messages: they hold what contacts are shown anyway, and a restore may come long after the last device was lost.

**Decision — the contact list.** Frames, as `people`, each entry one person whole. Whether they are a contact, the name given to them and the pin each go by their own stamp, from one clock per device that only moves forward; relay hints add up. Stamps outlive someone's removal, so a late frame cannot bring them back. Changes always go, so a device restored within the month learns them even with nobody online. A new device, or one away for 25 days, is told the whole list and who is blocked.

**Decision — a contact's own profile.** A `profile` frame now says when the profile changed, `at`, so anything older is dropped, including from a device of theirs yet to catch up. Frames without it go by the rumor's time.

**A pin control.** Nothing could set `pinned` before: the column and the sort existed with no way to reach them. Contact details now has one, as there was otherwise nothing to synchronise.

**Found on the way.**

- **NIP-44 pads in 8 KiB steps.** A picture at the 47 KiB planned made a 66 KB event, past 64 KiB relays. The limit is 40,800 characters, and Settings now falls back to lower quality above that.
- **A new device could go untold.** An answer was limited to one an hour, and a device arriving inside that hour was never answered. What is owed is now kept, across restarts, and the limit is five minutes.
- **The first read could stop before reaching a relay with the picture,** as it does not wait on the slowest relay. The name's record now carries the picture's stamp, so a device knows to keep looking, and only a restore's first read hurries.
- **Writing where messages go reached four relays of six,** the active set. Records go to every write relay.
- **An open contact page could undo a rename.** Its field kept the old name, and leaving it saved that as a new change. The field now follows the name, as the one in Settings does.

**Budget.** All of it is in the device sync chunk, now 16.3 kB, except the hooks. The precache went from 796.3 to 797.6 KiB of 800.

**Not built, and why.**

- **The contact list in a record.** _(Built after all: ADR-078.)_ The reason in ADR-073 stands: it would stay on relays for good, readable by anyone who ever gets the key. So restoring with no device left brings the profile, and of the contact list only changes from the last 30 days, plus whoever writes.
- **Contacts' pictures in the list.** At up to 64 KB each they would not fit. A new device shows a contact's name at once, and their picture when they next send a profile.
- **Notes and verification.** A note was not asked for. Having verified someone on one device says nothing about the key another holds, so it stays per device.

**Limits.**

- **Two devices that never compared** merge the first time, by the time each contact was added. A contact removed from one long ago comes back, since nothing recorded its removal, and of two differing profiles neither has a real stamp, so the later-made identity's stands.
- **The record's key is linked only by who connects.** A relay seeing one connection read this inbox and write the record can tie them, as it can with derived wrap signers (ADR-074).
- **An identity not opened for a year loses its record,** as relays honour the expiry.
- **A write counts once any relay takes it.** A slow connection can leave a record on only a few until the next change or the monthly write, as nothing counts the copies.
- **A picture over the limit,** from before it was lowered, stays on its device.

**Verified.**

- `tests/profileSync.test.ts`: real engines with one key. Each part both ways and in both orders, changes made apart, a restore with and without another device, nothing readable on a relay, a stand-in never told or written, later looks, stale frames, removal and re-adding, pins, a whole list in frames every relay will keep, a device back after weeks, stamps far ahead, no relay answering, and a contact's frames in any order.
- On the six default relays, 2 November 2026, with throwaway keys, over a connection that started good and turned slow, with relays taking up to 6 seconds to answer on open sockets and half of publishes timing out. The records are 674 bytes and, with a 20 kB picture, 27.8 kB, and each reached between two and six relays. A restored device had its name in 1.5 to 4 seconds and its whole profile in 1.8 on the good connection and up to 20 on the slow one, with another device online or none. Renames, pins and profile changes crossed in 1 to 2.5 seconds, once 8.4. Runs on the slow connection that missed these times are why a restore now looks again sooner, and why reads wait longer.
- In the browser, two instances restored from one phrase. Restoring went from the words to protection without asking a name, and Settings showed the name, about and picture from the record. A contact added in one appeared in the other, pinned; a display name changed in Settings, and a contact renamed, each showed in the other within seconds without a reload; removing the contact removed it there.

**Revisit if** the retention probe (ADR-073) shows relays dropping replaceable events early, when a month is too long between writes; or if someone asks for the list to survive losing every device, which needs a decision on that exposure.

---

## ADR-078 — A restore brings back the contact list, and nothing that was deleted

**Problem.** Two, found by using it. Restoring from the twelve words with every device lost brought back the profile (ADR-077) and no contacts. And messages deleted for everyone came back on a restored device, for good.

**What was measured.** Six default relays, 2 November 2026, with throwaway keys, after sending a few messages and deleting them.

| Relay                                   | Held after a deletion                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purplerelay`, `oxtr`, `wellorder`      | Dropped what its author asked them to. Hold the deletion frames.                                                                                                                                                                        |
| `offchain`                              | **Everything it was sent first, and no deletion frame or NIP-09 request.** After about 14 events from new keys it answers `pubkey is not in our web of trust` to anything, on a new connection too. It accepted again within 5 minutes. |
| `primal`, `wirednet`                    | Only what was sent to every relay: neither is in the set in use on a new device.                                                                                                                                                        |
| Any, for a message from someone offline | The message: only its author's key can ask.                                                                                                                                                                                             |

Restoring three times, one message came back twice: one the other person had deleted.

**Why they came back.** Relays were part of it, but all but one of these bring a message back with relays that behave. Each was reproduced in a test before it was fixed.

1. **The tombstone was filed under the wrong name.** Bob deletes something I wrote. A catch-up returns his deletion first, which finds nothing and files a tombstone under his name. My own copy arrives, is looked up under mine, and is stored for good. Which of the two came first was chance. This is the one seen on the real relays.
2. **A race.** A deletion and what it deletes, read at once. The message checks for a tombstone and finds none, and while it writes its conversation and contact, the deletion finds no message and writes one. Then the message is stored. Relays without NIP-77 replay through a subscription nothing waits on, so this needed only two wraps close together.
3. **The copy of a deletion to our own inbox was sent once, and forgotten.** If no relay took it, nothing tried again, and nothing else told a restored device.
4. **A refused deletion was given up on.** ADR-075 stopped pressing large chunks on a relay that refuses them, by the words of its refusal, and deletions shared that path. So `offchain` was never asked twice, and went on serving what was deleted.

**Decision — deletions.** Any one of these holds on its own against a different failure.

- **Tombstone first, and look again.** A deletion writes its tombstone before it looks for the message, and a message looks for a tombstone again once stored. Of two read at once, one always sees the other.
- **Who can stop a rumor.** Its author; us, since only we write under our own key; or in a direct conversation the other person, for whom anything in it is theirs to take out (ADR-061). Nobody else, so a stranger still cannot silence anyone.
- **The copy to our own inbox** counts like anyone's: retried until a relay has it, and sent to every relay of ours, since what it deletes may be on any of them.
- **NIP-09 is asked until it is answered.** The usual tries, then every six hours until the request expires. And a device offered a copy of something of ours that was deleted asks again, so a restored one mends what a lost one could not finish.
- **A sealed record of what was deleted** (PROTOCOL §4.7), `gone`: rumor ids and conversations deleted, kept 90 days, since a message can be sent again for about 80 (ADR-076). This is what makes a relay serving deleted wraps harmless: a restore needs only one relay to hold the record, whatever the rest serve.
- **A restore commits nothing until it knows.** A device restored from the words holds back messages, reactions, receipts, votes and locations, while frames that delete things are acted on as they arrive. Once catch-up is done and it has heard what the records hold, or 20 seconds have passed, it commits them, oldest first, and only then shows anything. What is held is not marked as read, and the inbox's marks stand still, so being closed part way loses nothing. A deleted message never gets a conversation, a contact or a receipt. Receipts now always find their message, too, which they did by chance before. Only a restore: a new identity has nothing to wait for.

**Decision — the contact list.** The owner's call, against ADR-073: a sealed record, `people`, like the profile's, so that losing every device does not lose every contact.

- **Only who is a contact now.** Aliases, pins, a few relay hints, and who is blocked. Someone removed is not in it, with no tombstone. Removing someone writes a new one within seconds, and asks relays to delete the one it replaces (NIP-09), for any that would not take the new one: `offchain` was measured refusing it, and a large list it refuses for good.
- **How a restore knows who was removed, with no tombstone.** From the record's own stamp. A restored device sets a floor there: nobody the record leaves out is taken from any frame or message of ours older than that. That last part matters: a message of ours used to make its recipient a contact, so a month of history brought back everyone removed. History stays, as it does on the device that removed them, and does not make them a contact. Someone removed who wrote to us becomes a request at most, as a stranger would, and the Contacts screen no longer names requests.
- **Being left out is not a removal, on a device already running.** Whoever wrote the record may simply not have heard of them, such as someone added offline, and silently losing a contact is worse than the alternative. Frames carry removals to any device around. A device away for 25 days, which frames may have missed, takes it as one, only for those in a record it read before.
- **Only ever the newest, whole.** Part of it missing means looking again, not settling for an older one, which may name someone removed.
- **A restored device writes no list until it has seen one**, or most of its relays have answered that there is none. Relays keep what is newest, so it would otherwise replace the whole list with the little it has heard so far. A test caught this happening, and also a frame part way through landing after the record had removed its subject, writing them back into the record. Changes to the list now run one at a time.

**Found on the way.**

- **The bundle check could fail at random.** It found the service worker with `endsWith('sw.js')`, and this build's hash made `lazy-deviceSync-B6oQnYsw.js`.

**Budget.** The device sync chunk is now 23 kB. The precache went from 797.6 to 798.5 KiB of 800, for what cannot wait for it: holding wraps, the tombstone checks, and the retries.

**Cost.**

- **Whoever gets the twelve words learns who you know,** long after every message has expired. That is what ADR-073 declined to accept, and it is the point of this: it was weighed, and the owner chose it. A backup file already said the same.
- **A relay learns the size of the list,** to within about 30 KB, and when it changes.
- **A restore takes longer.** It waits on relays it did not before: about 7 seconds on the connection measured, and at most 20.
- **Events.** A deletion's copy now goes to every relay, and a change to the list writes the list and one deletion.

**Limits.**

- **What was deleted before this version is not in the record.** Tombstones are blinded, so they cannot be listed. Frames still say so, for 30 days.
- **A relay can keep an old copy anyway,** against the rules of replaceable events and NIP-09. It stays sealed, and a restore does not use it, but someone with the words and that relay could read it.
- **An identity not opened for a year loses its records,** as relays honour their expiry (ADR-077).
- **About 800 contacts and 2,500 deletions** fit. Past that the newest are kept, and a warning is logged.
- **Someone added offline, while another device writes the list,** may be missing from a restore until their device next runs, when it writes them back.
- **Whether a message's author can ask relays to delete it depends on their device** coming back. Until it does, the wrap stays on relays, sealed, until it expires, and does nothing on any device.

**Verified.**

- `tests/deletionResurrection.test.ts`: every way a message can be deleted, on a restored device and a running one, on relays that honour deletions and relays that ignore them, in both orders, with a message parked at each point of the race. A relay holding no deletion frame at all, a restore closed part way, refusals, and a stranger's deletion.
- `tests/coldRoster.test.ts`: a list brought back with every device lost; nothing of someone removed in what relays hold; none of the ways they could come back; a list across several events, and shrinking; a device that has been around, and one away; every bound.
- `tests/deviceChunkFails.test.ts`, `tests/contactsScreen.test.ts`.
- Each fix was then broken on purpose, to see a test fail. Three got through at first, and each exposed a gap in the tests, now closed. One was rescued by the record, which is the point of having several.
- On the six default relays, 2 November 2026, end to end, with throwaway keys. Four restores in a row with every device gone, each showing only what was kept, in its first render and after everything had arrived, with the contacts, aliases and pin, and nobody removed. That was 2 in 3 restores wrong before. Seven minutes after a removal `offchain` had taken the new list, so no relay named them, and it had dropped what was asked of it. After the restores no relay held any of the messages deleted, the last of them because a restored device asked. A restore ended in 6.6 seconds on that connection, and in one earlier run took the 20 it may wait.

**Revisit if** the retention probe (ADR-073) shows relays dropping replaceable events early, when a month is too long between writes; or if relays start refusing kind 30078 from new keys outright, when a restore has nothing to read.

---

## ADR-079 — A Textor ID is ten characters worked out from the twelve words, with no registry

**Context.** People had to hand each other a 63-character `npub`, a link or a QR code. The owner asked for a friend code: the same on every device and after a restore, with no backend or paid server, nothing to choose and nothing to set up, and working out or checking one in under ten seconds on a budget phone. An 8-character, 40-bit version was built first and never released. A relay could have listed every user of it for about $2,200 at the theoretical best of owned GPUs, and the owner asked for 50 bits so that a sweep stops being economic, leaving the choice of function and encoding open.

A registry could give a shorter code, and none can exist here. A unique name needs everyone to agree who claimed it first; on an open network that takes an authority or a cost that stops one person posing as thousands (Douceur, _The Sybil Attack_), and relays have neither. They keep one event per kind, key and `d`, so nothing stops two keys sharing a `d`: a 200-event sample held up to 41 keys on one. So the code has to be something anyone can check for themselves.

**Decision.** Every identity has one ID, worked out from its secret key, which needs no input and is put on the relays by itself.

### The construction

For secret key `s` with public key `P`:

```
w     = HKDF-SHA256(s, no salt, "textor/id/v1/salt", 16)
laneᵢ = scrypt(password = hex(P) ":" hex(w),
               salt     = SHA-256("textor/id/v1/claim" 0x00 "i"),
               N = 2^15, r = 8, p = 1, dkLen = 32)              for i = 0, 1
K     = SHA-256(lane₀ ‖ lane₁)
ID    = the first 50 bits of K, as 10 symbols of Crockford's base32, upper case
```

It is shown as `7X9K2-M4QHD`, and accepted however it is typed: any case, grouped or not, with `O` read as `0`, `I` and `L` as `1`, and Persian and Arabic-Indic digits as digits.

An ID belongs to `P` if a `w` gives exactly that ID, which takes one run to check. A reader gets `P` and `w` from a record found through the ID.

**Why the hidden `w`.** With `K` over the public key alone, a relay could work out the ID of every key it had seen and see which have a record, for two runs a key, and so test every Nostr key for using Textor whatever the length of the ID. With `w` it can only guess IDs. `w` comes out of the secret key, so the ID is still the same everywhere, and it does not make forging any easier: an attacker's own `w` is one more thing to try, no cheaper than trying another key.

### What it costs

```
forging one chosen ID = 2^50 runs = 1.13 × 10^15
sweeping every ID     = 2^50 runs
working out your own  = 1 run
looking someone up    = 2 runs: one to find the record, one to check it
```

| Attacker                                                   | Per run      | All 2^50         | Time                   |
| ---------------------------------------------------------- | ------------ | ---------------- | ---------------------- |
| Rented CPUs at $0.04 a core-hour, 82 ms of core time a run | $9.1 × 10^-7 | **$1 billion**   | 2.9 million core-years |
| Owned GPUs at their theoretical ceiling                    | $4.0 × 10^-9 | **$4.6 million** | 4,200 GPU-years        |

The GPU line is deliberately the attacker's best case, and an upper bound rather than a benchmark: no published figure was found for these parameters. One run moves at least 128 MiB through memory, so an RTX 4090's 1.15 TB/s allows at most 8,600 runs a second, ignoring all computation. At $0.125 an hour, for the card over three years plus power, that is the figure above. Ten thousand such cards would take five months and cost about $18 million to buy. These are expected values, resting on assumed prices: treat them as orders of magnitude.

**What this does and does not achieve.** Going from 40 to 50 bits made a full sweep 1,024 times as expensive, and with the second lane 2,048 times. That is not the same as impossible, and three things should be read as they are:

- **It is economic, not mathematical.** Fifty bits can be enumerated. A state with $5–20 million and a reason can do it.
- **A sweep need not finish.** IDs are spread evenly, so each one tried is as likely as any to hit someone, and the cost per person found falls as Textor grows:

  | Users     | Per person found, rented CPUs | At the GPU ceiling |
  | --------- | ----------------------------- | ------------------ |
  | 10,000    | $100,000                      | $460               |
  | 100,000   | $10,000                       | $46                |
  | 1 million | $1,000                        | $4.60              |

  Trying 1% of all IDs costs about $10 million on rented CPUs, or about $46,000 and 42 GPU-years at the ceiling, and finds about 1% of everyone. It does not reach anyone in particular, only whoever turns up.

- **Someone with a specific person in mind does not sweep.** They ask for the ID, or take it from wherever it was posted.

So a sweep is no longer something a relay operator does idly, or something the 40-bit design was: within reach of anyone with a few GPUs. It remains something a well-funded adversary can do in part. The size of that exposure is why Cost, below, comes first in anything said about this.

### Choosing the function

Measured on an Apple M4, 2 November 2026, in browser workers, on the actual `@noble/hashes` code, as the time for one run with every lane going at once:

| Lanes × scrypt | Memory     | Moved per run | One run   | Cost to an attacker |
| -------------- | ---------- | ------------- | --------- | ------------------- |
| 1 × N=2^15     | 32 MiB     | 64 MiB        | 49 ms     | 1                   |
| **2 × N=2^15** | **64 MiB** | **128 MiB**   | **52 ms** | **2**               |
| 1 × N=2^16     | 64 MiB     | 128 MiB       | 99 ms     | 2                   |
| 2 × N=2^16     | 128 MiB    | 256 MiB       | 105 ms    | 4                   |
| 4 × N=2^15     | 128 MiB    | 256 MiB       | 55 ms     | 4                   |

**Two lanes, because a reader has a spare core and an attacker gets nothing for free.** An attacker runs a billion guesses side by side anyway, and pays for every lane of every one. A person runs one, and has cores idle. So the same memory and the same cost to an attacker comes in half the time of one larger lane. Every phone sold has at least four cores; with no workers at all the lanes share a thread and it takes twice as long. Each lane has its own salt and `K` needs both, so stopping after one tells an attacker nothing.

**Not more lanes, or more memory.** 64 MiB is what `kdf.ts` records as safe on mobile Safari, and 256 MiB as a real risk of the page being killed; 128 MiB is unmeasured on a phone with 2 GB, and four lanes on a phone with only two fast cores would run at the speed of its slow ones. Each would double the attacker's cost, which is one bit, and neither is worth a page that may die. One lane at N=2^16 has a better area-time product, should an attacker ever be limited by how much memory fits rather than by how fast it moves, and it takes every reader twice as long.

**scrypt, not Argon2id.** At 32 MiB, Argon2id took 263 ms in the same browser worker against scrypt's 50, with no faster native code for an attacker, since JavaScript handles its 64-bit multiplies badly and the content policy rules out WebAssembly. That gives an attacker about 2.3 bits for nothing. scrypt's weakness, memory access that depends on its input, does not matter here because the input is not a secret to protect from someone watching the cache, and it has been proved maximally memory-hard (Alwen et al., EUROCRYPT 2017). It is also already in the bundle.

**The budget.** No phone was measured. On the M4 one lane takes 49 ms on a performance core and 291 ms on an efficiency core at background priority. A Helio G85, in budget phones sold today, scores about nine times below an M4 in single-core benchmarks, and memory-bound work should fare worse, so about 1 second a run, and about 2 on the slowest phones still sold. That is at most 2 seconds to work out an ID and 4 to look one up, in workers, with the page still painting. `kdf.ts` records a much slower figure from an earlier measurement, 3–4 seconds on a mid-range phone at N=2^16, on code that takes a tenth of its stated desktop time on this machine. If that held and a budget phone were twice as slow again, a lookup would take about 8 seconds, still inside ten.

### Choosing the encoding

Fifty bits take this many characters:

| Encoding         | Characters | Why not                                                                                                                                          |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Crockford**    | **10**     | Chosen. Case does not count, and the characters it leaves out are read as the ones they look like, so a mistake of that kind is no mistake.      |
| Base58           | 9          | One character saved, and then case counts: aloud, on a phone keyboard that capitalizes the first letter, and in anything that folds case.        |
| Base36           | 10         | No shorter, and it has `0`, `O`, `1`, `I` and `L` together.                                                                                      |
| Bech32's letters | 10         | The alphabet has `u` and `v` together, its strength is a six-character checksum that would make it 16, and it reads no mistake as anything else. |
| z-base-32        | 10         | Good for humans, and no shorter, and nothing is forgiven when typed.                                                                             |
| Digits           | 16         | Easy on any keyboard, and sixteen of them.                                                                                                       |
| Recovery words   | 5          | Easier to say, and teaches people to hand out something that looks like their recovery phrase.                                                   |

**5-5.** Ten characters read best in groups, and a group of about four or five is what people hold at once. 5-5 has one delimiter, two groups of equal size, and a middle to read back to: "7X9K2, M4QHD". 4-4-2 leaves a stray pair, and 3-3-4 reads well but takes two delimiters. This is reasoning, not a usability study.

**No check symbol.** A check catches a typo before the network is asked, and costs an eleventh character, or five of the fifty bits. A typo already fails safely: it finds nobody, or, at a million users, someone else about once in a billion, with the same reminder to verify. It costs a few seconds.

### Finding one

Sealed, as ADR-077's records are, at an address only someone with the ID can work out:

```
A       = SHA-256(scrypt(ID, SHA-256("textor/id/v1/address" 0x00 "0"), …) ‖ scrypt(ID, SHA-256("textor/id/v1/address" 0x00 "1"), …))
d, seal = HKDF-SHA256(A, no salt, "textor/id/v1/record", 48), split at 16
```

- **That first step is what a sweep has to run,** for every guess. With a cheap hash here, a relay could try all 2^50 in a day or two on one GPU.
- **Signed by a key derived from the secret key,** so a relay sees an opaque event from a key seen nowhere else, and no kind 0.
- **The owner's own signature inside** covers the relays, so anyone can copy a record but nobody can change where it sends people.
- **Asked for by `d` alone, with no author**, since finding the author is the point. All six default relays and three others answered this on 2 November 2026, in 289–632 ms found and 220–409 ms not. None advertises NIP-50: lookup is by exact ID.
- **On the default relays as well as the owner's,** unlike every other record: someone looking may share no relay with them.
- **Written by itself** once a relay has answered, about a minute after an identity first opens, and again monthly. It asks to last a year, like ADR-077's. An identity unopened for a year stops being found until it comes back, and nobody can take its ID in the meantime.

**What an attacker can do.**

- **A forged record** appears beside the real one, so a reader sees a warning and a choice, not the attacker. To be silent, a forger must also keep the real record from every relay the reader asks, which takes control of the reader's network.
- **Two people holding one ID by chance** see the same, and there is nothing to regrind, as the ID is deterministic. It is rare: about one pair in 2,300 at a million users, and one chance in 23 of a single pair at ten million.
- **Precomputing** gets nothing that doing the work later does not, and is not specific to anyone. `T` runs hit one of `U` existing IDs with probability `T·U / 2^50`, as in a partial sweep, which is worth something only to someone happy to imitate whoever comes up.
- **Mining a collision**, two keys with one ID, takes about 2^25 runs and gains nothing, as the attacker owns both.
- **Flooding an ID with records.** Anyone who has it can publish false ones, and each costs a reader one run. A look spends at most four and says if there were more, so the worst outcome is finding nobody.

### On the screens

The app calls it simply **ID**, and شناسه in Persian; "Textor ID" is only this record's name for it, and the code's. It comes before any key, wherever someone is shown:

- **Your own** is in the profile card in Settings, on a button that copies it, with no screen of its own, and first on the screen for adding a contact.
- **A contact's** is what their page leads with, on the same kind of button. Where there is no name for them it is what they are called, in the chat header and everywhere else.
- **A raw key** is behind "Show public key", collapsed, on those pages, an invite's and a lookup's. Open by default only where two keys hold one ID, as it is then what tells them apart.

### How a contact learns one

**A key alone cannot say what someone's ID is.** That is what the hidden `w` is for, and it holds for a contact as for a relay, so they have to be told. An `id` control frame, sealed like any other, carries `w`. The reader works out the ID from the key it came from and `w`, so a contact cannot claim someone else's ID without the 2^50 runs, and once it has one it takes no other, as `w` follows from the key and never changes.

- **When it is sent.** When someone is added or accepted; with the first message written to them; when their own has just been learned, if ours was last sent over a day ago, in case they could not read it then; and with a message a month after it was last sent, as a frame can run out of tries while offline with nothing to say it did. **Never to everyone at once.** A relay watching one connection write to every contact in the same moment would be reading off the contact list, and a backfill to all of them on the day this shipped would have done exactly that. So someone not written to learns nothing and hears nothing until they are.
- **Only a contact costs anything.** Anyone can write to an inbox, and each of these takes a phone a second or two and 64 MiB. From someone who has only asked to talk, `w` is kept and worked out when they are accepted. Anyone not accepted can make it wait, and cannot make it run.
- **A restore keeps them.** They go in the sealed list (ADR-078), so a device restored with every other gone has everyone's ID, which it could not get again from people who have already told it once.

**So some people have no ID here.** Someone on a version before this one, until they update and next write; someone on another Nostr client, always; someone added by invite or `npub`, until they accept. For them a piece of the key stays the label, as there is nothing else to show, and their page says the ID is on its way. Group members who are not contacts are the same.

### Budget

The engine is in `lazy-textorId` and the screens in a chunk of their own, both out of the precache, and `check-bundle` looks for `textor/id/v1` in the shell. `kdfClient` is deliberately not imported: statically imported from a lazy chunk as well as the shell, the bundler hoists it into a shared chunk without the `lazy-` prefix and into the precache. Parsing, deriving and lookup are all in the chunks; what the shell has is one route, the loader, the small components for a key and an ID, the frame, and how to name someone. To pay for those, twenty strings only the contact screens use moved out of the main dictionaries into `peopleText.ts`, in that chunk. Precache: 797.6 KiB of 800 on a custom domain and 797.8 under a project path, which leaves about 2 KiB.

**Alternatives not covered above.**

| Option                     | Why not                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A chosen name and 50 bits  | Built first, never released. A name added nothing an attacker could not also type, and brought normalization and bidi rules with it.                                               |
| 8 characters at 40 bits    | Built second, never released. About $2,200 at the GPU ceiling to list everyone.                                                                                                    |
| 12 characters at 60 bits   | Would put a full sweep past $4 billion at that ceiling and end this section. It is two more characters to read out and type, which is the thing the ID is for. The owner chose 50. |
| A search for leading zeros | Takes a varying time, so cannot be strictly under ten seconds, and needs a screen. At this budget it buys about two bits.                                                          |
| Proof of work in SHA-256   | Worthless. A phone's few seconds are about 2^20 hashes, and one GPU does 2^33 a second.                                                                                            |
| NIP-05, on `textor.ir`     | It would work on a static host, make the owner the registry, publish every user in one file, and put that file under a national domain.                                            |

**Cost.**

- **Every identity is findable, by default, with no way to opt out.** Publishing is automatic, as the owner asked, and existing identities start about a minute after they update. Anyone with an ID can find the key and see when messages reach it. Before this, a relay had no way to tell a Textor user from any other Nostr key. A well-funded adversary who tries enough IDs now can, for as many users as it pays to find, at the prices above, and gets each one's public key and relays. Those are not a name, but a relay also sees the addresses that read those keys' inboxes (THREAT-MODEL §2.1), and the two together can name someone. An opt-out is the change to make if that is not acceptable, and would have to reach every device of an identity.
- **A leaked phrase cannot be fixed by moving an ID.** A new key means a new number.
- **An ID is not verification.** Whoever passes it on can pass on another. The safety number remains the only check, and the screen says so.
- **There is nothing to give up.** A relay asked to drop a record would be asked to write it again a month later.
- **A contact can compute your ID**, and passes it on as they could your key. That is the point of telling them, and it says nothing a key did not.

**Limits.**

- Phone timings are estimates, as above.
- The scheme is original to this project, and nobody outside it has reviewed it. RFC 3972's cryptographically generated addresses are the closest prior art.
- A lookup depends on relays keeping records, which the retention probe (ADR-073) has not finished measuring.
- An ID shared in the first minute of an identity's life finds nobody until its record is up.

**Found on the way.** Adding someone from an invite could fail with nothing said, and now says so. `tests/relayTending.test.ts` failed whenever it ran first or alone: it gave the device sync chunk 100 ms to load, which holds only once something else has loaded it. It now loads it ahead.

**Verified.**

- `tests/textorId.test.ts`: the vector in PROTOCOL §4.9 on real scrypt, which was also recomputed with Node's own scrypt, HKDF and SHA-256, using none of this code; exactly which bits count, against a second implementation over one long number; that both lanes are needed; forgery by another key, by the owner's values signed by someone else, with its relays changed, and moved to another ID; two real owners; a flood; each malformed field; workers, a worker that will not load, and no worker at all, giving the same answer.
- `tests/textorIdSync.test.ts`: real engines on a stand-in for scrypt, across two devices and a restore with every device gone; the month's rewrite; a locked vault and a stopped engine.
- `tests/textorIdScreens.test.ts`: the profile card, a contact's page, an invite's, a lookup's and adding a contact, with the key shown closed on each; what a tap copies; Persian.
- `tests/textorIdSync.test.ts` also takes an ID from one real engine to another by adding and by a first message, across being offline, held for someone not yet accepted, and through a restore; and checks that a contact not written to hears nothing.
- `tests/identity.test.ts`: NIP-06's own vector, and every way a pasted key or a hand-built invite can be wrong. This brought all of `src/core/identity/` under a 100% threshold, and removed three branches nothing could reach.
- Forty-four protections of the ID itself were then broken on purpose, one at a time, and a test failed each time. Then forty-seven of how contacts learn it and what the screens show. Two got through at first: one was a guard that protected nothing, and went; the other was covered up by a record sync, which only happens while relays answer, and now has a test of its own. A test that failed about one run in four was also found this way, for it was being credited with breaks it had nothing to do with. It had found something real: an ID frame sent while offline for ten minutes can run out of tries, which is why a month later it is sent again.
- On the six default relays, 2 November 2026, on the production build under its real content policy, in two browser profiles with throwaway keys. A new identity showed its ID with nothing to fill in, in about half a second, with both lanes in workers and no policy violations. Its record was on all six within about 90 seconds, at the address a separate script worked out from the ID using only Node's own crypto. The other profile found it in 1.0 second by typing it in lower case, with a space and `L` for `1`, and a message to the key it gave arrived. A restore from the twelve words on a wiped profile showed the same ID. Then again, for the screens: the profile card showed the ID with the key closed; someone with no name was their ID in the contact list, the chat header and on their page; one tap copied it; a request's page said the ID was on its way and did no work, and accepting them showed exactly the ID their own device showed; and Persian read right, with the ID still left to right.

**Revisit if** phones prove much slower or faster than estimated, when N or the lanes should move; if a sweep or a forgery is ever seen in practice, when a version 2 with a longer ID is the answer; or if commodity memory bandwidth improves by an order of magnitude, as the same.

---

## ADR-080 — The mark is refined, the name is drawn, and a link to Textor unfurls to an image of its own

**Problem.**

- **The mark read as a dumbbell in a box.** ADR-026's idea held, a message bubble with a link between two nodes in it, but the link lay flat between two dots, and the tail was a triangle stuck to the bottom of the bubble.
- **The name had no form of its own.** A README could only set it in whatever font the reader had, and nothing could put it in a raster image without a font, which here would mean a dependency.
- **A link to the app unfurled to nothing.** No Open Graph tags and no image, so a link pasted into a chat was a bare URL, and the repository had no social preview.
- **The SVGs carried their design notes.** The favicon and the pinned-tab glyph are precached, and 1.1 KB of them was XML comments.
- **Two descriptions of one mark.** ADR-026 drove both renderers from the same numbers, but the SVG was written by hand: "change a number here and in the SVG, or neither" was a rule, not a check.

**Decision — the mark.** The same idea, three shapes and two colours, no gradient and no shadow:

- **The link climbs** from lower left to upper right, from you to them, centred on the bubble. It reads as a direction rather than as an object.
- **The bubble is rounder,** 40 by 32 with a radius of 14, and **the tail continues its left edge** straight down, so the silhouette is one outline. Bubble and tail fill a square, 12 to 52 on both axes, centred on the badge.
- **The maskable icon's mark is at 80%,** up from 75%. Its farthest point, the tail's tip, then sits 22.6 units from the centre, inside the 25.6 a circular crop of 80% leaves, which a test checks pixel by pixel.

**Decision — the wordmark.** "textor" in lower case, a geometric sans drawn from the mark's own primitives and one more, the part of a ring between two angles: an x-height of 24 units, one stroke weight, round letters overshooting a little, the `t` rising above the rest, and five kerning pairs. It sits beside the mark at 1.125 times, an x-height of 0.42 of the badge, centred on it. Drawn, it needs no font in an SVG on GitHub, where an image cannot load one, or in a PNG made here.

**Decision — one source for every file.** `scripts/brand.mjs` describes each image as layers of analytic shapes, writes the SVGs from them and rasterizes the PNGs by testing each sample against the same shapes' equations, as ADR-026's renderer did. `npm run icons` writes all of them: the favicon, the pinned-tab glyph, the five PWA icons, the link preview and the README's two logos. `tests/brandAssets.test.ts` compares every committed file with what the numbers draw, the SVGs as text and the PNGs pixel for pixel after decoding them, so a different zlib does not fail it. Nothing is written by hand, and the SVGs no longer carry comments: the notes are in the generator, which ships nowhere.

**Decision — the link preview.**

- **`public/social-card.png`, 1280 by 640,** the 2:1 that GitHub and large link cards both use. The logo is centred on the night ground, `--n-950`, with a faint network of nodes and links either side in `--blue-900`, kept out of the middle where a 1.91:1 crop or a rounded corner would reach. 20.0 KiB.
- **The tags are written at build time** by `vite.config.ts`, because `og:image` must be an absolute URL and only the deployment knows the address. CI passes it as `SITE_URL`: the Pages URL, or `https://` and the custom domain. A build without it writes the title and description and leaves the image out, rather than guess. The description is read from `index.html`'s own, so the two cannot drift.
- **Not precached.** An unfurler fetches it, never the app, so `globIgnores` leaves it out like the home-screen icons.
- **`check-bundle` checks it is linked,** as nothing else would notice: an unfurler that cannot fetch an image shows a bare link and says nothing. The URL must be `https:` and under the base path the assets use, the file must be in the build, a PNG of the size the tags claim, under 300 KiB, and not in the precache.
- **GitHub's social preview** can only be uploaded in the repository's settings, under General. It is the same file.

**Decision — the README.** The logo is the lockup in two SVGs in `docs/assets/`, one for each page colour, chosen with `<picture>` as GitHub documents; outside `public/`, so they are never deployed. Badges come from shields.io, and only those GitHub's API answers live: checks on `main` and the Pages deployment, which do not name the workflow's file, since that changes every push (ADR-048).

**Budget.** The precache went from 797.8 to 797.3 KiB of 800 under a project path, and from 797.6 to 797.1 on a custom domain. The comments out of the two SVGs, 1,275 bytes, pay for the tags, 753 bytes of `index.html`. A build with no `SITE_URL` is 796.6.

**Cost.**

- **A link preview is fetched by whoever unfurls a link,** usually a chat app's server, which has just fetched the page anyway. An invite's payload is in the fragment, which no unfurler is sent (THREAT-MODEL §2.2), so a preview of an invite shows the app and nothing of the invite.
- **The wordmark is numbers, not a font.** Another letter means drawing it, and its spacing is five pairs by eye.
- **The README compares Textor with other messengers.** Those are claims about other people's products, dated, and the first thing in the README to go out of date.

**Verified.**

- Contact sheets in Chromium: the favicon at 16, 24, 32, 64 and 128 pixels and the variants it was chosen from at 16 to 192, on light and dark grounds; every PNG; the maskable icon under a circular mask; the lockup on GitHub's light and dark page colours; the card at full size.
- `tests/brandAssets.test.ts`. One number changed without regenerating failed every file the link is drawn in, nine of them; regenerating passed.
- Builds under `/Textor/` and `/` with a `SITE_URL`, and without one, each passing `check-bundle`. With the built tags edited to a wrong height, to `http:` and to another base path, and with the image removed, it failed each, naming it.

**Not verified.** How each unfurler crops the card, beyond keeping what matters inside 1.91:1. The README's diagrams were not rendered here: they are written in Mermaid's documented syntax, for GitHub to draw in either theme.

**Revisit if** a platform that matters stops unfurling 2:1 cards, or the app's accent colour moves, when `COLOURS` in `brand.mjs` follows it and `npm run icons` redraws everything.
