import * as q from "../db/queries.js";
import { nowSec } from "../util.js";

// Fixed window per key, started by the first hit. Good enough for a family site.
// Counting and reading are one write, so hits sent at once cannot share a count.
export async function allow(db, key, limit, windowSeconds, now = nowSec()) {
  return (await q.rateLimitHit(db, key, now, windowSeconds).first()).count <= limit;
}
