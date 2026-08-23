import * as q from "../db/queries.js";
import { clientIp, json, nowSec, randomB64url } from "../util.js";
import { hashIp, historyStmt } from "../history.js";
import { cleanPersonInput, displayNameOf, PARTNER_KINDS } from "../people/fields.js";
import { ApiError, readJson, requireAdmin, requireRole, requireSession } from "./common.js";
import { personHistory, savePersonPatch, storeAvatar } from "./people.js";

async function admin(request, env, write) {
  const ctx = await requireSession(request, env);
  if (write) requireAdmin(ctx); else requireRole(ctx, "admin");
  return ctx;
}

async function personOr404(env, id) {
  const p = await q.personById(env.DB, id).first();
  if (!p) throw new ApiError(404, "not_found");
  return p;
}

async function createPerson(request, env) {
  const { account } = await admin(request, env, true);
  const { fields, links } = cleanPersonInput(await readJson(request), { admin: true });
  const display_name = displayNameOf(fields, null);
  if (!display_name) throw new ApiError(400, "bad_request");
  const now = nowSec(), id = randomB64url(12);
  const person = { maiden_name: null, nickname: null, sex: null, birth_date: null, birth_place: null, death_date: null, death_place: null, deceased: 0, email: null, phone: null, residence: null, notes: null, unverified: 0, ...fields, id, first_name: fields.first_name || null, last_name: fields.last_name || null, display_name, created_at: now, updated_at: now, updated_by: account.id };
  const stmts = [q.insertPerson(env.DB, person)];
  for (const l of links || []) stmts.push(q.insertLink(env.DB, { id: randomB64url(12), person_id: id, ...l }));
  stmts.push(await personHistory(request, env, account.id, "person_created", id, { name: display_name }, now));
  await env.DB.batch(stmts);
  return json({ id }, 201);
}

async function patchPerson(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const person = await personOr404(env, m[1]);
  await env.DB.batch(await savePersonPatch(env, request, account, person, await readJson(request), { admin: true, now: nowSec() }));
  return json({ ok: true });
}

async function deletePerson(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const person = await personOr404(env, m[1]);
  if ((await q.personRefCount(env.DB, person.id).first()).n > 0) throw new ApiError(409, "conflict");
  const now = nowSec();
  await env.DB.batch([
    q.deleteTagsForPerson(env.DB, person.id),
    q.deleteLinksByPerson(env.DB, person.id),
    q.deleteAvatar(env.DB, person.id),
    q.deletePerson(env.DB, person.id),
    await personHistory(request, env, account.id, "person_deleted", person.id, { name: person.display_name }, now),
  ]);
  return json({ ok: true });
}

async function putAvatar(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const person = await personOr404(env, m[1]);
  const updated_at = await storeAvatar(request, env, account.id, person.id, { name: person.display_name });
  return json({ ok: true, updated_at });
}

async function addParent(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const [childId, parentId] = [m[1], m[2]];
  if (childId === parentId) throw new ApiError(400, "bad_request");
  const child = await personOr404(env, childId);
  const parent = await personOr404(env, parentId);
  if (await q.parentEdge(env.DB, parentId, childId).first()) throw new ApiError(409, "conflict");
  const { results } = await q.parentsOf(env.DB, childId).all();
  if (results.length >= 2) throw new ApiError(409, "conflict");
  const now = nowSec();
  await env.DB.batch([
    q.insertParent(env.DB, parentId, childId),
    await personHistory(request, env, account.id, "link_added", childId, { kind: "parent", other: parentId, name: child.display_name, other_name: parent.display_name }, now),
  ]);
  return json({ ok: true }, 201);
}

async function removeParent(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const [childId, parentId] = [m[1], m[2]];
  if (!(await q.parentEdge(env.DB, parentId, childId).first())) throw new ApiError(404, "not_found");
  const child = await personOr404(env, childId);
  const parent = await personOr404(env, parentId);
  const now = nowSec();
  await env.DB.batch([
    q.deleteParent(env.DB, parentId, childId),
    await personHistory(request, env, account.id, "link_removed", childId, { kind: "parent", other: parentId, name: child.display_name, other_name: parent.display_name }, now),
  ]);
  return json({ ok: true });
}

