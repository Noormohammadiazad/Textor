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

**Cannot see.** Message content. Who sent it — the wrap is signed by a key derived for
that wrap alone, which appears in that event and in any request to delete it, and which
cannot be linked to anything without the sender's key (ADR-074). Whether two wraps came
from the same sender. Display names, contact lists, or conversation structure.

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
sinks in the ranking within a few messages rather than coasting on its history, and one
that goes down or refuses the inbox is taken out of use and out of the announced inbox
list at once (ADR-067).

**Could also try** to be added to someone's list. Textor adds a relay on its own only
after testing it from the device, and only from its vetted list or a relay two or more
of that person's contacts read their inbox on — so no single contact, and no public
monitor, can steer an inbox onto a relay they run. Monitors' reports only nominate relays
for a test the person starts.

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

**Mitigations.** The relay set is fully user-editable. Only the relays in use, up to four
per role, are held open; the rest are not contacted unless one is needed. The app makes
no other network requests — no CDN, no analytics, no fonts from a third party. It works
over Tor Browser.

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

Delete anything in your conversation with them from your device: what they wrote, what
you wrote, and calls (ADR-061). That is Telegram's rule for a conversation between two,
and what people now expect of one. It means your copy of your own words is not evidence
they cannot remove. Keep a backup, or a screenshot, of anything you may need to show
later. They cannot touch any other conversation, a group included.

Send you any position they like, as a place or a live location: a position is a claim,
like any message. And while you share yours with them, see where you are, as often as
every ten seconds, until the time you chose runs out or you stop. Taking the share out
of the conversation ends it too (ADR-064).

**Cannot do.** Impersonate someone else — the seal is signed by their real key and the
rumor's author must match it. Forge a message id (checked against the content hash).
Reorder your history. The `ms` tag is rejected unless it agrees with the event second, and
a rumor dated more than a day ahead is refused. Within that day they choose their own
stamp and sort key, as any author does. A message keyed hours ahead sits at the bottom
only until someone answers it: anything sent after seeing it sorts after it, on every
device (ADR-063). Learn your IP address, _unless_ a direct connection
or a call connects — see §3.2. Ring you if you have not accepted them: a call from a
stranger or a message request is dropped without a reply, so it does not even learn
whether you are online. Listen in on or alter a call: its media keys are bound to the
DTLS fingerprints each side sent inside sealed frames, so substituting either end fails
the handshake. Move someone else's live location, or yours: only a share's author
moves it, and only in the conversation it went to. Keep a live location you ended looking
live: the end is believed at once, and a share never outlasts its time on their screen by
more than their clock is out.

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

Without "always relay calls", a TURN server is brought into a call only once direct
paths have failed (ADR-068), so its operator learns only of the calls that needed it.
Either side's server may carry the call: the callee's own servers join when the caller
restarts ICE.

Textor ships no TURN server and needs none (ADR-072), so no operator the user did not
choose is involved. A server added by its shared secret never sees the secret: the device makes a
password from it for each call, good for a day. What each server did is kept in the
vault, never in a backup.

Both people may talk over the relays instead of a network path (ADR-069, ADR-070), when
one presses the walkie-talkie in a conversation's header and the other answers. A call that
fails never starts this, so nothing reaches those relays because of a failed call (ADR-071).

**What is protected.**

- The voice is sealed under a key both devices derive from the call — its id and both
  sides' nonces — which never crossed a wire unsealed.
- It is published under keys made for that call alone, so relays see neither person's
  key.
- A walkie-talkie has no peer connection, so neither person learns the other's IP
  address, and no STUN or TURN server learns of it.

**What relays see.** Relays do see each side's IP address, when each one talks, and
which address is listening. Every audio packet is the same size. Three relays named in
the app, the meeting relays, see this for every such session, whoever's relays the two
people use. A relay that blocks ephemeral events is sent the same sealed packet as a
gift-wrap-kind event, tagged with the other side's throwaway key. It expires in a
minute, but a relay that ignores expiry may keep it: sealed audio under keys used once.

**Abuse limits.** Public relays defend themselves against floods, and one measured
blocked a device's address outright — its mail along with its voice. Each side therefore
sends a relay no more than fifteen events a minute, and a press stops itself after
thirty seconds.

It happens only while someone holds the button.

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

A file's chunks wait on relays at an address only someone holding the message can work out
(ADR-075). A relay can count them, and so tell a file's size to within about 48 KiB, and it
sees which addresses upload and read one address. It is not told whose file it is.

A message someone has not confirmed is sent again near day 25 and day 50 (ADR-076), so its
ciphertext may stay on relays for about 80 days rather than 30. A 7-day setting turns that off.

### 3.4.1 What a call adds

A call costs a handful of gift wraps, indistinguishable from messages on the relays.
Answering or refusing costs one more each. What remains visible is the media connection
itself: the two devices' addresses to each other (unless relayed), to a network observer
on either side, and to a TURN server when one is used — since ADR-068, only for a call
whose direct paths failed, or every call with "always relay calls" on. A call that has to
fall back costs one more offer and answer on the relays. Call audio and video have forward
secrecy — DTLS negotiates fresh keys for every call — unlike messages (§3.1). Calls ring
only while Textor is open on the other device. A second device of the same identity rings
too; the first to answer connects, and the other stops ringing (ADR-073). Each device keeps
its own record of a call in the conversation; it is never sent anywhere.

