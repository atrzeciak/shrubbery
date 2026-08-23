import * as q from "../db/queries.js";
import { clientIp, json, nowSec, randomB64url } from "../util.js";
import { hashIp, historyStmt } from "../history.js";
import { sendAdminGranted, sendInvitation } from "../mail.js";
import { ApiError, EMAIL_RE, accountIdentity, adminEmails, normEmail, readJson, requireAdmin, requireRole, requireSession } from "./common.js";

const INVITE_TTL = 14 * 86400;
const PAGE = 50;

async function admin(request, env, write) {
  const ctx = await requireSession(request, env);
  if (write) requireAdmin(ctx); else requireRole(ctx, "admin");
  return ctx;
}

async function adminHistory(request, env, actor, action, targetType, targetId, details, now) {
  return historyStmt(env.DB, { actor: actor.id, action, targetType, targetId, details, ipHash: await hashIp(env, clientIp(request), now) }, now);
}

async function listInvitations(request, env) {
  await admin(request, env, false);
  const { results } = await q.listInvitations(env.DB, nowSec()).all();
  return json({ invitations: results });
}

async function createInvitation(request, env) {
  const { account } = await admin(request, env, true);
  const body = await readJson(request);
  const email = normEmail(body.email);
  const lang = body.lang === "en" ? "en" : body.lang === "pl" ? "pl" : null;
  if (!EMAIL_RE.test(email) || !lang) throw new ApiError(400, "bad_request");
  const now = nowSec();
  if (await q.accountByEmail(env.DB, email).first()) throw new ApiError(409, "conflict");
  if (await q.activeInvitationByEmail(env.DB, email, now).first()) throw new ApiError(409, "conflict");
  const id = randomB64url(16);
  await env.DB.batch([
    q.insertInvitation(env.DB, { id, email, lang, invitedBy: account.id, createdAt: now, expiresAt: now + INVITE_TTL }),
    await adminHistory(request, env, account, "invite_sent", "invitation", id, { email }, now),
  ]);
  await sendInvitation(env, email, lang, await accountIdentity(env, account.id), await adminEmails(env));
  return json({ id }, 201);
}

async function resendInvitation(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const inv = await q.invitationById(env.DB, m[1]).first();
  if (!inv || inv.accepted_at || inv.revoked_at) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.extendInvitation(env.DB, inv.id, now + INVITE_TTL),
    await adminHistory(request, env, account, "invite_resent", "invitation", inv.id, { email: inv.email }, now),
  ]);
  await sendInvitation(env, inv.email, inv.lang, await accountIdentity(env, inv.invited_by), await adminEmails(env));
  return json({ ok: true });
}

async function revokeInvitation(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const inv = await q.invitationById(env.DB, m[1]).first();
  if (!inv || inv.accepted_at || inv.revoked_at) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.revokeInvitation(env.DB, inv.id, now),
    await adminHistory(request, env, account, "invite_revoked", "invitation", inv.id, { email: inv.email }, now),
  ]);
  return json({ ok: true });
}

async function listAccounts(request, env) {
  await admin(request, env, false);
  const { results } = await q.listAccounts(env.DB).all();
  return json({ accounts: results });
}

