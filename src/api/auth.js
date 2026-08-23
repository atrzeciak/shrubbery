import * as q from "../db/queries.js";
import { clientIp, cookie, json, nowSec, randomB64url, readCookie } from "../util.js";
import { hashIp, historyStmt } from "../history.js";
import { allow } from "../auth/ratelimit.js";
import { prepareCode, verifyCode } from "../auth/codes.js";
import { clearSessionCookie, prepareSession, resolveSession, sessionCookie } from "../auth/sessions.js";
import { newChallenge, verifyAssertion, WebAuthnError } from "../auth/webauthn.js";
import { sendCode, sendJoinedNotice } from "../mail.js";
import { ApiError, EMAIL_RE, appOrigin, normEmail, readJson, requireSession, rpIdOf } from "./common.js";

const NONCE_COOKIE = "session_nonce";
const NONCE_TTL = 3600;
export const CHALLENGE_COOKIE = "wa_challenge";
const CHALLENGE_TTL = 300;
const CODE_LIMIT = 5, CHALLENGE_LIMIT = 20, HOUR = 3600;

export const clearChallenge = () => ({ "set-cookie": cookie(CHALLENGE_COOKIE, "", 0) });

async function postEmail(request) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ApiError(400, "bad_request");
  const existingNonce = readCookie(request, NONCE_COOKIE);
  const nonce = existingNonce || randomB64url(16);
  const headers = existingNonce ? {} : { "set-cookie": cookie(NONCE_COOKIE, nonce, NONCE_TTL) };
  return json({ ok: true }, 200, headers);
}

async function postCodeRequest(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ApiError(400, "bad_request");
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!nonce) throw new ApiError(400, "bad_request");
  const db = env.DB, now = nowSec(), ip = clientIp(request);
  if (!(await allow(db, `code:email:${email}`, CODE_LIMIT, HOUR, now)) || !(await allow(db, `code:ip:${ip}`, CODE_LIMIT, HOUR, now))) {
    throw new ApiError(429, "rate_limited");
  }
  const account = await q.accountByEmail(db, email).first();
  let lang = null;
  if (account) {
    if (!account.disabled_at) lang = account.lang;
  } else {
    const inv = await q.activeInvitationByEmail(db, email, now).first();
    if (inv) lang = inv.lang;
  }
  // Always create the code row for a well-formed, rate-limit-passing address — only the
  // history write and the actual mail send are conditional on the address being known/invited.
  // Otherwise /api/auth/code could distinguish known from unknown addresses by error code.
  const { code, stmt } = await prepareCode(db, { email, nonce }, now);
  const stmts = [stmt];
  if (lang) stmts.push(historyStmt(db, { actor: account ? account.id : null, action: "code_sent", targetType: "email", targetId: email, details: {}, ipHash: await hashIp(env, ip, now) }));
  await db.batch(stmts);
  if (lang) await sendCode(env, email, code, lang);
  return json({ ok: true });
}

async function postChallenge(request, env) {
  if (!(await allow(env.DB, `challenge:ip:${clientIp(request)}`, CHALLENGE_LIMIT, HOUR))) throw new ApiError(429, "rate_limited");
  const challenge = newChallenge();
  return json({ challenge, rpId: rpIdOf(env) }, 200, { "set-cookie": cookie(CHALLENGE_COOKIE, challenge, CHALLENGE_TTL) });
}

// Verifies a browser assertion against the stored passkey. Throws 400/401 on any failure.
export async function assertPasskey(env, cred, challenge) {
  if (!challenge || !cred || typeof cred.id !== "string" || !cred.response) throw new ApiError(400, "bad_request", clearChallenge());
  const pk = await q.passkeyByCredentialId(env.DB, cred.id).first();
  if (!pk) throw new ApiError(401, "unauthorized", clearChallenge());
  try {
    const r = await verifyAssertion({ ...cred.response, publicKey: pk.public_key, expectedChallenge: challenge, expectedOrigin: appOrigin(env), rpId: rpIdOf(env), prevCounter: pk.counter });
    return { pk, counter: r.counter };
  } catch (e) {
    if (e instanceof WebAuthnError) throw new ApiError(401, "unauthorized", clearChallenge());
    throw e;
  }
}

async function postPasskeyLogin(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const nonce = readCookie(request, NONCE_COOKIE);
  const challenge = readCookie(request, CHALLENGE_COOKIE);
  if (!nonce || !challenge) throw new ApiError(400, "bad_request", clearChallenge());
  const db = env.DB, now = nowSec(), ip = clientIp(request);
  const { pk, counter } = await assertPasskey(env, body.credential, challenge);
  const account = await q.accountById(db, pk.account_id).first();
  if (!account || account.disabled_at || account.email !== email) throw new ApiError(401, "unauthorized", clearChallenge());
  const s = await prepareSession(db, { accountId: account.id, passkeyAt: now, userAgent: request.headers.get("user-agent") || "" }, now);
  await db.batch([
    q.updatePasskeyCounter(db, pk.id, counter, now),
    s.stmt,
    historyStmt(db, { actor: account.id, action: "login", targetType: "account", targetId: account.id, details: { passkey: true }, ipHash: await hashIp(env, ip, now) }),
  ]);
  return json({ ok: true }, 200, { "set-cookie": [sessionCookie(s.token), cookie(NONCE_COOKIE, "", 0), cookie(CHALLENGE_COOKIE, "", 0)] });
}

