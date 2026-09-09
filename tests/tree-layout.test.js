import { describe, it, expect } from "vitest";
import { buildGraph } from "../public/app/graph.js";
import { focusLayout, familyLayout, generations } from "../public/app/tree-layout.js";
import { FAMILY } from "./helpers/family.js";

const g = buildGraph(FAMILY);
const P = (id, birth_date = null) => ({ id, display_name: id, birth_date });
const kids = (parents, children) => children.flatMap((child_id) => parents.map((parent_id) => ({ parent_id, child_id })));
const pair = (a_id, b_id, kind = "married") => ({ a_id, b_id, kind });
const at = (nodes, id) => nodes.find((n) => n.id === id);

describe("focusLayout", () => {
  it("lays the neighbourhood out as family blocks, with the focus at column 0", () => {
    const { nodes, edges } = focusLayout(g, "p1");
    const c = (id) => at(nodes, id).col;
    expect(at(nodes, "p1")).toMatchObject({ col: 0, row: 1, role: "focus" });
    expect(at(nodes, "p3")).toMatchObject({ row: 1, role: "sibling" });
    expect(at(nodes, "p2")).toMatchObject({ row: 1, role: "partner" });
    expect(Math.abs(c("p2"))).toBe(1);
    expect([at(nodes, "g1"), at(nodes, "g2")].map((n) => [n.row, n.role])).toEqual([[0, "parent"], [0, "parent"]]);
    expect(Math.abs(c("g1") - c("g2"))).toBe(1);
    expect([at(nodes, "c1"), at(nodes, "c2")].map((n) => [n.row, n.role])).toEqual([[2, "child"], [2, "child"]]);
    // each couple sits over its own children
    expect((c("c1") + c("c2")) / 2).toBe(c("p2") / 2);
    expect((c("g1") + c("g2")) / 2).toBe(c("p3") / 2);
    expect(edges).toEqual(expect.arrayContaining([
      { type: "family", parents: ["g1", "g2"], children: ["p1", "p3"] }, { type: "family", parents: ["p1", "p2"], children: ["c1", "c2"] },
      { from: "p1", to: "p2", type: "partner", kind: "married" }, { from: "g1", to: "g2", type: "partner", kind: "married" },
    ]));
    expect(nodes).toHaveLength(7);
  });
  it("a loner is a single node; a child sees both parents", () => {
    expect(focusLayout(g, "x").nodes).toEqual([{ id: "x", col: 0, row: 1, role: "focus" }]);
    const { nodes } = focusLayout(g, "c1");
    expect(nodes.filter((n) => n.role === "parent").map((n) => n.id).sort()).toEqual(["p1", "p2"]);
    expect(at(nodes, "c2").role).toBe("sibling");
  });
});

