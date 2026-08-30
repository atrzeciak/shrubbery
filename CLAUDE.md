# CLAUDE.md

## Project Overview

A private family archive: a family tree, photographs and documents, birthday and anniversary
reminders, a gathering with a guest list, and a backup anyone can take away. One Cloudflare Worker
serving a small public landing page and a login-only app, with D1 for data and R2 for files.

The code names no site of its own. Everything site-specific lives in `wrangler.toml`, which is
git-ignored; `wrangler.example.toml` is the tracked template.

## Key Documentation

| File | Owns |
| ---- | ---- |
| `ARCHITECTURE.md` | Routes, data model, integrations, configuration, security, testing |
| `DEVELOPER_GUIDE.md` | Setup, secrets, troubleshooting, operational procedures |
| `README.md` | What this is, how to stand one up, how to run the tests |
| `CONTRIBUTING.md` | What contributions are welcome, the checks, the conventions, commits |
| `SECURITY.md` | How to report a vulnerability; what is a known and accepted decision |
| `CLAUDE.md` | Build commands, structure, conventions (this file) |

A change to a route or a table goes in ARCHITECTURE. A change to how you operate or recover the
thing goes in DEVELOPER_GUIDE. Neither belongs in README. A change to what an outside
contributor has to know goes in CONTRIBUTING.

## Build & Run

There is no build step. `make help` lists everything; the table below is what you will actually use.

| Command | What it does |
| ------- | ------------ |
| `make install` | `npm ci`, exactly as CI does it |
| `make test` | The whole suite in a real Workers runtime |
| `make verify` | Repository checks: required files, self-containment, no stray secrets |
| `make lint` | `eslint`, correctness rules only — no formatting rules |
| `make check` | `verify`, `lint`, then `test` — what CI runs, in CI's order |
| `make coverage` | The suite with a per-file coverage table |
| `make dev` | Serve locally on `http://localhost:8787` |
| `make release` | Run the checks, refuse a dirty tree, tag the commit, push so Actions deploys |
| `make save-config` | Copy `wrangler.toml` to the config store, keeping the last 5 versions |
| `make scrub-check` | Look for real names and addresses in what would be published |
| `make migrations` | List D1 migrations and whether they are applied remotely |
| `make backup COOKIE=...` | Download the archive as a ZIP |

## Testing

`vitest` with `@cloudflare/vitest-pool-workers`, so tests run against real D1, R2 and the real
Workers runtime rather than mocks. Config: `vitest.config.js`, which reads
**`wrangler.example.toml`** — never your own `wrangler.toml`, so tests cannot depend on anybody's
real configuration. Helpers live in `tests/helpers/`; `makeEnv()` builds an env with a stub `EMAIL`
binding that records what was sent.

Two vitest projects: `workers` runs `tests/*.test.js` in the Workers runtime; `dom` runs
`tests/dom/*.test.js` under `happy-dom` for `public/app/`. `tests/dom/setup.js` stubs `fetch`
(i18n files from disk, everything else to `mockApi(routes)` from `tests/dom/helpers.js`, which
records the calls). `make coverage` prints the per-file table; lines sit near 100% and a change
should keep them there. Tests must never add hooks or exports to app code for their own sake.

## Project Structure

```text
src/            the Worker
  worker.js       router and the scheduled handler
  api/            one module per route group; each exports `routes`
  auth/           sessions, login codes, WebAuthn
  db/             queries.js (every SQL statement) and migrations/
  people/         person field rules, JPEG handling
  media/          upload rules
  ops/            the site's checks on its own survival
  events/         reminder crons and relationship scope
  backup/         SQL dump and ZIP writer
  mail.js         every message the site sends
public/         static assets, served by the Worker
  app/            the app: plain browser modules, no build, no dependencies
  app/i18n/       pl.json and en.json, which must stay key-for-key identical
scripts/        verify.sh and the dev-only seeding scripts
tests/          vitest suites
screenshots/    images the README embeds; invented families only, never real data
```

## Key Conventions

- **No build step and no runtime dependencies.** `public/app/` is plain ES modules loaded by the
  browser. `verify.sh` fails the build if a runtime dependency appears in `package.json` or if any
  file under `public/` references an external origin.
- **Every SQL statement lives in `src/db/queries.js`.** Route modules compose them; they do not
  write SQL. `src/backup/dump.js` is the one exception and has to be: it reads `sqlite_master`
  and emits a statement per table it finds, so the set cannot be fixed in advance.
- **The site names no domain.** Mail templates write `{app}` and `{domain}`; interface strings do
  the same. They are filled in from configuration at the point of use.
- **`pl.json` and `en.json` must have identical keys.** `verify.sh` enforces it.
- **Migrations are append-only**, numbered, and applied by CI before the Worker deploys.
- **Warnings are recomputed on read, never trusted from storage.** A row that froze when a cron died
  must not keep reading as calm.
- **History is an append-only log.** Deleting a thing does not delete the record that it existed.
- **Admin write routes require a fresh passkey** (`requireAdmin`); routes that are merely
  administrative rather than destructive use `requireRole`.
