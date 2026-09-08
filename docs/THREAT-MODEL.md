# Threat Model

What Textor protects, what it does not, and how you can check.

This document is written to be falsifiable. Where a protection is partial, it says so.
Where there is none, it says that too. A privacy claim you cannot check is marketing.

---

## 1. What we are protecting

| Asset                            | Where it lives                                                    |
| -------------------------------- | ----------------------------------------------------------------- |
| Message content                  | Encrypted end-to-end; plaintext exists only in RAM while unlocked |
| Forward-secret group messages    | MLS end to end; each key deleted once used, all of them renewed   |
| Call audio and video             | DTLS-SRTP end to end, keyed through sealed signalling; never kept |
| Identity secret key              | Encrypted in the local vault, opened only through a keyslot       |
| Social graph (who talks to whom) | Encrypted locally; blinded in database indexes                    |
| Conversation timing              | Fuzzed by up to two days on relays; hour-granular locally         |
| Display name and avatar          | Shared only with contacts unless a public profile is opted into   |

---

## 2. Adversaries

### 2.1 A relay operator

**Can see.** That a gift wrap addressed to a particular public key arrived, at a
timestamp randomised up to two days backwards, with a size rounded to a padding bucket.
The IP address of anyone connecting to fetch or publish. When a conversation is opened,
Textor connects to that contact's inbox relays ahead of sending, so those relays see a
connection at that moment — the same moment the direct-connection offer is published to
them anyway.

**Cannot see.** Message content. Who sent it — the wrap is signed by a single-use
ephemeral key that appears in exactly one event ever. Whether two wraps came from the
same sender. Display names, contact lists, or conversation structure.

**For a forward-secret group it can also see** the group's events. Each one carries the
group's random `h` id, the exact time it was sent (unlike a wrap, it is not fuzzed), its
size, and a throwaway signing key that appears once. So a relay can count one group's
messages and see when its members talk, and it sees the address of every device that asks
for that group's events. It cannot see who sent any of them, or who is in the group. The
invitation itself travels as a gift wrap, like any message.

It also sees each account's KeyPackage while invitations are on. That event is signed by
the account, so it says the account can be invited to a forward-secret group, and when
it last refreshed. Someone about to invite you fetches it first, which shows the relay
that their address was interested in your key at that moment.

**Can do.** Refuse to store or serve events. Lie about what it holds. Textor's answer is
redundancy: publishing goes to every targeted relay, a message is sent once two
independent relays accept it (one, when three or fewer are targeted), and the relay panel
shows per-relay delivery statistics so a relay that quietly stops accepting writes
becomes visible rather than silently swallowing messages. A relay that keeps failing
sinks in the ranking within a few messages rather than coasting on its history.

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
than the defaults. Connections stay open while the app is unlocked, with a small
keepalive after 10–55 s of silence, so whether the app is open is visible on the wire.

**Cannot see.** Message content or recipients.

**Mitigations.** The relay set is fully user-editable. The app makes no other network
requests — no CDN, no analytics, no fonts from a third party. It works over Tor Browser.

### 2.4 Someone with your unlocked device

**Full access.** This is out of scope for any messenger. Auto-lock (15 minutes by
default) and optional lock-on-background reduce the window. Three things are not one tap
away even then: showing the recovery phrase, adding a way to open the vault, and removing
one all ask for it to be opened again first — so a passer-by cannot quietly enrol a way
back in, or clear the way to opening instantly (ADR-054, ADR-059). A device only the
recovery phrase opens asks for the phrase. A wrong PIN given there counts towards erasing
it, as at the lock screen (ADR-058). A device that already opens instantly has nothing to
ask with, and does not pretend otherwise.

### 2.5 Someone with your locked device

**Can see.** That Textor is installed, the size of the database, the keyslots — which
kinds of unlock are set up, their salts and parameters, a credential id, how many wrong
PINs have been tried, and the sealed data key in each — and the cached language and
theme.

**Cannot see**, unless the device opens instantly: messages, contacts, or keys. Every
record body is XChaCha20-Poly1305 sealed, and primary keys are HMAC-blinded, so even the
_index structures_ do not reveal who the user talks to. Timestamps in indexes are
hour-granular.

**Can do** depends on how the device opens, and the vault is only as strong as its
weakest way in (ADR-054):

| Way in                        | At the device, through Textor's own screen                             | Against a copy of the device's data, or code running in the page                                                                         |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Open instantly                | Nothing asked.                                                         | **Nothing stops them.** The key sits beside the vault; a non-extractable key keeps it from script, not from a copy.                      |
| Biometrics, or a security key | The platform or the key verifies the person, and limits its own tries. | **Nothing stops them**, as with opening instantly: the key sits beside the vault, and only Textor's code asks for the fingerprint first. |
| PIN or pattern                | Ten wrong tries erase it.                                              | An offline guessing attack, one scrypt evaluation per guess (N=2¹⁵): **minutes** for six digits or a pattern.                            |
| Passphrase                    | As below.                                                              | An offline guessing attack, one scrypt evaluation per guess (N=2¹⁶, r=8, p=1): hours for a short human one, ages for four random words.  |
| Recovery phrase               | As below.                                                              | No offline attack: 128 random bits.                                                                                                      |

