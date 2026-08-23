import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import * as q from "../src/db/queries.js";
import worker from "../src/worker.js";
import { makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";

// The one line that runs the whole alarm system every night. Everything else in this branch is tested
// through runOps and runDaily directly; this is the only test that proves the wiring exists at all.
// Set here rather than inherited from wrangler.toml, where it is deliberately empty until somebody
// fills in the real registrar date: this test asserts the date reaches the row, not the config value.
const RENEWS_AT = "2027-04-02";
const RENEWS_AT_SEC = Date.parse(`${RENEWS_AT}T00:00:00Z`) / 1000;

let env, sent;
beforeEach(async () => {
  ({ env, sent } = makeEnv());
  env.DOMAIN_RENEWS_AT = RENEWS_AT;
  await resetDb(env);
});
afterEach(() => { vi.unstubAllGlobals(); });

// 2026-06-15 05:00 UTC == 2026-06-15 in Warsaw, and Mama's birthday is seven days out.
const SCHEDULED_TIME = Date.parse("2026-06-15T05:00:00Z");

async function familyWithABirthdayComing() {
  await seedPerson(env, { id: "me", first_name: "Ja", last_name: "T" });
  await seedPerson(env, { id: "mom", first_name: "Mama", last_name: "T", birth_date: "1960-06-22" });
  await q.insertParent(env.DB, "mom", "me").run();
  await seedAccount(env, { id: "acc", email: "me@x.org", lang: "pl" });
  await q.linkAccountPerson(env.DB, "acc", "me").run();
}

async function runScheduled(withEnv) {
  const ctx = createExecutionContext();
  await worker.scheduled({ scheduledTime: SCHEDULED_TIME, cron: "0 5 * * *" }, withEnv, ctx);
  await waitOnExecutionContext(ctx);
}

const status = () => env.DB.prepare("SELECT * FROM ops_status WHERE id = 1").first();

describe("the nightly scheduled handler", () => {
  it("writes the ops status and sends the birthday reminders in one pass", async () => {
    await familyWithABirthdayComing();
    await runScheduled(env);

    const row = await status();
    expect(row.checked_at).toBeGreaterThan(0);
    expect(row.domain_expires_at).toBe(RENEWS_AT_SEC);
    expect(sent.map((m) => m.to)).toEqual(["me@x.org"]);
    expect(sent[0].subject).toContain("Mama");
  });

  it("keeps the birthday reminders when the billing check fails", async () => {
    // The branch's most important safety claim: the alarm system shares a cron with the reminders the
    // family actually notices, and a Cloudflare outage must never cost anyone a birthday.
    await familyWithABirthdayComing();
    vi.stubGlobal("fetch", async () => { throw new Error("cloudflare is down"); });
    await runScheduled({ ...env, CF_BILLING_TOKEN: "a-token" });

    expect(sent.map((m) => m.to)).toEqual(["me@x.org"]);       // the reminder still went out
    const row = await status();
    expect(row.error).toMatch(/cloudflare is down/);           // and the failure was recorded, not swallowed
    expect(row.checked_at).toBeGreaterThan(0);
    expect(row.error_since).toBeGreaterThan(0);
  });

  it("still records the ops status when the reminders themselves blow up", async () => {
    await familyWithABirthdayComing();
    const broken = { ...env, EMAIL: { async send() { throw new Error("the mail provider is down"); } } };
    await runScheduled(broken);
    expect((await status()).checked_at).toBeGreaterThan(0);
  });
});
