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

async function linkedMember() {
  await seedPerson(env, { id: "p_me", first_name: "Ja", last_name: "T" });
  await seedPerson(env, { id: "p_other", first_name: "Inna", last_name: "T" });
  await seedAccount(env, { id: "a1", email: "a@x.org" });
  await q.linkAccountPerson(env.DB, "a1", "p_me").run();
  return login("a@x.org");
}

const upload = (c, qs, bytes, type = "image/jpeg") => c.fetch(`/api/media?${qs}`, { method: "POST", body: bytes, headers: { "content-type": type } });

describe("edit and move", () => {
  it("uploader edits caption/year; stranger cannot; admin can", async () => {
    const c = await linkedMember();
    const { id } = await (await upload(c, "kind=photo&owner=p_me", fakeJpeg(50, 50))).json();
    expect((await c.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "Nowy", year: 2001 } })).status).toBe(200);
    await seedAccount(env, { id: "s", email: "s@x.org" });
    const stranger = await login("s@x.org");
    expect((await stranger.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "haha" } })).status).toBe(403);
    const { c: adm } = await adminWithFreshPasskey();
    expect((await adm.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "Od admina" } })).status).toBe(200);
    expect((await c.json("/api/people/p_me/media")).body.media[0].caption).toBe("Od admina");
  });
  // Pins which tags belong to which file when a person has several. The listing used to fetch them
  // one query per file; this is what must not change when it stops doing that.
  it("gives every file in a listing its own tags", async () => {
    const c = await linkedMember();
    const { c: adm } = await adminWithFreshPasskey();
    for (const id of ["t1", "t2", "t3"]) await seedPerson(env, { id, first_name: id, last_name: "X" });
    const a = (await (await upload(c, "kind=photo&owner=p_me&caption=A", fakeJpeg(50, 50))).json()).id;
    const b = (await (await upload(c, "kind=photo&owner=p_me&caption=B", fakeJpeg(50, 50))).json()).id;
    const cc = (await (await upload(c, "kind=photo&owner=p_me&caption=C", fakeJpeg(50, 50))).json()).id;
    await adm.json(`/api/media/${a}`, { method: "PATCH", body: { tags: ["t1", "t2"] } });
    await adm.json(`/api/media/${b}`, { method: "PATCH", body: { tags: ["t3"] } });
    const list = (await c.json("/api/people/p_me/media")).body.media;
    const byId = Object.fromEntries(list.map((m) => [m.id, m.people.slice().sort()]));
    expect(byId[a]).toEqual(["t1", "t2"]);
    expect(byId[b]).toEqual(["t3"]);
    expect(byId[cc]).toEqual([]);
  });

  it("owner move and tags are admin-only; move respects the target cap; tags unlimited and free", async () => {
    const c = await linkedMember();
    const { id } = await (await upload(c, "kind=photo&owner=p_me", fakeJpeg(50, 50))).json();
    expect((await c.json(`/api/media/${id}`, { method: "PATCH", body: { owner_person_id: "p_other" } })).status).toBe(403);
    expect((await c.json(`/api/media/${id}`, { method: "PATCH", body: { tags: ["p_other"] } })).status).toBe(403);
    const { c: adm } = await adminWithFreshPasskey();
    for (let i = 0; i < 9; i++) await seedPerson(env, { id: `t${i}`, first_name: `T${i}`, last_name: "X" });
    expect((await adm.json(`/api/media/${id}`, { method: "PATCH", body: { tags: ["p_other", ...Array.from({ length: 9 }, (_, i) => `t${i}`)] } })).status).toBe(200);
    expect((await adm.json("/api/people/t3/media")).body).toMatchObject({ counts: { used: 0, cap: 6 }, media: [{ id }] });
    expect((await adm.json(`/api/media/${id}`, { method: "PATCH", body: { owner_person_id: "p_other" } })).status).toBe(200);
    const mine = (await adm.json("/api/people/p_me/media")).body;
    expect(mine.counts.used).toBe(0);
    expect((await adm.json("/api/people/p_other/media")).body.counts.used).toBe(1);
    for (let i = 0; i < 6; i++) expect((await adm.fetch("/api/media?kind=photo&owner=p_me", { method: "POST", body: fakeJpeg(40, 40), headers: { "content-type": "image/jpeg" } })).status).toBe(201);
    const back = await adm.json(`/api/media/${id}`, { method: "PATCH", body: { owner_person_id: "p_me" } });
    expect(back.status).toBe(409);
    expect(back.body.person).toBe("Ja T");
  });
});

describe("delete + news", () => {
  it("uploader deletes own (R2 objects gone); admin deletes any; media_added visible in family news", async () => {
    const c = await linkedMember();
    const bytes = fakeJpeg(60, 60);
    const { id } = await (await upload(c, "kind=photo&owner=p_me&caption=Test", bytes)).json();
    await c.fetch(`/api/media/${id}/thumb`, { method: "PUT", body: fakeJpeg(30, 30), headers: { "content-type": "image/jpeg" } });
    expect((await c.json(`/api/media/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c.fetch(`/api/media/${id}`)).status).toBe(404);
    expect((await env.MEDIA.get(`media/${id}.jpg`))).toBe(null);
    expect((await env.MEDIA.get(`media/${id}.thumb.jpg`))).toBe(null);
    expect((await c.json("/api/people/p_me/media")).body.counts.used).toBe(0);
    const { id: id2 } = await (await upload(c, "kind=photo&owner=p_me", fakeJpeg(20, 20))).json();
    const { c: adm } = await adminWithFreshPasskey();
    expect((await adm.json(`/api/media/${id2}`, { method: "DELETE" })).status).toBe(200);
    const news = (await c.json("/api/news")).body.items.map((i) => i.action);
    expect(news).toContain("media_added");
    expect(news).not.toContain("media_removed");
  });
});