async function patchAccount(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const body = await readJson(request);
  const wantsRole = "role" in body;
  const wantsProtection = "protected" in body;
  if (!wantsRole && !wantsProtection) throw new ApiError(400, "bad_request");
  if (wantsRole && body.role !== "admin" && body.role !== "family") throw new ApiError(400, "bad_request");
  if (wantsProtection && body.protected !== 0 && body.protected !== 1) throw new ApiError(400, "bad_request");
  if (m[1] === account.id) throw new ApiError(409, "conflict");
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  // The founder's own standing is fixed; a protected admin, and the protection flag itself,
  // answer to the founder alone — otherwise two admins could demote each other in turn.
  if (target.founder) throw new ApiError(403, "forbidden");
  if ((wantsProtection || target.protected) && !account.founder) throw new ApiError(403, "forbidden");
  if (wantsRole && body.role === "admin") {
    const { n } = await q.countPasskeys(env.DB, target.id).first();
    if (n < 1) throw new ApiError(409, "passkey_required");
  }
  const now = nowSec();
  const stmts = [];
  if (wantsRole) {
    stmts.push(q.setRole(env.DB, target.id, body.role),
      await adminHistory(request, env, account, "role_changed", "account", target.id, { email: target.email, role: body.role }, now));
  }
  if (wantsProtection) {
    stmts.push(q.setProtected(env.DB, target.id, body.protected),
      await adminHistory(request, env, account, "protection_changed", "account", target.id, { email: target.email, on: body.protected }, now));
  }
  await env.DB.batch(stmts);
  // Being handed admin rights is worth telling someone about; losing them is not an announcement.
  if (wantsRole && body.role === "admin" && target.role !== "admin") {
    try { await sendAdminGranted(env, target.email, target.lang); } catch { /* the promotion stands */ }
  }
  return json({ ok: true });
}

async function disableAccount(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  if (m[1] === account.id) throw new ApiError(409, "conflict");
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  if (target.founder) throw new ApiError(403, "forbidden");                                  // demotion by another name
  if (target.protected && !account.founder) throw new ApiError(403, "forbidden");            // and so is this
  const now = nowSec();
  await env.DB.batch([
    q.disableAccount(env.DB, target.id, now),
    q.revokeSessionsByAccount(env.DB, target.id, now),
    await adminHistory(request, env, account, "account_disabled", "account", target.id, { email: target.email }, now),
  ]);
  return json({ ok: true });
}

async function enableAccount(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.enableAccount(env.DB, target.id),
    await adminHistory(request, env, account, "account_enabled", "account", target.id, { email: target.email }, now),
  ]);
  return json({ ok: true });
}

async function revokeAccountSessions(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.revokeSessionsByAccount(env.DB, target.id, now),
    await adminHistory(request, env, account, "session_revoked", "account", target.id, { email: target.email, by_admin: true }, now),
  ]);
  return json({ ok: true });
}

export function historyPage(results, limit, { emails } = {}) {
  const items = results.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    ...(emails ? { actor_email: r.actor_email } : {}),
    actor_person_id: r.actor_person_id,
    actor_name: r.actor_nickname || [r.actor_first_name, r.actor_last_name].filter(Boolean).join(" ") || r.actor_display_name || null,
    target_type: r.target_type,
    target_id: r.target_id,
    details: r.details ? JSON.parse(r.details) : {},
  }));
  return { items, next: results.length === limit ? results[results.length - 1].id : null };
}

export function beforeIdOf(url) {
  const raw = Number(url.searchParams.get("before"));
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

async function history(request, env) {
  await admin(request, env, false);
  const url = new URL(request.url);
  const beforeId = beforeIdOf(url);
  const accountId = url.searchParams.get("account") || null;
  const { results } = await q.listHistory(env.DB, { beforeId, limit: PAGE, actions: null, accountId }).all();
  return json(historyPage(results, PAGE, { emails: true }));
}

export const routes = [
  ["GET", /^\/api\/admin\/invitations$/, listInvitations],
  ["POST", /^\/api\/admin\/invitations$/, createInvitation],
  ["POST", /^\/api\/admin\/invitations\/([A-Za-z0-9_-]+)\/resend$/, resendInvitation],
  ["DELETE", /^\/api\/admin\/invitations\/([A-Za-z0-9_-]+)$/, revokeInvitation],
  ["GET", /^\/api\/admin\/accounts$/, listAccounts],
  ["PATCH", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)$/, patchAccount],
  ["POST", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)\/disable$/, disableAccount],
  ["POST", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)\/enable$/, enableAccount],
  ["POST", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)\/revoke-sessions$/, revokeAccountSessions],
  ["GET", /^\/api\/admin\/history$/, history],
];
