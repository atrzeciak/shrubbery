import * as q from "../db/queries.js";
import { json, nowSec, randomB64url } from "../util.js";
import { checkDocument, checkPhoto, cleanCaption, cleanYear, MEDIA_CAP, THUMB_MAX_BYTES } from "../media/rules.js";
import { jpegSize } from "../people/jpeg.js";
import { ApiError, readJson, requireSession } from "./common.js";
import { personHistory } from "./people.js";

export const keyFor = (m) => `media/${m.id}.${m.content_type === "application/pdf" ? "pdf" : "jpg"}`;
export const canTouch = (account, media) => account.role === "admin" || media.uploaded_by === account.id;

async function mediaOr404(env, id) {
  const m = await q.mediaById(env.DB, id).first();
  if (!m) throw new ApiError(404, "not_found");
  return m;
}

// Owner must exist and — for non-admins — be the caller's own person, with no tags.
async function resolveOwnerAndTags(env, account, url) {
  const ownerId = url.searchParams.get("owner") || "";
  const tags = (url.searchParams.get("tags") || "").split(",").filter(Boolean);
  if (account.role !== "admin") {
    if (!account.person_id || ownerId !== account.person_id || tags.length) throw new ApiError(403, "forbidden");
  }
  const owner = await q.personById(env.DB, ownerId).first();
  if (!owner) throw new ApiError(account.role === "admin" ? 404 : 403, account.role === "admin" ? "not_found" : "forbidden");
  for (const tid of tags) if (!(await q.personById(env.DB, tid).first())) throw new ApiError(404, "not_found");
  return { owner, tags };
}

async function upload(request, env) {
  const { account } = await requireSession(request, env);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "photo" && kind !== "document") throw new ApiError(400, "bad_request");
  const caption = cleanCaption(url.searchParams.get("caption"));
  const year = cleanYear(url.searchParams.get("year"));
  const { owner, tags } = await resolveOwnerAndTags(env, account, url);
  const { n } = await q.countOwnedMedia(env.DB, owner.id).first();
  if (n >= MEDIA_CAP) return json({ error: "conflict", person: owner.display_name }, 409);
  const bytes = new Uint8Array(await request.arrayBuffer());
  const contentType = kind === "photo" ? checkPhoto(bytes) : checkDocument(bytes, request.headers.get("content-type"));
  const now = nowSec();
  const media = { id: randomB64url(12), ownerPersonId: owner.id, kind, caption, year, contentType, size: bytes.length, uploadedBy: account.id, createdAt: now };
  const key = keyFor({ id: media.id, content_type: contentType });
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  // The count above is the friendly answer; this is the one that actually holds when two uploads
  // arrive together. If the cap refuses the row, the object just written has nothing to belong to.
  if (!(await q.insertMedia(env.DB, media).run()).meta.changes) {
    await env.MEDIA.delete(key);
    return json({ error: "conflict", person: owner.display_name }, 409);
  }
  const stmts = [];
  for (const tid of tags) stmts.push(q.insertMediaTag(env.DB, media.id, tid));
  stmts.push(await personHistory(request, env, account.id, "media_added", owner.id, { kind, caption, name: owner.display_name }, now));
  await env.DB.batch(stmts);
  return json({ id: media.id }, 201);
}

