# Threat Model

What Textor protects, what it does not, and how you can check.

This document is written to be falsifiable. Where a protection is partial, it says so.
Where there is none, it says that too. A privacy claim you cannot check is marketing.

---

## 1. What we are protecting

| Asset                            | Where it lives                                                    |
| -------------------------------- | ----------------------------------------------------------------- |
| Message content                  | Encrypted end-to-end; plaintext exists only in RAM while unlocked |
| Identity secret key              | Encrypted in the local vault under a passphrase-derived key       |
| Social graph (who talks to whom) | Encrypted locally; blinded in database indexes                    |
| Conversation timing              | Fuzzed by up to two days on relays; hour-granular locally         |
| Display name and avatar          | Shared only with contacts unless a public profile is opted into   |

---

## 2. Adversaries

### 2.1 A relay operator

**Can see.** That a gift wrap addressed to a particular public key arrived, at a
timestamp randomised up to two days backwards, with a size rounded to a padding bucket.
The IP address of anyone connecting to fetch or publish.

**Cannot see.** Message content. Who sent it — the wrap is signed by a single-use
ephemeral key that appears in exactly one event ever. Whether two wraps came from the
same sender. Display names, contact lists, or conversation structure.

**Can do.** Refuse to store or serve events. Lie about what it holds. Textor's answer is
redundancy: publishing goes to every healthy relay, delivery succeeds if one accepts, and
the relay panel shows per-relay delivery statistics so a relay that quietly stops
accepting writes becomes visible rather than silently swallowing messages.

### 2.2 Whoever hosts the static files

**Can see.** Standard web-server logs: IP address, user agent, which asset was requested.
Because the app is a PWA, this happens on the first visit and after updates, not per
message.

**Cannot see.** Anything about messages, contacts, or keys — none of it is ever sent to
the origin. Invite links keep their payload in the URL **fragment**, which browsers never
transmit.

**Can do.** Serve modified JavaScript. This is the most serious risk in the model: a
malicious build could exfiltrate keys, and no amount of client-side cryptography defends
against it. Mitigations are all about verifiability — the source is public, builds are
reproducible from a tag, release artifacts are hashed, and installing the PWA pins a
version until you accept an update.

### 2.3 A network observer

**Can see.** TLS connections to a set of relay hostnames, and their timing and volume.
The relay set is itself a weak fingerprint: an unusual custom set is more identifying
than the defaults.

**Cannot see.** Message content or recipients.

**Mitigations.** The relay set is fully user-editable. The app makes no other network
requests — no CDN, no analytics, no fonts from a third party. It works over Tor Browser.

### 2.4 Someone with your unlocked device

**Full access.** This is out of scope for any messenger. Auto-lock (15 minutes by
default) and optional lock-on-background reduce the window.

### 2.5 Someone with your locked device

**Can see.** That Textor is installed, the size of the database, the KDF salt and
parameters, the wrapped data key, and the cached language and theme.

**Cannot see.** Messages, contacts, or keys — every record body is XChaCha20-Poly1305
sealed, and primary keys are HMAC-blinded, so even the _index structures_ do not reveal
who the user talks to. Timestamps in indexes are hour-granular.

**Can do.** Attempt an offline passphrase attack. Cost per guess is one scrypt evaluation
at N=2¹⁶, r=8, p=1 (≈0.9 s in a browser, and memory-hard so GPUs help far less than they
would against PBKDF2). **A weak passphrase is the weakest link in this model.** Ciphertext
tampering is detected: the AAD binds each record to its table and primary key, so
ciphertexts cannot be swapped between rows.

### 2.6 A malicious contact

**Can do.** Everything a person you are talking to can do: read what you send them, keep
it, screenshot it, and claim you said something else. Message deniability (unsigned
rumors) means they cannot _cryptographically prove_ to a third party that you wrote a
message — but this is a legal-deniability property, not protection against a
screenshot.

