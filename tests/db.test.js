import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { historyStmt, historyStmtIfPasskeyGone, record, hashIp } from "../src/history.js";
import { seedPerson, seedAccount } from "./helpers/env.js";

const db = env.DB;
const T = 1_800_000_000;
const TABLES = ["history", "rate_limits", "invitations", "login_codes", "sessions", "passkeys", "accounts"];

beforeEach(async () => {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
});

describe("queries", () => {
  it("inserts and finds an account by email (lowercasing is the caller's job)", async () => {
    await q.insertAccount(db, { id: "a1", email: "anna@example.org", role: "family", lang: "pl", createdAt: T, invitedBy: null }).run();
    const row = await q.accountByEmail(db, "anna@example.org").first();
    expect(row.id).toBe("a1");
    expect(row.role).toBe("family");
    expect(await q.accountByEmail(db, "nobody@example.org").first()).toBeNull();
  });

  it("changes role, language and disables", async () => {
    await q.insertAccount(db, { id: "a1", email: "a@x.org", role: "family", lang: "pl", createdAt: T, invitedBy: null }).run();
    await q.setRole(db, "a1", "admin").run();
    await q.setLang(db, "a1", "en").run();
    await q.disableAccount(db, "a1", T + 5).run();
    const row = await q.accountById(db, "a1").first();
    expect([row.role, row.lang, row.disabled_at]).toEqual(["admin", "en", T + 5]);
  });

  it("finds only an active invitation", async () => {
    await q.insertAccount(db, { id: "adm", email: "adm@x.org", role: "admin", lang: "pl", createdAt: T, invitedBy: null }).run();
    await q.insertInvitation(db, { id: "i1", email: "new@x.org", lang: "en", invitedBy: "adm", createdAt: T, expiresAt: T + 100 }).run();
    expect((await q.activeInvitationByEmail(db, "new@x.org", T + 50).first()).id).toBe("i1");
    expect(await q.activeInvitationByEmail(db, "new@x.org", T + 200).first()).toBeNull();
    await q.revokeInvitation(db, "i1", T + 10).run();
    expect(await q.activeInvitationByEmail(db, "new@x.org", T + 50).first()).toBeNull();
  });

  it("history: newest first, paged by id, filtered by actions and account", async () => {
    await db.batch([
      historyStmt(db, { actor: null, action: "code_sent", targetType: "email", targetId: "x", details: {}, ipHash: "h" }),
      historyStmt(db, { actor: "a1", action: "invite_accepted", targetType: "account", targetId: "a1", details: { email: "a@x.org" }, ipHash: "h" }),
      historyStmt(db, { actor: "a1", action: "login", targetType: "account", targetId: "a1", details: {}, ipHash: "h" }),
    ]);
    const all = (await q.listHistory(db, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
    expect(all.map((r) => r.action)).toEqual(["login", "invite_accepted", "code_sent"]);
    const page2 = (await q.listHistory(db, { beforeId: all[0].id, limit: 1, actions: null, accountId: null }).all()).results;
    expect(page2.map((r) => r.action)).toEqual(["invite_accepted"]);
    const family = (await q.listHistory(db, { beforeId: null, limit: 10, actions: ["invite_accepted"], accountId: null }).all()).results;
    expect(family.map((r) => r.action)).toEqual(["invite_accepted"]);
    const byAccount = (await q.listHistory(db, { beforeId: null, limit: 10, actions: null, accountId: "a1" }).all()).results;
    expect(byAccount).toHaveLength(2);
    expect(JSON.parse(byAccount[1].details)).toEqual({ email: "a@x.org" });
  });

  it("insertHistoryIfPasskeyGone only records once the passkey is actually gone", async () => {
    await q.insertAccount(db, { id: "a1", email: "a@x.org", role: "family", lang: "pl", createdAt: T, invitedBy: null }).run();
    await q.insertPasskey(db, { id: "p1", accountId: "a1", credentialId: "c1", publicKey: "k", counter: 0, transports: null, name: "n", createdAt: T }).run();
    const entry = { actor: "a1", action: "passkey_removed", targetType: "account", targetId: "a1", details: {}, ipHash: "h" };
    await db.batch([historyStmtIfPasskeyGone(db, entry, "p1", T)]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM history").first()).n).toBe(0);
    await db.batch([q.deletePasskey(db, "p1", "a1"), historyStmtIfPasskeyGone(db, entry, "p1", T)]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM history").first()).n).toBe(1);
  });

  it("record() writes one row", async () => {
    await record(db, { actor: null, action: "login_failed", targetType: "email", targetId: "e", details: {}, ipHash: "h" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM history").first()).n).toBe(1);
  });

  it("history is append-only: no query updates or deletes it", () => {
    for (const fn of Object.values(q)) {
      expect(fn.toString()).not.toMatch(/(update|delete\s+from)\s+history/i);
    }
  });

  it("hashIp changes daily, never contains the ip, and is salted per-secret", async () => {
    const env1 = { IP_HASH_SECRET: "s" };
    const a = await hashIp(env1, "203.0.113.5", T);
    const b = await hashIp(env1, "203.0.113.5", T + 86400);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const env2 = { IP_HASH_SECRET: "other" };
    expect(await hashIp(env2, "203.0.113.5", T)).not.toBe(a);
  });

  it("0002: people tables exist and accounts.person_id is unique", async () => {
    await seedPerson(env, { id: "p1", first_name: "A", last_name: "B" });
    await seedAccount(env, { id: "a1", email: "a1@x.org" });
    await seedAccount(env, { id: "a2", email: "a2@x.org" });
    await q.linkAccountPerson(env.DB, "a1", "p1").run();
    await expect(q.linkAccountPerson(env.DB, "a2", "p1").run()).rejects.toThrow();
    expect((await q.personRefCount(env.DB, "p1").first()).n).toBe(1);
  });

  it("0004: owned media blocks person deletion, tags do not", async () => {
    await seedPerson(env, { id: "own", first_name: "O", last_name: "P" });
    await seedPerson(env, { id: "tag", first_name: "T", last_name: "P" });
    await seedAccount(env, { id: "up", email: "up@x.org" });
    await q.insertMedia(env.DB, { id: "m1", ownerPersonId: "own", kind: "photo", caption: null, year: null, contentType: "image/jpeg", size: 10, uploadedBy: "up", createdAt: 1 }).run();
    await q.insertMediaTag(env.DB, "m1", "tag").run();
    expect((await q.personRefCount(env.DB, "own").first()).n).toBe(1);
    expect((await q.personRefCount(env.DB, "tag").first()).n).toBe(0);
    expect((await q.countOwnedMedia(env.DB, "own").first()).n).toBe(1);
    expect((await q.mediaForPerson(env.DB, "tag").all()).results.map((m) => m.id)).toEqual(["m1"]);
  });
});
