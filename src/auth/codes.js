import * as q from "../db/queries.js";
import { nowSec, randomB64url, sha256Hex } from "../util.js";

export const CODE_TTL = 600;
export const CODE_MAX_ATTEMPTS = 5;

export function generateCode() {
  // Rejection sampling keeps every 6-digit value equally likely.
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  let n;
  do n = crypto.getRandomValues(new Uint32Array(1))[0]; while (n >= limit);
  return String(n % 1_000_000).padStart(6, "0");
}

const hashCode = (email, nonce, code) => sha256Hex(`${email}|${nonce}|${code}`);

export async function prepareCode(db, { email, nonce }, now = nowSec()) {
  const code = generateCode();
  const stmt = q.insertCode(db, {
    id: randomB64url(16), email, codeHash: await hashCode(email, nonce, code), sessionNonce: nonce,
    createdAt: now, expiresAt: now + CODE_TTL,
  });
  return { code, stmt };
}

// The attempt is spent before the comparison, in one conditional write, so guesses sent at once
// cannot all read the same count. On success the caller runs the returned markCodeUsed.
export async function verifyCode(db, { email, nonce, code }, now = nowSec()) {
  const row = await q.latestOpenCode(db, email, nonce, now).first();
  const spent = row && (await q.bumpCodeAttempts(db, row.id, CODE_MAX_ATTEMPTS).run()).meta.changes;
  if (!spent) return { ok: false, error: "expired", stmt: null };
  if (row.code_hash !== (await hashCode(email, nonce, String(code)))) return { ok: false, error: "invalid_code", stmt: null };
  return { ok: true, id: row.id, stmt: q.markCodeUsed(db, row.id, now) };
}
