import * as q from "../db/queries.js";
import { clientIp, json, nowSec, randomB64url, readCookie } from "../util.js";
import { hashIp, historyStmt, historyStmtIfPasskeyGone } from "../history.js";
import { clearSessionCookie } from "../auth/sessions.js";
import { verifyRegistration, WebAuthnError } from "../auth/webauthn.js";
import { ApiError, appOrigin, readJson, requireAdmin, requireSession, rpIdOf } from "./common.js";
import { CHALLENGE_COOKIE, clearChallenge } from "./auth.js";
import { domainRenewsAt, warningsFor } from "../ops/checks.js";

async function ownHistory(request, env, account, action, details, now) {
  return historyStmt(env.DB, { actor: account.id, action, targetType: "account", targetId: account.id, details, ipHash: await hashIp(env, clientIp(request), now) }, now);
}

async function ownHistoryIfPasskeyGone(request, env, account, action, details, passkeyId, now) {
  return historyStmtIfPasskeyGone(env.DB, { actor: account.id, action, targetType: "account", targetId: account.id, details, ipHash: await hashIp(env, clientIp(request), now) }, passkeyId, now);
}

// Admins carry the survival warnings on every view, so an admin who signed in to approve a join request
// cannot miss them. The warnings are recomputed here rather than read from the stored column: a frozen
// row would keep showing whatever was true the day the cron last ran, which is the failure this is for.
// Dates and warning keys only — no addresses, no token state, nothing that would justify a step-up.
async function opsSummary(env) {
  try {
    const s = (await q.opsStatus(env.DB).first()) || {};
    // The renewal date lives in wrangler.toml and is known right here, so it is read from the
    // settings rather than from whatever the last nightly run happened to copy into the row.
    const status = { ...s, domain_expires_at: domainRenewsAt(env.DOMAIN_RENEWS_AT) };
    return {
      warnings: warningsFor(status, nowSec()),
      checked_at: s.checked_at ?? null,
      domain_expires_at: status.domain_expires_at,
      card_expires_at: s.card_expires_at ?? null,
      subscription_renews_at: s.subscription_renews_at ?? null,
    };
  } catch (e) {
    // This is a convenience panel on the response that every view depends on: an ops_status that
    // cannot be read — a migration that has not landed, a dropped column, a transient D1 error —
    // must never cost an admin the whole app. It is still not allowed to answer with silence, so it
    // reports that it could not look rather than an empty, calm-looking summary.
    console.error(e);
    return { warnings: ["checks_unreadable"], checked_at: null, domain_expires_at: null, card_expires_at: null, subscription_renews_at: null };
  }
}

async function getMe(request, env) {
  const { session, account } = await requireSession(request, env);
  const { n } = await q.countPasskeys(env.DB, account.id).first();
  const avatar = account.person_id ? await q.avatarStamp(env.DB, account.person_id).first() : null;
  const person = account.person_id ? await q.personById(env.DB, account.person_id).first() : null;
  return json({
    account: {
      id: account.id, email: account.email, role: account.role, lang: account.lang, person_id: account.person_id ?? null,
      notify_events: account.notify_events ?? 0, news_seen_at: account.news_seen_at ?? null,
      founder: account.founder ?? 0,
    },
    person: person ? { id: person.id, display_name: person.display_name, avatar_at: avatar?.updated_at ?? null } : null,
    passkeys: n,
    session: { passkey_at: session.passkey_at, created_at: session.created_at },
    ops: account.role === "admin" ? await opsSummary(env) : null,
  });
}

