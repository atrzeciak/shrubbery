import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
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

// p_gran -> p_mum -> p_kid; p_aunt is nobody's parent here. Only p_mum and p_aunt have accounts.
async function family() {
  await seedPerson(env, { id: "p_gran", first_name: "Babcia", last_name: "T" });
  await seedPerson(env, { id: "p_mum", first_name: "Mama", last_name: "T" });
  await seedPerson(env, { id: "p_kid", first_name: "Mala", last_name: "T" });
  await seedPerson(env, { id: "p_aunt", first_name: "Ciocia", last_name: "T" });
  await q.insertParent(env.DB, "p_gran", "p_mum").run();
  await q.insertParent(env.DB, "p_mum", "p_kid").run();
  await seedAccount(env, { id: "a_mum", email: "mum@x.org" });
  await q.linkAccountPerson(env.DB, "a_mum", "p_mum").run();
  await seedAccount(env, { id: "a_aunt", email: "aunt@x.org" });
  await q.linkAccountPerson(env.DB, "a_aunt", "p_aunt").run();
}

async function kidJoins() {
  await seedAccount(env, { id: "a_kid", email: "kid@x.org" });
  await q.linkAccountPerson(env.DB, "a_kid", "p_kid").run();
}

const upload = (c, qs) => c.fetch(`/api/media?${qs}`, { method: "POST", body: fakeJpeg(100, 100), headers: { "content-type": "image/jpeg" } });
const putAvatar = (c, id) => c.fetch(`/api/people/${id}/avatar`, { method: "PUT", body: fakeJpeg(256, 256), headers: { "content-type": "image/jpeg" } });

describe("a parent curates a child who has no account", () => {
  it("uploads a photo owned by the child", async () => {
    await family();
    const mum = await login("mum@x.org");
    expect((await upload(mum, "kind=photo&owner=p_kid")).status).toBe(201);
    const list = (await mum.json("/api/people/p_kid/media")).body;
    expect(list.media).toHaveLength(1);
  });
  it("still cannot tag other people", async () => {
    await family();
    const mum = await login("mum@x.org");
    expect((await upload(mum, "kind=photo&owner=p_kid&tags=p_mum")).status).toBe(403);
  });
  it("sets the child's avatar, and history says a parent did it", async () => {
    await family();
    const mum = await login("mum@x.org");
    const res = await putAvatar(mum, "p_kid");
    expect(res.status).toBe(200);
    expect((await res.json()).updated_at).toBeGreaterThan(0);
    expect((await mum.fetch("/api/people/p_kid/avatar")).status).toBe(200);
    const hist = await env.DB.prepare("SELECT actor_account_id, details FROM history WHERE action = 'avatar_updated' AND target_id = 'p_kid'").first();
    expect(hist.actor_account_id).toBe("a_mum");
    expect(JSON.parse(hist.details)).toMatchObject({ by_parent: true, name: "Mala T" });
  });
});

describe("who is refused", () => {
  it("a non-parent, for upload and avatar", async () => {
    await family();
    const aunt = await login("aunt@x.org");
    expect((await upload(aunt, "kind=photo&owner=p_kid")).status).toBe(403);
    expect((await putAvatar(aunt, "p_kid")).status).toBe(403);
  });
  it("a grandparent: the edge must be direct", async () => {
    await family();
    await seedAccount(env, { id: "a_gran", email: "gran@x.org" });
    await q.linkAccountPerson(env.DB, "a_gran", "p_gran").run();
    const gran = await login("gran@x.org");
    expect((await upload(gran, "kind=photo&owner=p_kid")).status).toBe(403);
    expect((await putAvatar(gran, "p_kid")).status).toBe(403);
  });
  it("a parent, once the child has an account", async () => {
    await family();
    await kidJoins();
    const mum = await login("mum@x.org");
    expect((await upload(mum, "kind=photo&owner=p_kid")).status).toBe(403);
    expect((await putAvatar(mum, "p_kid")).status).toBe(403);
  });
  it("an account linked to no person, and nobody at all", async () => {
    await family();
    await seedAccount(env, { id: "a_loose", email: "loose@x.org" });
    const loose = await login("loose@x.org");
    expect((await putAvatar(loose, "p_kid")).status).toBe(403);
    expect((await putAvatar(new Client(env), "p_kid")).status).toBe(401);
  });
  it("an avatar for a person who does not exist is 404", async () => {
    await family();
    const mum = await login("mum@x.org");
    expect((await putAvatar(mum, "nope")).status).toBe(404);
  });
});

describe("the child takes over", () => {
  it("recaptions and deletes a photo the parent uploaded", async () => {
    await family();
    const mum = await login("mum@x.org");
    const { id } = await (await upload(mum, "kind=photo&owner=p_kid")).json();
    await kidJoins();
    const kid = await login("kid@x.org");
    expect((await kid.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "Ja" } })).status).toBe(200);
    expect((await kid.json(`/api/media/${id}`, { method: "DELETE" })).status).toBe(200);
  });
  it("replaces the avatar the parent set, through the same route", async () => {
    await family();
    const mum = await login("mum@x.org");
    await putAvatar(mum, "p_kid");
    await kidJoins();
    const kid = await login("kid@x.org");
    expect((await putAvatar(kid, "p_kid")).status).toBe(200);
    const hist = await env.DB.prepare("SELECT details FROM history WHERE action = 'avatar_updated' AND actor_account_id = 'a_kid'").first();
    expect(JSON.parse(hist.details)).toMatchObject({ self: true });
  });
  it("the parent keeps their own uploads; a stranger still cannot touch them", async () => {
    await family();
    const mum = await login("mum@x.org");
    const { id } = await (await upload(mum, "kind=photo&owner=p_kid")).json();
    await kidJoins();
    const aunt = await login("aunt@x.org");
    expect((await aunt.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "x" } })).status).toBe(403);
    expect((await mum.json(`/api/media/${id}`, { method: "PATCH", body: { caption: "Mala" } })).status).toBe(200);
  });
});
