import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { nowSec } from "../src/util.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function login(email) {
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email } });
  expect((await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } })).status).toBe(200);
  return c;
}

async function addPasskey(c, name = "phone") {
  const auth = await createAuthenticator();
  const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  const cred = await auth.create(ch.body.challenge);
  const r = await c.json("/api/me/passkeys", { method: "POST", body: { name, credential: cred } });
  return { auth, r };
}

async function stepUp(c, auth) {
  const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  const r = await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } });
  expect(r.status).toBe(200);
}

describe("passkeys", () => {
  it("family adds, lists, renames and removes a passkey; adding never grants step-up", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    const { r } = await addPasskey(c);
    expect(r.status).toBe(201);
    expect((await c.json("/api/me")).body.session.passkey_at).toBeNull();
    // The configured zone reaches the browser here or the views cannot agree with the cron on what
    // "today" is. Europe/Warsaw is what wrangler.example.toml sets, not a default: the fallback is UTC.
    expect((await c.json("/api/me")).body.tz).toBe("Europe/Warsaw");
    let list = (await c.json("/api/me/passkeys")).body.passkeys;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("phone");
    expect((await c.json(`/api/me/passkeys/${list[0].id}`, { method: "PATCH", body: { name: "laptop" } })).status).toBe(200);
    list = (await c.json("/api/me/passkeys")).body.passkeys;
    expect(list[0].name).toBe("laptop");
    expect((await c.json(`/api/me/passkeys/${list[0].id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c.json("/api/me/passkeys")).body.passkeys).toHaveLength(0);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 20, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).toContain("passkey_added");
    expect(actions).toContain("passkey_renamed");
    expect(actions).toContain("passkey_removed");
  });

  it("rejects a registration with a stale or wrong challenge", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    const auth = await createAuthenticator();
    const cred = await auth.create("not-the-challenge");
    expect((await c.json("/api/me/passkeys", { method: "POST", body: { name: "x", credential: cred } })).status).toBe(400);
  });

  it("admin needs a fresh passkey to add another one, and cannot remove the last one", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "family" });
    const c = await login("adm@x.org");
    const { auth, r } = await addPasskey(c, "first");
    expect(r.status).toBe(201);
    await q.setRole(env.DB, "adm", "admin").run();
    const second = await addPasskey(c, "second");
    expect(second.r.status).toBe(401);
    expect(second.r.body).toEqual({ error: "step_up_required" });
    await stepUp(c, auth);
    expect((await addPasskey(c, "second")).r.status).toBe(201);
    const list = (await c.json("/api/me/passkeys")).body.passkeys;
    expect((await c.json(`/api/me/passkeys/${list[0].id}`, { method: "DELETE" })).status).toBe(200);
    const last = await c.json(`/api/me/passkeys/${list[1].id}`, { method: "DELETE" });
    expect(last.status).toBe(409);
    expect(last.body).toEqual({ error: "last_passkey" });
  });

  it("removing a non-existent passkey is a 404 and writes no history", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    expect((await c.json("/api/me/passkeys/nope", { method: "DELETE" })).status).toBe(404);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 20, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).not.toContain("passkey_removed");
  });
});

describe("sessions and language", () => {
  it("lists sessions with the current one flagged, revokes one, revokes all", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c1 = await login("a@x.org");
    const c2 = await login("a@x.org");
    const list = (await c1.json("/api/me/sessions")).body.sessions;
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = list.find((s) => !s.current);
    expect((await c1.json(`/api/me/sessions/${other.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c2.json("/api/me")).status).toBe(401);
    expect((await c1.json("/api/me/sessions/revoke-all", { method: "POST", body: {} })).status).toBe(200);
    expect(c1.cookies.has("session")).toBe(false);
    expect((await c1.json("/api/me")).status).toBe(401);
  });

  it("changes language and records it", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    expect((await c.json("/api/me", { method: "PATCH", body: { lang: "en" } })).status).toBe(200);
    expect((await c.json("/api/me")).body.account.lang).toBe("en");
    expect((await c.json("/api/me", { method: "PATCH", body: { lang: "de" } })).status).toBe(400);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 20, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).toContain("lang_changed");
  });

  it("revoking a non-existent session is a 404 and writes no history", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    expect((await c.json("/api/me/sessions/nope", { method: "DELETE" })).status).toBe(404);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 20, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).not.toContain("session_revoked");
  });
});

describe("chrome identity", () => {
  it("/api/me carries the linked person and their avatar stamp, null when unlinked", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    expect((await c.json("/api/me")).body.person).toBe(null);

    await seedPerson(env, { id: "p1", first_name: "Jan", last_name: "Kowalski" });
    await q.linkAccountPerson(env.DB, "a1", "p1").run();
    expect((await c.json("/api/me")).body.person).toEqual({ id: "p1", display_name: "Jan Kowalski", avatar_at: null });

    await q.upsertAvatar(env.DB, "p1", new Uint8Array([1, 2, 3]), 1_800_000_500).run();
    expect((await c.json("/api/me")).body.person.avatar_at).toBe(1_800_000_500);
  });
});

