import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, vi } from "vitest";
import { mockApi } from "./helpers.js";

// happy-dom keeps localStorage as a getter on the window's prototype, and vitest copies only own
// properties and a fixed key list onto the global, so whether it arrives depends on load order.
// A Map behind the four methods the app uses makes it certain.
if (!globalThis.localStorage) {
  const store = new Map();
  vi.stubGlobal("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() });
}

// Every test starts with a fresh document, storage, and an API that answers nothing.
beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "pl";
  localStorage.clear();
  mockApi({});
});

// fetch: i18n files come from disk (by path, not URL: happy-dom's URL resolves file:// bases to
// localhost); everything else goes to the per-test API mock.
vi.stubGlobal("fetch", async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const u = new URL(url, "http://test.local");
  const m = u.pathname.match(/^\/app\/i18n\/(pl|en)\.json$/);
  if (m) return new Response(await readFile(resolve(`public/app/i18n/${m[1]}.json`)), { headers: { "content-type": "application/json" } });
  return globalThis.__api(u.pathname + u.search, init);
});