async function patchMe(request, env) {
  const { account } = await requireSession(request, env);
  const body = await readJson(request);
  const now = nowSec();
  const stmts = [];
  if ("lang" in body) {
    if (body.lang !== "pl" && body.lang !== "en") throw new ApiError(400, "bad_request");
    stmts.push(q.setLang(env.DB, account.id, body.lang), await ownHistory(request, env, account, "lang_changed", { lang: body.lang }, now));
  }
  if ("notify_events" in body) {
    if (body.notify_events !== 0 && body.notify_events !== 1) throw new ApiError(400, "bad_request");
    stmts.push(q.setNotifyEvents(env.DB, account.id, body.notify_events), await ownHistory(request, env, account, "notify_changed", { on: body.notify_events }, now));
  }
  if ("news_seen_at" in body) {
    const at = body.news_seen_at;
    if (!Number.isSafeInteger(at) || at <= 0 || at > now + 60) throw new ApiError(400, "bad_request");
    stmts.push(q.setNewsSeenAt(env.DB, account.id, at));
  }
  if (!stmts.length) throw new ApiError(400, "bad_request");
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function listPasskeys(request, env) {
  const { account } = await requireSession(request, env);
  const { results } = await q.passkeysByAccount(env.DB, account.id).all();
  return json({ passkeys: results.map(({ credential_id, ...p }) => p) });
}

async function addPasskey(request, env) {
  const ctx = await requireSession(request, env);
  const { account } = ctx;
  if (account.role === "admin") requireAdmin(ctx);
  const body = await readJson(request);
  const challenge = readCookie(request, CHALLENGE_COOKIE);
  const cred = body.credential;
  if (!challenge || !cred || !cred.response) throw new ApiError(400, "bad_request", clearChallenge());
  let reg;
  try {
    reg = await verifyRegistration({ ...cred.response, expectedChallenge: challenge, expectedOrigin: appOrigin(env), rpId: rpIdOf(env) });
  } catch (e) {
    if (e instanceof WebAuthnError) throw new ApiError(400, "bad_request", clearChallenge());
    throw e;
  }
  if (await q.passkeyByCredentialId(env.DB, reg.credentialId).first()) throw new ApiError(409, "conflict", clearChallenge());
  const now = nowSec();
  const id = randomB64url(16);
  const name = String(body.name || "").slice(0, 60) || "passkey";
  const transports = Array.isArray(cred.response.transports) ? cred.response.transports.join(",") : null;
  await env.DB.batch([
    q.insertPasskey(env.DB, { id, accountId: account.id, credentialId: reg.credentialId, publicKey: reg.publicKey, counter: reg.counter, transports, name, createdAt: now }),
    await ownHistory(request, env, account, "passkey_added", { name }, now),
  ]);
  return json({ id }, 201, clearChallenge());
}

async function renamePasskey(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  const body = await readJson(request);
  const name = String(body.name || "").slice(0, 60);
  if (!name) throw new ApiError(400, "bad_request");
  if (!(await q.passkeyById(env.DB, m[1], account.id).first())) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.renamePasskey(env.DB, m[1], account.id, name),
    await ownHistory(request, env, account, "passkey_renamed", { id: m[1], name }, now),
  ]);
  return json({ ok: true });
}

async function removePasskey(request, env, ctx, m) {
  const sctx = await requireSession(request, env);
  const { account } = sctx;
  if (account.role === "admin") requireAdmin(sctx);
  if (!(await q.passkeyById(env.DB, m[1], account.id).first())) throw new ApiError(404, "not_found");
  const { n } = await q.countPasskeys(env.DB, account.id).first();
  if (account.role === "admin" && n <= 1) throw new ApiError(409, "last_passkey");
  const now = nowSec();
  const delStmt = account.role === "admin" ? q.deletePasskeyKeepingOne(env.DB, m[1], account.id) : q.deletePasskey(env.DB, m[1], account.id);
  const [del] = await env.DB.batch([
    delStmt,
    await ownHistoryIfPasskeyGone(request, env, account, "passkey_removed", { id: m[1] }, m[1], now),
  ]);
  if (!del.meta.changes) {
    if (await q.passkeyById(env.DB, m[1], account.id).first()) throw new ApiError(409, "last_passkey");
    throw new ApiError(404, "not_found");
  }
  return json({ ok: true });
}

async function listSessions(request, env) {
  const { session, account } = await requireSession(request, env);
  const { results } = await q.sessionsByAccount(env.DB, account.id, nowSec()).all();
  return json({ sessions: results.map((s) => ({ ...s, current: s.id === session.id })) });
}

async function revokeOneSession(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  if (!(await q.sessionByIdForAccount(env.DB, m[1], account.id).first())) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.revokeSession(env.DB, m[1], account.id, now),
    await ownHistory(request, env, account, "session_revoked", { self: true }, now),
  ]);
  return json({ ok: true });
}

async function revokeAllSessions(request, env) {
  const { account } = await requireSession(request, env);
  const now = nowSec();
  await env.DB.batch([
    q.revokeSessionsByAccount(env.DB, account.id, now),
    await ownHistory(request, env, account, "session_revoked", { self: true, all: true }, now),
  ]);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

export const routes = [
  ["GET", /^\/api\/me$/, getMe],
  ["PATCH", /^\/api\/me$/, patchMe],
  ["GET", /^\/api\/me\/passkeys$/, listPasskeys],
  ["POST", /^\/api\/me\/passkeys$/, addPasskey],
  ["PATCH", /^\/api\/me\/passkeys\/([A-Za-z0-9_-]+)$/, renamePasskey],
  ["DELETE", /^\/api\/me\/passkeys\/([A-Za-z0-9_-]+)$/, removePasskey],
  ["GET", /^\/api\/me\/sessions$/, listSessions],
  ["POST", /^\/api\/me\/sessions\/revoke-all$/, revokeAllSessions],
  ["DELETE", /^\/api\/me\/sessions\/([A-Za-z0-9_-]+)$/, revokeOneSession],
];
