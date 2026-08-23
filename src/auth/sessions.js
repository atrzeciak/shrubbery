import * as q from "../db/queries.js";
import { cookie, nowSec, randomB64url, readCookie, sha256Hex } from "../util.js";

export const SESSION_COOKIE = "session";
export const SESSION_TTL = 365 * 86400;
export const STEP_UP_WINDOW = 600;
const TOUCH_INTERVAL = 3600;

export async function prepareSession(db, { accountId, passkeyAt, userAgent }, now = nowSec()) {
  const token = randomB64url(32);
  const id = await sha256Hex(token);
  const stmt = q.insertSession(db, { id, accountId, createdAt: now, expiresAt: now + SESSION_TTL, passkeyAt, userAgent });
  return { token, id, stmt };
}

export const sessionCookie = (token) => cookie(SESSION_COOKIE, token, SESSION_TTL);
export const clearSessionCookie = () => cookie(SESSION_COOKIE, "", 0);

export async function resolveSession(db, request, now = nowSec()) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await q.sessionById(db, await sha256Hex(token)).first();
  if (!session || session.revoked_at || session.expires_at <= now) return null;
  const account = await q.accountById(db, session.account_id).first();
  if (!account || account.disabled_at) return null;
  if (now - session.last_seen_at >= TOUCH_INTERVAL) {
    await q.touchSession(db, session.id, now).run();
    session.last_seen_at = now;
  }
  return { session, account };
}

export function hasFreshPasskey(session, now = nowSec()) {
  return session.passkey_at != null && now - session.passkey_at < STEP_UP_WINDOW;
}