**Cannot do.** Impersonate someone else — the seal is signed by their real key and the
rumor's author must match it. Forge a message id (checked against the content hash).
Reorder your history (the `ms` tag is rejected unless it agrees with the event second,
and future-dated rumors are refused). Learn your IP address, _unless_ a direct connection
succeeds — see §3.2.

Blocking drops their messages on receipt.

### 2.7 An attacker who steals your key today

**Can do.** Read all future messages. Read _past_ messages if they also retained the
ciphertexts, because there is no forward secrecy in v1 (ADR-003). Impersonate you.

**Mitigations.** Gift wraps carry a 30-day expiration tag that honest relays honour.
The mitigation is partial and stated as such.

---

## 3. Known limitations

These are real. None are hidden in the UI.

### 3.1 No forward secrecy

NIP-44 uses static ECDH. Key compromise plus retained ciphertext exposes past messages.
Tracked for `v: 2`. See ADR-003.

### 3.2 Direct connections reveal your IP to your contact

Any peer-to-peer connection does. Turn off "use direct connections" in Settings to route
everything through relays. STUN servers also learn your IP when a direct connection is
attempted.

### 3.3 No push notifications

Delivering them needs an application server we do not run. New messages arrive when the
app is open. This is the largest usability cost of being serverless.

### 3.4 Metadata that remains

Relays learn that a given public key fetches mail, and when. Your network provider sees
which relays you use. Correlating a sender and receiver is not possible from wrap
contents, but a global passive observer watching both ends could infer timing.
**Anonymity against a global passive adversary is not a goal** — that is Tor's job.

### 3.5 Clickjacking is guarded in JavaScript, not by the browser

CSP `frame-ancestors` is ignored when delivered in a `<meta>` element, and a static host
cannot set response headers. Textor instead refuses to render when it detects it is
framed. That runs after script load rather than being enforced beforehand, so if you
self-host behind a web server you control, send `frame-ancestors 'none'` as a real header
too. See ADR-016.

### 3.6 XSS would be fatal

A script injection in this app defeats everything above. Mitigations: a strict CSP with
`script-src 'self'`, no `eval`, no inline scripts, no third-party or CDN code, React's
automatic escaping, a deliberately small dependency set, and no `dangerouslySetInnerHTML`
except for locally generated QR SVG markup.

### 3.7 Trust in the delivered bundle

See §2.2. Verify reproducible builds if this matters to you.

### 3.8 Invite substitution

An attacker who controls the channel you exchange invites over can hand you their key
instead of your contact's. The invite signature does not help — they can sign their own.
**The safety-number ceremony is the only defence**, which is why the app prompts for it
in every unverified conversation.

### 3.9 Deletion is local only

"Delete for me" removes a message from your device. It cannot unsend. Relays are asked to
expire wraps, but nothing forces them to comply. The UI never claims otherwise.

---

## 4. What we do not claim

- Not anonymous. Textor protects _content and relationships_, not the fact that you use it.
- Not resistant to a compromised device or a coerced user.
- Not resistant to a malicious build served from a compromised host.
- Not audited. Primitives come from audited `@noble/*` libraries and the protocol follows
  reviewed NIPs, but this application has not had an independent security review.

---

## 5. How to check these claims

| Claim                            | How to verify                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| No third-party requests          | Open DevTools → Network. Only origin assets and your chosen relay websockets.                   |
| Relays see only ciphertext       | Watch the WS frames in DevTools; kind-1059 events carry an ephemeral author and an opaque blob. |
| Sender is not in the wrap        | Compare the wrap's `pubkey` against your own npub — they never match, and differ per message.   |
| Nothing plaintext at rest        | DevTools → Application → IndexedDB. Every `enc` field is binary; primary keys are opaque hex.   |
| Fragments never reach the server | Send yourself an invite link and check the server log, or DevTools → Network.                   |
| Auto-lock actually drops keys    | Lock, then inspect IndexedDB: it is unreadable until you unlock again.                          |
| Relay honesty                    | Settings → Relays shows per-relay delivered/failed counts and the last error verbatim.          |

---

## 6. Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md).
