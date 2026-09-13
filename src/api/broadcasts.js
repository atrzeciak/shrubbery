import * as q from "../db/queries.js";
import { clientIp, json, nowSec, randomB64url } from "../util.js";
import { ApiError, accountIdentity, readJson, requireAdmin, requireSession } from "./common.js";
import { documentAttachment } from "./attachment.js";
import { hashIp, historyStmt } from "../history.js";
import { sendBroadcast } from "../mail.js";

const INVITE_TTL = 14 * 86400;
const GROUPS = ["accounts", "invited", "others"];

const text = (v, max) => String(v ?? "").trim().slice(0, max) || null;
const key = (email) => String(email ?? "").trim().toLowerCase();

// Writing to the whole family is not a thing to do by accident, so it asks for a fresh passkey,
// the same line a single invitation draws.
async function adminCtx(request, env) {
  const ctx = await requireSession(request, env);
  requireAdmin(ctx);
  return ctx;
}

// The three groups the form offers, kept apart so that ticking two never writes to anybody twice
// and the counts add up to what will be sent: every account, then the invitations of people who
// have no account, then the relatives the tree holds an address for who have neither.
async function groupsOf(env, now) {
  const { results: accounts } = await q.accountsWithEmail(env.DB).all();
  const { results: invitations } = await q.openInvitationEmails(env.DB, now).all();
  const { results: people } = await q.livingWithEmail(env.DB).all();
  const out = { accounts: new Map(), invited: new Map(), others: new Map() };
  for (const a of accounts) out.accounts.set(key(a.email), { email: key(a.email), lang: a.lang });
  for (const i of invitations) {
    const k = key(i.email);
    if (!out.accounts.has(k)) out.invited.set(k, { email: k, lang: i.lang });
  }
  for (const p of people) {
    const k = key(p.email);
    if (k && !out.accounts.has(k) && !out.invited.has(k)) out.others.set(k, { email: k, lang: "pl" });
  }
  return out;
}

async function sendMessage(request, env) {
  const { account } = await adminCtx(request, env);
  const body = await readJson(request);
  const subject = text(body.subject, 200);
  const message = text(body.body, 5000);
  const groups = Array.isArray(body.groups) ? GROUPS.filter((g) => body.groups.includes(g)) : [];
  if (!subject || !message || !groups.length) throw new ApiError(400, "bad_request");
  const now = nowSec();
  // Read the document before anything is mailed: a bad choice is the admin's mistake, not a
  // half-sent letter.
  const attachment = await documentAttachment(env, body.attachment || null, true);
  const picked = await groupsOf(env, now);
  const to = groups.flatMap((g) => [...picked[g].values()]);
  if (!to.length) throw new ApiError(400, "bad_request");
  const inviter = await accountIdentity(env, account.id);
  let sent = 0;
  for (const person of to) {
    try {
      // Somebody the tree knows but the site does not: carry them in with the letter, the way a
      // gathering announcement does, or the link in it leads nowhere.
      if (!(await q.accountByEmail(env.DB, person.email).first())
          && !(await q.activeInvitationByEmail(env.DB, person.email, now).first())) {
        await q.insertInvitation(env.DB, {
          id: randomB64url(16), email: person.email, lang: "pl", invitedBy: account.id,
          createdAt: now, expiresAt: now + INVITE_TTL,
        }).run();
      }
      await sendBroadcast(env, person.email, person.lang, { subject, body: message }, inviter, attachment);
      sent++;
    } catch (e) {
      console.error(e);           // one dead mailbox must not silence the rest of the family
    }
  }
  const id = randomB64url(12);
  await env.DB.batch([
    q.insertBroadcast(env.DB, {
      id, subject, body: message, groups: JSON.stringify(groups),
      attachmentMediaId: body.attachment || null, sentBy: account.id, sentAt: now, sentCount: sent,
    }),
    historyStmt(env.DB, {
      actor: account.id, action: "broadcast_sent", targetType: "broadcast", targetId: id,
      details: { subject, groups, sent }, ipHash: await hashIp(env, clientIp(request), now),
    }, now),
  ]);
  return json({ sent, id });
}

export const routes = [
  ["POST", /^\/api\/admin\/broadcasts$/, sendMessage],
];
