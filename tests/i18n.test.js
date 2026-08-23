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
});