const yearOk = (v) => v == null || (Number.isInteger(v) && v >= 1000 && v <= 2999);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

async function putPartner(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  if (m[1] === m[2]) throw new ApiError(400, "bad_request");
  const body = await readJson(request);
  const kind = body.kind, start_year = body.start_year ?? null, end_year = body.end_year ?? null;
  if (!PARTNER_KINDS.includes(kind) || !yearOk(start_year) || !yearOk(end_year)) throw new ApiError(400, "bad_request");
  const a = await personOr404(env, m[1]);
  const b = await personOr404(env, m[2]);
  const [a_id, b_id] = pair(a.id, b.id);
  const now = nowSec();
  await env.DB.batch([
    q.upsertPartner(env.DB, { a_id, b_id, kind, start_year, end_year }),
    await personHistory(request, env, account.id, "link_added", a.id, { kind: "partner", other: b.id, name: a.display_name, other_name: b.display_name, partner_kind: kind }, now),
  ]);
  return json({ ok: true });
}

async function removePartner(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const [a_id, b_id] = pair(m[1], m[2]);
  if (!(await q.partnerEdge(env.DB, a_id, b_id).first())) throw new ApiError(404, "not_found");
  const person = await personOr404(env, m[1]);
  const other = await personOr404(env, m[2]);
  const now = nowSec();
  await env.DB.batch([
    q.deletePartner(env.DB, a_id, b_id),
    await personHistory(request, env, account.id, "link_removed", m[1], { kind: "partner", other: m[2], name: person.display_name, other_name: other.display_name }, now),
  ]);
  return json({ ok: true });
}

async function linkAccount(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const body = await readJson(request);
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  const person = await personOr404(env, String(body.person_id || ""));
  if (target.person_id) throw new ApiError(409, "conflict");
  if (await q.accountByPerson(env.DB, person.id).first()) throw new ApiError(409, "conflict");
  const now = nowSec();
  await env.DB.batch([
    q.linkAccountPerson(env.DB, target.id, person.id),
    historyStmt(env.DB, { actor: account.id, action: "account_linked", targetType: "account", targetId: target.id, details: { email: target.email, person_id: person.id, name: person.display_name }, ipHash: await hashIp(env, clientIp(request), now) }, now),
  ]);
  return json({ ok: true });
}

async function unlinkAccount(request, env, ctx, m) {
  const { account } = await admin(request, env, true);
  const target = await q.accountById(env.DB, m[1]).first();
  if (!target) throw new ApiError(404, "not_found");
  if (!target.person_id) throw new ApiError(404, "not_found");
  const now = nowSec();
  await env.DB.batch([
    q.linkAccountPerson(env.DB, target.id, null),
    historyStmt(env.DB, { actor: account.id, action: "account_unlinked", targetType: "account", targetId: target.id, details: { email: target.email, person_id: target.person_id }, ipHash: await hashIp(env, clientIp(request), now) }, now),
  ]);
  return json({ ok: true });
}

export const routes = [
  ["POST", /^\/api\/admin\/people$/, createPerson],
  ["PATCH", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)$/, patchPerson],
  ["DELETE", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)$/, deletePerson],
  ["PUT", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)\/avatar$/, putAvatar],
  ["POST", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)\/parents\/([A-Za-z0-9_-]+)$/, addParent],
  ["DELETE", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)\/parents\/([A-Za-z0-9_-]+)$/, removeParent],
  ["POST", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)\/partners\/([A-Za-z0-9_-]+)$/, putPartner],
  ["DELETE", /^\/api\/admin\/people\/([A-Za-z0-9_-]+)\/partners\/([A-Za-z0-9_-]+)$/, removePartner],
  ["POST", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)\/link$/, linkAccount],
  ["POST", /^\/api\/admin\/accounts\/([A-Za-z0-9_-]+)\/unlink$/, unlinkAccount],
];
