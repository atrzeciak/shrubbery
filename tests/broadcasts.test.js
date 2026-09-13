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
  return c;
}

// The letters that went to the family, ignoring the login codes the admin needed to get in.
const letters = () => sent.filter((m) => ["Zjazd", "Pierwszy", "Drugi"].includes(m.subject));
const to = () => letters().map((m) => m.to).sort();

describe("sending", () => {
  it("writes to everyone with an account, records the row and the history entry", async () => {
    await seedAccount(env, { id: "a2", email: "kin@x.org", lang: "en" });
    await seedAccount(env, { id: "a3", email: "off@x.org" });
    await env.DB.prepare("UPDATE accounts SET disabled_at = 1 WHERE id = 'a3'").run();
    const c = await adminWithFreshPasskey();

    const r = await c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Zjazd", body: "Do zobaczenia w lipcu.", groups: ["accounts"] } });
    expect(r.status).toBe(200);
    expect(r.body.sent).toBe(2);                       // the admin and kin; the disabled account is left out
    expect(to()).toEqual(["adm@x.org", "kin@x.org"]);

    // the letter is the admin's words, signed by them, with replies coming back to them
    const kin = letters().find((m) => m.to === "kin@x.org");
    expect(kin.text).toContain("Do zobaczenia w lipcu.");
    expect(kin.replyTo).toBe("adm@x.org");
    expect(kin.attachments).toBeUndefined();

    const row = await env.DB.prepare("SELECT * FROM broadcasts").first();
    expect(row).toMatchObject({ id: r.body.id, subject: "Zjazd", body: "Do zobaczenia w lipcu.", groups: '["accounts"]', sent_by: "adm", sent_count: 2, attachment_media_id: null });
    const h = await env.DB.prepare("SELECT * FROM history WHERE action = 'broadcast_sent'").first();
    expect(JSON.parse(h.details)).toMatchObject({ subject: "Zjazd", groups: ["accounts"], sent: 2 });
  });

  it("refuses a message with no subject, no body, no groups, or a group nobody is in", async () => {
    const c = await adminWithFreshPasskey();
    const bad = async (body) => (await c.json("/api/admin/broadcasts", { method: "POST", body })).status;
    expect(await bad({ subject: "  ", body: "x", groups: ["accounts"] })).toBe(400);
    expect(await bad({ subject: "Zjazd", body: "   ", groups: ["accounts"] })).toBe(400);
    expect(await bad({ subject: "Zjazd", body: "x", groups: [] })).toBe(400);
    expect(await bad({ subject: "Zjazd", body: "x", groups: ["nonsense"] })).toBe(400);
    expect(await bad({ subject: "Zjazd", body: "x", groups: ["invited"] })).toBe(400);   // nobody is invited
    expect(letters()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first()).toEqual({ n: 0 });
  });

  it("asks the admin for a fresh passkey, and turns the family away", async () => {
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    await seedAccount(env, { id: "a9", email: "plain@x.org", role: "admin" });
    const fam = await login("f@x.org");
    expect((await fam.json("/api/admin/broadcasts", { method: "POST", body: { subject: "x", body: "y", groups: ["accounts"] } })).status).toBe(403);
    const stale = await login("plain@x.org");
    const r = await stale.json("/api/admin/broadcasts", { method: "POST", body: { subject: "x", body: "y", groups: ["accounts"] } });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "step_up_required" });
  });

  it("carries one document from the archive, and refuses one that is not a usable document", async () => {
    const c = await adminWithFreshPasskey();
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    await seedPerson(env, { id: "p_doc", first_name: "Doc", last_name: "Owner" });
    await env.MEDIA.put("media/tree1.pdf", pdf, { httpMetadata: { contentType: "application/pdf" } });
    await q.insertMedia(env.DB, { id: "tree1", ownerPersonId: "p_doc", kind: "document", caption: "Drzewo rodziny", year: 2026, contentType: "application/pdf", size: pdf.length, uploadedBy: "adm", createdAt: 1_800_000_000 }).run();

    const r = await c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Zjazd", body: "W załączniku drzewo.", groups: ["accounts"], attachment: "tree1" } });
    expect(r.status).toBe(200);
    expect(letters()[0].attachments).toHaveLength(1);
    expect(letters()[0].attachments[0]).toMatchObject({ filename: "Drzewo_rodziny.pdf", type: "application/pdf", disposition: "attachment" });
    expect(new Uint8Array(letters()[0].attachments[0].content)).toEqual(pdf);   // the bytes come from R2, not from the request
    expect((await env.DB.prepare("SELECT attachment_media_id FROM broadcasts").first()).attachment_media_id).toBe("tree1");

    const bad = await c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Zjazd", body: "x", groups: ["accounts"], attachment: "nope" } });
    expect(bad.body).toEqual({ error: "bad_attachment" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM broadcasts").first()).toEqual({ n: 1 });
  });

  it("counts only what left when one mailbox refuses, and still records the message", async () => {
    await seedAccount(env, { id: "a2", email: "dead@x.org" });
    const c = await adminWithFreshPasskey();
    const real = env.EMAIL.send;
    env.EMAIL.send = async (msg) => { if (msg.to === "dead@x.org") throw new Error("mailbox full"); return real(msg); };
    const r = await c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Zjazd", body: "x", groups: ["accounts"] } });
    expect(r.body.sent).toBe(1);
    expect(to()).toEqual(["adm@x.org"]);
    expect((await env.DB.prepare("SELECT sent_count FROM broadcasts").first()).sent_count).toBe(1);
  });
});
