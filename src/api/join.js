import * as q from "../db/queries.js";
import { clientIp, cookie, json, nowSec, randomB64url, readCookie } from "../util.js";
import { hashIp, historyStmt } from "../history.js";
import { allow } from "../auth/ratelimit.js";
import { prepareCode, verifyCode } from "../auth/codes.js";
import { sendCode, sendInvitation, sendJoinNotice } from "../mail.js";
import { DATE_RE, yearOf } from "../people/fields.js";
import { ApiError, EMAIL_RE, accountIdentity, adminEmails, normEmail, readJson, requireAdmin, requireRole, requireSession } from "./common.js";
import { personHistory } from "./people.js";

const NONCE_COOKIE = "join_nonce", NONCE_TTL = 3600;
const LIMIT = 3, HOUR = 3600, INVITE_TTL = 14 * 86400;

async function admin(request, env, write) {
  const ctx = await requireSession(request, env);
  if (write) requireAdmin(ctx); else requireRole(ctx, "admin");
  return ctx;
}

const text = (v, min, max) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw new ApiError(400, "bad_request");
  return s || null;
};

function cleanForm(body) {
  const f = {
    first_name: text(body.first_name, 1, 80),
    last_name: text(body.last_name, 1, 80),
    birth_date: text(body.birth_date, 4, 10),
    parent_text: text(body.parent_text, 1, 200),
    email: normEmail(body.email),
    message: text(body.message, 0, 1000),
    lang: body.lang === "en" ? "en" : "pl",
  };
  if (!DATE_RE.test(f.birth_date) || !EMAIL_RE.test(f.email) || f.email.length > 254) throw new ApiError(400, "bad_request");
  return f;
}

async function joinHistory(request, env, action, id, details, now, actor = null) {
  return historyStmt(env.DB, { actor, action, targetType: "join_request", targetId: id, details, ipHash: await hashIp(env, clientIp(request), now) }, now);
}

async function notifyAdmins(env, name, auto) {
  const { results } = await q.listAdmins(env.DB).all();
  for (const a of results) await sendJoinNotice(env, a.email, a.lang, name, auto);
}

async function firstAdminId(env) {
  const a = await q.listAdmins(env.DB).first();
  if (!a) throw new ApiError(500, "internal");
  return a.id;
}

async function postRequest(request, env) {
  const body = await readJson(request);
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true });
  const f = cleanForm(body);
  const now = nowSec(), ip = clientIp(request);
  if (!(await allow(env.DB, `join:ip:${ip}`, LIMIT, HOUR, now)) || !(await allow(env.DB, `join:email:${f.email}`, LIMIT, HOUR, now))) throw new ApiError(429, "rate_limited");
  const existingNonce = readCookie(request, NONCE_COOKIE);
  const nonce = existingNonce || randomB64url(16);
  const headers = existingNonce ? {} : { "set-cookie": cookie(NONCE_COOKIE, nonce, NONCE_TTL) };
  // Same enumeration rule as login: the code row is always created; the mail only goes out
  // when the address is not already a member's login.
  const { code, stmt } = await prepareCode(env.DB, { email: f.email, nonce }, now);
  await env.DB.batch([stmt]);
  if (!(await q.accountByEmail(env.DB, f.email).first())) await sendCode(env, f.email, code, f.lang);
  return json({ ok: true }, 200, headers);
}

async function postConfirm(request, env) {
  const body = await readJson(request);
  const f = cleanForm(body);
  const code = String(body.code || "").trim();
  const nonce = readCookie(request, NONCE_COOKIE);
  if (!nonce || !/^\d{6}$/.test(code)) throw new ApiError(400, "bad_request");
  const now = nowSec();
  const v = await verifyCode(env.DB, { email: f.email, nonce, code }, now);
  if (!v.ok) { if (v.stmt) await v.stmt.run(); throw new ApiError(400, v.error); }
  const [used] = await env.DB.batch([v.stmt]);
  if (!used.meta.changes) throw new ApiError(400, "expired");
  if (await q.accountByEmail(env.DB, f.email).first()) throw new ApiError(409, "conflict");
  const clear = { "set-cookie": cookie(NONCE_COOKIE, "", 0) };
  const id = randomB64url(12), name = `${f.first_name} ${f.last_name}`;
  const match = await q.personByEmail(env.DB, f.email).first();
  const stmts = [q.deletePendingJoinRequests(env.DB, f.email)];
  // An invitation already outstanding (e.g. a prior join request was just approved for this
  // email) means the person is already on their way in — fall through to "pending" rather
  // than mailing a second invitation.
  if (match && !(await q.accountByPerson(env.DB, match.id).first()) && !(await q.activeInvitationByEmail(env.DB, f.email, now).first())) {
    const inviterId = await firstAdminId(env);
    stmts.push(
      q.insertJoinRequest(env.DB, { id, ...f, created_at: now, status: "auto", matched_person_id: match.id }),
      q.insertInvitation(env.DB, { id: randomB64url(16), email: f.email, lang: f.lang, invitedBy: inviterId, createdAt: now, expiresAt: now + INVITE_TTL }),
      await joinHistory(request, env, "join_auto_approved", id, { name, person_id: match.id }, now),
    );
    await env.DB.batch(stmts);
    await sendInvitation(env, f.email, f.lang, await accountIdentity(env, inviterId), await adminEmails(env));
    await notifyAdmins(env, name, true);
    return json({ ok: true, auto: true }, 200, clear);
  }
  stmts.push(
    q.insertJoinRequest(env.DB, { id, ...f, created_at: now, status: "pending", matched_person_id: null }),
    await joinHistory(request, env, "join_requested", id, { name }, now),
  );
  await env.DB.batch(stmts);
  await notifyAdmins(env, name, false);
  return json({ ok: true, auto: false }, 200, clear);
}

