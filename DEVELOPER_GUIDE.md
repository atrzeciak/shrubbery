# Developer Guide

## Standing one up

You need a Cloudflare account (the free plan is enough) and a domain on it.

```sh
cp wrangler.example.toml wrangler.toml       # then edit: domain, database, bucket
npm ci
npx wrangler d1 create <your-database>       # put the printed id into wrangler.toml
npx wrangler r2 bucket create <your-bucket>
npx wrangler d1 migrations apply <your-database> --remote
npx wrangler deploy
```

`wrangler.toml` is git-ignored on purpose: it names your domain, your database and your bucket.
That also means the working tree holds the only copy, so `make release` runs `make save-config`
first: it copies the file to `~/.secrets/<this directory's name>/` (override with `CONFIG_STORE=`)
and keeps the last five versions under `versions/`, newest by name. To recover after a fresh clone,
copy it back: `cp ~/.secrets/$(basename $PWD)/wrangler.toml .`

### Mail

Set up **Cloudflare Email Routing** with a verified sender and bind it as `EMAIL`. Without it the
site runs but nobody can sign in, because the login code arrives by mail. Two senders are used — one
for login codes, one for everything a relative reads. Naming them with `MAIL_LOGIN_FROM` and
`MAIL_FAMILY_FROM` is optional; see the configuration table in ARCHITECTURE for what they fall back
to. Whichever two addresses end up in use must be verified in Email Routing, or nothing sends.

### The first account

There is no bootstrap screen, on purpose. Insert one row:

```sh
npx wrangler d1 execute <your-database> --remote --command \
  "INSERT INTO accounts (id, email, role, lang, created_at, founder, notify_events)
   VALUES ('$(openssl rand -hex 8)', 'you@example.org', 'admin', 'pl', strftime('%s','now'), 1, 1)"
```

Then sign in with a login code and add a passkey. Admin write routes need a fresh passkey, so
without one you can read the admin screens but change nothing.

### Secrets

| Secret | Why |
| ------ | --- |
| `IP_HASH_SECRET` | Salts the hashed IPs in the history log |
| `CF_BILLING_TOKEN` | Optional. Two permissions only: Account→Billing:Read, User→User Details:Read |

```sh
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HASH_SECRET
```

Keep the billing token minimal. Cloudflare's "read everything" preset includes D1, R2 and Secrets
Store — far more blast radius than a billing check needs.

## Local development

```sh
make dev            # http://localhost:8787
```

Put this in a git-ignored `.dev.vars` so login codes print to the terminal instead of an inbox:

```ini
APP_ORIGIN=http://localhost:8787
MAIL_ECHO=1
```

Tests pin their own origin and ignore `.dev.vars`.

## Deploying

Pushing to `main` deploys. GitHub Actions verifies, tests, writes `wrangler.toml` from a secret,
applies migrations, and only then deploys the Worker — migrations always land before the code that
needs them.

Because the real configuration is not in the repository, CI needs:

| Kind | Name | Value |
| ---- | ---- | ----- |
| Secret | `WRANGLER_TOML` | The entire contents of your `wrangler.toml` |
| Secret | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Deploy credentials |
| Secret | `D1_DATABASE` | Database name, for the migration step |
| Secret | `SITE_URL`, `SITE_NAME` | For the watchdog workflow |

All of them are secrets, not variables: on a public repository the Actions logs are public, and
GitHub masks secrets in them but does not mask variables.

`make release` runs the checks, refuses a dirty tree or a non-`main` branch, and pushes.

## Operations

### Backups

Admin → Backup streams everything as one ZIP: the database as SQL, every file, and restore
instructions. Keep a copy off Cloudflare. A test restores the dump on every commit, so the file is
known to work. `make backup COOKIE=...` does the same from a terminal.

### Watching the site

Three things watch it, deliberately from different places:

1. **The site watches itself** nightly and shows what it finds at the top of the admin's view.
2. **A monthly letter** to every admin on the first. Its *absence* is the signal.
3. **A GitHub Actions watchdog** from outside Cloudflare, since nothing inside Cloudflare can report
   that Cloudflare stopped. A failed scheduled run mails whoever last edited the cron line — if that
   is not the right person, edit that line so it is.

### Telling the family about a gathering

Two buttons on the gathering page, each usable **once** and each behind a confirmation, because both
write to real relatives and neither can be taken back:

- **Announce** — to every living person with an address on file. Anyone without an account also gets
  an invitation created, so the mail can tell them how to get in.
- **Nudge** — appears only after announcing, and reaches only people who have not answered.

The week-before and day-of reminders need no button: they come from the daily cron, honour the same
reminder opt-in as birthdays, and are protected by the same guard against a cron that fires twice.

Most of a family will never sign in, so the guest list is worked by hand: an admin can record
anyone's answer, and the list marks it as entered by somebody else.

### Keeping the domain

`DOMAIN_RENEWS_AT` is typed in by hand and **must be updated after every renewal**. There is no
lookup: `.eu` publishes no usable RDAP endpoint, and a lookup that silently stops answering is worse
than a date somebody retypes once a year. Empty or unreadable says so out loud rather than lying.

## Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| Banner says the daily check has never run | Normal on a fresh deploy or restore until 05:00 UTC. Still there the next day means the cron is not firing. |
| Banner says the site does not know the renewal date | `DOMAIN_RENEWS_AT` is empty. It is read on every request, so filling it in takes effect on deploy. |
| Backup downloads as a 0-byte file | The stream failed. The site now records the time and reason; look at the backup panel. |
| Nobody can sign in | The `EMAIL` binding or its verified sender. Login codes go out over it. |
| `SQLITE_AUTH` from a query | You are reading a Cloudflare-internal table (`_cf_*`). They exist only on remote D1. |
| Admin write returns `step_up_required` | Correct: add a passkey and use it, then retry. |

## Before publishing anything

`make scrub-check` looks for real addresses and, from a git-ignored `.scrub-names`, real surnames —
in exactly the files a public copy would contain. Publishing is irreversible; forks and caches
survive a later change of mind.
