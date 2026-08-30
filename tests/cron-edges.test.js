import { beforeEach, describe, expect, it } from "vitest";
import { capturingErrors } from "./helpers/logging.js";
import * as q from "../src/db/queries.js";
import { gatheringReminders, runDaily } from "../src/events/cron.js";
import { runOps } from "../src/ops/daily.js";
import { billingFacts } from "../src/ops/checks.js";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";
import { createAuthenticator } from "./helpers/authenticator.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

const WEEK_BEFORE = new Date("2027-06-05T05:00:00Z");

async function gatheringWithTwoAccounts() {
  await seedPerson(env, { id: "p1", first_name: "Jan" });
  await seedPerson(env, { id: "p2", first_name: "Anna" });
  await seedAccount(env, { id: "a1", email: "one@x.org" });
  await seedAccount(env, { id: "a2", email: "two@x.org" });
  await q.linkAccountPerson(env.DB, "a1", "p1").run();
  await q.linkAccountPerson(env.DB, "a2", "p2").run();
  await q.insertGathering(env.DB, { id: "g1", onDate: "2027-06-12", place: null, note: null, createdBy: "a1", createdAt: 1_800_000_000 }).run();
}

const noticeRow = (action, target, at, details) => env.DB.prepare(
  "INSERT INTO history (at, actor_account_id, action, target_type, target_id, details, ip_hash) VALUES (?, NULL, ?, 'x', ?, ?, NULL)").bind(at, action, target, details).run();

// One mailbox refusing must cost exactly that one mail, and the record must say who was reached.
const failingFor = (address) => ({ async send(m) { if (m.to === address) throw new Error(`${address} bounced`); sent.push(m); } });

describe("gatheringReminders", () => {
  it("keeps mailing after one address fails, and records only what went out", async () => {
    await gatheringWithTwoAccounts();
    env.EMAIL = failingFor("one@x.org");
    const { logged } = await capturingErrors(() => gatheringReminders(env, WEEK_BEFORE));
    expect(logged.map((e) => e.message)).toEqual(["one@x.org bounced"]);
    expect(sent.map((m) => m.to)).toEqual(["two@x.org"]);
    const { results } = await env.DB.prepare("SELECT details FROM history WHERE action = 'gathering_notice_sent'").all();
    expect(results.map((r) => JSON.parse(r.details).to_account)).toEqual(["a2"]);
  });

  it("swallows a database that is down, so the rest of the nightly run survives", async () => {
    const broken = { ...env, DB: { prepare() { throw new Error("no database"); } } };
    const { logged } = await capturingErrors(() => gatheringReminders(broken, WEEK_BEFORE));
    expect(logged.map((e) => e.message)).toEqual(["no database"]);
    expect(sent).toHaveLength(0);
  });

  // Only a notice sent today counts as sent: one from yesterday, or one whose record cannot be read,
  // must not silence today's reminder.
  it("is not put off by yesterday's notice or one whose details are not JSON", async () => {
    await gatheringWithTwoAccounts();
    const at = Math.floor(WEEK_BEFORE.getTime() / 1000);
    await noticeRow("gathering_notice_sent", "g1", at, "not json");
    await noticeRow("gathering_notice_sent", "g1", at - 86400, JSON.stringify({ to_account: "a2", in_days: 7 }));
    await gatheringReminders(env, WEEK_BEFORE);
    expect(sent.map((m) => m.to).sort()).toEqual(["one@x.org", "two@x.org"]);
  });
});

describe("runDaily", () => {
  const NOW = new Date("2026-06-15T05:00:00Z");

  it("is not put off by yesterday's notice or one whose details are not JSON", async () => {
    await seedPerson(env, { id: "me", first_name: "Ja" });
    await seedPerson(env, { id: "mom", first_name: "Mama", birth_date: "1960-06-22" });
    await q.insertParent(env.DB, "mom", "me").run();
    await seedAccount(env, { id: "acc", email: "me@x.org" });
    await q.linkAccountPerson(env.DB, "acc", "me").run();
    const at = Math.floor(NOW.getTime() / 1000);
    await noticeRow("event_notice_sent", "mom", at, "not json");
    await noticeRow("event_notice_sent", "mom", at - 86400, JSON.stringify({ to_account: "acc", in_days: 7 }));
    await runDaily(env, NOW);
    expect(sent.map((m) => m.to)).toEqual(["me@x.org"]);
  });
});

describe("announcing a gathering", () => {
  async function login(email) {
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email } });
    await c.json("/api/auth/code/request", { method: "POST", body: { email } });
    await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } });
    return c;
  }

  it("reaches everyone else when one relative's mailbox is dead, and counts only them", async () => {
    await seedPerson(env, { id: "p1", first_name: "Jan", email: "one@x.org" });
    await seedPerson(env, { id: "p2", first_name: "Anna", email: "two@x.org" });
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "family" });
    const c = await login("adm@x.org");
    const auth = await createAuthenticator();
    let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } });
    await q.setRole(env.DB, "adm", "admin").run();
    ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } });
    const { body } = await c.json("/api/admin/gatherings", { method: "POST", body: { on_date: "2027-06-12" } });
    sent.length = 0;
    env.EMAIL = failingFor("one@x.org");
    const { value: r, logged } = await capturingErrors(() => c.json(`/api/admin/gatherings/${body.id}/announce`, { method: "POST", body: {} }));
    expect(r.status).toBe(200);
    expect(logged.map((e) => e.message)).toEqual(["one@x.org bounced"]);
    expect(sent.map((m) => m.to)).toEqual(["two@x.org"]);
    const row = await env.DB.prepare("SELECT details FROM history WHERE action = 'gathering_announced'").first();
    expect(JSON.parse(row.details)).toEqual({ sent: 1 });
  });
});

describe("runOps on the first of the month", () => {
  const SEP_1 = new Date("2026-09-01T05:00:00Z");
  const noFetch = async () => { throw new Error("no network call expected in this test"); };

  it("reaches the second admin when the first one's mailbox is dead", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedAccount(env, { id: "adm2", email: "second@x.org", role: "admin" });
    env.EMAIL = failingFor("adm@x.org");
    const { logged } = await capturingErrors(() => runOps(env, SEP_1, noFetch));
    expect(logged.map((e) => e.message)).toEqual(["adm@x.org bounced"]);
    expect(sent.map((m) => m.to)).toEqual(["second@x.org"]);
    expect((await q.opsStatus(env.DB).first()).checked_at).toBe(Math.floor(SEP_1.getTime() / 1000));
  });
});

describe("billingFacts", () => {
  const fetchWith = (subs) => async (url) => new Response(JSON.stringify({ success: true, result: url.includes("/billing/profile") ? {} : subs }), { status: 200 });

  it("picks the earliest renewal out of several subscriptions", async () => {
    const facts = await billingFacts(fetchWith([{ current_period_end: "2026-11-01T00:00:00Z" }, { current_period_end: "2026-09-12T00:00:00Z" }, {}]), "token");
    expect(facts.subscription_renews_at).toBe(Date.parse("2026-09-12T00:00:00Z") / 1000);
  });

  it("knows no renewal date when the list is empty or every entry lacks one", async () => {
    expect((await billingFacts(fetchWith([]), "token")).subscription_renews_at).toBe(null);
    expect((await billingFacts(fetchWith([{ current_period_end: "soon" }]), "token")).subscription_renews_at).toBe(null);
  });
});