async function listRequests(request, env) {
  await admin(request, env, false);
  const [reqs, people] = await env.DB.batch([q.listJoinRequests(env.DB), q.listPeople(env.DB)]);
  const requests = reqs.results.map((r) => {
    const byEmail = people.results.find((p) => p.email && p.email.toLowerCase() === r.email);
    const byName = people.results.find((p) => (p.last_name || "").toLowerCase() === r.last_name.toLowerCase() && yearOf(p.birth_date) === yearOf(r.birth_date));
    return { ...r, match: (byEmail || byName || {}).id || null };
  });
  return json({ requests });
}

async function pendingOr404(env, id) {
  const r = await q.joinRequestById(env.DB, id).first();
  if (!r || r.status !== "pending") throw new ApiError(404, "not_found");
  return r;
}

async function approve(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const r = await pendingOr404(env, m[1]);
  const body = await readJson(request);
  const now = nowSec(), stmts = [];
  let personId;
  if (body.create === true) {
    personId = randomB64url(12);
    const notes = r.parent_text + (r.message ? `\n\n${r.message}` : "");
    stmts.push(q.insertPerson(env.DB, { id: personId, first_name: r.first_name, last_name: r.last_name, maiden_name: null, nickname: null, sex: null, display_name: `${r.first_name} ${r.last_name}`, birth_date: r.birth_date, birth_place: null, death_date: null, death_place: null, deceased: 0, email: r.email, phone: null, residence: null, notes, unverified: 1, created_at: now, updated_at: now, updated_by: account.id }));
    stmts.push(await personHistory(request, env, account.id, "person_created", personId, { name: `${r.first_name} ${r.last_name}`, from_join: true }, now));
  } else {
    const p = await q.personById(env.DB, String(body.person_id || "")).first();
    if (!p) throw new ApiError(404, "not_found");
    if (await q.accountByPerson(env.DB, p.id).first()) throw new ApiError(409, "conflict");
    personId = p.id;
  }
  if (await q.activeInvitationByEmail(env.DB, r.email, now).first()) throw new ApiError(409, "conflict");
  stmts.push(
    q.decideJoinRequest(env.DB, r.id, "approved", personId, account.id, now, null),
    q.insertInvitation(env.DB, { id: randomB64url(16), email: r.email, lang: r.lang, invitedBy: account.id, createdAt: now, expiresAt: now + INVITE_TTL }),
    await joinHistory(request, env, "join_approved", r.id, { name: `${r.first_name} ${r.last_name}`, person_id: personId }, now, account.id),
  );
  await env.DB.batch(stmts);
  await sendInvitation(env, r.email, r.lang, await accountIdentity(env, account.id), await adminEmails(env));
  return json({ person_id: personId });
}

async function reject(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const r = await pendingOr404(env, m[1]);
  const body = await readJson(request);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  const now = nowSec();
  await env.DB.batch([
    q.decideJoinRequest(env.DB, r.id, "rejected", null, account.id, now, note),
    await joinHistory(request, env, "join_rejected", r.id, { name: `${r.first_name} ${r.last_name}` }, now, account.id),
  ]);
  return json({ ok: true });
}

export const routes = [
  ["POST", /^\/api\/join\/request$/, postRequest],
  ["POST", /^\/api\/join\/confirm$/, postConfirm],
  ["GET", /^\/api\/admin\/join-requests$/, listRequests],
  ["POST", /^\/api\/admin\/join-requests\/([A-Za-z0-9_-]+)\/approve$/, approve],
  ["POST", /^\/api\/admin\/join-requests\/([A-Za-z0-9_-]+)\/reject$/, reject],
];
