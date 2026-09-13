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

describe("who it reaches", () => {
  // An account, an open invitation, two relatives the tree holds addresses for, and four who must
  // never be written to: a deceased relative, a revoked invitation, an accepted one and a stale
  // one. Also an address with both an account and a still-open invitation, which belongs to
  // accounts alone: it proves the invited-excludes-accounts guard, not just its absence.
  async function cast() {
    await seedAccount(env, { id: "a2", email: "kin@x.org" });
    await seedAccount(env, { id: "a5", email: "both@x.org" });
    await q.insertInvitation(env.DB, { id: "i0", email: "both@x.org", lang: "en", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await q.insertInvitation(env.DB, { id: "i1", email: "asked@x.org", lang: "en", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await q.insertInvitation(env.DB, { id: "i2", email: "gone@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await env.DB.prepare("UPDATE invitations SET revoked_at = 2 WHERE id = 'i2'").run();
    await q.insertInvitation(env.DB, { id: "i3", email: "joined@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await env.DB.prepare("UPDATE invitations SET accepted_at = 2 WHERE id = 'i3'").run();
    await q.insertInvitation(env.DB, { id: "i4", email: "stale@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 2 }).run();
    await seedPerson(env, { id: "p1", first_name: "Maria", email: "maria@x.org" });
    await seedPerson(env, { id: "p2", first_name: "Jan", email: "JAN@x.org" });
    await seedPerson(env, { id: "p3", first_name: "Zofia", email: "zofia@x.org", deceased: 1 });
    await seedPerson(env, { id: "p4", first_name: "Kin", email: "kin@x.org" });          // the person behind the account
  }
  const send = (c, groups) => c.json("/api/admin/broadcasts", { method: "POST", body: { subject: "Zjazd", body: "x", groups } });

  it("keeps the three groups apart, so nobody is written to twice", async () => {
    const c = await adminWithFreshPasskey();
    await cast();
    expect((await send(c, ["accounts"])).body.sent).toBe(3);            // the admin, kin, and both (account wins)
    expect(to()).toEqual(["adm@x.org", "both@x.org", "kin@x.org"]);

    sent.length = 0;
    expect((await send(c, ["invited"])).body.sent).toBe(1);             // asked@x.org alone, not both@x.org
    expect(to()).toEqual(["asked@x.org"]);

    // checked before "others" runs, so maria and jan have not yet been invited into this group
    sent.length = 0;
    expect((await send(c, ["accounts", "invited"])).body.sent).toBe(4); // both@x.org written exactly once
    expect(to()).toEqual(["adm@x.org", "asked@x.org", "both@x.org", "kin@x.org"]);

    sent.length = 0;
    expect((await send(c, ["others"])).body.sent).toBe(2);              // maria and jan, not the deceased, not kin again
    expect(to()).toEqual(["jan@x.org", "maria@x.org"]);                 // and the address is folded to lower case

    sent.length = 0;
    expect((await send(c, ["accounts", "invited", "others"])).body.sent).toBe(6);
    expect(to()).toEqual(["adm@x.org", "asked@x.org", "both@x.org", "jan@x.org", "kin@x.org", "maria@x.org"]);
  });

  it("writes in the language the site knows, and in Polish when it knows none", async () => {
    const c = await adminWithFreshPasskey();
    await cast();
    await send(c, ["accounts", "invited", "others"]);
    const line = (addr) => letters().find((m) => m.to === addr).text.split("\n")[0];
    expect(line("asked@x.org")).toBe("Hello,");                         // the invitation says en
    expect(line("kin@x.org")).toBe("Cześć,");                           // the account says pl
    expect(line("maria@x.org")).toBe("Cześć,");                         // a person row has no language
  });

  it("carries in anybody who could not otherwise get in, and does not invite them twice", async () => {
    const c = await adminWithFreshPasskey();
    await cast();
    await send(c, ["accounts", "invited", "others"]);
    const { results } = await env.DB.prepare("SELECT email, invited_by FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > 4 ORDER BY email").all();
    expect(results.map((r) => r.email)).toEqual(["asked@x.org", "both@x.org", "jan@x.org", "maria@x.org"]);
    expect(results.find((r) => r.email === "maria@x.org").invited_by).toBe("adm");

    // sending again adds no second invitation for the same people
    await send(c, ["others"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invitations WHERE email = 'maria@x.org'").first()).toEqual({ n: 1 });
  });
});
