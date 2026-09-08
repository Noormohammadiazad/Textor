# Textor

**A private messenger that is nothing but a web page.**

No accounts. No phone numbers. No servers we operate. No analytics. Your identity is a
key that is generated in your browser and never leaves it; your messages are encrypted
before they touch the network; everything is stored encrypted on your own device.

Textor is a static site. There is no Textor backend to compel, subpoena, breach, or
shut down — because there isn't one.

**[Open Textor →](https://noormohammadiazad.github.io/Textor/)**

---

## How it works

Your identity is a secp256k1 keypair, backed up as twelve words. Messages are
end-to-end encrypted and **gift-wrapped** ([NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)),
then published to public [Nostr](https://nostr.com) relays that act as dumb encrypted
mailboxes.

A relay sees: _an event addressed to some public key, at a fuzzy time, containing an
opaque blob, signed by a throwaway key that appears exactly once._ It cannot see the
message, who sent it, your name, or your contacts. When both people happen to be online,
the app opportunistically upgrades to a direct WebRTC channel for instant delivery — but
every message still goes to relays, so nothing is ever lost to a dropped connection.

Relays are public infrastructure that anyone can run and that you can change at any
time. That is the point: no single party, including us, can stop the app working or read
anything.

```
   Your device                    Public relays                  Their device
┌────────────────┐          ┌───────────────────────┐         ┌────────────────┐
│  plaintext     │          │                       │         │  plaintext     │
│      ↓         │          │   opaque ciphertext   │         │      ↑         │
│  NIP-44 seal   │──wss──▶  │   ephemeral author    │──wss──▶ │  unwrap+verify │
│  gift wrap     │          │   fuzzed timestamp    │         │                │
│      ↓         │          │                       │         │      ↑         │
│ encrypted vault│          └───────────────────────┘         │ encrypted vault│
└────────┬───────┘                                            └───────┬────────┘
         └──────────── direct WebRTC when both online ────────────────┘
                    (still NIP-44 encrypted on top of DTLS)
```

---

## Features

- **End-to-end encrypted messaging**, online or offline — messages wait on relays
- **Small groups** of up to eight people, as NIP-17 defines them: no group server, one
  sealed copy per member, and delivery tracked per person
- **Forward-secret groups** of up to a hundred people, using MLS in the
  [Marmot](https://github.com/marmot-protocol/marmot) format. Keys change with every
  change of members and at least weekly, and are deleted once used. Admins, a security
  code to compare, and text only. Loaded only by those who use them
- **Polls and shared checklists**, sealed and counted on each device — no tally server
- **Voice and video calls**, one to one: mute, camera on and off, front and back camera,
  screen sharing. Signalled through sealed gift wraps shaped after NIP-AC, carried as
  DTLS-SRTP media, and loaded only when a call is placed or rings. Bring a TURN server
  for strict networks, or to keep your IP address from the person you call
- **No metadata for relays to sell**: ephemeral senders, fuzzed timestamps, padded sizes
- **Encrypted local vault** — XChaCha20-Poly1305, blinded indexes, and LUKS-style
  keyslots: open it with Touch ID, Face ID, Windows Hello, your phone's fingerprint or a
  FIDO2 security key (a key kept on the device, used once you are verified — nothing in
  any cloud), a PIN or a pattern, a passphrase, or instantly, which is only ever the one
  way in. Each is labelled with what it protects against, and your twelve-word recovery
  phrase opens it whichever you chose, so a forgotten PIN or passphrase no longer costs
  your history
- **Delivery states** you can trust: queued → sent → delivered → read, each with a
  text label rather than an unlabelled tick
- **Safety-number verification** to confirm you have the right person's key
- **Direct connections** for instant delivery and typing indicators, with graceful fallback
- **Contact exchange** by QR code, invite link, or `npub` — no directory server
- **Relay panel** showing real per-relay delivery statistics and errors
- **Encrypted export/import** for moving between devices — a backup opens with its own
  passphrase or with your recovery phrase, so a new device needs only the file and the
  twelve words
- **Drafts, replies, copy, and local delete** — with delete labelled honestly as
  local-only, because nothing can unsend a message
- **Installable PWA**, works offline
- **Persian and English**, full RTL, light and dark themes
- **No push notifications** — that would need a server. Stated plainly, not hidden.

---

## Try it

The live app: **<https://noormohammadiazad.github.io/Textor/>**

Or run it yourself:

```bash
npm install
npm run dev
```

Open two browsers (or two ports, so they get separate storage), create an identity in
each, and exchange invite links.

## Build

```bash
npm run build
```

Output is a static `dist/` directory. Serve it from anywhere — GitHub Pages, any static
host, a USB stick, IPFS.

## Verify

```bash
npm run verify        # typecheck, lint, format, tokens, tests with coverage
npm run relays:probe  # check which public relays actually accept anonymous writes
```

---

## Deploying your own

Textor is designed to be forked and self-hosted; running your own copy is the strongest
answer to "why should I trust your build?".

1. Fork this repository.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow typechecks, lints, checks formatting, runs the tests,
   builds, verifies the bundle, and deploys. A build that fails any of those is not
   deployed.
4. Nothing to configure for the base path. A project page served from `/<repo>/` and a
   user page served from `/` are both handled automatically, and CI fails the build if
   the manifest and the asset paths ever disagree.
5. **Custom domain (optional).** Add a repository variable `CUSTOM_DOMAIN` under
   _Settings → Secrets and variables → Actions → Variables_ with the hostname, and point
   your DNS at GitHub Pages. It is a variable rather than a committed `CNAME` file so
   forks do not inherit a domain they do not own — a committed `CNAME` would tell Pages
   to serve every fork at someone else's address and break their own URL.

There are no secrets to set and no backend to configure. The in-app "source code" link
and crash-report hint point at your repository automatically, so a fork never invites
people to audit somebody else's code.

### Browser support

| Browser              | Minimum |
| -------------------- | ------- |
| Chrome / Edge        | 108     |
| Firefox              | 110     |
| Safari (macOS / iOS) | 15.4    |

Required: IndexedDB, `crypto.getRandomValues`, WebSocket, `TextEncoder`. Everything else
degrades rather than blocking startup — WebRTC (falls back to relays), notifications,
the QR camera, backup compression, storage persistence, unlocking with biometrics
(WebAuthn user verification) and opening instantly (WebCrypto) are each feature-detected. If
a hard requirement is missing the app says which one instead of showing a blank page.

### After deploying

Two things are worth checking once, on the live site:

- **Install it.** The app should offer to install; an installed PWA is also the state in
  which browsers most reliably grant persistent storage.
- **Open Settings → Data.** It states whether the browser has agreed to keep your vault.
  If it says it may delete your data, export an encrypted backup — there is no server
  copy to restore from.

No secrets, no environment variables, no build-time configuration. There is nothing to
configure because there is no backend.

---

## Documentation

| Document                                       | Contents                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md)         | Wire format, validation rules, delivery semantics, storage layout      |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)       | Why each choice was made, including ones revised during implementation |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Adversaries, guarantees, limitations, and how to check them            |
| [`SECURITY.md`](SECURITY.md)                   | Reporting a vulnerability                                              |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)           | Development setup and standards                                        |