async function postCode(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const code = String(body.code || "").trim();
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!nonce || !/^\d{6}$/.test(code) || !EMAIL_RE.test(email)) throw new ApiError(400, "bad_request");
  const db = env.DB, now = nowSec(), ip = clientIp(request);
  const ipHash = await hashIp(env, ip, now);
  const v = await verifyCode(db, { email, nonce, code }, now);
  if (!v.ok) {
    await db.batch([v.stmt, historyStmt(db, { actor: null, action: "login_failed", targetType: "email", targetId: email, details: { reason: v.error }, ipHash })].filter(Boolean));
    throw new ApiError(400, v.error);
  }
  // markCodeUsed runs alone first, before anything else: the code is single-use, and a
  // concurrent request may already have burned it between verifyCode's read and here.
  const [used] = await db.batch([v.stmt]);
  if (!used.meta.changes) throw new ApiError(400, "expired");
  let account = await q.accountByEmail(db, email).first();
  const stmts = [];
  let joined = false;
  if (account && account.disabled_at) throw new ApiError(403, "forbidden");
  if (!account) {
    const inv = await q.activeInvitationByEmail(db, email, now).first();
    if (!inv) throw new ApiError(401, "unauthorized");
    const granted = await q.grantedJoinRequestByEmail(db, email).first();
    const personId = granted && !(await q.accountByPerson(db, granted.matched_person_id).first()) ? granted.matched_person_id : null;
    account = { id: randomB64url(16), email, role: "family", lang: inv.lang, createdAt: now, invitedBy: inv.invited_by, personId };
    stmts.push(
      q.insertAccount(db, account),
      q.acceptInvitation(db, inv.id, now),
      historyStmt(db, { actor: account.id, action: "invite_accepted", targetType: "account", targetId: account.id, details: { email }, ipHash }),
    );
    joined = true;
  }
  const s = await prepareSession(db, { accountId: account.id, passkeyAt: null, userAgent: request.headers.get("user-agent") || "" }, now);
  stmts.push(s.stmt, historyStmt(db, { actor: account.id, action: "login", targetType: "account", targetId: account.id, details: { passkey: false }, ipHash }));
  await db.batch(stmts);
  if (joined) await notifyAdminsJoined(env, account, email);
  return json({ ok: true }, 200, { "set-cookie": [sessionCookie(s.token), cookie(NONCE_COOKIE, "", 0)] });
}

// A failed notice must never cost the new member their first login: the account already exists.
async function notifyAdminsJoined(env, account, email) {
  try {
    const person = account.personId ? await q.personById(env.DB, account.personId).first() : null;
    const name = person?.display_name || email;
    const { results } = await q.listAdmins(env.DB).all();
    for (const a of results) {
      try { await sendJoinedNotice(env, a.email, a.lang, name, email); } catch { /* keep notifying the rest */ }
    }
  } catch { /* the login stands regardless */ }
}

async function postStepUp(request, env) {
  const { session, account } = await requireSession(request, env);
  const body = await readJson(request);
  const challenge = readCookie(request, CHALLENGE_COOKIE);
  const { pk, counter } = await assertPasskey(env, body.credential, challenge);
  if (pk.account_id !== account.id) throw new ApiError(401, "unauthorized", clearChallenge());
  const now = nowSec();
  await env.DB.batch([q.updatePasskeyCounter(env.DB, pk.id, counter, now), q.setSessionPasskeyAt(env.DB, session.id, now)]);
  return json({ ok: true, passkey_at: now }, 200, clearChallenge());
}

async function postLogout(request, env) {
  const r = await resolveSession(env.DB, request);
  if (r) {
    const now = nowSec();
    await env.DB.batch([
      q.revokeSession(env.DB, r.session.id, r.account.id, now),
      historyStmt(env.DB, { actor: r.account.id, action: "session_revoked", targetType: "account", targetId: r.account.id, details: { self: true }, ipHash: await hashIp(env, clientIp(request), now) }),
    ]);
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

export const routes = [
  ["POST", /^\/api\/auth\/email$/, postEmail],
  ["POST", /^\/api\/auth\/code\/request$/, postCodeRequest],
  ["POST", /^\/api\/auth\/passkey\/challenge$/, postChallenge],
  ["POST", /^\/api\/auth\/passkey\/login$/, postPasskeyLogin],
  ["POST", /^\/api\/auth\/code$/, postCode],
  ["POST", /^\/api\/auth\/passkey\/step-up$/, postStepUp],
  ["POST", /^\/api\/auth\/logout$/, postLogout],
];
