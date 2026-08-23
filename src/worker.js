import { json } from "./util.js";
import { ApiError, appOrigin } from "./api/common.js";
import { routes as authRoutes } from "./api/auth.js";
import { routes as meRoutes } from "./api/me.js";
import { routes as peopleRoutes } from "./api/people.js";
import { routes as adminRoutes } from "./api/admin.js";
import { routes as adminPeopleRoutes } from "./api/admin-people.js";
import { routes as newsRoutes } from "./api/news.js";
import { routes as joinRoutes } from "./api/join.js";
import { routes as mediaRoutes } from "./api/media.js";
import { routes as backupRoutes } from "./api/backup.js";
import { routes as healthRoutes } from "./api/health.js";
import { routes as gatheringRoutes } from "./api/gatherings.js";
import { gatheringReminders, runDaily } from "./events/cron.js";
import { runOps } from "./ops/daily.js";

export const API = [...authRoutes, ...meRoutes, ...peopleRoutes, ...adminRoutes, ...adminPeopleRoutes, ...newsRoutes, ...joinRoutes, ...mediaRoutes, ...backupRoutes, ...healthRoutes, ...gatheringRoutes];

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== appOrigin(env)) return json({ error: "forbidden" }, 403);
  try {
    for (const [method, pattern, handler] of API) {
      if (request.method !== method) continue;
      const m = pattern.exec(url.pathname);
      if (m) return await handler(request, env, ctx, m);
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.code }, e.status, e.headers);
    console.error(e);
    return json({ error: "internal" }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
      const shell = await env.ASSETS.fetch(new URL("/app/index.html", url));
      if (shell.status === 200) return shell;
    }
    return res;
  },

  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil(runDaily(env, now));
    ctx.waitUntil(runOps(env, now));
    ctx.waitUntil(gatheringReminders(env, now));
  },
};
