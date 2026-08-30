import { describe, it, expect } from "vitest";
import { loadGraph, avatarUrl, avatarEl } from "../../public/app/people.js";
import { buildGraph } from "../../public/app/graph.js";
import { mockApi } from "./helpers.js";

const people = [{ id: "p1", first_name: "Anna", last_name: "Kowal", display_name: "Anna Kowal" }, { id: "p2", display_name: "Jan Nowak" }];

describe("loadGraph", () => {
  it("fetches the family and builds the graph from it", async () => {
    const calls = mockApi({ "GET /api/people": { people, parents: [{ parent_id: "p1", child_id: "p2" }], avatars: [] } });
    const g = await loadGraph();
    expect(calls[0].path).toBe("/api/people");
    expect(g.parents("p2")).toEqual(["p1"]);
  });
});

describe("avatars", () => {
  const g = buildGraph({ people, avatars: [{ person_id: "p1", updated_at: 1700000000 }] });
  it("avatarUrl carries the upload time so a new photo is not served from cache", () => {
    expect(avatarUrl(g, "p1")).toBe("/api/people/p1/avatar?v=1700000000");
    expect(avatarUrl(g, "p2")).toBeNull();
  });
  it("avatarEl shows the picture when there is one and initials otherwise", () => {
    const img = avatarEl(g, "p1", 72);
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("/api/people/p1/avatar?v=1700000000");
    expect(img.style.width).toBe("72px");
    const div = avatarEl(g, "p2");
    expect(div.tagName).toBe("DIV");
    expect(div.textContent).toBe("JN");
    expect(div.style.height).toBe("40px");
    expect(div.getAttribute("aria-hidden")).toBe("true");
  });
});
