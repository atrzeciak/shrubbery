# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. It opens a thread only the maintainer can see.

Please do not open a public issue for anything that would let somebody reach data they should not
reach. Every copy of this code that matters is somebody's family archive, and the gap between a
public report and a deployed fix is a gap in which real photographs are exposed.

Expect an answer within a week. There is one maintainer and no service-level agreement; if a week
passes in silence, assume the mail was missed rather than ignored, and say so again.

## What is worth reporting

This is a small, login-only site, and its threat model is narrow. Reports that matter most:

- Anything that returns another family's data, or any data at all, without a session.
- Anything that lets a non-admin reach an admin route, or an admin reach a destructive route
  without the fresh passkey assertion `requireAdmin` is supposed to demand.
- A way to make the backup produce an archive that cannot be restored, or that omits data silently.
  A backup believed good and found empty years later is the worst failure this project has.
- Anything in the login code or passkey path: one-time codes, rate limits, session cookies, the
  WebAuthn verification in `src/auth/webauthn.js`, which is written here rather than taken from a
  library and is therefore the most likely place for a real flaw.
- Anything that leaks a home address. Addresses are the one genuinely sensitive field in the data
  model, and the news feed and gathering payloads are built to exclude them.

## What is already known and accepted

These are decisions, not oversights. A report that describes one of them will be closed as such:

- **Everyone signed in sees everything.** Privacy here is editorial: sensitive things are not
  entered in the first place. There is no per-person visibility model and there will not be one.
- **`GET /api/health` is public** and unauthenticated on purpose. It answers `{ok, checks_stale}`
  and nothing else, so an outside watchdog can tell "the Worker and its database are alive" from
  "DNS still resolves" without holding a session.
- **The daily cron and the monthly letter are not authenticated to the reader.** Their absence is
  the alarm, which means a silenced letter is a real failure — but a forged one is not a threat
  worth the machinery.
- **`DOMAIN_RENEWS_AT` is typed in by hand.** A lookup that silently stops answering is worse than
  a date somebody retypes once a year.

## Running your own copy

If you stand one up, two things are on you rather than on this code:

- **`IP_HASH_SECRET` must be set and must be random.** It salts the hashed IP addresses in the
  history log. Unset or guessable, the hashes are reversible by anyone who can read the table.
- **Keep `CF_BILLING_TOKEN` minimal** — Account→Billing:Read and User→User Details:Read, nothing
  more. Cloudflare's "read everything" preset includes D1, R2 and Secrets Store, which is far more
  blast radius than a billing check needs.

`wrangler.toml` is git-ignored because it names your domain, your database and your bucket. If you
fork this repository, keep it that way, and check with `make scrub-check` before you publish
anything.