### 3.4.2 What a location adds

Coordinates, accuracy, heading and speed travel only inside gift wraps, and the map is
drawn on the device; no geocoder or search is ever asked anything (ADR-064). What
remains:

- **Streets, if you turn them on** (ADR-065). They are off by default. Once on,
  OpenStreetMap's tile servers see your IP address and the areas your maps show — often
  where a contact is or was — the time, your browser and that this is Textor. They see no
  message, name or key. Fetched tiles stay in your browser's cache, outside the vault,
  where someone with the browser profile could see which areas you looked at.

- **Your browser finds your position,** and may ask its maker's location service —
  Google, Apple or Mozilla — using nearby networks. Textor cannot see or change that, and
  says so where you share.
- **A live location has a rhythm.** While it runs, wraps go to the people it is shared
  with every ten seconds to ten minutes. A relay, and a network observer, can see that
  something is going on between you, and for how long — not what, and not where. Updates
  ask relays to drop them after an hour.
- **Handing a place to a maps application or to OpenStreetMap** tells that service the
  place. It happens only when you tap the link, and the sheet says so.
- **Your own position, shown beside someone's share,** stays on your screen. It is never
  sent.
- **A live share moves only while Textor is open.** It is remembered in the vault, not in
  backups: a restored vault shows it, but never takes it up.

### 3.4.3 What finding relays adds

Testing a relay (ADR-067) connects to it from this device. It happens when a configured
relay has died and automatic replacement is on, or when the person asks in Settings →
Relays. What it reveals:

- **To each relay tested:** this device's IP address, a query for a stranger's inbox,
  and one gift wrap from a throwaway key to another, expiring within the hour. No real
  key, name or message.
- **To the relay asked for monitor reports,** only when the person switches that on:
  that this address looked for relay reports. That relay is already one of theirs.
- **Contacts' relays** are read from the contacts already on the device. Nothing is
  fetched to find them.

A relay added by a repair then sees what any relay in use sees (§2.1).

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

"Delete for me" removes a message from your devices. It cannot unsend. "Delete for
everyone" asks the other person's device to delete its copy too (ADR-035), and asks relays
to delete the wraps of what you wrote (ADR-074). A client that honours the request cannot
be told apart from one that ignores it, a relay can ignore it, and anyone may already hold
a copy. Measured, the six default relays honour it when it is signed by the wrap's own
signer, so a message the other person wrote leaves the relays only when their device acts
on the withdrawal. Chunks at their own address go with the message when the author's
device still holds them; otherwise they stay until they expire, unreadable without the key
in the message. The UI never claims otherwise.

Both kinds of deletion leave a tombstone, so a copy still in flight (a retry, or a relay
replaying history) does not bring the message back. Tombstones last 45 days. After that,
a copy that old is refused anyway: nothing created before the point the table was pruned
to is ever processed (ADR-051). A backup restored after that can still contain what was
deleted.

**Between two people, either can delete anything in their conversation from the other's
device**: messages either of them wrote, and calls (ADR-047, ADR-061). In a group, only
the author can. Anyone else's request is ignored: a stranger's, or a group member's
reaching into another conversation.

### 3.9.1 Every device holds the same key

NIP-17 addresses a person by one key, so a second device is that key, entered from the
recovery phrase. A device cannot be locked out: whoever has the phrase reads everything the
key can, past and future, and appears as another of your devices. Settings says when another
device was last heard from, and a device you do not recognise means moving to a new
identity. A silent thief who sends nothing is not seen.

Anyone with the key can also work out every wrap's signer (ADR-074), and so ask relays to
delete your wraps. They could already read them and write as you.

What devices tell each other travels in wraps addressed to the key itself, so a relay sees a
few more of those and nothing of what they say. That now includes the contact list, which
stays on relays, sealed, for as long as those wraps do: up to 30 days.

Your own name, about and picture, your contact list with the names you gave people, who you
have blocked, and the ids of what you deleted are also kept on relays, sealed, for up to a year, so
a restore can bring them back with no other device left (ADR-077, ADR-078). A relay sees opaque
events from a key seen nowhere else, and never a kind 0. It can tie that key to you only by who
connects: one connection reading your inbox and writing the record, and how large the list is,
to within about 30 KB.

**So whoever gets your twelve words now learns who you know, even long after every message has
expired.** That outlasts anything else Textor keeps on a relay. It was weighed against losing every
contact along with your devices, and the owner chose restoring them (ADR-078). A backup file
already said the same to whoever opened it.

Someone you remove is gone from the record at once, with no mark that they were there. That holds
for what Textor writes. A relay may keep an older copy against the rules of replaceable events, or
refuse the newer one; it stays sealed, and a restore only ever uses the newest. So someone who has
your words and a relay that kept old copies could see who you once knew.

