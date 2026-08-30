import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { mediaGallery } from "../../public/app/media-gallery.js";
import { mockApi, appCtx, lang, q, qa, tick } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => { vi.restoreAllMocks(); delete globalThis.confirm; });

const people = [{ id: "p1", display_name: "Anna Kowal" }, { id: "p2", display_name: "Jan Nowak" }];
const media = [
  { id: "m1", kind: "photo", caption: "Wedding", year: 1950, has_thumb: 1, uploaded_by: "acc1", owner_person_id: "p1", people: ["p2"] },
  { id: "m2", kind: "photo", caption: null, year: null, has_thumb: 0, uploaded_by: "other", owner_person_id: "p1", people: [] },
  { id: "m3", kind: "document", caption: null, year: 1910, uploaded_by: "acc1", owner_person_id: "p1" },
  { id: "m4", kind: "document", caption: "Deed", year: null, uploaded_by: "other", owner_person_id: "p1" },
];
const gallery = (media, counts = { used: media.length, cap: 6 }) => ({ "GET /api/people/p1/media": { media, counts } });
const mount = async (opts, ctx = appCtx()) => { document.body.append(await mediaGallery("p1", ctx, opts)); return ctx; };

describe("mediaGallery", () => {
  it("explains when the files cannot be loaded", async () => {
    mockApi({});
    await mount();
    expect(q(".media-gallery").textContent).toBe("Nie udało się wczytać plików.");
  });
  it("says so when there is nothing, and shows the count against the cap", async () => {
    mockApi(gallery([], { used: 0, cap: 6 }));
    await mount();
    expect(q(".media-head").textContent).toContain("0/6");
    expect(q(".media-gallery p").textContent).toBe("Brak plików.");
    expect(q(".media-upload")).toBeNull();
  });
  it("shows photos by their thumbnail when there is one and opens the viewer on tap", async () => {
    mockApi(gallery(media));
    vi.spyOn(history, "pushState").mockImplementation(() => {});
    await mount();
    const thumbs = qa(".media-thumb");
    expect(thumbs.map((i) => i.getAttribute("src"))).toEqual(["/api/media/m1/thumb", "/api/media/m2"]);
    expect(thumbs[0].getAttribute("alt")).toBe("Wedding");
    expect(qa("figcaption").map((c) => c.textContent)).toEqual(["Wedding · 1950", "bez podpisu"]);
    thumbs[1].click();
    expect(q(".viewer-img").getAttribute("src")).toBe("/api/media/m2");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  it("lists documents by caption or a generic name, with the year when known", async () => {
    mockApi(gallery(media));
    await mount();
    const rows = qa(".media-docs li");
    expect(rows.map((r) => r.querySelector("a").textContent)).toEqual(["dokument", "Deed"]);
    expect(rows[0].querySelector("a").getAttribute("href")).toBe("/api/media/m3");
    expect(rows[0].querySelector(".small").textContent).toBe("1910");
    expect(rows[1].querySelector(".small")).toBeNull();
    expect(qa(".media-actions").length).toBe(0);
  });
  it("lets a member delete only their own uploads, after confirming", async () => {
    const calls = mockApi({ ...gallery(media), "DELETE /api/media/m1": {} });
    globalThis.confirm = vi.fn(() => false);
    await mount({ editable: true });
    const dels = qa(".media-actions .danger");
    expect(dels.length).toBe(2);
    expect(qa(".media-actions .link-btn:not(.danger)").length).toBe(0);
    dels[0].click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE").length).toBe(0);
    globalThis.confirm = () => true;
    dels[0].click();
    await tick();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /api/media/m1");
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });
  it("toasts when a delete fails", async () => {
    mockApi({ ...gallery(media), "DELETE /api/media/m1": { status: 403, body: { error: "forbidden" } } });
    globalThis.confirm = () => true;
    const ctx = await mount({ editable: true });
    q(".media-actions .danger").click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("forbidden");
  });
  it("offers the upload form under the cap and a notice at it", async () => {
    mockApi(gallery(media, { used: 4, cap: 6 }));
    await mount({ editable: true });
    expect(q(".media-upload")).not.toBeNull();
    document.body.innerHTML = "";
    mockApi(gallery(media, { used: 6, cap: 6 }));
    await mount({ editable: true });
    expect(q(".media-upload")).toBeNull();
    expect(q(".media-gallery > p.small").textContent).toContain("limit");
  });
  it("gives an admin an edit panel per file, toggled from the actions row", async () => {
    mockApi(gallery(media));
    await mount({ editable: true, admin: true, people }, appCtx({ role: "admin", id: "admin1" }));
    expect(qa(".media-actions .danger").length).toBe(4);
    const toggle = q(".media-actions .link-btn");
    const panel = q(".media-file-edit");
    expect(panel.hidden).toBe(true);
    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.querySelector('input[type="text"]').value).toBe("Wedding");
    expect(panel.querySelector("select").value).toBe("p1");
    const boxes = qa('input[type="checkbox"]', panel);
    expect(boxes.map((b) => b.dataset.personId)).toEqual(["p2"]);
    expect(boxes[0].checked).toBe(true);
  });
  it("saves caption, year, owner and tags, then reloads", async () => {
    const calls = mockApi({ ...gallery(media), "PATCH /api/media/m2": {} });
    const ctx = await mount({ editable: true, admin: true, people }, appCtx({ role: "admin" }));
    const panel = qa(".media-file-edit")[1];
    panel.querySelector('input[type="text"]').value = "  Picnic ";
    panel.querySelector('input[type="number"]').value = "1961";
    panel.querySelector("select").value = "p2";
    panel.querySelector('input[type="checkbox"]').checked = true;
    panel.querySelector(".btn").click();
    await tick();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.body).toEqual({ caption: "Picnic", year: 1961, owner_person_id: "p2", tags: ["p2"] });
    expect(ctx.toast).toHaveBeenCalledWith("Zapisano.");
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });
  it("sends nulls for a cleared caption and year, and re-enables Save when saving fails", async () => {
    const calls = mockApi({ ...gallery(media), "PATCH /api/media/m1": { status: 500, body: { error: "internal" } } });
    const ctx = await mount({ editable: true, admin: true, people }, appCtx({ role: "admin" }));
    const panel = q(".media-file-edit");
    panel.querySelector('input[type="text"]').value = " ";
    panel.querySelector('input[type="number"]').value = "";
    panel.querySelector('input[type="checkbox"]').checked = false;
    const save = panel.querySelector(".btn");
    save.click();
    expect(save.disabled).toBe(true);
    await tick();
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({ caption: null, year: null, owner_person_id: "p1", tags: [] });
    expect(ctx.toast).toHaveBeenCalledWith("internal");
    expect(save.disabled).toBe(false);
  });
});
