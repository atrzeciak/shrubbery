import { insertHistory, insertHistoryIfPasskeyGone } from "./db/queries.js";
import { nowSec, sha256Hex } from "./util.js";

// ip_hash = SHA-256(secret + ip + daily salt): correlates within a day, not across days, and
// isn't brute-forceable from a data export without the server-side IP_HASH_SECRET.
export async function hashIp(env, ip, at = nowSec()) {
  return sha256Hex(`${env.IP_HASH_SECRET || ""}|${ip}|${Math.floor(at / 86400)}`);
}

export function historyStmt(db, { actor, action, targetType, targetId, details, ipHash }, at = nowSec()) {
  return insertHistory(db, { at, actor, action, targetType, targetId, details: JSON.stringify(details ?? {}), ipHash });
}

export function historyStmtIfPasskeyGone(db, { actor, action, targetType, targetId, details, ipHash }, passkeyId, at = nowSec()) {
  return insertHistoryIfPasskeyGone(db, { at, actor, action, targetType, targetId, details: JSON.stringify(details ?? {}), ipHash }, passkeyId);
}

export async function record(db, entry) {
  await historyStmt(db, entry).run();
}
