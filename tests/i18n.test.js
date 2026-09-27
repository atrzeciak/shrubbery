import { describe, it, expect } from "vitest";
import pl from "../public/app/i18n/pl.json";
import en from "../public/app/i18n/en.json";

describe("i18n", () => {
  it("pl and en have identical key sets", () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });
  it("no empty strings and every placeholder appears in both", () => {
    for (const k of Object.keys(pl)) {
      expect(pl[k].trim(), k).not.toBe("");
      expect(en[k].trim(), k).not.toBe("");
      const ph = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort();
      expect(ph(pl[k]), k).toEqual(ph(en[k]));
    }
  });

  // Every code the Worker throws and every action it writes to history needs its sentence, or the
  // reader sees "Something went wrong" for a refusal that has a reason, and History a bare action name.
  it("has a string for every error code the Worker throws and every history action it writes", () => {
    const sources = Object.values(import.meta.glob("../src/**/*.js", { query: "?raw", import: "default", eager: true })).join("\n");
    const codes = new Set([...sources.matchAll(/(?:ApiError\([^,]+,\s*|error:\s*)"([a-z_]+)"/g)].map((m) => `error.${m[1]}`));
    const actions = new Set([...sources.matchAll(/action: "([a-z_]+)"|(?:own|admin|person|join)History\(request[^"\n]*"([a-z_]+)"/g)].map((m) => `news.${m[1] || m[2]}`));
    expect(codes.size).toBeGreaterThan(5);
    expect(actions.size).toBeGreaterThan(10);
    expect([...codes, ...actions].filter((k) => !(k in en)).sort()).toEqual([]);
  });
});
