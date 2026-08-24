import * as q from "../db/queries.js";
import { historyStmt } from "../history.js";
import { sendEventNotice, sendGatheringMail } from "../mail.js";
import { upcoming, today as dayIn } from "../../public/app/events.js";
import { siteTz } from "../api/common.js";
import { buildScope } from "./scope.js";

// Daily reminder pass: exactly-T-7 and T-0 events, opted-in linked accounts, scope-checked.
export async function runDaily(env, now = new Date()) {
  const db = env.DB;
  const accounts = (await q.listNotifyAccounts(db).all()).results;
  if (!accounts.length) return;
  const [people, parents, partners] = await db.batch([q.listPeople(db), q.listParents(db), q.listPartners(db)]);
  const tz = siteTz(env);
  const events = upcoming(people.results, dayIn(now, tz), 7).filter((e) => e.inDays === 0 || e.inDays === 7);
  if (!events.length) return;
  const scope = buildScope(parents.results, partners.results);
  const byId = new Map(people.results.map((p) => [p.id, p]));
  // Cloudflare may run a cron trigger more than once, and a redeploy or a hand-run can too. Each mail
  // already leaves an event_notice_sent row, so that is the record consulted here — the day is worked
  // out from the row's own timestamp, which means rows written before this guard existed count too.
  const today = dayIn(now, tz);
  const at = Math.floor(now.getTime() / 1000);
  const since = at - 3 * 86400;
  const alreadySent = new Set();
  for (const row of (await q.historySince(db, "event_notice_sent", since).all()).results) {
    if (dayIn(new Date(row.at * 1000), tz) !== today) continue;
    let d = {};
    try { d = JSON.parse(row.details) || {}; } catch { continue; }
    alreadySent.add(`${row.target_id}|${d.to_account}|${d.in_days}`);
  }
  const stmts = [];
  for (const ev of events) for (const a of accounts) {
    if (!scope.inScope(ev.person_id, a.person_id, ev.type)) continue;
    if (alreadySent.has(`${ev.person_id}|${a.id}|${ev.inDays}`)) continue;
    const p = byId.get(ev.person_id);
    try {
      await sendEventNotice(env, a.email, a.lang, { type: ev.type, name: p.display_name, years: ev.years, inDays: ev.inDays });
    } catch (e) {
      console.error(e);
      continue;
    }
    alreadySent.add(`${ev.person_id}|${a.id}|${ev.inDays}`);
    stmts.push(historyStmt(db, { actor: null, action: "event_notice_sent", targetType: "person", targetId: ev.person_id, details: { type: ev.type, name: p.display_name, to_account: a.id, in_days: ev.inDays }, ipHash: null }, at));
  }
  if (stmts.length) await db.batch(stmts);
}

// The gathering's own reminders: a week before and on the day. Same opt-in and the same guard as the
// birthday reminders, because a cron that fires twice must not mail the family twice.
export async function gatheringReminders(env, now = new Date()) {
  try {
    const db = env.DB;
    const tz = siteTz(env);
    const today = dayIn(now, tz);
    const gathering = await q.nextGathering(db, today).first();
    if (!gathering) return;
    const days = Math.round((Date.parse(`${gathering.on_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    if (days !== 7 && days !== 0) return;
    const accounts = (await q.listNotifyAccounts(db).all()).results;
    if (!accounts.length) return;
    const at = Math.floor(now.getTime() / 1000);
    const already = new Set();
    for (const row of (await q.historySince(db, "gathering_notice_sent", at - 3 * 86400).all()).results) {
      if (dayIn(new Date(row.at * 1000), tz) !== today) continue;
      let d = {};
      try { d = JSON.parse(row.details) || {}; } catch { continue; }
      already.add(`${row.target_id}|${d.to_account}|${d.in_days}`);
    }
    const stmts = [];
    for (const a of accounts) {
      const key = `${gathering.id}|${a.id}|${days}`;
      if (already.has(key)) continue;
      try {
        await sendGatheringMail(env, a.email, a.lang, gathering, days === 0 ? "day" : "week");
      } catch (e) {
        console.error(e);
        continue;
      }
      already.add(key);
      stmts.push(historyStmt(db, {
        actor: null, action: "gathering_notice_sent", targetType: "gathering", targetId: gathering.id,
        details: { to_account: a.id, in_days: days }, ipHash: null,
      }, at));
    }
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    console.error(e);            // reminders must never take the rest of the nightly run with them
  }
}