async function putThumb(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  const media = await mediaOr404(env, m[1]);
  if (!canTouch(account, media)) throw new ApiError(403, "forbidden");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > THUMB_MAX_BYTES || !jpegSize(bytes)) throw new ApiError(400, "bad_request");
  await env.MEDIA.put(`media/${media.id}.thumb.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await q.setMediaThumb(env.DB, media.id).run();
  return json({ ok: true });
}

async function listForPerson(request, env, ctx, m) {
  await requireSession(request, env);
  if (!(await q.personById(env.DB, m[1]).first())) throw new ApiError(404, "not_found");
  const { results } = await q.mediaForPerson(env.DB, m[1]).all();
  const byMedia = new Map(results.map((r) => [r.id, []]));
  if (results.length) {
    const { results: tags } = await q.tagsForMediaMany(env.DB, [...byMedia.keys()]).all();
    for (const tag of tags) byMedia.get(tag.media_id)?.push(tag.person_id);
  }
  const media = results.map((row) => ({ ...row, people: byMedia.get(row.id) }));
  const { n } = await q.countOwnedMedia(env.DB, m[1]).first();
  return json({ media, counts: { used: n, cap: MEDIA_CAP } });
}

async function streamObject(env, media, key, contentType, request) {
  const etag = `"${media.id}-${media.created_at}"`;
  const headers = {
    etag,
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new ApiError(404, "not_found");
  return new Response(obj.body, { status: 200, headers: { ...headers, "content-type": contentType } });
}

async function getMedia(request, env, ctx, m) {
  await requireSession(request, env);
  const media = await mediaOr404(env, m[1]);
  return streamObject(env, media, keyFor(media), media.content_type, request);
}

async function getThumb(request, env, ctx, m) {
  await requireSession(request, env);
  const media = await mediaOr404(env, m[1]);
  if (!media.has_thumb) throw new ApiError(404, "not_found");
  return streamObject(env, media, `media/${media.id}.thumb.jpg`, "image/jpeg", request);
}

async function patchMedia(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  const media = await mediaOr404(env, m[1]);
  const body = await readJson(request);
  const wantsAdmin = "owner_person_id" in body || "tags" in body;
  if (wantsAdmin && account.role !== "admin") throw new ApiError(403, "forbidden");
  if (!wantsAdmin && !canTouch(account, media)) throw new ApiError(403, "forbidden");
  let ownerId = media.owner_person_id;
  const stmts = [];
  if ("owner_person_id" in body) {
    const owner = await q.personById(env.DB, String(body.owner_person_id || "")).first();
    if (!owner) throw new ApiError(404, "not_found");
    if (owner.id !== media.owner_person_id) {
      const { n } = await q.countOwnedMedia(env.DB, owner.id).first();
      if (n >= MEDIA_CAP) return json({ error: "conflict", person: owner.display_name }, 409);
      stmts.push(q.setMediaOwner(env.DB, media.id, owner.id));
      ownerId = owner.id;
    }
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags)) throw new ApiError(400, "bad_request");
    const tags = [...new Set(body.tags.map(String))].filter((tid) => tid !== ownerId);
    for (const tid of tags) if (!(await q.personById(env.DB, tid).first())) throw new ApiError(404, "not_found");
    stmts.push(q.deleteMediaTags(env.DB, media.id));
    for (const tid of tags) stmts.push(q.insertMediaTag(env.DB, media.id, tid));
  }
  const caption = "caption" in body ? cleanCaption(body.caption) : media.caption;
  const year = "year" in body ? cleanYear(body.year) : media.year;
  if ("caption" in body || "year" in body) stmts.push(q.updateMediaMeta(env.DB, media.id, caption, year));
  if (!stmts.length) throw new ApiError(400, "bad_request");
  const ownerRow = await q.personById(env.DB, ownerId).first();
  const now = nowSec();
  stmts.push(await personHistory(request, env, account.id, "media_updated", ownerId, { kind: media.kind, caption, name: ownerRow.display_name }, now));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function deleteMediaRoute(request, env, ctx, m) {
  const { account } = await requireSession(request, env);
  const media = await mediaOr404(env, m[1]);
  if (!canTouch(account, media)) throw new ApiError(403, "forbidden");
  const owner = await q.personById(env.DB, media.owner_person_id).first();
  await env.MEDIA.delete([keyFor(media), `media/${media.id}.thumb.jpg`]);
  const now = nowSec();
  await env.DB.batch([
    q.deleteMediaTags(env.DB, media.id),
    q.deleteMedia(env.DB, media.id),
    await personHistory(request, env, account.id, "media_removed", media.owner_person_id, { kind: media.kind, caption: media.caption, name: owner ? owner.display_name : "" }, now),
  ]);
  return json({ ok: true });
}

export const routes = [
  ["POST", /^\/api\/media$/, upload],
  ["PUT", /^\/api\/media\/([A-Za-z0-9_-]+)\/thumb$/, putThumb],
  ["GET", /^\/api\/people\/([A-Za-z0-9_-]+)\/media$/, listForPerson],
  ["GET", /^\/api\/media\/([A-Za-z0-9_-]+)\/thumb$/, getThumb],
  ["GET", /^\/api\/media\/([A-Za-z0-9_-]+)$/, getMedia],
  ["PATCH", /^\/api\/media\/([A-Za-z0-9_-]+)$/, patchMedia],
  ["DELETE", /^\/api\/media\/([A-Za-z0-9_-]+)$/, deleteMediaRoute],
];
