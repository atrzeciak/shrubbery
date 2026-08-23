import * as q from "../db/queries.js";
import { json } from "../util.js";
import { requireSession } from "./common.js";
import { beforeIdOf, historyPage } from "./admin.js";

const PAGE = 30;
// What non-admins see in the feed. Later sub-projects add their content actions here.
export const FAMILY_ACTIONS = ["invite_accepted", "login", "person_created", "person_updated", "avatar_updated", "media_added", "gathering_created", "gathering_deleted", "gathering_announced", "gathering_nudged", "rsvp_answered"];

async function news(request, env) {
  await requireSession(request, env);
  const beforeId = beforeIdOf(new URL(request.url));
  const { results } = await q.listHistory(env.DB, { beforeId, limit: PAGE, actions: FAMILY_ACTIONS, accountId: null }).all();
  return json(historyPage(results, PAGE, { emails: false }));
}

export const routes = [["GET", /^\/api\/news$/, news]];
