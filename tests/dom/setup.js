import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, vi } from "vitest";
import { mockApi } from "./helpers.js";

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
