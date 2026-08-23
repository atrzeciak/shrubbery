import { describe, it, expect } from "vitest";
import { buildGraph } from "../public/app/graph.js";
import { focusLayout, familyLayout, generations } from "../public/app/tree-layout.js";
import { FAMILY } from "./helpers/family.js";

const g = buildGraph(FAMILY);
const at = (nodes, id) => nodes.find((n) => n.id === id);

describe("focusLayout", () => {
  it("places parents above, siblings left, partners right, children below, focus at 0", () => {
    const { nodes, edges } = focusLayout(g, "p1");
    expect(at(nodes, "p1")).toMatchObject({ col: 0, row: 1, role: "focus" });
    expect(at(nodes, "p3")).toMatchObject({ col: -1, row: 1, role: "sibling" });
    expect(at(nodes, "p2")).toMatchObject({ col: 1, row: 1, role: "partner" });
    expect([at(nodes, "g1").row, at(nodes, "g2").row]).toEqual([0, 0]);
    expect([at(nodes, "g1").col, at(nodes, "g2").col].sort()).toEqual([-0.5, 0.5]);
    expect([at(nodes, "c1"), at(nodes, "c2")].map((n) => [n.col, n.row, n.role])).toEqual([[-0.5, 2, "child"], [0.5, 2, "child"]]);
    expect(edges).toEqual(expect.arrayContaining([
      { from: "g1", to: "p1", type: "parent" }, { from: "p1", to: "c1", type: "parent" },
      { from: "p1", to: "p2", type: "partner" }, { from: "g1", to: "g2", type: "partner" },
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
    expect(edges.filter((e) => e.type === "partner")).toHaveLength(2);
    expect(edges.filter((e) => e.type === "parent")).toHaveLength(8);
  });
  it("survives a cycle without hanging", () => {
    const cyc = buildGraph({ people: [{ id: "a", display_name: "a" }, { id: "b", display_name: "b" }], parents: [{ parent_id: "a", child_id: "b" }, { parent_id: "b", child_id: "a" }], partners: [], links: [], avatars: [] });
    expect(familyLayout(cyc).nodes).toHaveLength(2);
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
