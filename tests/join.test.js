import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { makeEnv, resetDb, seedAccount, seedPerson, lastCode, Client } from "./helpers/env.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function login(email) {
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email } });
  expect((await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } })).status).toBe(200);
  return c;
}

// Seeds an admin the way production is bootstrapped: family → passkey → promoted → step-up.
async function adminWithFreshPasskey(email = "adm@x.org") {
  await seedAccount(env, { id: "adm", email, role: "family" });
  const c = await login(email);
  const auth = await createAuthenticator();
  let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  expect((await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } })).status).toBe(201);
  await q.setRole(env.DB, "adm", "admin").run();
  ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  expect((await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } })).status).toBe(200);
  return { c, auth };
}

const FORM = { first_name: "Anna", last_name: "Zielińska", birth_date: "1985", parent_text: "Barbara", email: "ola@x.org", message: "hi", lang: "en" };

describe("join request", () => {
  it("validates, honeypot swallows, code mailed, confirm → pending + admins mailed", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin", lang: "pl" });
    await seedAccount(env, { id: "adm2", email: "adm2@x.org", role: "admin", lang: "en" });
    const c = new Client(env);
    expect((await c.json("/api/join/request", { method: "POST", body: { ...FORM, birth_date: "85" } })).status).toBe(400);
    expect((await c.json("/api/join/request", { method: "POST", body: { ...FORM, first_name: "" } })).status).toBe(400);
    expect((await c.json("/api/join/request", { method: "POST", body: { ...FORM, website: "http://spam" } })).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await c.json("/api/join/request", { method: "POST", body: FORM })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ola@x.org");
    expect(c.cookies.has("join_nonce")).toBe(true);
    const code = lastCode(sent);
    expect((await c.json("/api/join/confirm", { method: "POST", body: { ...FORM, code: "000000" } })).status).toBe(400);
    const ok = await c.json("/api/join/confirm", { method: "POST", body: { ...FORM, code } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, auto: false });
    expect(c.cookies.has("join_nonce")).toBe(false);
    const notices = sent.slice(1);
    expect(notices.map((m) => m.to).sort()).toEqual(["adm2@x.org", "adm@x.org"]);
    expect(notices.find((m) => m.to === "adm@x.org").subject).toContain("Anna Zielińska");
    expect(notices.find((m) => m.to === "adm2@x.org").text).toContain("Anna Zielińska");
    const rows = (await env.DB.prepare("SELECT status, email FROM join_requests").all()).results;
    expect(rows).toEqual([{ status: "pending", email: "ola@x.org" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE action = 'join_requested'").first()).n).toBe(1);
  });

  it("rate limits after 3 requests per email/IP", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const c = new Client(env);
    for (let i = 0; i < 3; i++) expect((await c.json("/api/join/request", { method: "POST", body: FORM })).status).toBe(200);
    expect((await c.json("/api/join/request", { method: "POST", body: FORM })).status).toBe(429);
  });

  it("existing member email: request is silent, confirm is 409", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedAccount(env, { id: "f1", email: "ola@x.org" });
    const c = new Client(env);
    expect((await c.json("/api/join/request", { method: "POST", body: FORM })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("confirm 409s when an account exists for the email by confirm time", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const c = new Client(env);
    expect((await c.json("/api/join/request", { method: "POST", body: FORM })).status).toBe(200);
    const code = lastCode(sent);
    await seedAccount(env, { id: "f1", email: "ola@x.org" });
    const confirm = await c.json("/api/join/confirm", { method: "POST", body: { ...FORM, code } });
    expect(confirm.status).toBe(409);
    expect(confirm.body).toEqual({ error: "conflict" });
  });

  it("known person email → auto-approved, invitation mailed, first login links the person", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedPerson(env, { id: "p_ola", first_name: "Anna", last_name: "Zielińska", email: "ola@x.org" });
    const c = new Client(env);
    await c.json("/api/join/request", { method: "POST", body: FORM });
    const ok = await c.json("/api/join/confirm", { method: "POST", body: { ...FORM, code: lastCode(sent) } });
    expect(ok.body).toEqual({ ok: true, auto: true });
    const inv = sent.find((m) => m.to === "ola@x.org" && m.text.includes("example.org/app/"));
    expect(inv).toBeTruthy();
    expect(sent.find((m) => m.to === "adm@x.org").text).toMatch(/auto/i);
    expect((await env.DB.prepare("SELECT status FROM join_requests").first()).status).toBe("auto");
    sent.length = 0;
    const s = await login("ola@x.org");
    const me = await s.json("/api/me/person");
    expect(me.status).toBe(200);
    expect(me.body.person.id).toBe("p_ola");
    // admins hear about the first login, by the joiner's name, once
    const joined = sent.filter((m) => m.to === "adm@x.org" && /Anna Zielińska/.test(m.subject));
    expect(joined).toHaveLength(1);
    expect(joined[0].text).toContain("ola@x.org");
    sent.length = 0;
    await login("ola@x.org");
    expect(sent.filter((m) => m.to === "adm@x.org" && /Anna Zielińska/.test(m.subject))).toHaveLength(0);
  });
});

describe("admin review", () => {
  async function pending() {
    const c = new Client(env);
    await c.json("/api/join/request", { method: "POST", body: FORM });
    await c.json("/api/join/confirm", { method: "POST", body: { ...FORM, code: lastCode(sent) } });
    sent.length = 0;
  }
  it("lists with match, approve to existing person → invitation + link on login", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p_ola", first_name: "Anna", last_name: "zielińska", birth_date: "1985-02" });
    await pending();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    const fam = await login("f@x.org");
    expect((await fam.json("/api/admin/join-requests")).status).toBe(403);
    sent.length = 0;
    const list = await c.json("/api/admin/join-requests");
    expect(list.status).toBe(200);
    expect(list.body.requests[0]).toMatchObject({ status: "pending", email: "ola@x.org", match: "p_ola" });
    const id = list.body.requests[0].id;
    expect((await c.json(`/api/admin/join-requests/${id}/approve`, { method: "POST", body: { person_id: "nope" } })).status).toBe(404);
    const ap = await c.json(`/api/admin/join-requests/${id}/approve`, { method: "POST", body: { person_id: "p_ola" } });
    expect(ap.status).toBe(200);
    expect(ap.body).toEqual({ person_id: "p_ola" });
    expect(sent.map((m) => m.to)).toEqual(["ola@x.org"]);
    expect((await c.json(`/api/admin/join-requests/${id}/approve`, { method: "POST", body: { person_id: "p_ola" } })).status).toBe(404);
    // p_ola now has an active invitation (from the approval above) — approving another
    // pending request for the same email with create:true must not issue a second one.
    await pending();
    const idB = (await c.json("/api/admin/join-requests")).body.requests.find((r) => r.status === "pending").id;
    expect((await c.json(`/api/admin/join-requests/${idB}/approve`, { method: "POST", body: { create: true } })).status).toBe(409);
    const s = await login("ola@x.org");
    expect((await s.json("/api/me/person")).body.person.id).toBe("p_ola");
    // p_ola now has an account — approving a different request onto the same person must 409.
    const c3 = new Client(env);
    await c3.json("/api/join/request", { method: "POST", body: { ...FORM, email: "ola3@x.org" } });
    await c3.json("/api/join/confirm", { method: "POST", body: { ...FORM, email: "ola3@x.org", code: lastCode(sent) } });
    const idC = (await c.json("/api/admin/join-requests")).body.requests.find((r) => r.email === "ola3@x.org").id;
    expect((await c.json(`/api/admin/join-requests/${idC}/approve`, { method: "POST", body: { person_id: "p_ola" } })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE action = 'join_approved'").first()).n).toBe(1);
  });
  it("approve with create makes an unverified person; reject records the note", async () => {
    const { c } = await adminWithFreshPasskey();
    await pending();
    const id = (await c.json("/api/admin/join-requests")).body.requests[0].id;
    const ap = await c.json(`/api/admin/join-requests/${id}/approve`, { method: "POST", body: { create: true } });
    expect(ap.status).toBe(200);
    const p = (await c.json(`/api/people/${ap.body.person_id}`)).body.person;
    expect(p).toMatchObject({ first_name: "Anna", last_name: "Zielińska", birth_date: "1985", email: "ola@x.org", unverified: 1 });
    expect(p.notes).toContain("Barbara");
    await pending();
    const id2 = (await c.json("/api/admin/join-requests")).body.requests.find((r) => r.status === "pending").id;
    expect((await c.json(`/api/admin/join-requests/${id2}/reject`, { method: "POST", body: { note: "unknown" } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status, note FROM join_requests WHERE id = ?").bind(id2).first())).toEqual({ status: "rejected", note: "unknown" });
  });
});
