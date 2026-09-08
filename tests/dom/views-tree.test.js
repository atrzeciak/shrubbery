import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "../../public/app/views/tree.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, byText } from "./helpers.js";

const people = [
  { id: "p1", first_name: "Anna", last_name: "Nowak", display_name: "Anna Nowak", birth_date: "1950-01-01" },
  { id: "p2", first_name: "Jan", last_name: "Nowak", display_name: "Jan Nowak", birth_date: "1948-05-05", death_date: "2010-01-01" },
  { id: "p3", first_name: "Kasia", last_name: "Nowak", display_name: "Kasia Nowak", birth_date: "1980-01-01" },
  { id: "p4", first_name: "Konstantynopolita", last_name: "Kowalska", display_name: "Konstantynopolita Kowalska", birth_date: "1985-01-01", unverified: 1 },
  { id: "p5", display_name: "Zofia Wiśniewska Trzecia", birth_date: null },
];
const graph = {
  people,
  parents: [{ parent_id: "p1", child_id: "p3" }, { parent_id: "p2", child_id: "p3" }, { parent_id: "p1", child_id: "p4" }, { parent_id: "p3", child_id: "p5" }],
  partners: [{ a_id: "p1", b_id: "p2", kind: "married" }],
  links: [], avatars: [{ person_id: "p3", updated_at: 7 }],
};

const me = (person_id = "p3") => viewCtx(meFixture({ account: { person_id } }));

async function draw(ctx = me(), path = "/app/tree", routes = {}) {
  history.replaceState(null, "", path);
  const calls = mockApi({ "GET /api/people": graph, ...routes });
  const root = document.createElement("div");
  document.body.append(root);
  await render(root, ctx);
  // The mode is module state, so each test asks for the one it wants.
  return { calls, root, ctx, mode: async (k) => { const b = byText("[role=tab]", k, root); if (b.getAttribute("aria-selected") !== "true") { b.click(); await tick(); await tick(); } } };
}

const names = (root) => qa("svg .node", root).map((n) => n.getAttribute("aria-label"));
const ptr = (el, type, pointerId, clientX, clientY) => el.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true, cancelable: true }));

beforeEach(async () => {
  await lang("en");
  vi.stubGlobal("requestAnimationFrame", (f) => { f(); return 1; });
  // happy-dom does no layout: give the SVG a box so zooming has a centre to zoom at.
  SVGElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
  Object.defineProperty(SVGElement.prototype, "clientWidth", { get: () => 400, configurable: true });
});

describe("empty and default focus", () => {
  it("says the tree is empty and draws nothing", async () => {
    const { root } = await draw(me(), "/app/tree", { "GET /api/people": { people: [] } });
    expect(root.textContent).toContain("The tree is still empty.");
    expect(q("svg", root)).toBeNull();
  });

  it("centres on me when my account is linked", async () => {
    const { root, mode } = await draw();
    await mode("Around a person");
    expect(q(".node.is-focus", root).getAttribute("aria-label")).toBe("Kasia Nowak");
    // reading order: the parents' row, then Kasia beside her elder half-sister, then her daughter
    expect(names(root)).toEqual(["Anna Nowak", "Jan Nowak", "Konstantynopolita Kowalska", "Kasia Nowak", "Zofia Wiśniewska Trzecia"]);
  });

  it("falls back to the oldest root when there is nobody to centre on", async () => {
    const { root, mode } = await draw(me(null));
    await mode("Around a person");
    expect(q(".node.is-focus", root).getAttribute("aria-label")).toBe("Jan Nowak");
  });

  it("uses the person named in the URL when they exist", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1");
    await mode("Around a person");
    expect(q(".node.is-focus", root).getAttribute("aria-label")).toBe("Anna Nowak");
    const { root: r2 } = await draw(me(), "/app/tree/nobody");
    expect(q(".node.is-focus", r2).getAttribute("aria-label")).toBe("Kasia Nowak");
  });
});

