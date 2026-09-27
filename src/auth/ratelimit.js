import * as q from "../db/queries.js";
import { hashIp } from "../history.js";
import { ipPrefix, nowSec } from "../util.js";

// Fixed window per key, started by the first hit. Good enough for a family site.
// Counting and reading are one write, so hits sent at once cannot share a count.
export async function allow(db, key, limit, windowSeconds, now = nowSec()) {
  return (await q.rateLimitHit(db, key, now, windowSeconds).first()).count <= limit;
}

// The key for a caller's address, hashed as history hashes it, so the table holds no IP.
export const ipKey = async (env, kind, ip, now = nowSec()) => `${kind}:ip:${await hashIp(env, ipPrefix(ip), now)}`;
