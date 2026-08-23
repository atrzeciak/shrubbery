import { describe, it, expect } from "vitest";
import { buildGraph, lifeSpan, initials, yearOf } from "../public/app/graph.js";
import { FAMILY } from "./helpers/family.js";

describe("graph", () => {
  const g = buildGraph(FAMILY);
  it("indexes relations", () => {
    expect(g.parents("c1").sort()).toEqual(["p1", "p2"]);
    expect(g.children("p1").sort()).toEqual(["c1", "c2"]);
    expect(g.siblings("c1")).toEqual(["c2"]);
    expect(g.siblings("p1")).toEqual(["p3"]);
    expect(g.partners("p2")).toEqual([expect.objectContaining({ id: "p1", kind: "married", start_year: 1958 })]);
    expect(g.links("p1")).toHaveLength(1);
    expect(g.avatarAt("p1")).toBe(5);
    expect(g.avatarAt("x")).toBe(null);
    expect(g.parents("x")).toEqual([]);
  });
  it("formats", () => {
    expect(lifeSpan({ birth_date: "1941", death_date: "2014", deceased: 1 })).toBe("1941–2014");
    expect(lifeSpan({ birth_date: "1941", death_date: null, deceased: 1 })).toBe("1941–†");
    expect(lifeSpan({ birth_date: "1964-10-04", deceased: 0 })).toBe("1964");
    expect(lifeSpan({ birth_date: null, deceased: 1 })).toBe("†");
    expect(lifeSpan({ birth_date: null, deceased: 0 })).toBe("");
    expect(initials({ first_name: "Jan", last_name: "Nowak", display_name: "x" })).toBe("JN");
    expect(initials({ first_name: null, last_name: null, display_name: "Unknown parents" })).toBe("UP");
    expect(initials({ first_name: null, last_name: null, display_name: " Solo  Z" })).toBe("SZ");
    expect(yearOf("~1888")).toBe(1888);
  });
});
