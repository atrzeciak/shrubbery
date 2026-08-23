import * as q from "../db/queries.js";
import { sendOpsLetter } from "../mail.js";
import { billingFacts, domainRenewsAt, warningsFor } from "./checks.js";

// The site's own read of whether it will still be here next month. It runs after the birthday
// reminders and can never interrupt them: everything below is inside one try, and a failure is
// recorded rather than thrown.
export async function runOps(env, now = new Date(), fetchImpl = fetch) {
  try {
    const at = Math.floor(now.getTime() / 1000);
    const previous = (await q.opsStatus(env.DB).first()) || {};

    let billing = { card_expires_at: previous.card_expires_at ?? null, subscription_renews_at: previous.subscription_renews_at ?? null };
    let error = null;
    if (env.CF_BILLING_TOKEN) {
      try {
        billing = await billingFacts(fetchImpl, env.CF_BILLING_TOKEN);
      } catch (e) {
        error = String(e && e.message ? e.message : e).slice(0, 200);
      }
    }

    const status = {
      checked_at: at,                 // this run is the check, so warningsFor never calls it stale here
      backup_at: previous.backup_at ?? null,
      domain_expires_at: domainRenewsAt(env.DOMAIN_RENEWS_AT),
      card_expires_at: billing.card_expires_at,
      subscription_renews_at: billing.subscription_renews_at,
      // A run of failures keeps its first date: check_failing counts days, not attempts.
      error_since: error ? (previous.error_since ?? at) : null,
    };
    const warnings = warningsFor(status, at);

    await q.setOpsStatus(env.DB, {
      checkedAt: at,
      domainExpiresAt: status.domain_expires_at,
      cardExpiresAt: status.card_expires_at,
      subscriptionRenewsAt: status.subscription_renews_at,
      warnings: JSON.stringify(warnings),
      error,
      errorSince: status.error_since,
    }).run();

    if (now.getUTCDate() === 1) {
      const { results: admins } = await q.listAdmins(env.DB).all();
      for (const a of admins) {
        try {
          // The count goes in the letter: one recipient is itself the thing to worry about.
          await sendOpsLetter(env, a.email, a.lang, { ...status, warnings, at, admins: admins.length });
        } catch (e) {
          console.error(e);        // one dead mailbox must not silence the others
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
}
