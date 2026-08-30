import { readFile } from "node:fs/promises";
import { beforeEach, vi } from "vitest";
import { mockApi } from "./helpers.js";

// Every test starts with a fresh document, storage, and an API that answers nothing.
beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "pl";
  localStorage.clear();
  mockApi({});
});

// fetch: i18n files come from disk; everything else goes to the per-test API mock.
vi.stubGlobal("fetch", async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const path = new URL(url, "http://test.local").pathname;
  const m = path.match(/^\/app\/i18n\/(pl|en)\.json$/);
  if (m) return new Response(await readFile(new URL(`../../public/app/i18n/${m[1]}.json`, import.meta.url)), { headers: { "content-type": "application/json" } });
  return globalThis.__api(path, init);
});
