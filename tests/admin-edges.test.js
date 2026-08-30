import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function login(email) {
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email } });
  await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } });
  return c;
}

async function adminWithFreshPasskey() {
  await seedAccount(env, { id: "adm", email: "adm@x.org", role: "family" });
  const c = await login("adm@x.org");
  const auth = await createAuthenticator();
  let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } });
  await q.setRole(env.DB, "adm", "admin").run();
  ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } });
  return c;
}

describe("invitations", () => {
  it("must name a language the site speaks", async () => {
    const c = await adminWithFreshPasskey();
    sent.length = 0;
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org", lang: "de" } })).status).toBe(400);
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org" } })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("once revoked, can be neither re-sent nor revoked again", async () => {
    const c = await adminWithFreshPasskey();
    const { body } = await c.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org", lang: "pl" } });
    expect((await c.json(`/api/admin/invitations/${body.id}`, { method: "DELETE" })).status).toBe(200);
    sent.length = 0;
    expect((await c.json(`/api/admin/invitations/${body.id}/resend`, { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json(`/api/admin/invitations/${body.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await c.json("/api/admin/invitations/never-existed/resend", { method: "POST", body: {} })).status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});

describe("accounts", () => {
  it("takes the protection flag only as 0 or 1, and needs something to change", async () => {
    const c = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    expect((await c.json("/api/admin/accounts/f1", { method: "PATCH", body: { protected: "yes" } })).status).toBe(400);
    expect((await c.json("/api/admin/accounts/f1", { method: "PATCH", body: {} })).status).toBe(400);
    expect((await c.json("/api/admin/accounts/nobody", { method: "PATCH", body: { role: "family" } })).status).toBe(404);
  });
});

describe("partners", () => {
  it("refuses a person as their own partner, and a pair that includes nobody", async () => {
    const c = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    expect((await c.json("/api/admin/people/p1/partners/p1", { method: "POST", body: { kind: "married" } })).status).toBe(400);
    expect((await c.json("/api/admin/people/p1/partners/ghost", { method: "POST", body: { kind: "married" } })).status).toBe(404);
    expect((await c.json("/api/admin/people/p1/partners/ghost", { method: "DELETE" })).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM partner_of").first()).n).toBe(0);
  });
});

describe("linking an account to a person", () => {
  it("needs both to exist, and unlinking needs a link to undo", async () => {
    const c = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    expect((await c.json("/api/admin/accounts/ghost/link", { method: "POST", body: { person_id: "p1" } })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/f1/link", { method: "POST", body: { person_id: "ghost" } })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/f1/link", { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/ghost/unlink", { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json("/api/admin/accounts/f1/unlink", { method: "POST", body: {} })).status).toBe(404);
    expect((await q.accountById(env.DB, "f1").first()).person_id).toBe(null);
  });
});

describe("creating a person", () => {
  it("needs a name of some kind, and keeps the links it is given", async () => {
    const c = await adminWithFreshPasskey();
    expect((await c.json("/api/admin/people", { method: "POST", body: { birth_place: "Łomża" } })).status).toBe(400);
    const r = await c.json("/api/admin/people", { method: "POST", body: { last_name: "Nowak", links: [{ kind: "other", url: "https://example.org/n" }] } });
    expect(r.status).toBe(201);
    const person = await env.DB.prepare("SELECT * FROM people WHERE last_name = 'Nowak'").first();
    expect(person).toMatchObject({ first_name: null, display_name: "Nowak" });
    expect((await q.linksByPerson(env.DB, person.id).all()).results).toHaveLength(1);
  });
});

describe("a gathering", () => {
  const create = (c, body) => c.json("/api/admin/gatherings", { method: "POST", body });

  it("needs a real date, on creation and on change", async () => {
    const c = await adminWithFreshPasskey();
    expect((await create(c, { place: "Ciechanowiec" })).status).toBe(400);
    expect((await create(c, { on_date: "next summer" })).status).toBe(400);
    const { body } = await create(c, { on_date: "2027-06-12" });
    expect((await c.json(`/api/admin/gatherings/${body.id}`, { method: "PATCH", body: { on_date: "12.06.2027" } })).status).toBe(400);
    expect((await c.json("/api/admin/gatherings/ghost", { method: "PATCH", body: { place: "x" } })).status).toBe(404);
  });

  it("cannot be announced or nudged when it does not exist", async () => {
    const c = await adminWithFreshPasskey();
    expect((await c.json("/api/admin/gatherings/ghost/announce", { method: "POST", body: {} })).status).toBe(404);
    expect((await c.json("/api/admin/gatherings/ghost/nudge", { method: "POST", body: {} })).status).toBe(404);
  });

  it("keeps the moment it was cancelled if cancelled again, and can be uncancelled", async () => {
    const c = await adminWithFreshPasskey();
    const { body } = await create(c, { on_date: "2027-06-12" });
    await c.json(`/api/admin/gatherings/${body.id}`, { method: "PATCH", body: { cancelled: 1 } });
    const first = (await q.gatheringById(env.DB, body.id).first()).cancelled_at;
    expect(first).toBeGreaterThan(0);
    await env.DB.prepare("UPDATE gatherings SET cancelled_at = cancelled_at - 100 WHERE id = ?").bind(body.id).run();
    await c.json(`/api/admin/gatherings/${body.id}`, { method: "PATCH", body: { cancelled: true } });
    expect((await q.gatheringById(env.DB, body.id).first()).cancelled_at).toBe(first - 100);
    await c.json(`/api/admin/gatherings/${body.id}`, { method: "PATCH", body: { cancelled: 0 } });
    expect((await q.gatheringById(env.DB, body.id).first()).cancelled_at).toBe(null);
  });

  it("takes no answer for a gathering or a person that is not there, nor for the dead", async () => {
    const c = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    await seedPerson(env, { id: "p_dead", first_name: "Władysław", deceased: 1 });
    const { body } = await create(c, { on_date: "2027-06-12" });
    expect((await c.json(`/api/admin/gatherings/ghost/rsvp/p1`, { method: "PUT", body: { coming: true, headcount: 1 } })).status).toBe(404);
    expect((await c.json(`/api/admin/gatherings/${body.id}/rsvp/ghost`, { method: "PUT", body: { coming: true, headcount: 1 } })).status).toBe(404);
    expect((await c.json(`/api/admin/gatherings/${body.id}/rsvp/p_dead`, { method: "PUT", body: { coming: false } })).status).toBe(404);
    expect((await c.json(`/api/admin/gatherings/${body.id}/rsvp/p1`, { method: "PUT", body: { coming: true, headcount: 2 } })).status).toBe(200);
    expect((await c.json(`/api/admin/gatherings/${body.id}/rsvp/p1`, { method: "PUT", body: { coming: "yes" } })).status).toBe(400);
    expect((await c.json("/api/gatherings")).body.totals).toEqual({ coming: 2, not_coming: 0, unanswered: 0 });
  });
});
