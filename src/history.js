import { insertHistory, insertHistoryIfPasskeyGone } from "./db/queries.js";
import { clientIp, nowSec, sha256Hex } from "./util.js";

// ip_hash = SHA-256(secret + ip + daily salt): correlates within a day, not across days, and
// isn't brute-forceable from a data export without the server-side IP_HASH_SECRET.
export async function hashIp(env, ip, at = nowSec()) {
  return sha256Hex(`${env.IP_HASH_SECRET || ""}|${ip}|${Math.floor(at / 86400)}`);
}

export function historyStmt(db, { actor, action, targetType, targetId, details, ipHash }, at = nowSec()) {
  return insertHistory(db, { at, actor, action, targetType, targetId, details: JSON.stringify(details ?? {}), ipHash });
}

// The row for something a request did: the caller's address goes in only as the day's hash of it.
export async function requestHistory(env, request, entry, at = nowSec()) {
  return historyStmt(env.DB, { ...entry, ipHash: await hashIp(env, clientIp(request), at) }, at);
}

export function historyStmtIfPasskeyGone(db, { actor, action, targetType, targetId, details, ipHash }, passkeyId, at = nowSec()) {
  return insertHistoryIfPasskeyGone(db, { at, actor, action, targetType, targetId, details: JSON.stringify(details ?? {}), ipHash }, passkeyId);
}
