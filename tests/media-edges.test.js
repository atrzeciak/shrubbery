import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries.js";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";
import { fakeJpeg } from "./helpers/jpeg.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { checkDocument, cleanCaption } from "../src/media/rules.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function linkedMember() {
  await seedPerson(env, { id: "p_me", first_name: "Ja", last_name: "T" });
  await seedAccount(env, { id: "a1", email: "a@x.org" });
  await q.linkAccountPerson(env.DB, "a1", "p_me").run();
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
  await c.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code: lastCode(sent) } });
  return c;
}

async function admin() {
  await seedAccount(env, { id: "adm", email: "adm@x.org", role: "family" });
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email: "adm@x.org" } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email: "adm@x.org" } });
  await c.json("/api/auth/code", { method: "POST", body: { email: "adm@x.org", code: lastCode(sent) } });
  const auth = await createAuthenticator();
  let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } });
  await q.setRole(env.DB, "adm", "admin").run();
  ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } });
  return c;
}

const post = (c, qs) => c.json(`/api/media?${qs}`, { method: "POST", body: fakeJpeg(50, 50), headers: { "content-type": "image/jpeg" } });
const upload = (c) => c.json("/api/media?kind=photo&owner=p_me", { method: "POST", body: fakeJpeg(50, 50), headers: { "content-type": "image/jpeg" } });

describe("two uploads arriving together", () => {
  // The count says there is room, the insert says there is not: the file already in R2 must go,
  // or the bucket fills with orphans nobody can see or delete.
  it("removes the object it wrote when the insert refuses the row", async () => {
    const c = await linkedMember();
    for (let i = 0; i < 6; i++) expect((await upload(c)).status).toBe(201);
    const objects = async () => (await env.MEDIA.list()).objects.length;
    const before = await objects();
    const real = env.DB;
    c.env = { ...env, DB: { prepare: (sql) => (sql.includes("COUNT(*) AS n FROM media") ? { bind: () => ({ first: async () => ({ n: 0 }) }) } : real.prepare(sql)) } };
    const r = await upload(c);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "conflict", person: "Ja T" });
    expect(await objects()).toBe(before);
    expect((await q.countOwnedMedia(env.DB, "p_me").first()).n).toBe(6);
  });
});

describe("an admin naming people that do not exist", () => {
  it("is told the owner or a tag is unknown, where a member would simply be forbidden", async () => {
    const adm = await admin();
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    const before = (await env.MEDIA.list()).objects.length;
    expect((await post(adm, "kind=photo&owner=ghost")).status).toBe(404);
    expect((await post(adm, "kind=photo&owner=p1&tags=ghost")).status).toBe(404);
    const mem = await linkedMember();
    expect((await post(mem, "kind=photo&owner=ghost")).status).toBe(403);
    expect((await env.MEDIA.list()).objects).toHaveLength(before);
  });
});

describe("a file's page", () => {
  it("is a 404 for a person who does not exist", async () => {
    const c = await linkedMember();
    expect((await c.json("/api/people/ghost/media")).status).toBe(404);
  });

  it("is a 404 when the row is there but the object is gone from R2", async () => {
    const c = await linkedMember();
    const { body } = await upload(c);
    await env.MEDIA.delete(`media/${body.id}.jpg`);
    expect((await c.json(`/api/media/${body.id}`)).status).toBe(404);
  });

  it("refuses a thumbnail that is empty or not a JPEG", async () => {
    const c = await linkedMember();
    const { body } = await upload(c);
    expect((await c.fetch(`/api/media/${body.id}/thumb`, { method: "PUT", body: new Uint8Array(0), headers: { "content-type": "image/jpeg" } })).status).toBe(400);
    expect((await c.fetch(`/api/media/${body.id}/thumb`, { method: "PUT", body: new Uint8Array([1, 2, 3, 4]), headers: { "content-type": "image/jpeg" } })).status).toBe(400);
    expect((await c.json(`/api/media/${body.id}/thumb`)).status).toBe(404);
  });
});

describe("editing a file", () => {
  it("needs something to change, and refuses tags that are not a list or name nobody", async () => {
    const c = await linkedMember();
    const { body } = await upload(c);
    expect((await c.json(`/api/media/${body.id}`, { method: "PATCH", body: {} })).status).toBe(400);
    const adm = await admin();
    expect((await adm.json(`/api/media/${body.id}`, { method: "PATCH", body: { tags: "p_me" } })).status).toBe(400);
    expect((await adm.json(`/api/media/${body.id}`, { method: "PATCH", body: { tags: ["ghost"] } })).status).toBe(404);
    expect((await adm.json(`/api/media/${body.id}`, { method: "PATCH", body: { owner_person_id: "ghost" } })).status).toBe(404);
    expect((await adm.json(`/api/media/${body.id}`, { method: "PATCH", body: { owner_person_id: "p_me" } })).status).toBe(400);   // the same owner is no change at all
    expect((await q.mediaById(env.DB, body.id).first()).owner_person_id).toBe("p_me");
  });
});

describe("document rules", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(20).fill(0x20)]);

  it("refuses an empty document, and one whose declared type is missing", () => {
    expect(() => checkDocument(new Uint8Array(0), "application/pdf")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => checkDocument(pdf, undefined)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => checkDocument(pdf, "application/pdf")).not.toThrow();
  });

  it("refuses a caption that is not text", () => {
    expect(() => cleanCaption(42)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
