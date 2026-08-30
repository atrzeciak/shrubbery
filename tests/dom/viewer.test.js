import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { openViewer } from "../../public/app/viewer.js";
import { lang, q, qa } from "./helpers.js";

const items = [
  { src: "/api/media/a", caption: "Wedding", year: 1950 },
  { src: "/api/media/b", caption: null, year: 1960 },
  { src: "/api/media/c", caption: "Picnic", year: null },
];
let back;
beforeAll(() => lang("pl"));
beforeEach(() => { vi.spyOn(history, "pushState").mockImplementation(() => {}); back = vi.spyOn(history, "back").mockImplementation(() => {}); });
// Viewers listen on the document, which outlives the test's body; close whatever is left.
afterEach(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); vi.restoreAllMocks(); });

const key = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key }));
const pointer = (el, type, clientX) => el.dispatchEvent(new PointerEvent(type, { clientX, bubbles: true }));

describe("openViewer", () => {
  it("shows the chosen photo with its caption and year, and pushes a history entry", () => {
    openViewer(items, 0);
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/a");
    expect(q(".viewer-caption").textContent).toBe("Wedding · 1950");
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Podgląd zdjęcia");
    expect(history.pushState).toHaveBeenCalledWith({ viewer: true }, "", location.href);
  });
  it("moves with the arrow keys and buttons, wrapping at both ends", () => {
    openViewer(items, 0);
    key("ArrowLeft");
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/c");
    expect(q(".viewer-caption").textContent).toBe("Picnic");
    key("ArrowRight");
    key("ArrowRight");
    expect(q(".viewer-caption").textContent).toBe("1960");
    q('[aria-label="Następne"]').click();
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/c");
    q('[aria-label="Poprzednie"]').click();
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/b");
  });
  it("offers no previous/next buttons for a single photo", () => {
    openViewer([items[0]]);
    expect(qa(".viewer-btn").length).toBe(1);
  });
  it("closes on Escape, ×, or a tap on the backdrop, consuming the history entry", () => {
    openViewer(items);
    key("Escape");
    expect(q(".viewer")).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
    key("Escape");
    expect(back).toHaveBeenCalledTimes(1);

    openViewer(items);
    q('[aria-label="Zamknij"]').click();
    expect(q(".viewer")).toBeNull();

    const el = openViewer(items);
    q(".viewer-img").click();
    expect(q(".viewer")).not.toBeNull();
    el.click();
    expect(q(".viewer")).toBeNull();
    expect(back).toHaveBeenCalledTimes(3);
  });
  it("closes on the back button without going back again", () => {
    openViewer(items);
    window.dispatchEvent(new Event("popstate"));
    expect(q(".viewer")).toBeNull();
    expect(back).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("popstate"));
    expect(back).not.toHaveBeenCalled();
  });
  it("swipes between photos and does not treat the swipe's click as a close", () => {
    const el = openViewer(items, 0);
    pointer(el, "pointerdown", 200);
    pointer(el, "pointerup", 100);
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/b");
    el.click();
    expect(q(".viewer")).not.toBeNull();

    pointer(el, "pointerdown", 100);
    pointer(el, "pointerup", 200);
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/a");

    // A short move is a tap: no navigation, and the click that follows closes.
    pointer(el, "pointerdown", 100);
    pointer(el, "pointerup", 110);
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/a");
    el.click();
    expect(q(".viewer")).toBeNull();
  });
  it("ignores a pointerup that had no pointerdown", () => {
    const el = openViewer(items, 0);
    pointer(el, "pointerup", 500);
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/a");
  });
});
