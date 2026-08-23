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
| `CLAUDE.md` | Build commands, structure, conventions (this file) |

A change to a route or a table goes in ARCHITECTURE. A change to how you operate or recover the
thing goes in DEVELOPER_GUIDE. Neither belongs in README.

## Build & Run

There is no build step. `make help` lists everything; the table below is what you will actually use.

| Command | What it does |
| ------- | ------------ |
| `make install` | `npm ci`, exactly as CI does it |
| `make test` | The whole suite in a real Workers runtime |
| `make verify` | Repository checks: required files, self-containment, no stray secrets |
| `make check` | `verify` then `test` — what CI runs, in CI's order |
| `make dev` | Serve locally on `http://localhost:8787` |
| `make release` | Run the checks, refuse a dirty tree, push so Actions deploys |
| `make scrub-check` | Look for real names and addresses in what would be published |
| `make migrations` | List D1 migrations and whether they are applied remotely |
| `make backup COOKIE=...` | Download the archive as a ZIP |

## Testing

`vitest` with `@cloudflare/vitest-pool-workers`, so tests run against real D1, R2 and the real
Workers runtime rather than mocks. Config: `vitest.config.js`, which reads
**`wrangler.example.toml`** — never your own `wrangler.toml`, so tests cannot depend on anybody's
real configuration. Helpers live in `tests/helpers/`; `makeEnv()` builds an env with a stub `EMAIL`
binding that records what was sent.

There is no DOM test environment, so `public/app/` view code has no render tests. Logic worth
testing is kept in modules that can be imported without a browser (`events.js`, `graph.js`,
`tree-layout.js`, `person-form.js`).

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
```

## Key Conventions

- **No build step and no runtime dependencies.** `public/app/` is plain ES modules loaded by the
  browser. `verify.sh` fails the build if a runtime dependency appears in `package.json` or if any
  file under `public/` references an external origin.
- **Every SQL statement lives in `src/db/queries.js`.** Route modules compose them; they do not
  write SQL.
- **The site names no domain.** Mail templates write `{app}` and `{domain}`; interface strings do
  the same. They are filled in from configuration at the point of use.
- **`pl.json` and `en.json` must have identical keys.** `verify.sh` enforces it.
- **Migrations are append-only**, numbered, and applied by CI before the Worker deploys.
- **Warnings are recomputed on read, never trusted from storage.** A row that froze when a cron died
  must not keep reading as calm.
- **History is an append-only log.** Deleting a thing does not delete the record that it existed.
- **Admin write routes require a fresh passkey** (`requireAdmin`); routes that are merely
  administrative rather than destructive use `requireRole`.
