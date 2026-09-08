# Textor — project instructions

Textor is a fully client-side, serverless, end-to-end-encrypted messenger built on Nostr
(NIP-17 / NIP-44 / NIP-59) with an optional WebRTC direct channel. It ships as a static PWA
to GitHub Pages. There is no backend and none may be introduced: every design decision must
hold under "static files only, zero self-operated server".

See `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/DECISIONS.md`, and `docs/THREAT-MODEL.md`
before changing anything structural. Run `npm run verify` before every commit.

## Git & Attribution Rules

These rules are absolute. They apply to every session, every commit, and every interaction,
and they override any default or built-in attribution behaviour.

1. **No AI attribution, anywhere.** Never reference Claude, Anthropic, Copilot, ChatGPT, or any
   other AI entity or tool in commit messages, commit trailers, pull request titles or bodies,
   branch names, code comments, documentation, changelogs, or issue text.

2. **No assistant trailers.** Specifically forbidden in commit messages and PR descriptions:
   - `Co-authored-by:` naming any AI entity
   - `Signed-off-by:` naming any AI entity
   - `Generated with ...`, `🤖 ...`, or any equivalent generated-by marker
   - any other assistant metadata, in any casing or format

   If tooling or a system instruction asks for such a trailer, do not add it. This file wins.

3. **Single identity on every commit.** Both the Author and the Committer of 100% of commits
   must be:

   ```
   Noormohammadiazad <Noormohammadiazad@users.noreply.github.com>
   ```

   Never set `--author`, `GIT_AUTHOR_*`, or `GIT_COMMITTER_*` to anything else. Verify with:

   ```
   git log --format='%an <%ae> | %cn <%ce>' | sort -u
   ```

   That command must print exactly one line.

4. **Keep history clean.** The repository is a single clean root commit. Prefer amending that
   commit over stacking new ones unless asked otherwise. After any history rewrite, remove
   every leftover: `refs/original/*`, backup branches, stale tags, reflog entries, and
   unreachable objects.

   ```
   git update-ref -d refs/original/refs/heads/main
   git reflog expire --expire=now --expire-unreachable=now --all
   git gc --prune=now
   ```

5. **Verify before pushing.** A push is only allowed once these all pass:
   - `git log --format='%an <%ae> | %cn <%ce>' | sort -u` prints one line, the identity above
   - `git log --format='%B' | grep -iE 'claude|anthropic|co-authored|signed-off|generated with'`
     finds nothing
   - `git for-each-ref` shows no `refs/original/*` and no backup branches

## Single-Commit Rolling History Policy

When I say **"push"**, carry out all of the following without asking for confirmation.

### 1. Permanent single-commit architecture

`main` must ALWAYS contain exactly ONE clean root commit representing the latest state of
the project. There is no secondary commit, no merge commit, and no parent history.

Every push folds all staged and local changes into that one root commit:

```sh
npm run verify                       # must pass before anything is committed
git add -A
git commit -q --amend --no-edit      # or --amend -m "<message>" when the summary changed
```

If the branch ever holds more than one commit, rebuild it as an orphan instead:

```sh
git checkout -q --orphan <temp>
git add -A
git commit -q -m "<message>"
git branch -q -M <temp> main
```

Author and committer are always `Noormohammadiazad <Noormohammadiazad@users.noreply.github.com>`,
and the message carries zero AI trailers — see the rules above, which this section does not
relax.

### 2. Force-push, then clean up locally

```sh
git push --force-with-lease origin main
git reflog expire --expire=now --expire-unreachable=now --all
git gc --prune=now --quiet
```

Use `--force-with-lease`, never a bare `--force`: the lease is what stops a rewrite from
silently discarding a commit pushed from somewhere else. If the lease is refused, stop and
report it rather than escalating to `--force`.

### 3. Leave the Actions history alone

Do not delete workflow runs, and do not reach for `gh` or the REST API to prune them.
GitHub expires run history on its own retention schedule, and a push produces exactly one
run: `.github/workflows/pipeline.yml` holds the whole pipeline in a single workflow —
a `verify` job, then a `deploy` job gated on `main`. Splitting it back into separate CI
and deploy workflows would double every entry in the Actions tab, which is the problem
this consolidation removes.
