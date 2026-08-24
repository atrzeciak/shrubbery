import { beforeEach, describe, expect, it } from "vitest";
import { capturingErrors } from "./helpers/logging.js";
import { makeEnv, resetDb, seedAccount } from "./helpers/env.js";
import { runOps } from "../src/ops/daily.js";

// The fixture owns its inputs. wrangler.toml's DOMAIN_RENEWS_AT is deliberately empty until somebody
// fills in the real registrar date, and these tests are about parsing a date, not about what the
// config file happens to say today.
const RENEWS_AT = "2027-04-02";
const RENEWS_AT_SEC = Date.parse(`${RENEWS_AT}T00:00:00Z`) / 1000;

const { env, sent } = makeEnv();
env.DOMAIN_RENEWS_AT = RENEWS_AT;
beforeEach(async () => { await resetDb(env); sent.length = 0; });

const AUG_14 = new Date("2026-08-14T05:00:00Z");     // an ordinary day
const SEP_1 = new Date("2026-09-01T05:00:00Z");      // the day the letter goes out

// With no billing token configured, runOps must not reach the network at all.
const noFetch = async () => { throw new Error("no network call expected in this test"); };

const status = async () => env.DB.prepare("SELECT * FROM ops_status WHERE id = 1").first();

describe("runOps", () => {
  it("records what it learned and stays quiet on an ordinary day", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await runOps(env, AUG_14, noFetch);
    const row = await status();
    expect(row.checked_at).toBeGreaterThan(0);
    expect(row.domain_expires_at).toBe(RENEWS_AT_SEC);              // parsed from DOMAIN_RENEWS_AT
    expect(JSON.parse(row.warnings)).toEqual(["backup_never"]);
    expect(row.error).toBe(null);
    expect(sent).toHaveLength(0);
  });

  it("says it does not know the domain date when the config is empty, which is what ships today", async () => {
    // wrangler.toml carries DOMAIN_RENEWS_AT = "" until the real registrar date is known. Pinning the
    // fixture above would otherwise leave the shipping configuration exercised nowhere.
    for (const value of ["", "   ", undefined]) {
      await resetDb(env);
      await runOps({ ...env, DOMAIN_RENEWS_AT: value }, AUG_14, noFetch);
      const row = await status();
      expect(row.domain_expires_at, String(value)).toBeNull();
      expect(JSON.parse(row.warnings), String(value)).toContain("domain_unknown");
    }
  });

  it("mails every admin on the first of the month, and nobody else", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedAccount(env, { id: "adm2", email: "second@x.org", role: "admin", lang: "en" });
    await seedAccount(env, { id: "fam", email: "fam@x.org", role: "family" });
    await runOps(env, SEP_1, noFetch);
    expect(sent.map((m) => m.to).sort()).toEqual(["adm@x.org", "second@x.org"]);
    const pl = sent.find((m) => m.to === "adm@x.org");
    expect(pl.text).toMatch(/example\.org/);
    expect(pl.text).toContain("poszedł do 2 osób");                 // how many people this alarm reached
    expect(sent.find((m) => m.to === "second@x.org").text).toContain("went to 2 people");
  });

  it("tells a lone admin that they are the only person this letter reaches", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await runOps(env, SEP_1, noFetch);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("jesteś jedynym administratorem strony");
  });

  it("remembers when a failing check started, and forgets once it succeeds", async () => {
    const failing = async () => { throw new Error("boom"); };
    const withToken = { ...env, CF_BILLING_TOKEN: "t" };
    await runOps(withToken, AUG_14, failing);
    const first = await status();
    expect(first.error).toMatch(/./);
    expect(first.error_since).toBeGreaterThan(0);

    await runOps(withToken, new Date("2026-08-15T05:00:00Z"), failing);
    expect((await status()).error_since).toBe(first.error_since);      // the run of failures, not the latest

    const working = async (url) => {
      if (url.includes("billing/profile")) return new Response(JSON.stringify({ success: true, result: { card_expiry_year: 2029, card_expiry_month: 1 } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    };
    await runOps(withToken, new Date("2026-08-16T05:00:00Z"), working);
    const healed = await status();
    expect(healed.error).toBe(null);
    expect(healed.error_since).toBe(null);
  });

  it("skips billing entirely when no token is configured", async () => {
    let billingCalls = 0;
    const counting = async () => {
      billingCalls++;
      return new Response("{}", { status: 200 });
    };
    await runOps(env, AUG_14, counting);
    expect(billingCalls).toBe(0);
    expect((await status()).error).toBe(null);
  });

  it("never lets its own failure break the run, and leaves the last good row alone", async () => {
    await env.DB.prepare("UPDATE ops_status SET checked_at = ?, backup_at = ?, domain_expires_at = ?, warnings = ? WHERE id = 1")
      .bind(1_780_000_000, 1_779_000_000, 1_790_000_000, JSON.stringify(["backup_stale"])).run();
    // A write that cannot land — a migration that has not run, a column that is not there yet — must
    // leave what the last good run recorded exactly as it was, not half-rewrite or empty it.
    const brokenWrite = {
      ...env,
      DB: { prepare: (sql) => (/^\s*UPDATE/i.test(sql) ? { bind: () => ({ run: () => Promise.reject(new Error("no such column")) }) } : env.DB.prepare(sql)) },
    };
    const { value, logged } = await capturingErrors(() => runOps(brokenWrite, AUG_14, noFetch));
    expect(value).toBeUndefined();
    expect(logged).toHaveLength(1);                       // swallowed, but not silently
    expect(logged[0].message).toMatch(/no such column/);

    const row = await status();
    expect(row.checked_at).toBe(1_780_000_000);
    expect(row.backup_at).toBe(1_779_000_000);
    expect(row.domain_expires_at).toBe(1_790_000_000);
    expect(JSON.parse(row.warnings)).toEqual(["backup_stale"]);
  });
});