**Against a copy of the device's data, only a passphrase protects anything**, and a weak
one, a PIN, biometrics or opening instantly is the weakest link in this model. The
interface says which the device has, and each choice says what it does not stop. Ciphertext tampering is detected: the AAD binds
each record to its table and primary key, and each sealed data key to its slot, so
ciphertexts cannot be swapped between rows or slots.

### 2.6 A malicious contact

**Can do.** Everything a person you are talking to can do: read what you send them, keep
it, screenshot it, and claim you said something else. Message deniability (unsigned
rumors) means they cannot _cryptographically prove_ to a third party that you wrote a
message — but this is a legal-deniability property, not protection against a
screenshot.

Ring you, if you have accepted them — and learn from the `ringing` reply that Textor is
open on your device. Learn your IP address when you answer their call or call them,
unless calls are relayed (§3.2).

**Cannot do.** Impersonate someone else — the seal is signed by their real key and the
rumor's author must match it. Forge a message id (checked against the content hash).
Reorder your history (the `ms` tag is rejected unless it agrees with the event second,
and future-dated rumors are refused). Learn your IP address, _unless_ a direct connection
or a call connects — see §3.2. Ring you if you have not accepted them: a call from a
stranger or a message request is dropped without a reply, so it does not even learn
whether you are online. Listen in on or alter a call: its media keys are bound to the
DTLS fingerprints each side sent inside sealed frames, so substituting either end fails
the handshake.

Blocking drops their messages on receipt.

### 2.6.1 A malicious member of a group

**Can do.** Everything a contact can, towards everyone in the group. Learn every other
member's public key — a group is defined by exactly who is in it, and each message names
them all. See how everyone voted on a poll: ballots are sent to every participant, so
polls are not anonymous and the interface does not suggest they are. Rename the group, as
NIP-17 lets any member do. Backdate a vote or a checklist tick within the one-second
tolerance of the `ms` tag to win a tie on it.

**Cannot do.** Add or remove anyone: a different set of people is a different
conversation, with its own id, so there is no membership message to forge. Vote twice —
each voter's newest ballot replaces the last, and a single-choice poll counts one choice.
Vote from outside: a ballot sealed to a different set of people lands in a different room
and is not counted. Mark your message read on anyone else's behalf — a receipt only moves
the state of the member who sent it, and only for a message that was sent to them. Delete
anyone's message but their own. Make your client fan its replies out to an arbitrary
number of keys: rooms larger than eight people are refused on arrival.

A group started by someone you have not accepted arrives as a request, as a first
message from a stranger does, and nobody in it is added to your address book.

**In a forward-secret group** (ADR-049) a member can also read everything sent while
they are in it, and learn every member's public key from the group's tree. An admin can
add and remove people, rename the group and choose other admins. Each member sees these
changes as they happen.

A member **cannot**:

- write as someone else — MLS proves which member sent a message, and the author named
  inside must be that member;
- change who is in the group, or its settings, without being an admin — every device
  applies the same rules and ignores a commit that breaks them;
- read what was said before they joined, or after they were removed — each change of
  members starts a new epoch, with keys the others derive and they cannot.

A member who asks to leave is let go by an admin's commit, and an admin must hand the role
on before leaving, so a group is never left without one.

### 2.7 An attacker who steals your key today

**Can do.** Read all future messages. Read _past_ messages if they also retained the
ciphertexts, because direct messages and small groups have no forward secrecy (ADR-003).
Impersonate you.

**Forward-secret groups are different.** Their messages are not encrypted to your Nostr
key, so the key alone opens none of them. With it a thief can sign a KeyPackage, and so
be invited to new groups as you, but cannot join the groups you are already in. To read those, the
attacker needs this device's group state, which lives only in the vault. Taken from an
unlocked device, that state opens the current epoch and the two before it, and nothing
older. Once you refresh your keys — automatically within a week, or with "Refresh keys" —
what is sent next is closed to someone who only copied that state. Using the stolen state
to take part as you, before you refresh, is another matter: the group sees it as your
device.

**Mitigations.** Gift wraps carry a 30-day expiration tag that honest relays honour.
The mitigation is partial and stated as such.

---

## 3. Known limitations

These are real. None are hidden in the UI.

### 3.1 No forward secrecy for direct messages and small groups

