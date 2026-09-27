import { hasFreshPasskey, resolveSession } from "../auth/sessions.js";
import * as q from "../db/queries.js";

export class ApiError extends Error {
  constructor(status, code, headers = {}) { super(code); this.status = status; this.code = code; this.headers = headers; }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (v) => String(v || "").trim().toLowerCase();
export const INVITE_TTL = 14 * 86400;
export const found = (row) => { if (!row) throw new ApiError(404, "not_found"); return row; };
export const appOrigin = (env) => env.APP_ORIGIN || "http://localhost:8787";
export const rpIdOf = (env) => new URL(appOrigin(env)).hostname;
// No family's zone belongs in the source, so the fallback is the neutral one and every deployment
// names its own in configuration.
export const siteTz = (env) => env.SITE_TZ || "UTC";

// A request body read chunk by chunk, refused once it passes max: arrayBuffer() would hold all of it
// first, and a chunked request carries no Content-Length to refuse it by.
export async function readBody(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new ApiError(400, "bad_request");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) out.set(parts[i], at);
  return out;
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new ApiError(400, "bad_request");
  }
}

export async function requireSession(request, env) {
  const r = await resolveSession(env.DB, request);
  if (!r) throw new ApiError(401, "unauthorized");
  return r;
}

export function requireAdmin({ session, account }) {
  if (account.role !== "admin") throw new ApiError(403, "forbidden");
  if (!hasFreshPasskey(session)) throw new ApiError(401, "step_up_required");
}

export function requireRole({ account }, role) {
  if (account.role !== role) throw new ApiError(403, "forbidden");
}

// A write that could hurt asks for a fresh passkey; reading or a merely administrative act, the role alone.
export async function adminSession(request, env, write) {
  const ctx = await requireSession(request, env);
  if (write) requireAdmin(ctx); else requireRole(ctx, "admin");
  return ctx;
}

// Photos and the avatar of a person: the person, or a parent until the child has an account.
// Says nothing of admins, whose routes ask for a fresh passkey.
export async function canCurate(env, account, personId) {
  if (!account.person_id) return false;
  if (account.person_id === personId) return true;
  if (!(await q.parentEdge(env.DB, account.person_id, personId).first())) return false;
  return !(await q.accountByPerson(env.DB, personId).first());
}

// Who an invitation comes from: the account's person name to sign it, their address for replies.
export async function accountIdentity(env, accountId) {
  if (!accountId) return null;
  const account = await q.accountById(env.DB, accountId).first();
  if (!account) return null;
  const person = account.person_id ? await q.personById(env.DB, account.person_id).first() : null;
  const name = person?.display_name || null;
  // founder: only he may invite in the first person, because the story the mail tells is his.
  return name || account.email ? { name, email: account.email || null, founder: Boolean(account.founder) } : null;
}

// Every admin keeps a blind copy of each invitation, so the record isn't only in one inbox.
export async function adminEmails(env) {
  const { results } = await q.listAdmins(env.DB).all();
  return results.map((a) => a.email);
}