A device away for over a month misses read marks and deletions whose frames have expired,
and keeps what it held. It is told the contact list again when another device hears from it.
History older than that reaches a new device only from a backup file. A forward-secret group
lives on the device that joined it.

A relay can go on serving what you deleted: `offchain.pub` was measured refusing deletions, and
everything else, once it had seen about 14 events from new keys, for some minutes (ADR-078). A
device asks it again, and a restored device reads what was deleted before it commits anything, so
that changes nothing you see. The copy itself stays on that relay until it expires, sealed.

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

### 3.12 Every identity can be found by its Textor ID

Every identity has a Textor ID (ADR-079) and publishes a record for it, with no setting to stop
that.

- **Anyone who has an ID can find its public key**, and can see when messages reach that key,
  though not who sent them or what they say.
- **A relay can look for Textor users by trying IDs.** It holds the record addresses, and each guess
  takes two lanes of scrypt at 32 MiB. All 2^50 cost about $1 billion of rented CPUs, or about $4.6
  million and 4,200 GPU-years on owned GPUs at their theoretical best. That makes the whole list
  expensive and not impossible. A partial sweep finds a share of users for the same share of the
  price, so the cost per person found falls as Textor grows: about $10,000 of rented CPUs at 100,000
  users, or $46 at that ceiling. It finds whoever turns up, not someone in particular, and gives their
  public key and relays. It does not give their name, contacts or messages, though a relay that also
  sees who reads those inboxes (§2.1) can put the two together. **A well-funded adversary should be
  assumed able to learn that some of the people it watches use Textor.**
- **It cannot test one key directly.** An ID also takes a salt from the secret key, so knowing
  someone's public key does not give their ID, and it takes the ID to learn the salt.
- **A contact is told the salt**, sealed, so they can show your ID in place of your key. It goes as
  you add or write to them, and never to everyone at once, because a relay seeing one connection
  write to all your contacts in a moment would learn who they are. Someone who has only asked to
  talk cannot make your device do the work of checking theirs until you accept them.
- **A relay sees who looks one up**, as an address and a hash, as with an inbox lookup (§2.1). No
  DNS query or HTTP request is made, and nobody hosts a list.
- **Forging one chosen ID** takes the same 2^50 runs. A forged record appears beside the real one and
  causes a warning, unless the real one is also kept from every relay a reader asks. Two people can
  also hold one ID by chance, and whoever looks them up sees both.
- **An ID is not verification.** As with an invite (§3.8), whoever passes it on can pass on another.
  One that looks alike is cheap: matching the first five characters costs about $30. **The
  safety-number ceremony is still the only defence.**
- **A leaked phrase takes the ID with it**, and it cannot be moved to a new key. A new key means a
  new number.

## 4. What we do not claim

- Not anonymous. Textor protects _content and relationships_, not the fact that you use it.
- Not resistant to a compromised device or a coerced user.
- Not resistant to a malicious build served from a compromised host.
- Not audited. Primitives come from audited `@noble/*` libraries and the protocol follows
  reviewed NIPs, but this application has not had an independent security review, and
  neither has ts-mls, the MLS implementation forward-secret groups use.

---

## 5. How to check these claims

| Claim                            | How to verify                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| No third-party requests          | DevTools → Network: origin assets, your relay websockets, and only with street maps on, OSM tiles.                                                  |
| Relays see only ciphertext       | Watch the WS frames in DevTools; kind-1059 events carry an ephemeral author and an opaque blob.                                                     |
| Sender is not in the wrap        | Compare the wrap's `pubkey` against your own npub — they never match, and differ per message.                                                       |
| Nothing plaintext at rest        | DevTools → Application → IndexedDB. Every `enc` field is binary; primary keys are opaque hex.                                                       |
| Fragments never reach the server | Send yourself an invite link and check the server log, or DevTools → Network.                                                                       |
| Auto-lock actually drops keys    | Lock, then inspect IndexedDB: it is unreadable until you unlock again.                                                                              |
| How the device opens             | DevTools → Application → IndexedDB → `meta` → `keyslots`: one entry per way in, each a sealed key.                                                  |
| Relay honesty                    | Settings → Relays shows per-relay delivered/failed counts and the last error verbatim.                                                              |
| Only the relays in use are open  | DevTools → Network → WS: at most four relays per role connected; Settings → Relays says which.                                                      |
| Calls are encrypted and relayed  | During a call, `chrome://webrtc-internals` shows DTLS-SRTP; with "always relay", only `relay` candidates.                                           |
| TURN only when a call needs it   | In `chrome://webrtc-internals`, a call that connects directly lists no TURN server in its configuration.                                            |
| Relay voice names nobody         | In the WS frames, a kind-21690 event has no tags, a `pubkey` never seen before, and opaque content; a kind-1059 one, a `p` tag to another such key. |
| Group events name nobody         | In the WS frames, a kind-445 event has one `h` tag, a `pubkey` never seen before, and opaque content.                                               |
| Everyone has the same group keys | Compare the security code in a forward-secret group's info with each member; it changes with every epoch.                                           |

---

## 6. Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md).
