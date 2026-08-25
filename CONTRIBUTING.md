# Contributing

## What this project is

One family's archive, published so that another family can run their own. It is not a product and
it is not looking for users. That shapes what happens to a contribution:

- **Bug reports are welcome and will be read.** So are questions about standing your own copy up —
  the setup touches Cloudflare D1, R2 and Email Routing, and the places it goes wrong are worth
  writing down.
- **Pull requests are welcome but not assumed.** A fix, a correction to the documentation, a
  clearer error message: yes. A new feature will usually be declined, not because it is bad but
  because every feature is one more thing that has to still work in twenty years with nobody
  watching. That is the whole design constraint, and it is a stricter one than it sounds.
- **Forking is the expected outcome.** If you want it to do something else, it is MIT-licensed and
  the whole thing is one Worker. Take it.

The commit history begins at the point the repository was made public, on 2026-08-23. What came
before names a real family and a real domain throughout, so it stays where it is. Nothing was
squashed to hide a decision; the reasoning that survived is in ARCHITECTURE.md.

## Before you open an issue

For anything that would let somebody reach data they should not reach, use private reporting
instead — see [SECURITY.md](SECURITY.md). A public issue on that is a public exploit against
whoever has not upgraded yet.

Otherwise, say what you did, what happened, and what you expected. If it involves the site's
scheduled work, note the date and the value of `SITE_TZ`, because almost every reminder bug is a
timezone bug.

## Working on the code

```sh
cp wrangler.example.toml wrangler.toml     # then edit it
make install                                # npm ci, exactly as CI does it
make check                                  # verify, lint, then the full test suite
make dev                                    # http://localhost:8787
```

`make help` lists the rest. [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) covers D1, R2, mail, secrets
and the first account; [ARCHITECTURE.md](ARCHITECTURE.md) covers routes, the data model and why
things are the shape they are. Read the latter before changing anything structural — most of the
odd-looking decisions have a paragraph explaining what went wrong the other way.

`make check` is exactly what CI runs, in CI's order. Run it before you push and there will be no
surprises.

## What the checks enforce

`scripts/verify.sh` is not a linter; it asserts the properties this project would otherwise lose
quietly:

- **Nothing under `public/` may reference an external origin.** No CDN, no font host, no analytics
  in anything committed here. The site has to work when the third party is gone, and a family
  archive should not tell anybody who is reading it. This is a rule about what the source adds,
  not a promise about the page: the zone injects an analytics beacon downstream of the Worker, and
  `public/_headers` admits it because the Worker cannot strip it. `SECURITY.md` records that one.
- **No runtime dependencies in `package.json`.** `public/app/` is plain ES modules the browser
  loads directly. There is no build step, and adding one is a larger conversation than a pull
  request.
- **`pl.json` and `en.json` must have identical keys.** Both languages are first-class; a missing
  key is a missing sentence for half the family.
- **No stray secrets, and every required file present.**

`eslint` runs alongside it, with correctness rules only and no formatting rules. Match the style of
the file you are in rather than reformatting it.

## Conventions worth knowing

- **Every SQL statement lives in `src/db/queries.js`.** Route modules compose queries; they do not
  write SQL. This is what makes it possible to read the whole data access surface in one sitting.
  The backup dump is the one exception, and unavoidably so: it walks `sqlite_master` and writes a
  statement per table it finds. If you are adding SQL anywhere else, it belongs in `queries.js`.
- **Migrations are append-only** and numbered. Never edit one that has been applied; add the next.
- **Warnings are recomputed on read, never trusted from storage.** A row that froze when a cron
  died must not keep reading as calm.
- **History is an append-only log.** Deleting a thing does not delete the record that it existed.
- **Admin write routes require a fresh passkey** (`requireAdmin`). Routes that are merely
  administrative rather than destructive use `requireRole`. If you add a route, decide which it is.
- **Comments explain why, not what.** The what is in the code underneath them.

## Tests

```sh
make test
```

`vitest` on `@cloudflare/vitest-pool-workers`: real D1, real R2, the real Workers runtime, no mocks.
Tests read `wrangler.example.toml`, never anybody's real `wrangler.toml`.

There is no DOM environment, so view code under `public/app/views/` has no render tests. Logic that
deserves a test belongs in a module that imports without a browser — `events.js`, `graph.js`,
`tree-layout.js`, `person-form.js` are the existing examples.

Two things are worth a test more than anything else you could write one for: the backup, because it
is what outlives the author, and the scheduled mail, because it reaches real relatives and cannot
be taken back.

## Commits

Imperative mood, under 72 characters, and the message explains why rather than what. `git log` here
reads as sentences on purpose:

```text
Copy the config somewhere a lost working tree cannot take it
Make the timezone configuration, not a Polish default
Ignore the working notes so a local copy cannot be published
```

One change per commit; keep refactors out of feature commits.

## Before you push anything public

If you have forked this and are about to publish, run `make scrub-check` first. It looks for real
addresses and, from a git-ignored `.scrub-names`, real surnames — in exactly the files a public copy
would contain. Publishing is irreversible: forks and caches survive a later change of mind.
