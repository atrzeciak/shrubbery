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

  it("joins two co-parents with a dotted line of their own and drops from between them like a couple", async () => {
    const rows = {
      people: [{ id: "a", display_name: "A" }, { id: "b", display_name: "B" }, { id: "c", display_name: "C" }, { id: "s", display_name: "S" }, { id: "k", display_name: "K" }],
      parents: [{ parent_id: "b", child_id: "c" }, { parent_id: "a", child_id: "k" }, { parent_id: "c", child_id: "k" }, { parent_id: "a", child_id: "s" }],
      partners: [], links: [], avatars: [],
    };
    const { root, mode } = await draw(viewCtx(meFixture({ account: { person_id: null } })), "/app/tree", { "GET /api/people": rows });
    await mode("Whole family");
    const svg = q(".tree-wrap svg", root);
    const x = (name) => Number(qa(".node", svg).find((n) => n.getAttribute("aria-label") === name).getAttribute("transform").match(/translate\(([-\d.]+)/)[1]);
    // A is pulled down beside C, one row above K, and the two are joined the way a couple is
    expect(Math.abs(x("A") - x("C"))).toBe(120 + 40);
    expect(qa(".edge.partner.coparents", svg)).toHaveLength(1);
    const ds = qa("path.edge.family", svg).map((e) => e.getAttribute("d"));
    expect(ds).toContainEqual(expect.stringMatching(new RegExp(`^M${(x("A") + x("C")) / 2} ${240 + 32} V`)));
    // A's own child S hangs from A's feet alone, as for any single parent
    expect(ds).toContainEqual(expect.stringMatching(new RegExp(`^M${x("A")} ${240 + 2 * 32 + 80} V`)));
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
    expect(qa(".tree-legend li", root).map((li) => li.textContent)).toEqual(["Married", "Partners", "Divorced", "Children together", "Children"]);
    expect(qa(".tree-legend .edge.divorce", root)).toHaveLength(1);
  });
});

// Every straight stroke the tree draws, tagged by the element it belongs to. The divorce strike
// is decoration and is left out.
function strokes(svg) {
  const out = [];
  qa("line.edge", svg).forEach((l, i) => out.push({ owner: `l${i}`, x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1"), x2: +l.getAttribute("x2"), y2: +l.getAttribute("y2") }));
  qa("path.edge:not(.divorce)", svg).forEach((p, i) => {
    let x = 0, y = 0;
    for (const [, cmd, rest] of p.getAttribute("d").matchAll(/([MVHa])((?:[-\d.]+ ?)+)/g)) {
      const n = rest.trim().split(" ").map(Number);
      if (cmd === "M") { [x, y] = n; continue; }
      // a hop is an arc: the pen lands past it and the gap it leaves is the point
      if (cmd === "a") { x += n[5]; y += n[6]; continue; }
      const nx = cmd === "H" ? n[0] : x, ny = cmd === "V" ? n[0] : y;
      out.push({ owner: `p${i}`, x1: x, y1: y, x2: nx, y2: ny });
      x = nx; y = ny;
    }
  });
  return out;
}
// Hops: the places where a line jumps over another because the crossing could not be avoided.
const hops = (svg) => qa("path.edge.family", svg).reduce((n, p) => n + (p.getAttribute("d").match(/ a/g) || []).length, 0);
const between = (v, a, b) => v > Math.min(a, b) && v < Math.max(a, b);
const samePoint = (a, b) => (a.x1 === b.x1 && a.y1 === b.y1) || (a.x1 === b.x2 && a.y1 === b.y2) || (a.x2 === b.x1 && a.y2 === b.y1) || (a.x2 === b.x2 && a.y2 === b.y2);

// Strokes of different elements that cut across each other, or run along each other for more
// than the few pixels where two lines meet at somebody's avatar (that is a junction, not a crossing).
function crossings(svg) {
  const s = strokes(svg);
  const out = [];
  const line = (t) => `${t.owner}:(${t.x1},${t.y1})-(${t.x2},${t.y2})`;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
    const a = s[i], b = s[j];
    if (a.owner === b.owner) continue;
    const av = a.x1 === a.x2, bv = b.x1 === b.x2;
    if (av !== bv) {
      const v = av ? a : b, h = av ? b : a;
      if (between(v.x1, h.x1, h.x2) && between(h.y1, v.y1, v.y2)) out.push(`${line(a)} x ${line(b)}`);
    } else if ((av ? a.x1 === b.x1 : a.y1 === b.y1) && !samePoint(a, b)) {
      const [a0, a1] = av ? [a.y1, a.y2] : [a.x1, a.x2], [b0, b1] = av ? [b.y1, b.y2] : [b.x1, b.x2];
      if (Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)) >= 20) out.push(`${line(a)} = ${line(b)}`);
    }
  }
  return out;
}