describe("familyLayout", () => {
  it("assigns generations and keeps couples adjacent, children under parents", () => {
    const gen = generations(g);
    expect([gen.get("g1"), gen.get("g2"), gen.get("p1"), gen.get("p2"), gen.get("p3"), gen.get("c1"), gen.get("x")]).toEqual([0, 0, 1, 1, 1, 2, 0]);
    const { nodes, edges, rows } = familyLayout(g);
    expect(rows).toBe(3);
    expect(Math.abs(at(nodes, "p1").col - at(nodes, "p2").col)).toBe(1);
    expect(Math.abs(at(nodes, "g1").col - at(nodes, "g2").col)).toBe(1);
    const mid = (at(nodes, "p1").col + at(nodes, "p2").col) / 2;
    const kids = (at(nodes, "c1").col + at(nodes, "c2").col) / 2;
    expect(Math.abs(mid - kids)).toBeLessThanOrEqual(1);
    expect(edges.filter((e) => e.type === "partner").map((e) => e.kind)).toEqual(["married", "married"]);
    expect(edges.filter((e) => e.type === "family").map((e) => e.children.sort())).toEqual([["p1", "p3"], ["c1", "c2"]]);
  });
  it("keeps each couple's children under that couple, so families never interleave", () => {
    const two = buildGraph({
      people: [P("g1", "1900"), P("g2", "1902"), P("p1", "1930"), P("p2", "1931"), P("p3", "1933"), P("p4", "1934"),
        P("c1", "1960"), P("c2", "1962"), P("c3", "1955"), P("c4", "1961"), P("c5", "1965")],
      parents: [...kids(["g1", "g2"], ["p1", "p3"]), ...kids(["p1", "p2"], ["c1", "c2"]), ...kids(["p3", "p4"], ["c3", "c4", "c5"])],
      partners: [pair("g1", "g2"), pair("p1", "p2"), pair("p3", "p4")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(two);
    const c = (id) => at(nodes, id).col;
    const span = (ids) => [Math.min(...ids.map(c)), Math.max(...ids.map(c))];
    const [a0, a1] = span(["c1", "c2"]), [b0, b1] = span(["c3", "c4", "c5"]);
    expect(a1 < b0 || b1 < a0).toBe(true);
    const mid = (x, y) => (c(x) + c(y)) / 2;
    expect(mid("p1", "p2")).toBeGreaterThanOrEqual(a0); expect(mid("p1", "p2")).toBeLessThanOrEqual(a1);
    expect(mid("p3", "p4")).toBeGreaterThanOrEqual(b0); expect(mid("p3", "p4")).toBeLessThanOrEqual(b1);
    expect(mid("g1", "g2")).toBeGreaterThanOrEqual(Math.min(c("p1"), c("p3")));
    expect(mid("g1", "g2")).toBeLessThanOrEqual(Math.max(c("p2"), c("p4")));
  });
  it("seats an in-law beside their spouse, and lays the larger family out first", () => {
    const inlaw = buildGraph({
      people: [P("q1", "1890"), P("q2", "1892"), P("g1", "1900"), P("g2", "1902"), P("p1", "1930"), P("p2", "1931"), P("p3", "1933"), P("c1", "1960")],
      parents: [...kids(["g1", "g2"], ["p1", "p3"]), ...kids(["q1", "q2"], ["p2"]), ...kids(["p1", "p2"], ["c1"])],
      partners: [pair("q1", "q2"), pair("g1", "g2"), pair("p1", "p2")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(inlaw);
    expect(Math.abs(at(nodes, "p1").col - at(nodes, "p2").col)).toBe(1);
    // the older but smaller family does not push the main line aside: p1 stays under g1-g2
    const c = (id) => at(nodes, id).col;
    expect((c("g1") + c("g2")) / 2).toBe((c("p1") + c("p3")) / 2);
    expect(Math.abs((c("q1") + c("q2")) / 2 - c("p2"))).toBeLessThanOrEqual(2);
    // nobody shares a cell
    const cells = nodes.map((n) => `${n.row}:${n.col}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
  it("puts two people who share a child on one row even when they were never partners", () => {
    const co = buildGraph({
      people: [P("g1", "1900"), P("g2", "1902"), P("m", "1930"), P("f", "1928"), P("c", "1960")],
      parents: [...kids(["g1", "g2"], ["m"]), ...kids(["m", "f"], ["c"])], partners: [pair("g1", "g2")], links: [], avatars: [],
    });
    const gen = generations(co);
    expect([gen.get("f"), gen.get("m"), gen.get("c")]).toEqual([1, 1, 2]);
    const { nodes } = familyLayout(co);
    expect(Math.abs(at(nodes, "m").col - at(nodes, "f").col)).toBe(1);
    expect(at(nodes, "c").col).toBe((at(nodes, "m").col + at(nodes, "f").col) / 2);
  });
  it("seats an in-law's parents straight above them when the room is free", () => {
    const inlaw = buildGraph({
      people: [P("q1", "1890"), P("q2", "1892"), P("g1", "1900"), P("g2", "1902"), P("p1", "1930"), P("p2", "1931"), P("c1", "1960")],
      parents: [...kids(["g1", "g2"], ["p1"]), ...kids(["q1", "q2"], ["p2"]), ...kids(["p1", "p2"], ["c1"])],
      partners: [pair("q1", "q2"), pair("g1", "g2"), pair("p1", "p2")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(inlaw);
    expect(Math.abs(at(nodes, "q1").col - at(nodes, "q2").col)).toBe(1);
    expect((at(nodes, "q1").col + at(nodes, "q2").col) / 2).toBe(at(nodes, "p2").col);
    expect(at(nodes, "q1").row).toBe(0);
  });
  it("seats an in-law's parents at the nearest free spot when the cells above are taken", () => {
    // g1-g2 sit right above p1-p2; q1-q2 cannot go over p2 and must settle beside g2, not at the row's end
    const crowded = buildGraph({
      people: [P("q1", "1890"), P("q2", "1892"), P("g1", "1900"), P("g2", "1902"), P("p1", "1930"), P("p2", "1931"), P("s1", "1933"), P("s2", "1935"), P("s3", "1937"), P("c1", "1960")],
      parents: [...kids(["g1", "g2"], ["s1", "s2", "p1", "s3"]), ...kids(["q1", "q2"], ["p2"]), ...kids(["p1", "p2"], ["c1"])],
      partners: [pair("q1", "q2"), pair("g1", "g2"), pair("p1", "p2")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(crowded);
    expect(Math.abs(at(nodes, "q1").col - at(nodes, "q2").col)).toBe(1);
    expect(Math.abs((at(nodes, "q1").col + at(nodes, "q2").col) / 2 - at(nodes, "p2").col)).toBeLessThanOrEqual(2);
    const cells = nodes.map((n) => `${n.row}:${n.col}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
  it("seats an in-law's parent above them even when the parent has other children, hung beside", () => {
    // Aleksy: father of Sergiusz, who married into the main line, and of Sergiusz's brother, who has
    // a son. The parent goes straight above the in-law, and the other child takes the free cell next
    // to them with their own line below, rather than the whole family being sent to the row's end.
    const inlaw = buildGraph({
      people: [P("g1", "1860"), P("g2", "1862"), P("a", "1860"), P("z", "1897"), P("m", "1899"), P("s", "1888"), P("b", "1890"), P("k", "1920"), P("j", "1941"), P("z1", "1925"), P("z2", "1927")],
      parents: [...kids(["g1", "g2"], ["z", "m"]), ...kids(["a"], ["s", "b"]), ...kids(["b"], ["k"]), ...kids(["m", "s"], ["j"]), ...kids(["z"], ["z1", "z2"])],
      partners: [pair("g1", "g2"), pair("m", "s")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(inlaw);
    expect(at(nodes, "a")).toMatchObject({ row: 0, col: at(nodes, "s").col });
    expect(at(nodes, "b")).toMatchObject({ row: 1, col: at(nodes, "s").col + 1 });
    expect(at(nodes, "k")).toMatchObject({ row: 2, col: at(nodes, "b").col });
    const cells = nodes.map((n) => `${n.row}:${n.col}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
  it("seats the spouses they had children with next to them when no year says otherwise", () => {
    // t: a child with j, later a child with l, and a childless partner h; h is the one who can go further off
    const later = buildGraph({
      people: [P("t", "1938"), P("h", "1939"), P("j", "1941"), P("l", "1942"), P("e", "1960"), P("a", "1964")],
      parents: [...kids(["t", "j"], ["e"]), ...kids(["t", "l"], ["a"])],
      partners: [pair("t", "h", "partner"), pair("t", "j", "divorced")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(later);
    expect(Math.abs(at(nodes, "t").col - at(nodes, "j").col)).toBe(1);
    expect(Math.abs(at(nodes, "t").col - at(nodes, "l").col)).toBe(1);
  });
  it("sits a row over the group with more children, not halfway between groups", () => {
    // a-alone has one child with a wide block; a-b has two children: the couple straddles the first of those
    const two = buildGraph({
      people: [P("a", "1900"), P("b", "1902"), P("s", "1925"), P("sp", "1926"), P("s1", "1950"), P("s2", "1952"), P("s3", "1954"), P("c1", "1928"), P("c2", "1930")],
      parents: [...kids(["a"], ["s"]), ...kids(["a", "b"], ["c1", "c2"]), ...kids(["s", "sp"], ["s1", "s2", "s3"])],
      partners: [pair("s", "sp")], links: [], avatars: [],
    });
    const { nodes } = familyLayout(two);
    const c = (id) => at(nodes, id).col;
    expect((c("a") + c("b")) / 2).toBe(c("c1"));
  });
  it("survives a cycle without hanging", () => {
    const cyc = buildGraph({ people: [{ id: "a", display_name: "a" }, { id: "b", display_name: "b" }], parents: [{ parent_id: "a", child_id: "b" }, { parent_id: "b", child_id: "a" }], partners: [], links: [], avatars: [] });
    expect(familyLayout(cyc).nodes).toHaveLength(2);
  });
  it("lets the parent link win over a partner or co-parent who is also an ancestor", () => {
    // A father wrongly recorded as co-parent of his son's child: two clicks in the editor can do
    // it. The same-row rule for co-parents must yield, or every row is pushed until the guard trips
    // and people land on top of each other. The wrong link is still drawn, so it can be seen and removed.
    const bad = buildGraph({
      people: [P("al"), P("s"), P("m"), P("y"), P("jan"), P("z")],
      parents: [...kids(["al"], ["s"]), ...kids(["al", "s"], ["y"]), ...kids(["m", "s"], ["jan"]), ...kids(["jan"], ["z"])],
      partners: [pair("m", "s"), pair("jan", "z")],
      links: [], avatars: [],
    });
    const gen = generations(bad);
    expect(["al", "s", "m", "y", "jan", "z"].map((id) => gen.get(id))).toEqual([0, 1, 1, 2, 2, 3]);
    const { nodes, edges } = familyLayout(bad);
    expect(new Set(nodes.map((n) => `${n.row}:${n.col}`)).size).toBe(6);
    expect(Math.abs(at(nodes, "m").col - at(nodes, "s").col)).toBe(1);
    expect(at(nodes, "y").col).not.toBe(at(nodes, "s").col);
    expect(edges).toContainEqual({ type: "family", parents: ["al", "s"], children: ["y"] });
  });
  it("keeps every couple adjacent when a person has multiple partners", () => {
    const multi = buildGraph({
      people: [{ id: "a", display_name: "a" }, { id: "b", display_name: "b" }, { id: "c", display_name: "c" }, { id: "d", display_name: "d" }],
      parents: [],
      partners: [{ a_id: "a", b_id: "b", kind: "married" }, { a_id: "a", b_id: "c", kind: "married" }, { a_id: "c", b_id: "d", kind: "married" }],
      links: [],
      avatars: [],
    });
    const { nodes } = familyLayout(multi);
    expect(Math.abs(at(nodes, "a").col - at(nodes, "b").col)).toBe(1);
    expect(Math.abs(at(nodes, "a").col - at(nodes, "c").col)).toBe(1);
    expect(Math.abs(at(nodes, "c").col - at(nodes, "d").col)).toBe(1);
  });
});