---

## Honest limitations

A messenger that only lists its strengths is not being straight with you.

- **No forward secrecy for direct messages and small groups.** If your key is stolen
  _and_ an adversary kept old ciphertexts, they can read past messages. Wraps carry a
  30-day expiration request, and the protocol is versioned so a ratchet can land later.
  Forward-secret groups do not have this limit, but carry text only.
  ([ADR-003, ADR-049](docs/DECISIONS.md))
- **No push notifications.** They require an application server. Messages arrive when the
  app is open. ([ADR-007](docs/DECISIONS.md))
- **Direct connections and calls reveal your IP to your contact**, as any peer-to-peer
  connection does. Direct connections can be turned off, and calls can be forced through
  a TURN server you provide.
- **Calls need both people to have Textor open**, and behind symmetric NAT or a strict
  firewall they need a TURN server — Textor runs none. The call screen says which applies.
  ([ADR-046](docs/DECISIONS.md))
- **Metadata is reduced, not eliminated.** Relays learn that a key receives mail, and
  roughly when. Anonymity against a global observer is not a goal.
- **Not independently audited.** The primitives are audited (`@noble/*`) and the protocol
  follows reviewed NIPs, but this application has not had a security review.
- **A malicious build would defeat everything.** Verify reproducible builds if that
  matters to you, or host your own.

---

## Technology

TypeScript · React 19 · Vite 8 · Dexie (IndexedDB) · Zustand · `nostr-tools` ·
`@noble/{ciphers,curves,hashes}` · `ts-mls` · `qr` · Workbox

Fourteen direct runtime dependencies, no CDN, no analytics, no tracking, no telemetry. Every
byte is served from the app's own origin under a strict Content-Security-Policy.

---

## Licence

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a network service, you
must publish your changes — the point being that users of a privacy tool should always be
able to read the code they are actually running.
