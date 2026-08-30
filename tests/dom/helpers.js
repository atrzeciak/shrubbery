import { vi } from "vitest";
import { setLang } from "../../public/app/i18n.js";

// Routes: { "GET /api/people": data | (init, path) => data | { status, body } }.
// A missing route is a 404 so a test fails loudly on a request it did not expect.
export function mockApi(routes) {
  const calls = [];
  globalThis.__api = async (path, init) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body && typeof init.body === "string" && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const hit = routes[key] ?? routes[`${method} ${path.split("?")[0]}`];
    if (hit === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const out = typeof hit === "function" ? await hit(body, path) : hit;
    if (out && typeof out === "object" && "status" in out && "body" in out) return new Response(JSON.stringify(out.body), { status: out.status });
    return new Response(JSON.stringify(out ?? {}), { status: 200 });
  };
  return calls;
}

export const lang = (l = "pl") => setLang(l);

// A rendering context shaped like app.js hands to views.
export function ctx(over = {}) {
  return { me: { id: "acc1", email: "me@x.org", role: "family", lang: "pl", person_id: null }, navigate: vi.fn(), toast: vi.fn(), errorText: (e) => e?.code || String(e), ...over };
}

export const tick = () => new Promise((r) => { setTimeout(r, 0); });
export const q = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