// Strokes that pass through somebody's avatar rather than ending at it.
function piercings(svg) {
  const R = 32;
  const nodes = qa(".node", svg).map((g) => { const [, x, y] = g.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/).map(Number); return { cx: x, cy: y + R }; });
  let n = 0;
  for (const s of strokes(svg)) for (const { cx, cy } of nodes) {
    const inside = (x, y) => Math.hypot(x - cx, y - cy) <= R + 1;
    if (inside(s.x1, s.y1) || inside(s.x2, s.y2)) continue;
    const v = s.x1 === s.x2;
    if ((v ? Math.abs(s.x1 - cx) : Math.abs(s.y1 - cy)) < R && (v ? between(cy, s.y1, s.y2) : between(cx, s.x1, s.x2))) n++;
  }
  return n;
}

const P = (id, display_name, birth_date = null) => ({ id, display_name, birth_date });
const kids = (parents, children) => children.flatMap((child_id) => parents.map((parent_id) => ({ parent_id, child_id })));
const pair = (a_id, b_id, kind = "married") => ({ a_id, b_id, kind });
// Four generations: grandparents with three children and one recorded under the grandfather
// alone, a child with three partners and
// children by each, an in-law whose own parents are in the tree, a pair who share a child but
// were never partners, and a childless couple nobody is related to. (A union between two people
// who both descend from the tree, cousins say, is left out: no layered drawing can avoid a long
// crossing link for that, and this test is about everything else.)
const clan = {
  people: [P("g1", "Aleksy", "1900"), P("g2", "Maria", "1902"), P("q1", "Ignacy", "1905"), P("q2", "Rozalia", "1908"),
    P("w", "Wanda", "1928"), P("a", "Anna", "1930"), P("b", "Bogdan", "1933"), P("c", "Celina", "1936"), P("d", "Dawid", "1934"), P("e", "Ewa", "1940"), P("f", "Feliks", "1938"), P("h", "Hanna", "1942"),
    P("k1", "Kuba", "1960"), P("k2", "Kasia", "1962"), P("k3", "Karol", "1965"), P("k4", "Klara", "1968"), P("k5", "Krzysztof", "1970"), P("k6", "Kinga", "1972"),
    P("n", "Natalia", "1961"), P("m", "Marta", "1990"), P("z1", "Zenon", "1950"), P("z2", "Zofia", "1952")],
  parents: [...kids(["g1"], ["w"]), ...kids(["g1", "g2"], ["a", "b", "c"]), ...kids(["q1", "q2"], ["d"]), ...kids(["a", "d"], ["k1", "k2"]),
    ...kids(["b", "e"], ["k3"]), ...kids(["b", "f"], ["k4"]), ...kids(["b", "h"], ["k5"]), ...kids(["c"], ["k6"]), ...kids(["k1", "n"], ["m"])],
  partners: [pair("g1", "g2"), pair("q1", "q2"), pair("a", "d"), pair("b", "e", "divorced"), pair("b", "f", "partner"), pair("b", "h"), pair("z1", "z2")],
  links: [], avatars: [],
};

describe("nothing crosses", () => {
  const clean = async (mode, path, routes) => {
    const { root, mode: pick } = await draw(viewCtx(meFixture({ account: { person_id: null } })), path, routes);
    await pick(mode);
    return q(".tree-wrap svg", root);
  };
  it("in the default family, whole and around each person", async () => {
    const whole = await clean("Whole family", "/app/tree");
    expect([crossings(whole), piercings(whole), hops(whole)]).toEqual([[], 0, 0]);
    for (const id of people.map((p) => p.id)) {
      const svg = await clean("Around a person", `/app/tree/${id}`);
      expect([id, crossings(svg), piercings(svg), hops(svg)]).toEqual([id, [], 0, 0]);
    }
  });
  it("in a clan with three partnerships, co-parents and a stranger couple; the one in-law link hops, nothing crosses", async () => {
    const svg = await clean("Whole family", "/app/tree", { "GET /api/people": clan });
    expect(qa(".node", svg)).toHaveLength(clan.people.length);
    expect(piercings(svg)).toBe(0);
    // Dawid's parents hang above him beside Anna's, and their line to him has to cut Anna's family
    // bar: it does so with a hop, and nothing else crosses anything
    expect(crossings(svg)).toEqual([]);
    expect(hops(svg)).toBe(1);
    for (const id of ["b", "a", "d", "k1", "k6", "m", "q1"]) {
      const around = await clean("Around a person", `/app/tree/${id}`, { "GET /api/people": clan });
      expect([id, crossings(around), piercings(around), hops(around)]).toEqual([id, [], 0, 0]);
    }
  });
});
