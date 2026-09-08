# Contributing

## Setup

```bash
npm install
npm run dev
```

Testing two-way messaging needs two origins, because browser storage is per-origin:

```bash
npm run dev                       # first identity  → localhost:5173
npx vite --port 5179              # second identity → localhost:5179
```

Create an identity in each and exchange invite links.

## Before opening a pull request

```bash
npm run verify   # typecheck + lint + tests
```

## Standards

**Layering is enforced by review.** `src/core/` is UI-framework-free and must stay
testable in Node. The UI never touches transports or Dexie directly — it goes through
the store, which goes through the repository, which goes through the vault. If domain
logic ends up in a screen component, move it into `core/`.

**Every dependency is a liability.** This is an app whose security rests on no
third-party code running unexpectedly. Adding a runtime dependency needs a justification
in the pull request. The router and the i18n layer were hand-rolled for exactly this
reason.

**Nothing sensitive outside a ciphertext.** New database columns must be either
blinded, coarse, or genuinely uninformative. If you add an indexed field, say in the pull
request what an attacker who copies the database off a locked device would learn from it.

**Comment the "why".** The code is dense with intent — validation checks name the attack
they prevent, parameter choices cite the measurement behind them. Match that; do not
narrate what the code already says.

**Tests carry their reasoning.** Crypto, protocol, and vault code get the heaviest
coverage. A test for a security property should say which property, so a future reader
knows what breaks if it is deleted.

**Honesty is a feature.** If a change weakens a guarantee, update
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) in the same pull request. If it reverses a
recorded decision, add an ADR rather than editing the old one.

## Adding a language

1. Copy `src/i18n/en.ts` to `src/i18n/<code>.ts` and translate the values.
2. Register it in `src/i18n/index.ts` (`DICTIONARIES`, `LOCALE_NAMES`, `LOCALE_DIRECTION`).
3. Add the code to `LocaleCode` in `src/core/models/types.ts`.

Missing keys are compile errors. For a right-to-left language, set the direction and
check the chat view, the composer, and the relay panel — those are where mirroring bugs
show up.

## Adding a default relay

Run `npm run relays:probe` first. A relay only qualifies if it accepts anonymous
kind-1059 **writes** — several serve reads to anyone but silently reject publishes from
keys outside a web of trust, which makes them useless as an inbox (see ADR-012).