NIP-44 uses static ECDH. Key compromise plus retained ciphertext exposes past messages.
Tracked for `v: 2`. See ADR-003.

Forward-secret groups have it (§2.7, ADR-049). They carry text only, so a photo, a voice
note, a poll or a call has to go through a direct conversation or a small group — and so
has no forward secrecy.

### 3.2 Direct connections and calls reveal your IP to your contact

Any peer-to-peer connection does. Turn off "use direct connections" in Settings to route
messages through relays. STUN servers also learn your IP when a direct connection is
attempted.

A call is peer to peer too, and there is no relay path for live audio. Calling someone
hands them your address with the offer; answering hands it over with the answer.
Declining, or letting it ring, reveals nothing — no connection, no STUN request and no
candidate exist on the receiving side before the call is accepted. To keep your address
from the people you call, add a TURN server in Settings → Calls and turn on "always relay
calls": only the relay's address is then offered, and Textor refuses to call rather than
go direct without one. The TURN operator then sees both parties' addresses and when and
how much you talk — never what is said, which stays DTLS-SRTP ciphertext. Choose one you
run or trust.

### 3.3 No push notifications

Delivering them needs an application server we do not run. New messages arrive when the
app is open. This is the largest usability cost of being serverless.

### 3.4 Metadata that remains

Relays learn that a given public key fetches mail, and when. Your network provider sees
which relays you use. A sender's self-addressed copy goes only to the sender's own inbox
relays; a relay that is also one of the recipient's still receives both wraps from one
connection within the same moment, which links the two keys for that relay operator. The
default relay set is shared, so on the defaults this applies. Correlating a sender and receiver is not possible from wrap
contents, but a global passive observer watching both ends could infer timing.
**Anonymity against a global passive adversary is not a goal** — that is Tor's job.

A group message is published as one wrap per member, all at once, from one connection.
Each wrap is individually unlinkable, but a relay that receives several of them in the
same moment can guess that the recipients are in a conversation together, and how large
it is. This is the same exposure as the self-copy above, multiplied by the group's size,
and one more reason groups are kept small.

A forward-secret group trades some of this for its keys. Its events share one `h` id and
are not fuzzed, so a relay can link all of one group's messages to each other and time
them, though not to the people who sent them (§2.1). A KeyPackage, while invitations are
on, tells anyone that the account uses forward-secret groups. Invitations can be turned
off in Settings → Privacy, which also withdraws the KeyPackage.

### 3.4.1 What a call adds

A call costs a handful of gift wraps, indistinguishable from messages on the relays.
Answering or refusing costs one more each. What remains visible is the media connection
itself: the two devices' addresses to each other (unless relayed), to a network observer
on either side, and to a TURN server when one is used. Call audio and video have forward
secrecy — DTLS negotiates fresh keys for every call — unlike messages (§3.1). Calls ring
only while Textor is open on the other device, and with one device per identity: a second
device that is open rings too, and only the first to answer connects. Each device keeps
its own record of a call in the conversation; it is never sent anywhere.

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

### 3.9 Deletion is a request

"Delete for me" removes a message from your device. It cannot unsend. "Delete for
everyone" asks the other device to delete its copy too (ADR-035). A client that honours
the request cannot be told apart from one that ignores it, and relays are asked to expire
wraps, but nothing forces them to comply. The UI never claims otherwise.

Both kinds of deletion leave a tombstone, so a copy still in flight (a retry, or a relay
replaying history) does not bring the message back. Tombstones last 45 days. After that,
a copy that old is refused anyway: nothing created before the point the table was pruned
to is ever processed (ADR-051). A backup restored after that can still contain what was
deleted.

A call has no author, so **either person in a call can delete it from the other's
conversation** (ADR-047). Nobody else can. A request to delete a message someone did not
write, or a call they were not in, is ignored.

### 3.10 Forward-secret groups rest on newer, unaudited code

MLS is a reviewed standard, but the implementation Textor uses, ts-mls, has not been
independently audited. The HPKE construction under it is composed in this codebase from
audited `@noble` primitives, and checked against a reference implementation. Where
Marmot asks for proposals ts-mls does not have, Textor uses standard MLS ones instead
(ADR-049). A race between commits heals automatically only one commit deep.

A group's state lives on one device. It is never in a backup, because a second copy of
the same member would break the group for everyone. A group's history is restored
read-only, and taking part again means being invited again.

### 3.11 How the device opens is only as strong as its weakest way in

- **Opening instantly is no protection at rest.** It is offered because full-disk
  encryption and the operating system's own lock already do this job on most phones and
  laptops, and a daily passphrase is a real cost. The choice says, in the words the user
  sees, that anyone who can use the device or copy its browser data can read the
  messages.
