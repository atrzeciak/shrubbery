import * as q from "../db/queries.js";
import { isDate } from "../people/fields.js";
import { clientIp, json, nowSec, randomB64url } from "../util.js";
import { ApiError, found, INVITE_TTL, accountIdentity, adminSession, normEmail, readJson, requireSession, siteTz } from "./common.js";
import { hashIp, historyStmt } from "../history.js";
import { today as dayIn } from "../../public/app/events.js";
import { sendGatheringMail } from "../mail.js";

// A gathering needs a whole day, and one the calendar has.
const isDay = (v) => typeof v === "string" && v.length === 10 && isDate(v);
const text = (v, max) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

// A gathering is not a destructive administrative act, so it asks for the admin role but not a fresh
// passkey — the same line the media routes draw.
const adminCtx = (request, env) => adminSession(request, env, false);

function guestsAndTotals(rows) {
  const totals = { coming: 0, not_coming: 0, unanswered: 0 };
  const guests = rows.map((r) => {
    if (r.coming === null || r.coming === undefined) totals.unanswered++;
    else if (r.coming) totals.coming += r.headcount;          // people who will arrive, not names on a list
    else totals.not_coming++;
    return {
      person_id: r.person_id,
      display_name: r.display_name,
      coming: r.coming ?? null,
      headcount: r.headcount ?? null,
      answered_at: r.answered_at ?? null,
      on_behalf: r.on_behalf ?? 0,
    };
  });
  return { guests, totals };
}

async function getCurrent(request, env) {
  await requireSession(request, env);
  const gathering = await q.currentGathering(env.DB, dayIn(new Date(), siteTz(env))).first();
  if (!gathering) return json({ gathering: null, guests: [], totals: { coming: 0, not_coming: 0, unanswered: 0 } });
  const { results } = await q.guestList(env.DB, gathering.id).all();
  return json({ gathering, ...guestsAndTotals(results) });
}

async function createGathering(request, env) {
  const { account } = await adminCtx(request, env);
  const body = await readJson(request);
  if (!isDay(body.on_date)) throw new ApiError(400, "bad_request");
  const now = nowSec();
  const id = randomB64url(12);
  await env.DB.batch([
    q.insertGathering(env.DB, {
      id, onDate: body.on_date, place: text(body.place, 120), note: text(body.note, 500),
      createdBy: account.id, createdAt: now,
    }),
    historyStmt(env.DB, {
      actor: account.id, action: "gathering_created", targetType: "gathering", targetId: id,
      details: { on_date: body.on_date, place: text(body.place, 120) },
      ipHash: await hashIp(env, clientIp(request), now),
    }, now),
  ]);
  return json({ id }, 201);
}

async function patchGathering(request, env, ctx, m) {
  const { account } = await adminCtx(request, env);
  const gathering = found(await q.gatheringById(env.DB, m[1]).first());
  const body = await readJson(request);
  if ("on_date" in body && !isDay(body.on_date)) throw new ApiError(400, "bad_request");
  const cancelledAt = "cancelled" in body
    ? (body.cancelled ? (gathering.cancelled_at ?? nowSec()) : null)
    : gathering.cancelled_at;
  // Final values, not patches: an emptied field must be able to become null.
  const g = {
    onDate: "on_date" in body ? body.on_date : gathering.on_date,
    place: "place" in body ? text(body.place, 120) : gathering.place,
    note: "note" in body ? text(body.note, 500) : gathering.note,
    cancelledAt,
  };
  const now = nowSec();
  await env.DB.batch([
    q.updateGathering(env.DB, m[1], g),
    historyStmt(env.DB, {
      actor: account.id, action: "gathering_updated", targetType: "gathering", targetId: m[1],
      details: { on_date: g.onDate, place: g.place, cancelled: Boolean(cancelledAt) },
      ipHash: await hashIp(env, clientIp(request), now),
    }, now),
  ]);
  return json({ ok: true });
}

// coming and headcount are one decision, not two: staying away brings nobody, and coming brings at
// least the person themselves. Anything else is a client that has lost track of its own form.
function readAnswer(body) {
  const coming = body.coming === 1 || body.coming === true ? 1 : body.coming === 0 || body.coming === false ? 0 : null;
  if (coming === null) throw new ApiError(400, "bad_request");
  if (!coming) return { coming: 0, headcount: 0 };
  const headcount = Number(body.headcount);
  if (!Number.isSafeInteger(headcount) || headcount < 1 || headcount > 50) throw new ApiError(400, "bad_request");
  return { coming: 1, headcount };
}

async function answerFor(request, env, gatheringId, personId, account) {
  const gathering = found(await q.gatheringById(env.DB, gatheringId).first());
  if (gathering.cancelled_at) throw new ApiError(409, "cancelled");
  const person = await q.personById(env.DB, personId).first();
  if (!person || person.deceased) throw new ApiError(404, "not_found");
  const answer = readAnswer(await readJson(request));
  const now = nowSec();
  await env.DB.batch([
    q.setRsvp(env.DB, { gatheringId, personId, ...answer, answeredBy: account.id, answeredAt: now }),
    historyStmt(env.DB, {
      actor: account.id, action: "rsvp_answered", targetType: "person", targetId: personId,
      details: { name: person.display_name, coming: answer.coming, headcount: answer.headcount },
      ipHash: await hashIp(env, clientIp(request), now),
    }, now),
  ]);
  return json({ ok: true });
}

