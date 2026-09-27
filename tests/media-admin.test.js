import { describe, it, expect, beforeEach } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import * as q from "../src/db/queries.js";
import { makeEnv, resetDb, seedAccount, seedPerson, loginAs, adminAs } from "./helpers/env.js";
import { fakeJpeg } from "./helpers/jpeg.js";
import { capturingErrors } from "./helpers/logging.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

const login = (email) => loginAs(env, sent, email);

// Seeds an admin the way production is bootstrapped: family → passkey → promoted → step-up.
const adminWithFreshPasskey = (email) => adminAs(env, sent, email);

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

describe("upload size", () => {
  // A chunked body carries no Content-Length, so the only way to refuse a huge one is to stop
  // reading it: the isolate has 128 MB, and a few bodies read whole would take it down.
  it("stops reading a body once it passes the cap, rather than holding all of it first", async () => {
    const c = await linkedMember();
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
      pull(ctl) {
        if (pulled >= 20 * 1024 * 1024) return ctl.close();
        pulled += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const req = new Request("https://example.org/api/media?kind=photo&owner=p_me", {
      method: "POST", body, duplex: "half", headers: { cookie, "content-type": "image/jpeg", "cf-connecting-ip": "203.0.113.1" },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(4 * 1024 * 1024);                     // the photo cap is 2 MiB
  });
});

describe("a person's gallery", () => {
  it("counts the owned files from the listing it already has, not with another query", async () => {
    const c = await linkedMember();
    expect((await upload(c, "kind=photo&owner=p_me", fakeJpeg(40, 40))).status).toBe(201);
    const real = env.DB, seen = [];
    c.env = { ...env, DB: { prepare: (sql) => { seen.push(sql); return real.prepare(sql); }, batch: (s) => real.batch(s) } };
    const r = await c.json("/api/people/p_me/media");
    expect(r.body.counts).toEqual({ used: 1, cap: 6 });
    expect(seen.filter((sql) => sql.includes("COUNT(*) AS n FROM media"))).toEqual([]);
  });

  it("lists every file a person is tagged in, past D1's 100 bound parameters, with its tags", async () => {
    const c = await linkedMember();
    const stmts = [];
    for (let o = 0; o < 17; o++) {                       // 17 owners at the cap of 6: 102 files, all tagging p_me
      stmts.push(env.DB.prepare("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)").bind(`o${o}`, `O${o}`));
      for (let i = 0; i < 6; i++) {
        const id = `m${o}_${i}`;
        stmts.push(
          env.DB.prepare("INSERT INTO media (id, owner_person_id, kind, content_type, size, uploaded_by, created_at) VALUES (?, ?, 'photo', 'image/jpeg', 1, 'a1', 1)").bind(id, `o${o}`),
          env.DB.prepare("INSERT INTO media_people (media_id, person_id) VALUES (?, 'p_me')").bind(id));
      }
    }
    await env.DB.batch(stmts);
    const r = await c.json("/api/people/p_me/media");
    expect(r.status).toBe(200);
    expect(r.body.media).toHaveLength(102);
    expect(r.body.media.every((m) => m.people.length === 1 && m.people[0] === "p_me")).toBe(true);
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

  // A file deleted is gone from R2 for good, so an admin reaching past their own files needs the
  // passkey as well as the role; their own uploads they delete like anyone else.
  it("an admin without a fresh passkey deletes only what they uploaded", async () => {
    const c = await linkedMember();
    const { id } = await (await upload(c, "kind=photo&owner=p_me", fakeJpeg(20, 20))).json();
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const adm = await login("adm@x.org");
    await env.MEDIA.put("media/mine.jpg", fakeJpeg(20, 20));
    await q.insertMedia(env.DB, { id: "mine", ownerPersonId: "p_other", kind: "photo", caption: null, year: null, contentType: "image/jpeg", size: 1, uploadedBy: "adm", createdAt: 1 }).run();
    const r = await adm.json(`/api/media/${id}`, { method: "DELETE" });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "step_up_required" });
    expect(await q.mediaById(env.DB, id).first()).not.toBeNull();
    expect(await env.MEDIA.get(`media/${id}.jpg`)).not.toBeNull();
    expect((await adm.json("/api/media/mine", { method: "DELETE" })).status).toBe(200);
  });
});

describe("deleting a document a letter carried", () => {
  // A document attached to an invitation is still pointed at by that invitation, and the
  // published tree is replaced every few days, so this is the ordinary case rather than a corner.
  async function published(c, id, caption) {
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    await env.MEDIA.put(`media/${id}.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await q.insertMedia(env.DB, { id, ownerPersonId: "p1", kind: "document", caption, year: 2026, contentType: "application/pdf", size: pdf.length, uploadedBy: "adm", createdAt: 1 }).run();
  }

  it("lets the old copy go, and leaves the letters that carried it standing", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "Doc", last_name: "Owner" });
    await published(c, "old", "Drzewo — 30.08");
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "kin@x.org", lang: "pl", attachment: "old" } })).status).toBe(201);
    await c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Drzewo", body: "W załączniku.", groups: ["accounts"], attachment: "old" } });

    expect((await c.json("/api/media/old", { method: "DELETE" })).status).toBe(200);
    expect((await c.json("/api/admin/documents")).body.documents).toHaveLength(0);
    // the invitation still stands and can still be re-sent; it simply goes without the document
    const inv = (await c.json("/api/admin/invitations")).body.invitations;
    expect(inv).toHaveLength(1);
    expect(inv[0].attachment_media_id).toBeNull();
    expect((await c.json(`/api/admin/invitations/${inv[0].id}/resend`, { method: "POST", body: {} })).status).toBe(200);
    expect(sent[sent.length - 1].attachments).toBeUndefined();
    // and the record of the letter that went out is untouched but for the document it named
    const row = await env.DB.prepare("SELECT subject, attachment_media_id FROM broadcasts").first();
    expect(row).toEqual({ subject: "Drzewo", attachment_media_id: null });
  });

  it("keeps the file when the database refuses, so a failure never destroys it", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "Doc", last_name: "Owner" });
    await published(c, "doc", "Drzewo");
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async () => { throw new Error("constraint"); };
    try {
      const { value: r, logged } = await capturingErrors(() => c.json("/api/media/doc", { method: "DELETE" }));
      expect(r.status).toBe(500);
      expect(logged.map((e) => e.message)).toEqual(["constraint"]);
    } finally { env.DB.batch = batch; }
    // the bytes are still there, so the same delete can be tried again once the cause is fixed
    expect(await env.MEDIA.get("media/doc.pdf")).not.toBeNull();
    expect((await c.json("/api/admin/documents")).body.documents).toHaveLength(1);
    expect((await c.json("/api/media/doc", { method: "DELETE" })).status).toBe(200);
    expect(await env.MEDIA.get("media/doc.pdf")).toBeNull();
  });
});
