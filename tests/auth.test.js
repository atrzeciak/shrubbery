import { describe, it, expect, beforeEach } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker.js";
import * as q from "../src/db/queries.js";
import { verifyRegistration } from "../src/auth/webauthn.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { makeEnv, resetDb, seedAccount, seedPerson, lastCode, Client } from "./helpers/env.js";
import { capturingErrors } from "./helpers/logging.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function registerPasskey(env, accountId, alg = "ES256", staticCounter = false) {
  const auth = await createAuthenticator({ alg, staticCounter });
  const ch = "seed-challenge";
  const cred = await auth.create(ch);
  const reg = await verifyRegistration({ expectedOrigin: "https://example.org", rpId: "example.org", ...cred.response, expectedChallenge: ch });
  await q.insertPasskey(env.DB, { id: `pk-${accountId}`, accountId, credentialId: reg.credentialId, publicKey: reg.publicKey, counter: reg.counter, transports: "internal", name: "test", createdAt: 1 }).run();
  return auth;
}

async function loginWithCode(c, email) {
  expect((await c.json("/api/auth/email", { method: "POST", body: { email } })).status).toBe(200);
  expect((await c.json("/api/auth/code/request", { method: "POST", body: { email } })).status).toBe(200);
  const r = await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } });
  expect(r.status).toBe(200);
  return r;
}

describe("email step", () => {
  it("answers identically for unknown and known addresses; sends nothing, writes nothing", async () => {
    await seedAccount(env, { id: "a1", email: "anna@x.org", lang: "en" });
    const c = new Client(env);
    const unknown = await c.json("/api/auth/email", { method: "POST", body: { email: "nobody@x.org" } });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    const known = await c.json("/api/auth/email", { method: "POST", body: { email: "Anna@X.org " } });
    expect(known.body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(c.cookies.has("session_nonce")).toBe(true);
    const hist = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
    expect(hist).toHaveLength(0);
  });

  it("rejects malformed email, refuses foreign origins and lets the site's own through", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    expect((await c.json("/api/auth/email", { method: "POST", body: { email: "nope" } })).status).toBe(400);
    const foreign = await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" }, headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    const own = await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" }, headers: { origin: "https://example.org" } });
    expect(own.status).toBe(200);
  });
});

describe("code request step", () => {
  it("known address gets one mail and a code_sent history entry", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org", lang: "en" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const r = await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("a@x.org");
    expect(sent[0].from).toEqual({ email: "login@mail.example.org", name: "Our Roots" });
    expect(sent[0].text).toMatch(/\b\d{6}\b/);
    expect(sent[0].subject).toMatch(/code/i);
    const hist = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
    expect(hist.map((h) => h.action)).toEqual(["code_sent"]);
  });

  it("unknown address gets no mail and no history, but still 200", async () => {
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "ghost@x.org" } });
    const r = await c.json("/api/auth/code/request", { method: "POST", body: { email: "ghost@x.org" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    const hist = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
    expect(hist).toHaveLength(0);
  });

  it("does not send to a disabled account", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    await q.disableAccount(env.DB, "a1", 1).run();
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
    expect(sent).toHaveLength(0);
  });

  it("rate-limits the 6th request for the same address, and requires the nonce cookie", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    for (let i = 0; i < 5; i++) expect((await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } })).status).toBe(200);
    expect((await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } })).status).toBe(429);
    const noNonce = new Client(env);
    expect((await noNonce.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } })).status).toBe(400);
  });

  it("limits one address even when every request comes from a different IP", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const from = async (i) => { c.ip = `198.51.100.${i}`; return (await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } })).status; };
    for (let i = 1; i <= 5; i++) expect(await from(i)).toBe(200);
    expect(await from(6)).toBe(429);
  });

  it("requests refused for their IP do not spend the address's budget", async () => {
    await seedAccount(env, { id: "b1", email: "b@x.org", lang: "en" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    for (let i = 0; i < 5; i++) await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
    for (let i = 0; i < 5; i++) expect((await c.json("/api/auth/code/request", { method: "POST", body: { email: "b@x.org" } })).status).toBe(429);
    const b = new Client(env);
    b.ip = "198.51.100.7";
    await b.json("/api/auth/email", { method: "POST", body: { email: "b@x.org" } });
    expect((await b.json("/api/auth/code/request", { method: "POST", body: { email: "b@x.org" } })).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["b@x.org"]);
  });
});

