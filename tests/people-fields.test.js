import { describe, it, expect } from "vitest";
import { DATE_RE, yearOf, cleanPersonInput, displayNameOf } from "../src/people/fields.js";
import { ApiError } from "../src/api/common.js";

describe("dates", () => {
  it("accepts the four shapes and rejects the rest", () => {
    for (const ok of ["1964", "~1888", "1964-10", "1964-10-04"]) expect(DATE_RE.test(ok), ok).toBe(true);
    for (const bad of ["64", "1964-13", "1964-10-32", "04.10.1964", "~1964-10", "abc", ""]) expect(DATE_RE.test(bad), bad).toBe(false);
  });
  it("yearOf reads the leading year", () => {
    expect(yearOf("~1888")).toBe(1888);
    expect(yearOf("1964-10-04")).toBe(1964);
    expect(yearOf(null)).toBe(null);
  });
});

describe("cleanPersonInput", () => {
  it("keeps known fields, trims, nulls empties, validates dates and links", () => {
    const { fields, links } = cleanPersonInput({
      first_name: "  Jan ", last_name: "Nowak", nickname: "", sex: "m", birth_date: "1964-10-04",
      email: "A@X.org", deceased: 0, bogus: "x",
      links: [{ kind: "instagram", label: "ig", url: "https://instagram.com/andy" }],
    }, { admin: false });
    expect(fields).toEqual({ first_name: "Jan", last_name: "Nowak", nickname: null, sex: "m", birth_date: "1964-10-04", email: "a@x.org", deceased: 0 });
    expect(links).toEqual([{ kind: "instagram", label: "ig", url: "https://instagram.com/andy" }]);
  });
  it("rejects bad dates, bad sex, non-https links, unknown link kinds, unverified from non-admins", () => {
    const bad = (body, admin = false) => expect(() => cleanPersonInput(body, { admin })).toThrow(ApiError);
    bad({ birth_date: "4.10.1964" });
    bad({ sex: "x" });
    bad({ links: [{ kind: "instagram", url: "http://x" }] });
    bad({ links: [{ kind: "tiktok", url: "https://x" }] });
    bad({ unverified: 1 });
    expect(cleanPersonInput({ unverified: 1 }, { admin: true }).fields).toEqual({ unverified: 1 });
    bad({ email: "not-an-email" });
    bad({ first_name: "x".repeat(81) });
  });
  it("omits links when the body has none", () => {
    expect(cleanPersonInput({ first_name: "A" }, { admin: true }).links).toBe(null);
  });
});

describe("displayNameOf", () => {
  it("joins names, appends maiden name, falls back", () => {
    expect(displayNameOf({ first_name: "Maria", last_name: "Nowak", maiden_name: "Wiśniewska" }, "x")).toBe("Maria Nowak (Wiśniewska)");
    expect(displayNameOf({ first_name: null, last_name: null, maiden_name: null }, "Unknown parents")).toBe("Unknown parents");
  });
});
