import { describe, it, expect } from "vitest";
import { buildScope } from "../src/events/scope.js";

// gm(=grandma)+gf are parents of mom & aunt; mom+dad are parents of me & sis; partners: dad-mom, gm-gsp, me-wife
const parents = [
  { parent_id: "gm", child_id: "mom" }, { parent_id: "gf", child_id: "mom" }, { parent_id: "gm", child_id: "aunt" },
  { parent_id: "mom", child_id: "me" }, { parent_id: "dad", child_id: "me" }, { parent_id: "mom", child_id: "sis" },
  { parent_id: "aunt", child_id: "cousin" },
];
const partners = [{ a_id: "dad", b_id: "mom" }, { a_id: "gm", b_id: "gsp" }, { a_id: "me", b_id: "wife" }];
const s = buildScope(parents, partners);

describe("birthday scope (close circle)", () => {
  it("parents, partners, children, siblings are in; others out", () => {
    for (const ok of ["mom", "dad", "sis", "wife"]) expect(s.inScope(ok, "me", "birthday"), ok).toBe(true);
    expect(s.inScope("me", "mom", "birthday")).toBe(true);   // child
    for (const no of ["gm", "gf", "aunt", "cousin", "gsp"]) expect(s.inScope(no, "me", "birthday"), no).toBe(false);
  });
  it("never self", () => expect(s.inScope("me", "me", "birthday")).toBe(false));
});

describe("death scope adds ancestors up to two generations and their partners", () => {
  it("grandparents and their partners are in", () => {
    for (const ok of ["mom", "gm", "gf", "gsp"]) expect(s.inScope(ok, "me", "death"), ok).toBe(true);
  });
  it("aunt and cousin are still out; great-grandparents would be out", () => {
    for (const no of ["aunt", "cousin"]) expect(s.inScope(no, "me", "death"), no).toBe(false);
  });
});