- **Opening instantly never sits beside another everyday way in (ADR-059).** Beside one,
  it would open the vault at every start and leave the other guarding nothing. Setting up
  biometrics, a security key, a PIN, a pattern or a passphrase deletes the instant slot and
  its key in the same write. Adding instant opening beside one is refused, and one left
  beside by an earlier build opens nothing and is dropped at start. Deleted means removed
  from the database: like any deleted IndexedDB data, its bytes may remain on disk until
  the browser compacts its storage, and a copy taken earlier still holds it.
- **Removing a way in is not retroactive.** A copy of the device's data taken before it
  was removed still holds that slot, and still opens with the old secret. Only a new data
  key would change that, which means re-encrypting every record; it is not offered.
- **Biometrics are a gate, not a lock (ADR-058).** The key sits beside the vault, sealed
  under a non-extractable WebCrypto key, and Textor's own code asks the platform to verify
  the person before using it. That stops someone who picks up the device. It does not stop
  someone who copies the browser's data, or who can run code in the page — a malicious
  extension, or a compromised build — who can use the key without asking. No key comes
  from WebAuthn, so where the platform keeps the credential, and whether it syncs, changes
  nothing: the credential carries no secret, and no cloud holds anything that opens the
  vault. A FIDO2 security key can stand at the gate instead, with the same limits.
- **"Biometrics" is whatever the platform verifies with.** WebAuthn has no way to ask for a
  fingerprint or a face alone: every system accepts its own PIN, password, passcode or
  pattern as user verification, and a device without a sensor verifies that way. Someone
  who knows the device's screen-lock PIN passes the gate. Setup and unlocking check that
  the platform reported the person verified, and a platform that answers without saying
  so — a fault seen with synced Windows Hello passkeys — is refused rather than trusted.
- **Linux has no gate of its own (ADR-059).** No browser there reaches a fingerprint
  reader; Chrome's platform authenticator on Linux is Google Password Manager, a cloud
  account. Textor offers a security key there instead.
- **A PIN or a pattern holds only at the lock screen.** Ten wrong tries there erase it,
  and the count is kept in the clear beside it, where anyone who can write to the
  browser's storage can reset it. Against a copy of the data, six digits or a pattern fall
  to a GPU in minutes. They are offered for devices without biometrics, and only where the
  recovery phrase or a passphrase will open the device after a lockout.
- **Only a passphrase protects a copy of the device's data.** Every other everyday way in
  leans on the device's own full-disk encryption and screen lock for that, and the choice
  says so.
- **A passkey way in from before ADR-058 no longer opens anything.** PRF made the
  authenticator hold the key, but on the devices people own it either could not derive one
  or synced it to Apple's or Google's cloud. The slot is dropped at start, and the lock
  screen says one was there.
- **The recovery phrase opens everything.** It always opened the identity; it now also
  opens this device's vault and any backup made from it. Keep it offline.
- **Nothing opens the vault unattended but the device key**, and even that is never handed
  to the service worker: the outbox still waits for an open tab (ADR-007).

---

## 4. What we do not claim

- Not anonymous. Textor protects _content and relationships_, not the fact that you use it.
- Not resistant to a compromised device or a coerced user.
- Not resistant to a malicious build served from a compromised host.
- Not audited. Primitives come from audited `@noble/*` libraries and the protocol follows
  reviewed NIPs, but this application has not had an independent security review, and
  neither has ts-mls, the MLS implementation forward-secret groups use.

---

## 5. How to check these claims

| Claim                            | How to verify                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No third-party requests          | Open DevTools → Network. Only origin assets and your chosen relay websockets.                             |
| Relays see only ciphertext       | Watch the WS frames in DevTools; kind-1059 events carry an ephemeral author and an opaque blob.           |
| Sender is not in the wrap        | Compare the wrap's `pubkey` against your own npub — they never match, and differ per message.             |
| Nothing plaintext at rest        | DevTools → Application → IndexedDB. Every `enc` field is binary; primary keys are opaque hex.             |
| Fragments never reach the server | Send yourself an invite link and check the server log, or DevTools → Network.                             |
| Auto-lock actually drops keys    | Lock, then inspect IndexedDB: it is unreadable until you unlock again.                                    |
| How the device opens             | DevTools → Application → IndexedDB → `meta` → `keyslots`: one entry per way in, each a sealed key.        |
| Relay honesty                    | Settings → Relays shows per-relay delivered/failed counts and the last error verbatim.                    |
| Calls are encrypted and relayed  | During a call, `chrome://webrtc-internals` shows DTLS-SRTP; with "always relay", only `relay` candidates. |
| Group events name nobody         | In the WS frames, a kind-445 event has one `h` tag, a `pubkey` never seen before, and opaque content.     |
| Everyone has the same group keys | Compare the security code in a forward-secret group's info with each member; it changes with every epoch. |

---

## 6. Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md).
