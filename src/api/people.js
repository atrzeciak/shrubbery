import * as q from "../db/queries.js";
import { clientIp, json, nowSec, randomB64url } from "../util.js";
import { hashIp, historyStmt } from "../history.js";
import { cleanPersonInput, displayNameOf } from "../people/fields.js";
import { jpegSize } from "../people/jpeg.js";
import { ApiError, readJson, requireSession } from "./common.js";

export const AVATAR_MAX_BYTES = 204800;
export const AVATAR_MAX_SIDE = 512;

export async function personHistory(request, env, actorId, action, personId, details, now) {
  return historyStmt(env.DB, { actor: actorId, action, targetType: "person", targetId: personId, details, ipHash: await hashIp(env, clientIp(request), now) }, now);
}

export const personView = (row) => row;

async function personOr404(env, id) {
  const p = await q.personById(env.DB, id).first();
  if (!p) throw new ApiError(404, "not_found");
  return p;
}

async function personWithLinks(env, id) {
  const person = await personOr404(env, id);
  const { results } = await q.linksByPerson(env.DB, id).all();
  return { person: personView(person), links: results };
}

// Statements for a validated PATCH: update, link replacement and the history row.
export async function savePersonPatch(env, request, actor, person, body, { admin, now, self }) {
  const { fields, links } = cleanPersonInput(body, { admin });
  const changed = Object.keys(fields);
  if (links) changed.push("links");
  if (!changed.length) throw new ApiError(400, "bad_request");
  const merged = { ...person, ...fields };
  if ("first_name" in fields || "last_name" in fields || "maiden_name" in fields) fields.display_name = displayNameOf(merged, person.display_name);
  const stmts = [q.updatePerson(env.DB, person.id, fields, now, actor.id)];
  if (links) {
    stmts.push(q.deleteLinksByPerson(env.DB, person.id));
    for (const l of links) stmts.push(q.insertLink(env.DB, { id: randomB64url(12), person_id: person.id, ...l }));
  }
  const details = { fields: changed, name: fields.display_name || person.display_name };
  if (self) details.self = true;
  stmts.push(await personHistory(request, env, actor.id, "person_updated", person.id, details, now));
  return stmts;
}

async function listAll(request, env) {
  await requireSession(request, env);
  const [people, parents, partners, links, avatars] = await env.DB.batch([
    q.listPeople(env.DB), q.listParents(env.DB), q.listPartners(env.DB), q.listLinks(env.DB), q.listAvatars(env.DB),
  ]);
  return json({ people: people.results.map(personView), parents: parents.results, partners: partners.results, links: links.results, avatars: avatars.results });
}

async function getOne(request, env, ctx, m) {
  await requireSession(request, env);
  return json(await personWithLinks(env, m[1]));
}

// D1 hands BLOB columns back as ArrayBuffer, a Uint8Array, or (locally, via .first()) a plain
// array of byte values — normalize to a Uint8Array so Response() gets real bytes either way.
function blobBytes(blob) {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  return Uint8Array.from(blob);
}

async function getAvatar(request, env, ctx, m) {
  await requireSession(request, env);
  const row = await q.avatarByPerson(env.DB, m[1]).first();
  if (!row) throw new ApiError(404, "not_found");
  const etag = `"${row.updated_at}"`;
  const headers = { etag, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-disposition": "inline" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(blobBytes(row.jpeg), { status: 200, headers: { ...headers, "content-type": "image/jpeg" } });
}

async function myPerson(request, env) {
  const { account } = await requireSession(request, env);
  if (!account.person_id) throw new ApiError(404, "not_found");
  return json(await personWithLinks(env, account.person_id));
}

async function patchMyPerson(request, env) {
  const { account } = await requireSession(request, env);
  if (!account.person_id) throw new ApiError(404, "not_found");
  const person = await personOr404(env, account.person_id);
  const body = await readJson(request);
  await env.DB.batch(await savePersonPatch(env, request, account, person, body, { admin: false, now: nowSec(), self: true }));
  return json({ ok: true });
}

// Shared by the own-avatar and admin-avatar routes. Validates and stores; returns updated_at.
export async function storeAvatar(request, env, actorId, personId, details) {
  if (!/^image\/jpeg\b/.test(request.headers.get("content-type") || "")) throw new ApiError(400, "bad_request");
  const contentLength = Number(request.headers.get("content-length"));
  if (contentLength > AVATAR_MAX_BYTES) throw new ApiError(400, "bad_request");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) throw new ApiError(400, "bad_request");
  const size = jpegSize(bytes);
  if (!size || size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE) throw new ApiError(400, "bad_request");
  const now = nowSec();
  await env.DB.batch([
    q.upsertAvatar(env.DB, personId, bytes, now),
    await personHistory(request, env, actorId, "avatar_updated", personId, details, now),
  ]);
  return now;
}

async function putMyAvatar(request, env) {
  const { account } = await requireSession(request, env);
  if (!account.person_id) throw new ApiError(404, "not_found");
  const person = await personOr404(env, account.person_id);
  const updated_at = await storeAvatar(request, env, account.id, person.id, { self: true, name: person.display_name });
  return json({ ok: true, updated_at });
}

export const routes = [
  ["GET", /^\/api\/people$/, listAll],
  ["GET", /^\/api\/people\/([A-Za-z0-9_-]+)$/, getOne],
  ["GET", /^\/api\/people\/([A-Za-z0-9_-]+)\/avatar$/, getAvatar],
  ["GET", /^\/api\/me\/person$/, myPerson],
  ["PATCH", /^\/api\/me\/person$/, patchMyPerson],
  ["PUT", /^\/api\/me\/person\/avatar$/, putMyAvatar],
];