// Cancelling is for a gathering the family was told about and that is no longer happening; it stays
// visible so nobody turns up to it. Deleting is for one that should never have existed. The history
// rows are left alone either way: the gathering goes, the record of who arranged it does not.
async function deleteGathering(request, env, ctx, m) {
  const { account } = await adminCtx(request, env);
  const gathering = found(await q.gatheringById(env.DB, m[1]).first());
  const now = nowSec();
  await env.DB.batch([
    q.deleteRsvpsFor(env.DB, m[1]),
    q.deleteGathering(env.DB, m[1]),
    historyStmt(env.DB, {
      actor: account.id, action: "gathering_deleted", targetType: "gathering", targetId: m[1],
      details: { on_date: gathering.on_date, place: gathering.place },
      ipHash: await hashIp(env, clientIp(request), now),
    }, now),
  ]);
  return json({ ok: true });
}

// Writing to the family is not something to do by accident or twice, so each of these can happen
// exactly once and records that it did.
async function mailOut(request, env, m, { mark, recipients, kind }) {
  const { account } = await adminCtx(request, env);
  const gathering = found(await q.gatheringById(env.DB, m[1]).first());
  if (gathering.cancelled_at) throw new ApiError(409, "cancelled");
  const now = nowSec();
  // Claimed before the first mail, not marked after the last: a second press, tab or admin that
  // arrives while the loop runs finds it taken. A run that dies partway stays sent rather than repeating.
  if (!(await mark(env.DB, m[1], now).run()).meta.changes) throw new ApiError(409, "already_sent");
  const identity = await accountIdentity(env, account.id);
  const { results } = await recipients(env, gathering).all();
  // The tree still holds the address of anybody an admin shut out; broadcasts.js draws the same line.
  const { results: withdrawn } = await q.withdrawnEmails(env.DB).all();
  // One mail per mailbox: a household often shares one, and the tree records it on each person.
  const skip = new Set(withdrawn.map((w) => normEmail(w.email)));
  let sent = 0;
  for (const person of results) {
    if (skip.has(normEmail(person.email))) continue;
    skip.add(normEmail(person.email));
    try {
      // An address with no account is a relative who cannot answer: carry them in with the mail.
      const reader = await q.accountByEmail(env.DB, person.email).first();
      const invitation = reader ? null : await q.activeInvitationByEmail(env.DB, person.email, now).first();
      if (!reader && !invitation) {
        await q.insertInvitation(env.DB, {
          id: randomB64url(16), email: person.email, lang: "pl", invitedBy: account.id,
          createdAt: now, expiresAt: now + INVITE_TTL,
        }).run();
      }
      const lang = reader?.lang || invitation?.lang || "pl";
      await sendGatheringMail(env, person.email, lang, gathering, kind, identity?.name || null);
      sent++;
    } catch (e) {
      console.error(e);           // one dead mailbox must not silence the rest of the family
    }
  }
  await historyStmt(env.DB, {
    actor: account.id, action: `gathering_${kind === "nudge" ? "nudged" : "announced"}`,
    targetType: "gathering", targetId: m[1], details: { sent },
    ipHash: await hashIp(env, clientIp(request), now),
  }, now).run();
  return json({ sent });
}

const announce = (request, env, ctx, m) => mailOut(request, env, m,
  { mark: q.markAnnounced, kind: "announce", recipients: (env) => q.livingWithEmail(env.DB) });

const nudge = (request, env, ctx, m) => mailOut(request, env, m,
  { mark: q.markNudged, kind: "nudge", recipients: (env, g) => q.unansweredWithEmail(env.DB, g.id) });

async function ownRsvp(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  // Nothing to answer with: the account is not yet anybody in the tree. Said plainly, because the
  // fix is one screen away in Konto.
  if (!account.person_id) throw new ApiError(409, "no_person");
  return answerFor(request, env, m[1], account.person_id, account);
}

async function adminRsvp(request, env, ctx, m) {
  const { account } = await adminCtx(request, env);
  return answerFor(request, env, m[1], m[2], account);
}

export const routes = [
  ["GET", /^\/api\/gatherings$/, getCurrent],
  ["PUT", /^\/api\/gatherings\/([A-Za-z0-9_-]+)\/rsvp$/, ownRsvp],
  ["POST", /^\/api\/admin\/gatherings$/, createGathering],
  ["PATCH", /^\/api\/admin\/gatherings\/([A-Za-z0-9_-]+)$/, patchGathering],
  ["DELETE", /^\/api\/admin\/gatherings\/([A-Za-z0-9_-]+)$/, deleteGathering],
  ["PUT", /^\/api\/admin\/gatherings\/([A-Za-z0-9_-]+)\/rsvp\/([A-Za-z0-9_-]+)$/, adminRsvp],
  ["POST", /^\/api\/admin\/gatherings\/([A-Za-z0-9_-]+)\/announce$/, announce],
  ["POST", /^\/api\/admin\/gatherings\/([A-Za-z0-9_-]+)\/nudge$/, nudge],
];