describe("focus mode", () => {
  it("draws avatars, initials, split names, life spans and the unverified mark", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1");
    await mode("Around a person");
    const node = (name) => qa(".node", root).find((n) => n.getAttribute("aria-label") === name);
    expect(q("image", node("Kasia Nowak")).getAttribute("href")).toBe("/api/people/p3/avatar?v=7");
    expect(q("text.initials", node("Anna Nowak")).textContent).toBe("AN");
    expect(qa("text.name", node("Konstantynopolita Kowalska")).map((t) => t.textContent)).toEqual(["Konstantynopoli…", "Kowalska"]);
    expect(qa("text.years", node("Konstantynopolita Kowalska")).map((t) => t.textContent)).toEqual(["1985", "?"]);
    expect(q("text.years", node("Jan Nowak")).textContent).toBe("1948–2010");
    // one drop per family: Kasia from the middle of her parents' marriage, Konstantynopolita from Anna alone
    const svg = q(".tree-wrap svg", root), married = q("line.edge.partner.married", svg);
    const mid = (Number(married.getAttribute("x1")) + Number(married.getAttribute("x2"))) / 2;
    const annaX = Number(node("Anna Nowak").getAttribute("transform").match(/translate\(([-\d.]+)/)[1]);
    const ds = qa("path.edge.family", svg).map((e) => e.getAttribute("d"));
    expect(ds).toHaveLength(2);
    expect(ds.some((d) => d.startsWith(`M${mid} `))).toBe(true);
    expect(ds.some((d) => d.startsWith(`M${annaX} `))).toBe(true);
  });

  it("joins siblings to their shared parents as well as the focus", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p3");
    await mode("Around a person");
    // Kasia from Anna & Jan, her half-sister Konstantynopolita from Anna, Zofia from Kasia
    expect(qa("path.edge.family", q(".tree-wrap svg", root))).toHaveLength(3);
  });

  it("splits a bare display name into first word and the rest", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p5");
    await mode("Around a person");
    const node = qa(".node", root).find((n) => n.getAttribute("aria-label") === "Zofia Wiśniewska Trzecia");
    expect(qa("text.name", node).map((t) => t.textContent)).toEqual(["Zofia", "Wiśniewska Trze…"]);
    expect(q("text.initials", node).textContent).toBe("ZW");
  });

  it("recentres on a tapped relative and opens the card for the centre", async () => {
    const { root, ctx, mode } = await draw(me(), "/app/tree/p3", { "GET /api/people/p3/media": { media: [], counts: {} } });
    await mode("Around a person");
    const node = (name) => qa(".node", root).find((n) => n.getAttribute("aria-label") === name);
    node("Anna Nowak").dispatchEvent(new Event("click"));
    expect(ctx.navigate).toHaveBeenCalledWith("/app/tree/p1");
    node("Kasia Nowak").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(q(".sheet h2").textContent).toBe("Kasia Nowak");
    node("Jan Nowak").dispatchEvent(new KeyboardEvent("keydown", { key: " ", cancelable: true }));
    expect(ctx.navigate).toHaveBeenCalledWith("/app/tree/p2");
    node("Jan Nowak").dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(ctx.navigate).toHaveBeenCalledTimes(2);
  });
});

