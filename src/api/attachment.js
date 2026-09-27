import * as q from "../db/queries.js";
import { ApiError } from "./common.js";
import { keyFor } from "./media.js";

// The mail provider caps a whole message at 5 MiB. Base64 grows a file by a third, so 3.5 MiB goes out
// as about 4.8 MiB, which leaves room for the text; 4 MiB would already be 5.3.
export const ATTACHMENT_MAX_BYTES = 3.5 * 1024 * 1024;

// The document a letter carries, read fresh from R2 each time it is sent. `strict` is the compose
// path: a bad choice is the admin's mistake and gets a 400. A re-send whose document has since gone
// away just goes out without it — the letter itself is still good.
export async function documentAttachment(env, mediaId, strict) {
  if (!mediaId) return null;
  const media = await q.mediaById(env.DB, mediaId).first();
  const usable = media && media.kind === "document" && media.content_type === "application/pdf" && media.size <= ATTACHMENT_MAX_BYTES;
  const obj = usable ? await env.MEDIA.get(keyFor(media)) : null;
  if (!obj) {
    if (strict) throw new ApiError(400, "bad_attachment");
    return null;
  }
  // ż splits into z and a mark that is dropped; ł has no split and is spelt plainly.
  const stem = (media.caption || "dokument").normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L")
    .replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "dokument";
  return { filename: `${stem}.pdf`, content: await obj.arrayBuffer(), type: "application/pdf" };
}
