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

async function family() {
  await seedPerson(env, { id: "p_and", first_name: "Jan", last_name: "Nowak", birth_date: "1964-10-04" });
  await seedPerson(env, { id: "p_jan", first_name: "Maria", last_name: "Nowak", birth_date: "1941", deceased: 1 });
  await seedPerson(env, { id: "p_v", first_name: "Ewa", last_name: "Nowak", birth_date: "1997" });
  await q.insertParent(env.DB, "p_jan", "p_and").run();
  await q.insertParent(env.DB, "p_and", "p_v").run();
  await seedAccount(env, { id: "a1", email: "a1@x.org" });
  await seedAccount(env, { id: "a2", email: "a2@x.org" });
  await q.linkAccountPerson(env.DB, "a1", "p_and").run();
}

describe("GET /api/people", () => {
  it("needs a session and returns the whole graph", async () => {
    await family();
    expect((await new Client(env).json("/api/people")).status).toBe(401);
    const c = await login("a2@x.org");
    const { status, body } = await c.json("/api/people");
    expect(status).toBe(200);
    expect(body.people.map((p) => p.id).sort()).toEqual(["p_and", "p_jan", "p_v"]);
    expect(body.people.find((p) => p.id === "p_and").account_email).toBe("a1@x.org");
    expect(body.parents).toEqual(expect.arrayContaining([{ parent_id: "p_jan", child_id: "p_and" }, { parent_id: "p_and", child_id: "p_v" }]));
    expect(body.partners).toEqual([]);
    expect(body.links).toEqual([]);
    expect(body.avatars).toEqual([]);
    const one = await c.json("/api/people/p_v");
    expect(one.status).toBe(200);
    expect(one.body.person.display_name).toBe("Ewa Nowak");
    expect((await c.json("/api/people/nope")).status).toBe(404);
  });
});

describe("own entry", () => {
  it("unlinked account gets 404; linked account reads and edits its own fields and links", async () => {
    await family();
    const other = await login("a2@x.org");
    expect((await other.json("/api/me/person")).status).toBe(404);
    expect((await other.json("/api/me/person", { method: "PATCH", body: { nickname: "x" } })).status).toBe(404);
    const me = await login("a1@x.org");
    expect((await me.json("/api/me/person")).body.person.id).toBe("p_and");
    const r = await me.json("/api/me/person", { method: "PATCH", body: { nickname: "Andy", residence: "Chicago", links: [{ kind: "linkedin", url: "https://linkedin.com/in/andy" }] } });
    expect(r.status).toBe(200);
    const after = await me.json("/api/me/person");
    expect(after.body.person.nickname).toBe("Andy");
    expect(after.body.person.updated_by).toBe("a1");
    expect(after.body.links).toEqual([expect.objectContaining({ kind: "linkedin", url: "https://linkedin.com/in/andy" })]);
    expect((await me.json("/api/me/person", { method: "PATCH", body: { unverified: 0 } })).status).toBe(400);
    expect((await me.json("/api/me/person", { method: "PATCH", body: { birth_date: "4.10.1964" } })).status).toBe(400);
    const hist = await env.DB.prepare("SELECT action, target_type, target_id, details FROM history WHERE action = 'person_updated'").all();
    expect(hist.results).toHaveLength(1);
    expect(hist.results[0].target_id).toBe("p_and");
    expect(JSON.parse(hist.results[0].details)).toEqual({ fields: ["nickname", "residence", "links"], self: true, name: "Jan Nowak" });
  });
  it("renaming recomputes display_name; a name-less person keeps its label", async () => {
    await family();
    await seedPerson(env, { id: "p_u", display_name: "Unknown parents" });
    const me = await login("a1@x.org");
    await me.json("/api/me/person", { method: "PATCH", body: { maiden_name: "Kowalski" } });
    expect((await me.json("/api/people/p_and")).body.person.display_name).toBe("Jan Nowak (Kowalski)");
    expect((await me.json("/api/people/p_u")).body.person.display_name).toBe("Unknown parents");
  });
});

describe("avatars", () => {
  it("upload, serve with ETag/304, reject wrong type/size/dimensions", async () => {
    await family();
    const me = await login("a1@x.org");
    const put = (bytes, type = "image/jpeg") => me.fetch("/api/me/person/avatar", { method: "PUT", body: bytes, headers: { "content-type": type } });
    const uploaded = fakeJpeg(512, 512);
    expect((await put(uploaded)).status).toBe(200);
    expect((await put(fakeJpeg(513, 512))).status).toBe(400);
    expect((await put(fakeJpeg(100, 100), "image/png")).status).toBe(400);
    expect((await put(new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await put(fakeJpeg(64, 64, 204800))).status).toBe(400);
    const res = await me.fetch("/api/people/p_and/avatar");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    expect(bodyBytes.length).toBe(uploaded.length);
    expect(bodyBytes).toEqual(uploaded);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"\d+"$/);
    expect((await me.fetch("/api/people/p_and/avatar", { headers: { "if-none-match": etag } })).status).toBe(304);
    const res2 = await me.fetch("/api/people/p_and/avatar");
    expect(res2.status).toBe(200);
    const bodyBytes2 = new Uint8Array(await res2.arrayBuffer());
    expect(bodyBytes2.length).toBe(uploaded.length);
    expect(bodyBytes2).toEqual(uploaded);
    expect((await me.fetch("/api/people/p_v/avatar")).status).toBe(404);
    expect((await new Client(env).fetch("/api/people/p_and/avatar")).status).toBe(401);
    const list = (await me.json("/api/people")).body.avatars;
    expect(list).toEqual([{ person_id: "p_and", updated_at: expect.any(Number) }]);
    const hist = await env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE action = 'avatar_updated' AND target_id = 'p_and'").first();
    expect(hist.n).toBe(1);
  });
});
