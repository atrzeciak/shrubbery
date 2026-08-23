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

const pdfBytes = (pad = 100) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(pad).fill(0x20)]);

async function linkedMember() {
  await seedPerson(env, { id: "p_me", first_name: "Ja", last_name: "T" });
  await seedPerson(env, { id: "p_other", first_name: "Inna", last_name: "T" });
  await seedAccount(env, { id: "a1", email: "a@x.org" });
  await q.linkAccountPerson(env.DB, "a1", "p_me").run();
  return login("a@x.org");
}

const upload = (c, qs, bytes, type = "image/jpeg") => c.fetch(`/api/media?${qs}`, { method: "POST", body: bytes, headers: { "content-type": type } });

describe("upload", () => {
  it("member uploads a photo for their own person; caption+year stored; history media_added", async () => {
    const c = await linkedMember();
    const res = await upload(c, "kind=photo&owner=p_me&caption=%C5%9Alub&year=1996", fakeJpeg(1600, 1200));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const list = (await c.json("/api/people/p_me/media")).body;
    expect(list.counts).toEqual({ used: 1, cap: 6 });
    expect(list.media[0]).toMatchObject({ id, kind: "photo", caption: "Ślub", year: 1996, owned: 1, people: [] });
    const hist = await env.DB.prepare("SELECT action, target_id FROM history WHERE action = 'media_added'").first();
    expect(hist.target_id).toBe("p_me");
  });
  it("member cannot upload for another person, with tags, or a bad kind", async () => {
    const c = await linkedMember();
    expect((await upload(c, "kind=photo&owner=p_other", fakeJpeg(100, 100))).status).toBe(403);
    expect((await upload(c, "kind=photo&owner=p_me&tags=p_other", fakeJpeg(100, 100))).status).toBe(403);
    expect((await upload(c, "kind=movie&owner=p_me", fakeJpeg(100, 100))).status).toBe(400);
    expect((await upload(c, "kind=photo&owner=nope", fakeJpeg(100, 100))).status).toBe(403);
  });
  it("unlinked account cannot upload; unauthenticated cannot list", async () => {
    await seedPerson(env, { id: "p_x", first_name: "X", last_name: "Y" });
    await seedAccount(env, { id: "u", email: "u@x.org" });
    const c = await login("u@x.org");
    expect((await upload(c, "kind=photo&owner=p_x", fakeJpeg(100, 100))).status).toBe(403);
    expect((await new Client(env).json("/api/people/p_x/media")).status).toBe(401);
  });
  it("cap 6 owned → 409 naming the person; tags never count", async () => {
    const c = await linkedMember();
    for (let i = 0; i < 6; i++) expect((await upload(c, "kind=photo&owner=p_me", fakeJpeg(50, 50))).status).toBe(201);
    const full = await c.json("/api/media?kind=photo&owner=p_me", { method: "POST", body: fakeJpeg(50, 50), headers: { "content-type": "image/jpeg" } });
    expect(full.status).toBe(409);
    expect(full.body.person).toBe("Ja T");
    expect((await c.json("/api/people/p_me/media")).body.counts.used).toBe(6);
  });
  // Two uploads arriving together both read the count as 5 and both proceed, and the seventh file
  // lands. Counting first cannot fix that; only the insert itself can refuse.
  it("the insert refuses past the cap even when nothing counted first", async () => {
    const c = await linkedMember();
    for (let i = 0; i < 6; i++) expect((await upload(c, "kind=photo&owner=p_me", fakeJpeg(50, 50))).status).toBe(201);
    const seventh = { id: "sneak", ownerPersonId: "p_me", kind: "photo", caption: null, year: null,
                      contentType: "image/jpeg", size: 10, uploadedBy: "u", createdAt: 1_800_000_000 };
    const res = await q.insertMedia(env.DB, seventh).run();
    expect(res.meta.changes).toBe(0);
    expect((await q.countOwnedMedia(env.DB, "p_me").first()).n).toBe(6);
  });

  it("photo validation: oversized pixels/bytes and PDFs rejected; documents accept pdf and jpeg scans", async () => {
    const c = await linkedMember();
    expect((await upload(c, "kind=photo&owner=p_me", fakeJpeg(2049, 10))).status).toBe(400);
    expect((await upload(c, "kind=photo&owner=p_me", pdfBytes(), "application/pdf")).status).toBe(400);
    expect((await upload(c, "kind=document&owner=p_me", pdfBytes(), "application/pdf")).status).toBe(201);
    expect((await upload(c, "kind=document&owner=p_me", fakeJpeg(4000, 3000))).status).toBe(201);
    expect((await upload(c, "kind=document&owner=p_me", new Uint8Array([1, 2, 3]), "application/pdf")).status).toBe(400);
  });
});

describe("stream + thumb", () => {
  it("uploads stream back byte-identical with headers; thumb after PUT; 304 on ETag", async () => {
    const c = await linkedMember();
    const bytes = fakeJpeg(800, 600, 500);
    const { id } = await (await upload(c, "kind=photo&owner=p_me", bytes)).json();
    const res = await c.fetch(`/api/media/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const etag = res.headers.get("etag");
    expect((await c.fetch(`/api/media/${id}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await c.fetch(`/api/media/${id}/thumb`)).status).toBe(404);
    expect((await c.fetch(`/api/media/${id}/thumb`, { method: "PUT", body: fakeJpeg(400, 300), headers: { "content-type": "image/jpeg" } })).status).toBe(200);
    const th = await c.fetch(`/api/media/${id}/thumb`);
    expect(th.status).toBe(200);
    expect((await c.json("/api/people/p_me/media")).body.media[0].has_thumb).toBe(1);
    expect((await new Client(env).fetch(`/api/media/${id}`)).status).toBe(401);
    expect((await c.fetch("/api/media/zzzz")).status).toBe(404);
  });
  it("uploads a document (PDF) and streams it back inline with the right content-type", async () => {
    const c = await linkedMember();
    const { id } = await (await upload(c, "kind=document&owner=p_me", pdfBytes(), "application/pdf")).json();
    const res = await c.fetch(`/api/media/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });
  it("PUT thumb is refused for a signed-in member who is neither uploader nor admin", async () => {
    const c = await linkedMember();
    const { id } = await (await upload(c, "kind=photo&owner=p_me", fakeJpeg(50, 50))).json();
    await seedAccount(env, { id: "s", email: "s@x.org" });
    const stranger = await login("s@x.org");
    const res = await stranger.fetch(`/api/media/${id}/thumb`, { method: "PUT", body: fakeJpeg(30, 30), headers: { "content-type": "image/jpeg" } });
    expect(res.status).toBe(403);
  });
});
