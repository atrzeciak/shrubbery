import { describe, expect, it } from "vitest";
import { billingFacts, CHECKS_STALE, domainRenewsAt, warningsFor } from "../src/ops/checks.js";

const NOW = 1_787_000_000;                       // a fixed clock: these are date arithmetic tests
const days = (n) => NOW + n * 86400;

function fakeFetch(status, body) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("domainRenewsAt", () => {
  it("reads the configured renewal date as Unix seconds, UTC", () => {
    expect(domainRenewsAt("2027-04-02")).toBe(Date.parse("2027-04-02T00:00:00Z") / 1000);
    expect(domainRenewsAt("  2027-04-02  ")).toBe(Date.parse("2027-04-02T00:00:00Z") / 1000);
  });

  it("is null when the value is missing, empty or not a date", () => {
    expect(domainRenewsAt(undefined)).toBe(null);
    expect(domainRenewsAt(null)).toBe(null);
    expect(domainRenewsAt("")).toBe(null);
    expect(domainRenewsAt("   ")).toBe(null);
    expect(domainRenewsAt("kiedys")).toBe(null);
  });
});

describe("warningsFor, when a backup download died", () => {
  it("warns while the last attempt is more recent than the last good backup", () => {
    const w = warningsFor({ checked_at: NOW, domain_expires_at: days(300), backup_at: days(-2), backup_failed_at: days(-1) }, NOW);
    expect(w).toContain("backup_failed");
  });

  it("says nothing once a later attempt has succeeded", () => {
    const w = warningsFor({ checked_at: NOW, domain_expires_at: days(300), backup_at: days(-1), backup_failed_at: days(-2) }, NOW);
    expect(w).not.toContain("backup_failed");
  });
});

describe("warningsFor, when nothing has checked yet", () => {
  // A site restored from backup, or freshly deployed, has an ops_status row full of nulls. Saying
  // the daily check "stopped working" there is false and frightening in exactly the situation this
  // system exists to serve: somebody standing the site back up.
  it("says the check has never run, rather than that it stopped", () => {
    const warnings = warningsFor({ checked_at: null, domain_expires_at: days(300), backup_at: NOW }, NOW);
    expect(warnings).toContain("checks_never");
    expect(warnings).not.toContain("checks_stale");
  });

  it("still says stale once a check has run and then stopped", () => {
    const warnings = warningsFor({ checked_at: NOW - CHECKS_STALE - 1, domain_expires_at: days(300), backup_at: NOW }, NOW);
    expect(warnings).toContain("checks_stale");
    expect(warnings).not.toContain("checks_never");
  });
});

describe("billingFacts", () => {
  it("reads card expiry and the next renewal", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes("/billing/profile")) {
        return new Response(JSON.stringify({ success: true, result: { card_expiry_year: 2028, card_expiry_month: 4 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [{ current_period_end: "2026-09-12T00:00:00Z" }] }), { status: 200 });
    };
    const facts = await billingFacts(fetchImpl, "token");
    expect(facts.card_expires_at).toBe(Date.parse("2028-04-30T23:59:59Z") / 1000);   // end of the stated month
    expect(facts.subscription_renews_at).toBe(Date.parse("2026-09-12T00:00:00Z") / 1000);
    expect(calls.every((u) => u.startsWith("https://api.cloudflare.com/"))).toBe(true);
  });

  it("throws when Cloudflare refuses, so a revoked token becomes a visible failing check", async () => {
    await expect(billingFacts(fakeFetch(403, { success: false }), "token")).rejects.toThrow();
  });

  it("survives a shape it does not recognise", async () => {
    const facts = await billingFacts(fakeFetch(200, { success: true, result: {} }), "token");
    expect(facts).toEqual({ card_expires_at: null, subscription_renews_at: null });
  });
});

describe("warningsFor", () => {
  it("names each threshold exactly at its boundary", () => {
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(46), backup_at: NOW }, NOW)).toEqual([]);
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(44), backup_at: NOW }, NOW)).toEqual(["domain_soon"]);
    // Literal boundary: exactly 45 days out is not yet "soon" (< 45 days), pinning DOMAIN_SOON itself.
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(45), backup_at: NOW }, NOW)).toEqual([]);

    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), card_expires_at: days(29), backup_at: NOW }, NOW)).toEqual(["card_soon"]);
    // Literal boundary: exactly 30 days out is not yet "soon" (< 30 days), pinning CARD_SOON itself.
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), card_expires_at: days(30), backup_at: NOW }, NOW)).toEqual([]);

    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: days(-61) }, NOW)).toEqual(["backup_stale"]);
    // Literal boundary: a backup exactly 60 days old is not yet stale (> 60 days), pinning BACKUP_STALE itself.
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: days(-60) }, NOW)).toEqual([]);

    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: NOW, error_since: days(-8) }, NOW)).toEqual(["check_failing"]);
    // Literal boundary: failing for exactly 7 days is not yet reported (> 7 days), pinning CHECK_FAILING itself.
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: NOW, error_since: days(-7) }, NOW)).toEqual([]);
  });

  it("says so when nothing has checked the site for days, and when nothing ever has", () => {
    // The row freezes rather than emptying when the cron stops, so staleness has to be read off
    // checked_at at the moment somebody looks, not off the warnings the last run happened to store.
    expect(warningsFor({ checked_at: NOW - CHECKS_STALE - 1, domain_expires_at: days(99), backup_at: NOW }, NOW))
      .toEqual(["checks_stale"]);
    // Literal boundary: checked exactly 3 days ago is not yet stale (> 3 days), pinning CHECKS_STALE.
    expect(warningsFor({ checked_at: NOW - CHECKS_STALE, domain_expires_at: days(99), backup_at: NOW }, NOW)).toEqual([]);
    // Never checked is its own key: see the "when nothing has checked yet" tests below.
    expect(warningsFor({ checked_at: null, domain_expires_at: days(99), backup_at: NOW }, NOW)).toEqual(["checks_never"]);
  });

  it("says so when it has no domain date at all, rather than staying silent", () => {
    expect(warningsFor({ checked_at: NOW, domain_expires_at: null, backup_at: NOW }, NOW)).toEqual(["domain_unknown"]);
    expect(warningsFor({ checked_at: NOW, backup_at: NOW }, NOW)).toEqual(["domain_unknown"]);
    // Knowing the date is what silences it — a date far out says nothing at all.
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: NOW }, NOW)).toEqual([]);
  });

  it("never warns about the monthly subscription renewal, which is not a thing to do", () => {
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), subscription_renews_at: days(1), backup_at: NOW }, NOW)).toEqual([]);
  });

  it("says nothing about the card or the subscription it has no facts for, but flags a missing backup", () => {
    expect(warningsFor({}, NOW)).toEqual(["checks_never", "domain_unknown", "backup_never"]);
    expect(warningsFor({ checked_at: NOW, domain_expires_at: days(99), backup_at: days(-3) }, NOW)).toEqual([]);
  });

  it("reports every warning that applies, in a stable order", () => {
    const all = warningsFor({ checked_at: NOW, domain_expires_at: days(10), card_expires_at: days(2), backup_at: days(-90), error_since: days(-30) }, NOW);
    expect(all).toEqual(["domain_soon", "card_soon", "backup_stale", "check_failing"]);
  });
});
