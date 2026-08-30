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
    expect(q("line.edge.partner", root)).not.toBeNull();
    expect(qa("path.edge.parent", root).length).toBe(2);
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
    expect(qa("datalist option", root).map((o) => o.value)).toContain("Zofia Wiśniewska Trzecia");
    expect(q("svg", root).getAttribute("viewBox")).not.toBe(`${q("svg", root).bounds.minX} ${q("svg", root).bounds.minY} ${q("svg", root).bounds.w} ${q("svg", root).bounds.h}`);
  });

  it("finds a person by name and centres on them; an unknown name does nothing", async () => {
    const { root, mode } = await draw(me(), "/app/tree/p1");
    await mode("Whole family");
    const svg = q("svg", root), find = q("input[type=search]", root);
    const before = svg.getAttribute("viewBox");
    find.value = " zofia wiśniewska trzecia ";
    find.dispatchEvent(new Event("change"));
    expect(svg.getAttribute("viewBox")).not.toBe(before);
    const after = svg.getAttribute("viewBox");
    find.value = "nobody";
    find.dispatchEvent(new Event("change"));
    expect(svg.getAttribute("viewBox")).toBe(after);
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
});
