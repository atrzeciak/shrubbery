import * as q from "../db/queries.js";
import { json, nowSec } from "../util.js";
import { CHECKS_STALE } from "../ops/checks.js";

// Deliberately public and deliberately tiny: an outside watchdog must be able to tell "the Worker and
// its database are alive" from "DNS still resolves", without holding a session or learning anything.
//
// checks_stale is reported next to ok rather than folded into it, on purpose. The site being up and the
// daily cron having stopped are two different facts: a site that answers while nothing checks it any
// more is exactly the failure this endpoint exists to make visible, and collapsing them would either
// hide it or cry wolf about the site being down.
export async function health(_request, env) {
  try {
    const status = await q.opsStatus(env.DB).first();
    const checkedAt = status?.checked_at ?? null;
    const stale = typeof checkedAt !== "number" || nowSec() - checkedAt > CHECKS_STALE;
    return json({ ok: true, checks_stale: stale });
  } catch {
    return json({ ok: false }, 500);
  }
}

export const routes = [["GET", /^\/api\/health$/, health]];
