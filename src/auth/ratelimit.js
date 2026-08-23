import * as q from "../db/queries.js";
import { nowSec } from "../util.js";

// Fixed window per key, started by the first hit. Good enough for a family site.
export async function allow(db, key, limit, windowSeconds, now = nowSec()) {
  const row = await q.rateLimitGet(db, key).first();
  if (!row || now - row.window_start >= windowSeconds) {
    await q.rateLimitPut(db, key, now, 1).run();
    return true;
  }
  if (row.count >= limit) return false;
  await q.rateLimitPut(db, key, row.window_start, row.count + 1).run();
  return true;
}
