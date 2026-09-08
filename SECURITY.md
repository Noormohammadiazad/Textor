# Security Policy

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, rather than opening a public issue.

Please include: what you found, how to reproduce it, and what an attacker gains. A proof
of concept helps but is not required.

We aim to acknowledge within 72 hours and to ship a fix or a documented mitigation within
30 days for issues that affect confidentiality or key material.

## In scope

- Anything that exposes plaintext, key material, or the social graph
- Bypassing vault encryption, the lock, or the passphrase check
- Protocol flaws: impersonation, message forgery, replay, reordering, downgrade
- XSS, CSP bypass, or any path that executes attacker-controlled script
- Metadata leaks beyond those documented in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- Supply-chain issues in the dependency set

## Out of scope

These are documented limitations, not vulnerabilities. Please read the threat model first.

- Absence of forward secrecy in v1 — see ADR-003
- IP address disclosure to a contact over a direct connection — see §3.2
- Relays learning that a public key receives mail — see §3.4
- Attacks requiring an already-unlocked device
- A user choosing a weak passphrase
- Relays refusing to store or serve events

## Cryptography

Primitives come from the audited [`@noble`](https://github.com/paulmillr/noble-hashes)
libraries. The message layer follows NIP-17/44/59 as specified, and interoperates with
other Nostr DM clients. We do not roll our own primitives; where we build on top of them
— the vault key hierarchy, blinded indexes, the invite codec — the design is documented
in [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and covered by tests.
