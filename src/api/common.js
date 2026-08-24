import { hasFreshPasskey, resolveSession } from "../auth/sessions.js";
import * as q from "../db/queries.js";

export class ApiError extends Error {
  constructor(status, code, headers = {}) { super(code); this.status = status; this.code = code; this.headers = headers; }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (v) => String(v || "").trim().toLowerCase();
export const appOrigin = (env) => env.APP_ORIGIN || "http://localhost:8787";
export const rpIdOf = (env) => new URL(appOrigin(env)).hostname;
// No family's zone belongs in the source, so the fallback is the neutral one and every deployment
// names its own in configuration.
export const siteTz = (env) => env.SITE_TZ || "UTC";

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