describe("family mode", () => {
  it("draws everyone, remembers the mode, and centres on the focus", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1");
    await mode("Whole family");
    expect(localStorage.getItem("treeMode")).toBe("family");
    expect(names(root)).toHaveLength(5);
    expect(q("datalist", root)).toBeNull();
    expect(q("svg", root).getAttribute("viewBox")).not.toBe(`${q("svg", root).bounds.minX} ${q("svg", root).bounds.minY} ${q("svg", root).bounds.w} ${q("svg", root).bounds.h}`);
  });

  it("finds a person as the name is typed and centres on the chosen row; no hit, no move", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1");
    await mode("Whole family");
    const svg = q("svg", root), find = q("input[type=search]", root), list = q(".picker", root);
    const type = (v) => { find.value = v; find.dispatchEvent(new Event("input")); };
    const before = svg.getAttribute("viewBox");
    type("nobody");
    expect(list.hidden).toBe(true);
    expect(svg.getAttribute("viewBox")).toBe(before);
    type("zof");
    expect(list.hidden).toBe(false);
    expect(qa("li", list).map((r) => q("span", r).textContent)).toEqual(["Zofia Wiśniewska Trzecia"]);
    q("li", list).dispatchEvent(new Event("mousedown", { cancelable: true }));
    expect(find.value).toBe("Zofia Wiśniewska Trzecia");
    expect(list.hidden).toBe(true);
    expect(svg.getAttribute("viewBox")).not.toBe(before);
  });

  it("zooms in and out with the buttons and the wheel, and Fit restores the whole tree", async () => {
    const { root, mode } = await draw();
    await mode("Whole family");
    const svg = q("svg", root);
    const width = () => Number(svg.getAttribute("viewBox").split(" ")[2]);
    byText("button", "Fit", root).click();
    const full = width();
    q("[aria-label='Zoom in']", root).click();
    expect(width()).toBeCloseTo(full / 1.3);
    q("[aria-label='Zoom out']", root).click();
    expect(width()).toBeCloseTo(full);
    svg.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: 10, clientY: 10, cancelable: true }));
    expect(width()).toBeCloseTo(full * 1.15);
    svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 10, clientY: 10, cancelable: true }));
    expect(width()).toBeCloseTo(full);
  });

  it("pans on drag and swallows the click that ends a drag", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1", { "GET /api/people/p1/media": { media: [], counts: {} } });
    await mode("Whole family");
    const svg = q("svg", root);
    svg.setPointerCapture = vi.fn(() => { throw Object.assign(new Error(), { name: "InvalidStateError" }); });
    byText("button", "Fit", root).click();
    const x = () => Number(svg.getAttribute("viewBox").split(" ")[0]);
    const start = x();
    ptr(svg, "pointerdown", 1, 100, 100);
    ptr(svg, "pointermove", 1, 100, 100);
    ptr(svg, "pointermove", 1, 60, 100);
    expect(x()).toBeGreaterThan(start);
    expect(svg.setPointerCapture).toHaveBeenCalled();
    const node = qa(".node", root).find((n) => n.getAttribute("aria-label") === "Anna Nowak");
    ptr(svg, "pointerup", 1, 60, 100);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(q(".sheet")).toBeNull();
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(q(".sheet h2").textContent).toBe("Anna Nowak");
    ptr(svg, "pointermove", 9, 0, 0);       // a pointer that never went down is ignored
    expect(x()).toBeCloseTo(start + 40 * (Number(svg.getAttribute("viewBox").split(" ")[2]) / 400));
  });

  it("zooms with two fingers", async () => {
    const { root, mode } = await draw();
    await mode("Whole family");
    const svg = q("svg", root);
    svg.setPointerCapture = vi.fn();
    byText("button", "Fit", root).click();
    const width = () => Number(svg.getAttribute("viewBox").split(" ")[2]);
    const full = width();
    ptr(svg, "pointerdown", 1, 100, 100);
    ptr(svg, "pointerdown", 2, 200, 100);
    ptr(svg, "pointermove", 2, 200, 100);
    ptr(svg, "pointermove", 2, 300, 100);
    expect(width()).toBeCloseTo(full / 2);
    ptr(svg, "pointercancel", 2, 300, 100);
    ptr(svg, "pointerup", 1, 100, 100);
  });

  it("rethrows a capture failure that is not about a vanished pointer", async () => {
    const { root, mode } = await draw();
    await mode("Whole family");
    const svg = q("svg", root);
    svg.setPointerCapture = () => { throw new TypeError("nope"); };
    ptr(svg, "pointerdown", 1, 100, 100);
    ptr(svg, "pointermove", 1, 100, 100);
    expect(() => ptr(svg, "pointermove", 1, 50, 100)).toThrow(TypeError);
  });

  it("drops beside the nearer parent, not through whoever sits between a couple", async () => {
    // A with three partners lands in the middle of the row, so A and D end up with B between them
    const between = {
      people: [{ id: "a", display_name: "A", birth_date: "1950" }, { id: "b", display_name: "B", birth_date: "1951" }, { id: "c", display_name: "C", birth_date: "1952" }, { id: "d", display_name: "D", birth_date: "1953" }, { id: "k", display_name: "K" }],
      parents: [{ parent_id: "a", child_id: "k" }, { parent_id: "d", child_id: "k" }],
      partners: [{ a_id: "a", b_id: "b", kind: "married" }, { a_id: "a", b_id: "c", kind: "partner" }, { a_id: "a", b_id: "d", kind: "divorced" }],
      links: [], avatars: [],
    };
    const { root, mode } = await draw(viewCtx(meFixture({ account: { person_id: null } })), "/app/tree", { "GET /api/people": between });
    await mode("Whole family");
    const svg = q(".tree-wrap svg", root);
    const x = (name) => Number(qa(".node", svg).find((n) => n.getAttribute("aria-label") === name).getAttribute("transform").match(/translate\(([-\d.]+)/)[1]);
    const [xa, xb, xd] = [x("A"), x("B"), x("D")];
    expect(Math.min(xa, xd) < xb && xb < Math.max(xa, xd)).toBe(true);
    // A and D are not side by side, so their line is a bridge above the row, not a line under A's marriage
    const bridge = q("path.edge.partner.divorced", svg).getAttribute("d");
    expect(bridge.startsWith(`M${xa} 0 V-`)).toBe(true);
    expect(bridge).toContain(` H${xd} V0`);
    // the drop leaves the bridge beside D: next to A the row is taken by A's marriage
    const [, drop, topY] = q("path.edge.family", svg).getAttribute("d").match(/^M([-\d.]+) ([-\d.]+)/).map(Number);
    expect(Math.abs(drop - xd)).toBe(80);
    expect(topY).toBeLessThan(0);
    // and so does the strike
    const mark = Number(q("path.edge.divorce", svg).getAttribute("d").match(/^M([-\d.]+)/)[1]) + 7;
    expect(Math.abs(mark - xd)).toBe(80);
  });

  it("drops once from between two co-parents, from below the row since they have no line", async () => {
    const rows = {
      people: [{ id: "a", display_name: "A" }, { id: "b", display_name: "B" }, { id: "c", display_name: "C" }, { id: "k", display_name: "K" }],
      parents: [{ parent_id: "b", child_id: "c" }, { parent_id: "a", child_id: "k" }, { parent_id: "c", child_id: "k" }],
      partners: [], links: [], avatars: [],
    };
    const { root, mode } = await draw(viewCtx(meFixture({ account: { person_id: null } })), "/app/tree", { "GET /api/people": rows });
    await mode("Whole family");
    const svg = q(".tree-wrap svg", root);
    const x = (name) => Number(qa(".node", svg).find((n) => n.getAttribute("aria-label") === name).getAttribute("transform").match(/translate\(([-\d.]+)/)[1]);
    const ds = qa("path.edge.family", svg).map((e) => e.getAttribute("d"));
    expect(ds).toHaveLength(2);
    // A is pulled down beside C, one row above K; the drop leaves the row's foot, not an avatar
    expect(ds.some((d) => d.startsWith(`M${(x("A") + x("C")) / 2} ${240 + 126} V`))).toBe(true);
  });

  it("tells marriage, partnership and divorce apart, bars siblings together, and explains itself", async () => {
    const kinds = {
      ...graph,
      people: [...people, { id: "p6", display_name: "Ewa Lis", birth_date: "1952-01-01" }, { id: "p7", display_name: "Ola Kot", birth_date: "1955-01-01" }],
      partners: [{ a_id: "p1", b_id: "p2", kind: "married" }, { a_id: "p1", b_id: "p6", kind: "divorced" }, { a_id: "p1", b_id: "p7", kind: "partner" }],
      parents: [{ parent_id: "p1", child_id: "p3" }, { parent_id: "p2", child_id: "p3" }, { parent_id: "p1", child_id: "p4" }, { parent_id: "p2", child_id: "p4" }, { parent_id: "p1", child_id: "p5" }],
    };
    const { root, mode } = await draw(me(), "/app/tree", { "GET /api/people": kinds });
    await mode("Whole family");
    const svg = q(".tree-wrap svg", root);
    expect(qa("line.edge.partner.married", svg)).toHaveLength(1);
    expect(qa(".edge.partner.unmarried", svg)).toHaveLength(1);
    expect(qa("line.edge.partner.divorced", svg)).toHaveLength(1);
    const divorced = q("line.edge.partner.divorced", svg);
    const mid = (Number(divorced.getAttribute("x1")) + Number(divorced.getAttribute("x2"))) / 2;
    expect(q("path.edge.divorce", svg).getAttribute("d")).toContain(`M${mid - 7} `);
    const ds = qa("path.edge.family", svg).map((e) => e.getAttribute("d"));
    expect(ds).toHaveLength(2);
    // Kasia and Konstantynopolita hang from one bar: a drop, the bar, two verticals
    const bar = ds.find((d) => (d.match(/V/g) || []).length === 3);
    expect(bar).toContain(" H");
    // Zofia alone under Anna: the bar reaches from Anna's drop to Zofia, however far apart they sit
    const lone = ds.find((d) => d !== bar);
    const [, tx, x0, x1, cx] = lone.match(/^M([-\d.]+) [-\d.]+ V[-\d.]+(?: M([-\d.]+) [-\d.]+ H([-\d.]+))? M([-\d.]+) [-\d.]+ V/).map((v) => (v === undefined ? undefined : Number(v)));
    expect(Math.min(x0 ?? tx, x1 ?? tx)).toBeLessThanOrEqual(Math.min(tx, cx));
    expect(Math.max(x0 ?? tx, x1 ?? tx)).toBeGreaterThanOrEqual(Math.max(tx, cx));
    // neighbouring families in one row hang their bars at different heights
    const ym = (d) => Number(d.match(/V([-\d.]+)/)[1]);
    expect(ym(bar)).not.toBe(ym(lone));
    expect(qa(".tree-legend li", root).map((li) => li.textContent)).toEqual(["Married", "Partners", "Divorced", "Children"]);
    expect(qa(".tree-legend .edge.divorce", root)).toHaveLength(1);
  });
});
