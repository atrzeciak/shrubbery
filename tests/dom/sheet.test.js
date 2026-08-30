import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { openSheet, closeSheet } from "../../public/app/sheet.js";
import { h } from "../../public/app/dom.js";
import { lang, q, qa } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => closeSheet());

const key = (key, shiftKey = false) => {
  const ev = new KeyboardEvent("keydown", { key, shiftKey, cancelable: true, bubbles: true });
  document.dispatchEvent(ev);
  return ev;
};

describe("openSheet", () => {
  it("shows a labelled dialog with the content, marks the body, and focuses the close button", () => {
    openSheet(h("p", { text: "hello" }), "Ann");
    const dlg = q('[role="dialog"]');
    expect(dlg.getAttribute("aria-label")).toBe("Ann");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.className).toBe("sheet");
    expect(dlg.textContent).toContain("hello");
    expect(document.body.classList.contains("sheet-open")).toBe(true);
    expect(document.activeElement).toBe(q(".sheet-close"));
    expect(q(".sheet-close").getAttribute("aria-label")).toBe("Zamknij");
  });
  it("covers the page when asked to be full, and replaces an earlier sheet", () => {
    openSheet(h("p"), "one");
    openSheet(h("p"), "two", { full: true });
    expect(qa('[role="dialog"]').length).toBe(1);
    expect(q('[role="dialog"]').className).toBe("sheet full");
  });
  it("calls onClose when the user closes it with × or Escape, but not when the app closes it", () => {
    const onClose = vi.fn();
    openSheet(h("p"), "x", { onClose });
    q(".sheet-close").click();
    expect(q('[role="dialog"]')).toBeNull();
    expect(document.body.classList.contains("sheet-open")).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    openSheet(h("p"), "x", { onClose });
    key("Escape");
    expect(q('[role="dialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);

    openSheet(h("p"), "x", { onClose });
    closeSheet();
    expect(onClose).toHaveBeenCalledTimes(2);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);

    openSheet(h("p"), "x");
    key("a");
    expect(q('[role="dialog"]')).not.toBeNull();
    q(".sheet-close").click();
    expect(q('[role="dialog"]')).toBeNull();
  });
  it("returns focus to whatever opened it, if that is still on the page", () => {
    const opener = h("button", { text: "open" });
    document.body.append(opener);
    opener.focus();
    openSheet(h("p"), "x");
    closeSheet();
    expect(document.activeElement).toBe(opener);

    opener.focus();
    openSheet(h("p"), "x");
    opener.remove();
    closeSheet();
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("focus trap", () => {
  it("wraps Tab from the last control to the first and Shift+Tab from the first to the last", () => {
    const a = h("input"), b = h("button", { text: "b" });
    openSheet(h("div", {}, a, b), "x");
    const close = q(".sheet-close");
    b.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    close.focus();
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
  });
  it("lets Tab move between controls inside the sheet", () => {
    const a = h("input"), b = h("button", { text: "b" });
    openSheet(h("div", {}, a, b), "x");
    a.focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(key("Tab", true).defaultPrevented).toBe(false);
  });
  it("pulls focus back in when it has wandered out of the sheet", () => {
    const outside = h("button", { text: "out" });
    document.body.append(outside);
    const a = h("input");
    openSheet(h("div", {}, a), "x");
    outside.focus();
    key("Tab");
    expect(document.activeElement).toBe(q(".sheet-close"));
    outside.focus();
    key("Tab", true);
    expect(document.activeElement).toBe(a);
  });
  it("ignores Tab when nothing in the sheet can take focus", () => {
    openSheet(h("p"), "x");
    q(".sheet-close").disabled = true;
    expect(key("Tab").defaultPrevented).toBe(false);
  });
});
