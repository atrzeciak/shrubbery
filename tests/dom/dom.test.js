import { describe, it, expect } from "vitest";
import { h, s, clear, fmtDate, fmtAgo } from "../../public/app/dom.js";

describe("h", () => {
  it("sets class, text, attributes, boolean flags and listeners, and skips null children", () => {
    let clicks = 0;
    const el = h("button", { class: "btn", text: "go", "aria-busy": true, hidden: false, "data-x": "1", onclick: () => clicks++ }, null, false, "tail", h("b", { text: "!" }));
    expect(el.className).toBe("btn");
    expect(el.hasAttribute("aria-busy")).toBe(true);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.dataset.x).toBe("1");
    expect(el.textContent).toBe("gotail!");
    el.click();
    expect(clicks).toBe(1);
  });
  it("writes style via cssText and flattens nested child arrays", () => {
    const el = h("div", { style: "color: red" }, [["a"], "b"]);
    expect(el.style.color).toBe("red");
    expect(el.textContent).toBe("ab");
  });
});

describe("s", () => {
  it("creates namespaced SVG elements with attributes and listeners", () => {
    let n = 0;
    const el = s("circle", { r: 4, hidden: true, text: "x", onclick: () => n++ }, "y");
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.getAttribute("r")).toBe("4");
    expect(el.getAttribute("hidden")).toBe("");
    el.dispatchEvent(new Event("click"));
    expect(n).toBe(1);
  });
});

describe("clear", () => {
  it("empties an element", () => {
    const el = h("div", {}, "a", h("span"));
    clear(el);
    expect(el.childNodes.length).toBe(0);
  });
});

describe("formatting", () => {
  it("fmtDate returns a dash for nothing and a localized string otherwise", () => {
    expect(fmtDate(0)).toBe("—");
    expect(fmtDate(86400 * 200, "en")).toMatch(/1970/);
  });
  it("fmtAgo picks the unit by distance", () => {
    const now = Date.now() / 1000;
    expect(fmtAgo(0)).toBe("—");
    expect(fmtAgo(now - 10, "en")).toMatch(/second/);
    expect(fmtAgo(now - 300, "en")).toMatch(/minute/);
    expect(fmtAgo(now - 7200, "en")).toMatch(/hour/);
    expect(fmtAgo(now - 3 * 86400, "en")).toMatch(/day/);
  });
});