describe("notify_events", () => {
  it("defaults on, toggles via PATCH /api/me, rejects bad values", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    expect((await c.json("/api/me")).body.account.notify_events).toBe(1);
    expect((await c.json("/api/me", { method: "PATCH", body: { notify_events: 0 } })).status).toBe(200);
    expect((await c.json("/api/me")).body.account.notify_events).toBe(0);
    expect((await c.json("/api/me", { method: "PATCH", body: { notify_events: 2 } })).status).toBe(400);
    expect((await c.json("/api/me", { method: "PATCH", body: {} })).status).toBe(400);
    expect((await c.json("/api/me", { method: "PATCH", body: { lang: "en", notify_events: 1 } })).status).toBe(200);
    const me = (await c.json("/api/me")).body.account;
    expect([me.lang, me.notify_events]).toEqual(["en", 1]);
    const acts = (await env.DB.prepare("SELECT action FROM history WHERE action IN ('lang_changed','notify_changed') ORDER BY id").all()).results.map((r) => r.action);
    expect(acts).toEqual(["notify_changed", "lang_changed", "notify_changed"]);
  });
  it("stores news_seen_at without a history row and validates it", async () => {
    await seedAccount(env, { id: "a2", email: "b@x.org" });
    const c = await login("b@x.org");
    expect((await c.json("/api/me")).body.account.news_seen_at).toBe(null);
    const seenAt = nowSec() + 30;
    expect((await c.json("/api/me", { method: "PATCH", body: { news_seen_at: seenAt } })).status).toBe(200);
    expect((await c.json("/api/me")).body.account.news_seen_at).toBe(seenAt);
    expect((await c.json("/api/me", { method: "PATCH", body: { news_seen_at: -1 } })).status).toBe(400);
    expect((await c.json("/api/me", { method: "PATCH", body: { news_seen_at: 9_999_999_999 } })).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE actor_account_id = 'a2' AND action NOT IN ('login','code_sent')").first()).n).toBe(0);
  });
});

describe("the ops summary on /api/me", () => {
  const setOps = (row) => env.DB.prepare(
    "UPDATE ops_status SET checked_at = ?, backup_at = ?, domain_expires_at = ?, card_expires_at = ?, subscription_renews_at = ?, warnings = ? WHERE id = 1")
    .bind(row.checked_at, row.backup_at, row.domain_expires_at, row.card_expires_at, row.subscription_renews_at, row.warnings).run();

  it("reaches an admin on plain /api/me, with no passkey step-up in the way", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const now = nowSec();
    await setOps({ checked_at: now, backup_at: now, domain_expires_at: null, card_expires_at: null, subscription_renews_at: now + 5 * 86400, warnings: "[]" });
    env.DOMAIN_RENEWS_AT = new Date((now + 10 * 86400) * 1000).toISOString().slice(0, 10);
    const c = await login("adm@x.org");                       // a code login: no passkey, no step-up
    const { ops } = (await c.json("/api/me")).body;
    expect(ops.warnings).toEqual(["domain_soon"]);
    expect(ops.checked_at).toBe(now);
    expect(ops.domain_expires_at).toBe(Date.parse(`${env.DOMAIN_RENEWS_AT}T00:00:00Z`) / 1000);
    expect(ops.subscription_renews_at).toBe(now + 5 * 86400);
    expect(Object.keys(ops).sort())
      .toEqual(["card_expires_at", "checked_at", "domain_expires_at", "subscription_renews_at", "warnings"]);
  });

  it("works out the warnings afresh, so a frozen row stops reading as calm", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const now = nowSec();
    // What a cron that died four days ago leaves behind: a stored all-clear that is no longer true.
    await setOps({ checked_at: now - 4 * 86400, backup_at: now, domain_expires_at: now + 300 * 86400, card_expires_at: null, subscription_renews_at: null, warnings: "[]" });
    env.DOMAIN_RENEWS_AT = "2030-01-01";                      // this test is about staleness, not the domain
    const c = await login("adm@x.org");
    expect((await c.json("/api/me")).body.ops.warnings).toEqual(["checks_stale"]);
  });

  // DOMAIN_RENEWS_AT lives in wrangler.toml and is known on every request. Copying it into the row
  // once a night meant a freshly filled-in date still read as "the site does not know" until the
  // next morning, which is how a real warning gets skimmed past.
  it("takes the domain renewal date from the settings, not from last night's row", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const now = nowSec();
    // The row carries a date ten days out, which on its own would raise domain_soon. The settings
    // say the domain is good for years, and the settings are what the site actually runs on.
    await setOps({ checked_at: now, backup_at: now, domain_expires_at: now + 10 * 86400, card_expires_at: null, subscription_renews_at: null, warnings: "[]" });
    env.DOMAIN_RENEWS_AT = "2030-01-01";
    const c = await login("adm@x.org");
    const { ops } = (await c.json("/api/me")).body;
    expect(ops.warnings).toEqual([]);
    expect(ops.domain_expires_at).toBe(Date.parse("2030-01-01T00:00:00Z") / 1000);
  });

  it("never costs an admin the whole app when the ops row cannot be read", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const c = await login("adm@x.org");
    // A migration that has not landed, a dropped column, a transient D1 error. refreshMe() rethrows
    // anything that is not a 401 and the bootstrap has no catch, so a 500 here is a blank page for
    // every admin: no chrome, no navigation, no views.
    const opsUnreadable = {
      ...env,
      DB: {
        prepare: (sql) => {
          if (sql.includes("ops_status")) throw new Error("no such table: ops_status");
          return env.DB.prepare(sql);
        },
        batch: (stmts) => env.DB.batch(stmts),
      },
    };
    const healthy = c.env;
    c.env = opsUnreadable;
    const r = await c.json("/api/me");
    c.env = healthy;
    expect(r.status).toBe(200);
    expect(r.body.account.email).toBe("adm@x.org");        // the app still has everything it renders from
    // and the banner says it could not look, rather than showing a calm, empty all-clear
    expect(r.body.ops.warnings).toEqual(["checks_unreadable"]);
    expect(r.body.ops.checked_at).toBeNull();
  });

  it("is not sent to a family member, who can do nothing about any of it", async () => {
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    const c = await login("f@x.org");
    expect((await c.json("/api/me")).body.ops).toBeNull();
  });
});
