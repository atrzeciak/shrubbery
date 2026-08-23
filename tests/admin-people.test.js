import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { makeEnv, resetDb, seedAccount, seedPerson, lastCode, Client } from "./helpers/env.js";
import { fakeJpeg } from "./helpers/jpeg.js";

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

describe("admin people", () => {
  it("family cannot write; admin CRUD with history; delete refused while referenced", async () => {
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    const fam = await login("f@x.org");
    expect((await fam.json("/api/admin/people", { method: "POST", body: { first_name: "X" } })).status).toBe(403);
    const { c } = await adminWithFreshPasskey();
    expect((await c.json("/api/admin/people", { method: "POST", body: { nickname: "no names" } })).status).toBe(400);
    const created = await c.json("/api/admin/people", { method: "POST", body: { first_name: "Marek", last_name: "Nowak", birth_date: "1938-03-21", unverified: 1, links: [{ kind: "other", label: "wiki", url: "https://example.org/t" }] } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const got = (await c.json(`/api/people/${id}`)).body;
    expect(got.person.display_name).toBe("Marek Nowak");
    expect(got.person.unverified).toBe(1);
    expect(got.links).toHaveLength(1);
    expect((await c.json(`/api/admin/people/${id}`, { method: "PATCH", body: { unverified: 0, notes: "ok" } })).status).toBe(200);
    expect((await c.json(`/api/people/${id}`)).body.person.unverified).toBe(0);
    await seedPerson(env, { id: "kid", first_name: "K", last_name: "T" });
    expect((await c.json(`/api/admin/people/kid/parents/${id}`, { method: "POST", body: {} })).status).toBe(201);
    expect((await c.json(`/api/admin/people/${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await c.json(`/api/admin/people/kid/parents/${id}`, { method: "DELETE" })).status).toBe(200);
    const avatarBytes = fakeJpeg(64, 64);
    expect((await c.fetch(`/api/admin/people/${id}/avatar`, { method: "PUT", body: avatarBytes, headers: { "content-type": "image/jpeg" } })).status).toBe(200);
    const avatarRes = await c.fetch(`/api/people/${id}/avatar`);
    expect(new Uint8Array(await avatarRes.arrayBuffer())).toEqual(avatarBytes);
    expect((await c.json(`/api/admin/people/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c.json(`/api/people/${id}`)).status).toBe(404);
    expect((await c.fetch(`/api/people/${id}/avatar`)).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM person_links WHERE person_id = ?").bind(id).first()).n).toBe(0);
    const actions = (await env.DB.prepare("SELECT action FROM history WHERE target_type = 'person' ORDER BY id").all()).results.map((r) => r.action);
    expect(actions).toEqual(["person_created", "person_updated", "link_added", "link_removed", "avatar_updated", "person_deleted"]);
  });

  it("admin deletes a person who is only tagged (not owner) in someone else's media", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "owner1", first_name: "Owner", last_name: "T" });
    await seedPerson(env, { id: "tagged1", first_name: "Tagged", last_name: "T" });
    const up = await c.fetch("/api/media?kind=photo&owner=owner1&tags=tagged1", { method: "POST", body: fakeJpeg(50, 50), headers: { "content-type": "image/jpeg" } });
    expect(up.status).toBe(201);
    const { id: mediaId } = await up.json();
    expect((await c.json("/api/admin/people/tagged1", { method: "DELETE" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media_people WHERE media_id = ?").bind(mediaId).first()).n).toBe(0);
    expect((await c.json("/api/people/owner1/media")).body.media[0].id).toBe(mediaId);
  });

  it("parents: max two, no self, no duplicates; partners: upsert with kind, delete", async () => {
    const { c } = await adminWithFreshPasskey();
    for (const id of ["a", "b", "d", "kid"]) await seedPerson(env, { id, first_name: id, last_name: "T" });
    expect((await c.json("/api/admin/people/kid/parents/kid", { method: "POST", body: {} })).status).toBe(400);
    expect((await c.json("/api/admin/people/kid/parents/zz", { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json("/api/admin/people/kid/parents/a", { method: "POST", body: {} })).status).toBe(201);
    expect((await c.json("/api/admin/people/kid/parents/a", { method: "POST", body: {} })).status).toBe(409);
    expect((await c.json("/api/admin/people/kid/parents/b", { method: "POST", body: {} })).status).toBe(201);
    expect((await c.json("/api/admin/people/kid/parents/d", { method: "POST", body: {} })).status).toBe(409);
    expect((await c.json("/api/admin/people/kid/parents/d", { method: "DELETE" })).status).toBe(404);
    expect((await c.json("/api/admin/people/b/partners/a", { method: "POST", body: { kind: "married", start_year: 1962 } })).status).toBe(200);
    expect((await c.json("/api/admin/people/a/partners/b", { method: "POST", body: { kind: "divorced", start_year: 1962, end_year: 1974 } })).status).toBe(200);
    expect((await c.json("/api/admin/people/a/partners/b", { method: "POST", body: { kind: "friends" } })).status).toBe(400);
    expect((await c.json("/api/admin/people/a/partners/b", { method: "POST", body: { kind: "married", start_year: 62 } })).status).toBe(400);
    const { partners } = (await c.json("/api/people")).body;
    expect(partners).toEqual([{ a_id: "a", b_id: "b", kind: "divorced", start_year: 1962, end_year: 1974 }]);
    expect((await c.json("/api/admin/people/b/partners/a", { method: "DELETE" })).status).toBe(200);
    expect((await c.json("/api/admin/people/b/partners/a", { method: "DELETE" })).status).toBe(404);
  });

  it("admin avatar upload and account link/unlink", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "P", last_name: "One" });
    await seedPerson(env, { id: "p2", first_name: "P", last_name: "Two" });
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    await seedAccount(env, { id: "f2", email: "g@x.org" });
    expect((await c.fetch("/api/admin/people/p1/avatar", { method: "PUT", body: fakeJpeg(64, 64), headers: { "content-type": "image/jpeg" } })).status).toBe(200);
    expect((await c.fetch("/api/people/p1/avatar")).status).toBe(200);
    expect((await c.json("/api/admin/accounts/f1/link", { method: "POST", body: { person_id: "p1" } })).status).toBe(200);
    expect((await c.json("/api/admin/accounts/f1/link", { method: "POST", body: { person_id: "p2" } })).status).toBe(409);
    expect((await c.json("/api/admin/accounts/f2/link", { method: "POST", body: { person_id: "p1" } })).status).toBe(409);
    expect((await c.json("/api/admin/accounts/f2/link", { method: "POST", body: { person_id: "zz" } })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/f2/unlink", { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/f1/unlink", { method: "POST", body: {} })).status).toBe(200);
    expect((await env.DB.prepare("SELECT person_id FROM accounts WHERE id = 'f1'").first()).person_id).toBe(null);
    const acts = (await env.DB.prepare("SELECT action FROM history WHERE target_type = 'account' AND target_id = 'f1' ORDER BY id").all()).results.map((r) => r.action);
    expect(acts).toEqual(["account_linked", "account_unlinked"]);
    const accounts = (await c.json("/api/admin/accounts")).body.accounts;
    expect(accounts.find((a) => a.id === "f1")).toHaveProperty("person_id", null);
  });
});
