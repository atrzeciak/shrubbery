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
  return { c, auth };
}

describe("authorization", () => {
  it("family is forbidden; admin without fresh passkey may read but not write", async () => {
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    const fam = await login("f@x.org");
    expect((await fam.json("/api/admin/accounts")).status).toBe(403);
    const adm = await login("adm@x.org");
    expect((await adm.json("/api/admin/accounts")).status).toBe(200);
    const w = await adm.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org", lang: "pl" } });
    expect(w.status).toBe(401);
    expect(w.body).toEqual({ error: "step_up_required" });
  });
});

describe("invitations", () => {
  it("invite → mail sent → duplicate refused → resend → revoke, all in history", async () => {
    const { c } = await adminWithFreshPasskey();
    sent.length = 0;
    const inv = await c.json("/api/admin/invitations", { method: "POST", body: { email: "New@X.org", lang: "en" } });
    expect(inv.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("new@x.org");
    expect(sent[0].text).toContain("example.org/app/");
    // the invitation names a person and the recipient's own address, so it doesn't read like spam
    expect(sent[0].text).toContain("new@x.org");
    // invitations come from a person and replies reach them, not a no-reply mailbox
    expect(sent[0].from).toEqual({ email: "rodzina@mail.example.org", name: "Our Roots" });
    expect(sent[0].replyTo).toBe("adm@x.org");
    expect(sent[0].bcc).toEqual(["adm@x.org"]);
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "new@x.org", lang: "en" } })).status).toBe(409);
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "adm@x.org", lang: "en" } })).status).toBe(409);
    const list = (await c.json("/api/admin/invitations")).body.invitations;
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe("new@x.org");
    expect((await c.json(`/api/admin/invitations/${inv.body.id}/resend`, { method: "POST", body: {} })).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect((await c.json(`/api/admin/invitations/${inv.body.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c.json("/api/admin/invitations")).body.invitations).toHaveLength(0);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 30, actions: null, accountId: null }).all()).results.map((h) => h.action);
    for (const a of ["invite_sent", "invite_resent", "invite_revoked"]) expect(actions).toContain(a);
    // revoked invitation can no longer log in
    const stranger = new Client(env);
    sent.length = 0;
    await stranger.json("/api/auth/email", { method: "POST", body: { email: "new@x.org" } });
    await stranger.json("/api/auth/code/request", { method: "POST", body: { email: "new@x.org" } });
    expect(sent).toHaveLength(0);
  });
});

describe("invitation voice", () => {
  // The first-person text tells the founder's own story: his mother left him the Drzewo
  // Genealogiczne. Signed by any other admin it would claim their mother did — so only the
  // founder speaks as "I", and everyone else speaks for the family.
  it("an admin who is not the founder invites in the family's voice, over their own name", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p_lu", first_name: "Piotr", last_name: "Mazur" });
    await env.DB.prepare("UPDATE accounts SET person_id = 'p_lu' WHERE id = 'adm'").run();
    sent.length = 0;
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org", lang: "pl" } })).status).toBe(201);
    expect(sent[0].text).not.toContain("Mama zostawiła mi");
    expect(sent[0].text).toContain("W rodzinie zostało po latach");
    expect(sent[0].text).toContain("próbujemy");                  // the whole paragraph is plural, not just its first line
    expect(sent[0].text).toContain("lepiej od nas");
    expect(sent[0].text.trimEnd().endsWith("Piotr Mazur")).toBe(true);
  });

  it("an invitation can carry one PDF document from the archive, and a re-send carries it again", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p_doc", first_name: "Anna", last_name: "Nowak" });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(200).fill(0x20)]);
    await env.MEDIA.put("media/tree1.pdf", pdf, { httpMetadata: { contentType: "application/pdf" } });
    await q.insertMedia(env.DB, { id: "tree1", ownerPersonId: "p_doc", kind: "document", caption: "Drzewo rodziny — wersja 2026", year: 2026, contentType: "application/pdf", size: pdf.length, uploadedBy: "adm", createdAt: 1_800_000_000 }).run();
    await q.insertMedia(env.DB, { id: "photo1", ownerPersonId: "p_doc", kind: "photo", caption: null, year: null, contentType: "image/jpeg", size: 10, uploadedBy: "adm", createdAt: 1_800_000_000 }).run();
    const docs = await c.json("/api/admin/documents");
    expect(docs.status).toBe(200);
    expect(docs.body.documents.map((d) => d.id)).toEqual(["tree1"]);           // photos are not offered
    sent.length = 0;
    const inv = await c.json("/api/admin/invitations", { method: "POST", body: { email: "kin@x.org", lang: "pl", attachment: "tree1" } });
    expect(inv.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments[0]).toMatchObject({ filename: "Drzewo_rodziny_wersja_2026.pdf", type: "application/pdf", disposition: "attachment" });
    expect(new Uint8Array(sent[0].attachments[0].content)).toEqual(pdf);      // the bytes come from R2, not from the request
    expect((await c.json("/api/admin/invitations")).body.invitations[0].attachment_media_id).toBe("tree1");
    expect((await c.json(`/api/admin/invitations/${inv.body.id}/resend`, { method: "POST", body: {} })).status).toBe(200);
    expect(sent[1].attachments[0].filename).toBe("Drzewo_rodziny_wersja_2026.pdf");
    // a photo, or a document that does not exist, is the admin's mistake and is refused up front
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "kin2@x.org", lang: "pl", attachment: "photo1" } })).body).toEqual({ error: "bad_attachment" });
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "kin2@x.org", lang: "pl", attachment: "nope" } })).status).toBe(400);
    // the plain invitation is unchanged: no attachments key at all
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "kin3@x.org", lang: "pl" } })).status).toBe(201);
    expect(sent[sent.length - 1].attachments).toBeUndefined();
    // a document removed after the invitation went out does not break the re-send
    await env.MEDIA.delete("media/tree1.pdf");
    expect((await c.json(`/api/admin/invitations/${inv.body.id}/resend`, { method: "POST", body: {} })).status).toBe(200);
    expect(sent[sent.length - 1].attachments).toBeUndefined();
  });

  it("the founder still invites in his own voice", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p_and", first_name: "Jan", last_name: "Nowak" });
    await env.DB.prepare("UPDATE accounts SET person_id = 'p_and', founder = 1 WHERE id = 'adm'").run();
    sent.length = 0;
    expect((await c.json("/api/admin/invitations", { method: "POST", body: { email: "n@x.org", lang: "pl" } })).status).toBe(201);
    expect(sent[0].text).toContain("Mama zostawiła mi Drzewo Genealogiczne");
    expect(sent[0].text).toContain("lepiej ode mnie");
    expect(sent[0].text.trimEnd().endsWith("Jan Nowak")).toBe(true);
  });
});

describe("accounts", () => {
  it("only the founder may protect an admin, and a protected admin resists everyone else", async () => {
    const { c } = await adminWithFreshPasskey();                       // an ordinary admin, not the founder
    await seedAccount(env, { id: "a2", email: "second@x.org", role: "admin" });
    expect((await c.json("/api/admin/accounts/a2", { method: "PATCH", body: { protected: 1 } })).status).toBe(403);
    await env.DB.prepare("UPDATE accounts SET protected = 1 WHERE id = 'a2'").run();
    expect((await c.json("/api/admin/accounts/a2", { method: "PATCH", body: { role: "family" } })).status).toBe(403);
    expect((await c.json("/api/admin/accounts/a2/disable", { method: "POST", body: {} })).status).toBe(403);

    await env.DB.prepare("UPDATE accounts SET founder = 1 WHERE id = 'adm'").run();   // now the founder is asking
    expect((await c.json("/api/admin/accounts/a2", { method: "PATCH", body: { protected: 0 } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT protected FROM accounts WHERE id = 'a2'").first()).protected).toBe(0);
    expect((await c.json("/api/admin/accounts/a2", { method: "PATCH", body: { role: "family" } })).status).toBe(200);
    const acts = (await env.DB.prepare("SELECT action FROM history WHERE target_id = 'a2' ORDER BY id").all()).results.map((r) => r.action);
    expect(acts).toEqual(["protection_changed", "role_changed"]);
  });

  it("the founder cannot be demoted or disabled, by anyone", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f0", email: "founder@x.org", role: "admin" });
    await env.DB.prepare("UPDATE accounts SET founder = 1 WHERE id = 'f0'").run();
    expect((await c.json("/api/admin/accounts/f0", { method: "PATCH", body: { role: "family" } })).status).toBe(403);
    expect((await c.json("/api/admin/accounts/f0/disable", { method: "POST", body: {} })).status).toBe(403);
    expect((await env.DB.prepare("SELECT role, disabled_at FROM accounts WHERE id = 'f0'").first()))
      .toMatchObject({ role: "admin", disabled_at: null });
  });

  it("mails the new admin when rights are granted, and says nothing when they are taken away", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedAccount(env, { id: "p1", email: "promoted@x.org", lang: "pl" });
    await env.DB.prepare("INSERT INTO passkeys (id, account_id, credential_id, public_key, counter, name, created_at) VALUES ('k1','p1','cred1',X'00',0,'k',1)").run();
    sent.length = 0;
    expect((await c.json("/api/admin/accounts/p1", { method: "PATCH", body: { role: "admin" } })).status).toBe(200);
    const granted = sent.filter((m) => m.to === "promoted@x.org");
    expect(granted).toHaveLength(1);
    expect(granted[0].text).toContain("/app/admin");
    sent.length = 0;
    expect((await c.json("/api/admin/accounts/p1", { method: "PATCH", body: { role: "family" } })).status).toBe(200);
    expect(sent.filter((m) => m.to === "promoted@x.org")).toHaveLength(0);
  });

  it("grant admin needs a passkey; revoke admin; cannot change own role", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    const g1 = await c.json("/api/admin/accounts/f1", { method: "PATCH", body: { role: "admin" } });
    expect(g1.status).toBe(409);
    expect(g1.body).toEqual({ error: "passkey_required" });
    const fam = await login("f@x.org");
    const auth = await createAuthenticator();
    const ch = await fam.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    await fam.json("/api/me/passkeys", { method: "POST", body: { name: "k", credential: await auth.create(ch.body.challenge) } });
    expect((await c.json("/api/admin/accounts/f1", { method: "PATCH", body: { role: "admin" } })).status).toBe(200);
    expect((await q.accountById(env.DB, "f1").first()).role).toBe("admin");
    expect((await c.json("/api/admin/accounts/f1", { method: "PATCH", body: { role: "family" } })).status).toBe(200);
    expect((await c.json("/api/admin/accounts/adm", { method: "PATCH", body: { role: "family" } })).status).toBe(409);
    expect((await c.json("/api/admin/accounts/f1", { method: "PATCH", body: { role: "root" } })).status).toBe(400);
    const list = (await c.json("/api/admin/accounts")).body.accounts;
    expect(list.find((a) => a.id === "f1")).toMatchObject({ email: "f@x.org", role: "family", passkeys: 1 });
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 40, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions.filter((a) => a === "role_changed")).toHaveLength(2);
  });

  it("disable kills sessions and blocks login; revoke-sessions signs the account out everywhere", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    const fam = await login("f@x.org");
    expect((await c.json("/api/admin/accounts/f1/revoke-sessions", { method: "POST", body: {} })).status).toBe(200);
    expect((await fam.json("/api/me")).status).toBe(401);
    const fam2 = await login("f@x.org");
    expect((await c.json("/api/admin/accounts/f1/disable", { method: "POST", body: {} })).status).toBe(200);
    expect((await fam2.json("/api/me")).status).toBe(401);
    sent.length = 0;
    const disabled = new Client(env);
    await disabled.json("/api/auth/email", { method: "POST", body: { email: "f@x.org" } });
    await disabled.json("/api/auth/code/request", { method: "POST", body: { email: "f@x.org" } });
    expect(sent).toHaveLength(0);
    expect((await c.json("/api/admin/accounts/adm/disable", { method: "POST", body: {} })).status).toBe(409);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 40, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).toContain("account_disabled");
    expect(actions).toContain("session_revoked");
  });

  it("enable reverses disable: a re-enabled account can request a code again", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedAccount(env, { id: "f1", email: "f@x.org" });
    expect((await c.json("/api/admin/accounts/f1/disable", { method: "POST", body: {} })).status).toBe(200);
    const disabled = new Client(env);
    await disabled.json("/api/auth/email", { method: "POST", body: { email: "f@x.org" } });
    await disabled.json("/api/auth/code/request", { method: "POST", body: { email: "f@x.org" } });
    const before = sent.length;
    expect((await c.json("/api/admin/accounts/f1/enable", { method: "POST", body: {} })).status).toBe(200);
    expect((await q.accountById(env.DB, "f1").first()).disabled_at).toBeNull();
    await disabled.json("/api/auth/code/request", { method: "POST", body: { email: "f@x.org" } });
    expect(sent.length).toBe(before + 1);
    expect((await c.json("/api/admin/accounts/nope/enable", { method: "POST", body: {} })).status).toBe(404);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 40, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).toContain("account_enabled");
  });
});

describe("history and news", () => {
  it("family and admin both see only content events, with no emails; paging works", async () => {
    const { c } = await adminWithFreshPasskey();
    await q.insertInvitation(env.DB, { id: "i1", email: "n@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    const fam = await login("n@x.org");
    const famNews = (await fam.json("/api/news")).body;
    expect(famNews.items.map((i) => i.action)).toEqual(["login", "invite_accepted", "login"]);
    expect(famNews.items[0]).not.toHaveProperty("actor_email");
    expect(famNews.items[0].actor_name).toBe("n@x.org");
    const admNews = (await c.json("/api/news")).body;
    // Admins now see the same family-visible feed — the full event table lives at Admin → Historia.
    expect(admNews.items.map((i) => i.action)).toEqual(famNews.items.map((i) => i.action));
    expect(admNews.items.map((i) => i.action)).not.toContain("code_sent");
    expect(admNews.items[0]).not.toHaveProperty("actor_email");
    expect(admNews.items[0]).not.toHaveProperty("ip_hash");
    expect(admNews.items[0]).not.toHaveProperty("actor_account_id");
    const first = admNews.items[0].id;
    const page2 = (await c.json(`/api/news?before=${first}`)).body;
    expect(page2.items[0].id).toBeLessThan(first);
    const hist = (await c.json("/api/admin/history?account=adm")).body;
    expect(hist.items.every((i) => i.actor_email === "adm@x.org" || i.target_id === "adm")).toBe(true);
    expect((await fam.json("/api/admin/history")).status).toBe(403);
  });

  it("news items from a person-linked actor carry actor_person_id and actor_name; admin history keeps actor_email", async () => {
    const { c } = await adminWithFreshPasskey();
    await seedPerson(env, { id: "p1", first_name: "Jan", last_name: "Kowalski" });
    await q.linkAccountPerson(env.DB, "adm", "p1").run();
    await q.insertHistory(env.DB, { at: 2, actor: "adm", action: "person_created", targetType: "person", targetId: "p1", details: JSON.stringify({ name: "Jan Kowalski" }), ipHash: "h" }).run();
    const admNews = (await c.json("/api/news")).body;
    const item = admNews.items.find((i) => i.action === "person_created");
    expect(item.actor_person_id).toBe("p1");
    expect(item.actor_name).toBe("Jan Kowalski");
    expect(item).not.toHaveProperty("actor_email");
    const hist = (await c.json("/api/admin/history")).body;
    expect(hist.items.some((i) => i.actor_email === "adm@x.org")).toBe(true);
  });
});