// Only a known address used to wait for the mail provider, so timing told members from strangers,
// and only a known address could turn a provider failure into a 500.
describe("the mail a code goes out in", () => {
  async function answerWhileMailHeld(c, path, body) {
    let release;
    const held = new Promise((r) => { release = r; });
    const send = env.EMAIL.send;
    env.EMAIL.send = async (m) => { await held; return send(m); };
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const req = new Request(`https://example.org${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": c.ip, cookie }, body: JSON.stringify(body) });
    const ctx = createExecutionContext();
    const res = await Promise.race([worker.fetch(req, env, ctx), new Promise((r) => { setTimeout(() => r("held back by the mail"), 300); })]);
    const before = sent.length;
    release();
    await waitOnExecutionContext(ctx);
    env.EMAIL.send = send;
    return { res, before };
  }

  it("is sent after the answer, for a login code and a join code alike", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org", lang: "en" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const login = await answerWhileMailHeld(c, "/api/auth/code/request", { email: "a@x.org" });
    expect(login.res.status).toBe(200);
    expect(login.before).toBe(0);
    const join = await answerWhileMailHeld(new Client(env), "/api/join/request", { first_name: "Anna", last_name: "Z", birth_date: "1985", parent_text: "B", email: "new@x.org", message: "", lang: "en" });
    expect(join.res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["a@x.org", "new@x.org"]);
  });

  it("failing to send is logged, and the answer is the same as for an unknown address", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org", lang: "en" });
    env.EMAIL.send = async () => { throw new Error("provider down"); };
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const { value: r, logged } = await capturingErrors(() => c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(logged.map((e) => e.message)).toEqual(["provider down"]);
    const j = await capturingErrors(() => new Client(env).json("/api/join/request", { method: "POST", body: { first_name: "Anna", last_name: "Z", birth_date: "1985", parent_text: "B", email: "new@x.org", message: "", lang: "en" } }));
    expect(j.value.status).toBe(200);
    expect(j.logged.map((e) => e.message)).toEqual(["provider down"]);
  });
});

describe("code step", () => {
  it("five wrong codes burn the right one too, and no session comes of it", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
    const code = lastCode(sent), wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await c.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code: wrong } })).body).toEqual({ error: "invalid_code" });
    }
    expect((await c.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code } })).body).toEqual({ error: "expired" });
    expect(c.cookies.has("session")).toBe(false);
  });

  it("invited relative signs in, account is created with the invitation language, history recorded", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await q.insertInvitation(env.DB, { id: "i1", email: "new@x.org", lang: "en", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    const c = new Client(env);
    await loginWithCode(c, "new@x.org");
    expect(c.cookies.has("session")).toBe(true);
    expect(c.cookies.has("session_nonce")).toBe(false);
    const me = await c.json("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ email: "new@x.org", role: "family", lang: "en" });
    expect(me.body.passkeys).toBe(0);
    expect(me.body.session.passkey_at).toBeNull();
    expect((await q.invitationById(env.DB, "i1").first()).accepted_at).not.toBeNull();
    const hist = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
    expect(hist.map((h) => h.action)).toEqual(["login", "invite_accepted", "code_sent"]);
    expect(JSON.parse(hist[0].details)).toEqual({ passkey: false });
  });

  it("first login links the account to the person in the tree who has that email", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedPerson(env, { id: "p1", first_name: "Nowa", last_name: "Osoba", email: "New@X.org" });
    await q.insertInvitation(env.DB, { id: "i1", email: "new@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await loginWithCode(new Client(env), "new@x.org");
    expect((await q.accountByEmail(env.DB, "new@x.org").first()).person_id).toBe("p1");
    expect((await q.personById(env.DB, "p1").first()).email).toBe("new@x.org");
    const row = await env.DB.prepare("SELECT details FROM history WHERE action = 'invite_accepted'").first();
    expect(JSON.parse(row.details)).toEqual({ email: "new@x.org", person_id: "p1" });   // the link is on record
  });

  it("first login leaves the account unlinked when that person already has an account", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedAccount(env, { id: "old", email: "old@x.org" });
    await seedPerson(env, { id: "p1", first_name: "Nowa", last_name: "Osoba", email: "new@x.org" });
    await env.DB.prepare("UPDATE accounts SET person_id = 'p1' WHERE id = 'old'").run();
    await q.insertInvitation(env.DB, { id: "i1", email: "new@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await loginWithCode(new Client(env), "new@x.org");
    expect((await q.accountByEmail(env.DB, "new@x.org").first()).person_id).toBeNull();
  });

  it("a granted join request names the person even when another person carries the email", async () => {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "admin" });
    await seedPerson(env, { id: "p_mail", first_name: "By", last_name: "Mail", email: "new@x.org" });
    await seedPerson(env, { id: "p_admin", first_name: "By", last_name: "Admin" });
    await q.insertJoinRequest(env.DB, { id: "j1", first_name: "By", last_name: "Admin", birth_date: "1980", parent_text: "x", email: "new@x.org", message: null, lang: "pl", created_at: 1, status: "approved", matched_person_id: "p_admin" }).run();
    await q.insertInvitation(env.DB, { id: "i1", email: "new@x.org", lang: "pl", invitedBy: "adm", createdAt: 1, expiresAt: 4_000_000_000 }).run();
    await loginWithCode(new Client(env), "new@x.org");
    expect((await q.accountByEmail(env.DB, "new@x.org").first()).person_id).toBe("p_admin");
    // The login address becomes the person's one address; the other person keeps theirs.
    expect((await q.personById(env.DB, "p_admin").first()).email).toBe("new@x.org");
    expect((await q.personById(env.DB, "p_mail").first()).email).toBe("new@x.org");
  });

  it("wrong code → invalid_code and login_failed; a browser without the nonce cannot use the code", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    await c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } });
    const code = lastCode(sent);
    const wrong = code === "000000" ? "000001" : "000000";
    const r = await c.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code: wrong } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_code" });
    const other = new Client(env);
    expect((await other.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code } })).status).toBe(400);
    const ok = await c.json("/api/auth/code", { method: "POST", body: { email: "a@x.org", code } });
    expect(ok.status).toBe(200);
    const actions = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results.map((h) => h.action);
    expect(actions).toContain("login_failed");
  });

  it("an unknown address behaves identically to a known one at the code step (no enumeration oracle)", async () => {
    const c = new Client(env);
    const email = await c.json("/api/auth/email", { method: "POST", body: { email: "ghost@x.org" } });
    expect(email.status).toBe(200);
    const req = await c.json("/api/auth/code/request", { method: "POST", body: { email: "ghost@x.org" } });
    expect(req.status).toBe(200);
    expect(sent).toHaveLength(0);
    const r = await c.json("/api/auth/code", { method: "POST", body: { email: "ghost@x.org", code: "000000" } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_code" });
    expect(sent).toHaveLength(0);
  });

  it("a guess with no code behind it writes nothing to history, whatever its size", async () => {
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const long = await c.json("/api/auth/code", { method: "POST", body: { email: `${"a".repeat(300)}@x.org`, code: "000000" } });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: "bad_request" });
    const none = await c.json("/api/auth/code", { method: "POST", body: { email: "nobody@x.org", code: "000000" } });
    expect(none.status).toBe(400);
    expect(none.body).toEqual({ error: "expired" });
    expect((await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results).toEqual([]);
  });

  it("logout revokes the session and clears the cookie", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = new Client(env);
    await loginWithCode(c, "a@x.org");
    const out = await c.json("/api/auth/logout", { method: "POST", body: {} });
    expect(out.status).toBe(200);
    expect(out.res.headers.get("clear-site-data")).toBe('"cache"');   // photos and documents it cached go too
    expect(c.cookies.has("session")).toBe(false);
    expect((await c.json("/api/me")).status).toBe(401);
  });

  it("a cookie that is not valid percent-encoding reads as no session, not a crash", async () => {
    const c = new Client(env);
    const headers = { cookie: "session=%" };
    expect((await c.json("/api/me", { headers })).status).toBe(401);
    const out = await c.json("/api/auth/logout", { method: "POST", body: {}, headers });
    expect(out.status).toBe(200);
    expect(out.res.headers.getSetCookie().some((sc) => sc.startsWith("session=;") && sc.includes("Max-Age=0"))).toBe(true);
  });
});

describe("passkey step", () => {
  for (const alg of ["ES256", "RS256"]) {
    it(`${alg}: an enrolled passkey signs in by itself`, async () => {
      await seedAccount(env, { id: "a1", email: "a@x.org" });
      const auth = await registerPasskey(env, "a1", alg);
      const c = new Client(env);
      await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
      const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
      expect(ch.status).toBe(200);
      expect(ch.body.rpId).toBe("example.org");
      const cred = await auth.get(ch.body.challenge);
      const login = await c.json("/api/auth/passkey/login", { method: "POST", body: { email: "a@x.org", credential: cred } });
      expect(login.status).toBe(200);
      expect(c.cookies.has("session")).toBe(true);
      expect(c.cookies.has("session_nonce")).toBe(false);
      expect(c.cookies.has("wa_challenge")).toBe(false);
      const me = await c.json("/api/me");
      expect(me.body.session.passkey_at).not.toBeNull();
      expect(me.body.passkeys).toBe(1);
      expect((await q.passkeyByCredentialId(env.DB, auth.credentialId).first()).counter).toBe(2);
      expect(sent).toHaveLength(0);
      const hist = (await q.listHistory(env.DB, { beforeId: null, limit: 10, actions: null, accountId: null }).all()).results;
      expect(hist.map((h) => h.action)).toEqual(["login"]);
      expect(JSON.parse(hist[0].details)).toEqual({ passkey: true });
    });
  }

  it("a disabled account's passkey is refused and no session is created", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const auth = await registerPasskey(env, "a1");
    await q.disableAccount(env.DB, "a1", 1).run();
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const cred = await auth.get(ch.body.challenge);
    const login = await c.json("/api/auth/passkey/login", { method: "POST", body: { email: "a@x.org", credential: cred } });
    expect(login.status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n).toBe(0);
  });

  it("a credential with a non-base64url field is refused, not a 500", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const auth = await registerPasskey(env, "a1");
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const cred = await auth.get(ch.body.challenge);
    cred.response.signature = "%%%";
    const login = await c.json("/api/auth/passkey/login", { method: "POST", body: { email: "a@x.org", credential: cred } });
    expect(login.status).toBe(401);
  });

  it("a passkey of another account, a stale challenge, or a replay is refused", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    await seedAccount(env, { id: "b1", email: "b@x.org" });
    const authB = await registerPasskey(env, "b1");
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const cred = await authB.get(ch.body.challenge);
    expect((await c.json("/api/auth/passkey/login", { method: "POST", body: { email: "a@x.org", credential: cred } })).status).toBe(401);
    // challenge cookie was consumed → second attempt has no challenge
    expect((await c.json("/api/auth/passkey/login", { method: "POST", body: { email: "b@x.org", credential: cred } })).status).toBe(400);
  });

  // Synced passkeys report counter 0 every time, so only the server's record of the challenge stops a replay.
  it("an assertion signs in once, even from a passkey whose counter never moves", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const auth = await registerPasskey(env, "a1", "ES256", true);
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });
    const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const body = { email: "a@x.org", credential: await auth.get(ch.body.challenge) };
    expect((await c.json("/api/auth/passkey/login", { method: "POST", body })).status).toBe(200);
    const replay = new Client(env);
    replay.cookies.set("session_nonce", "x");
    replay.cookies.set("wa_challenge", ch.body.challenge);
    expect((await replay.json("/api/auth/passkey/login", { method: "POST", body })).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n).toBe(1);
  });

  it("a challenge the server never issued signs nobody in", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const auth = await registerPasskey(env, "a1", "ES256", true);
    const c = new Client(env);
    c.cookies.set("session_nonce", "x");
    c.cookies.set("wa_challenge", "made-up");
    const body = { email: "a@x.org", credential: await auth.get("made-up") };
    expect((await c.json("/api/auth/passkey/login", { method: "POST", body })).status).toBe(401);
  });

  it("a step-up assertion counts once, even from a passkey whose counter never moves", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const auth = await registerPasskey(env, "a1", "ES256", true);
    const c = new Client(env);
    await loginWithCode(c, "a@x.org");
    const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const body = { credential: await auth.get(ch.body.challenge) };
    expect((await c.json("/api/auth/passkey/step-up", { method: "POST", body })).status).toBe(200);
    c.cookies.set("wa_challenge", ch.body.challenge);
    expect((await c.json("/api/auth/passkey/step-up", { method: "POST", body })).status).toBe(401);
  });

  it("step-up sets passkey_at on a code-only session; only the account's own passkey counts", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    await seedAccount(env, { id: "b1", email: "b@x.org" });
    const authA = await registerPasskey(env, "a1");
    const authB = await registerPasskey(env, "b1");
    const c = new Client(env);
    await loginWithCode(c, "a@x.org");
    expect((await c.json("/api/me")).body.session.passkey_at).toBeNull();
    let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    expect((await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await authB.get(ch.body.challenge) } })).status).toBe(401);
    ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    const up = await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await authA.get(ch.body.challenge) } });
    expect(up.status).toBe(200);
    expect((await c.json("/api/me")).body.session.passkey_at).toBe(up.body.passkey_at);
  });

  it("challenge requests are rate-limited at 20/hour per IP", async () => {
    const c = new Client(env);
    for (let i = 0; i < 20; i++) expect((await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} })).status).toBe(200);
    expect((await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} })).status).toBe(429);
  });
});
