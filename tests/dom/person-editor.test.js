import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { openPersonEditor } from "../../public/app/person-editor.js";
import { closeSheet } from "../../public/app/sheet.js";
import { mockApi, appCtx, lang, q, qa, tick, stubCanvas, pickFile } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => { closeSheet(); vi.restoreAllMocks(); delete globalThis.confirm; });

const people = [
  { id: "p1", first_name: "Anna", last_name: "Kowal", display_name: "Anna Kowal", birth_date: "1950-03-04" },
  { id: "p2", display_name: "Jan Kowal", birth_date: "1948", deceased: 1 },
  { id: "p3", display_name: "Ola Kowal" },
  { id: "p4", display_name: "Adam Nowak" },
];
const data = () => ({
  people,
  parents: [{ parent_id: "p2", child_id: "p1" }],
  partners: [{ a_id: "p1", b_id: "p4", kind: "partner", start_year: 1990, end_year: 1995 }],
  links: [],
  avatars: [{ person_id: "p1", updated_at: 5 }],
});
const empty = { media: [], counts: { used: 0, cap: 6 } };
const routes = (extra = {}) => ({ "GET /api/people": data(), "GET /api/people/p1/media": empty, ...extra });
const cards = () => Object.fromEntries(qa(".editor > .card").filter((c) => c.querySelector("h2")).map((c) => [c.querySelector("h2").textContent, c]));
const open = async (id, ctx = appCtx({ role: "admin" }), onDone = vi.fn()) => { await openPersonEditor(id, ctx, { onDone }); return { ctx, onDone }; };

describe("openPersonEditor", () => {
  it("opens a full sheet for a new person with only the form", async () => {
    mockApi(routes());
    const { onDone } = await open(null);
    const dlg = q('[role="dialog"]');
    expect(dlg.className).toBe("sheet full");
    expect(dlg.getAttribute("aria-label")).toBe("Nowa osoba");
    expect(q(".editor h2").textContent).toBe("Nowa osoba");
    expect(q(".avatar-picker")).toBeNull();
    expect(qa(".editor > .card").length).toBe(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it("can be opened with nothing to call back when it closes", async () => {
    mockApi(routes());
    await openPersonEditor(null, appCtx({ role: "admin" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(q('[role="dialog"]')).toBeNull();
  });
  it("creates the person on save and reopens on them", async () => {
    let created = false;
    const calls = mockApi(routes({
      "POST /api/admin/people": () => { created = true; return { id: "p9" }; },
      "GET /api/people": () => (created ? { ...data(), people: [...people, { id: "p9", display_name: "Nowa Osoba" }] } : data()),
      "GET /api/people/p9/media": empty,
    }));
    const { ctx } = await open(null);
    q("#pf-first_name").value = "Nowa";
    q("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    await tick();
    expect(calls.find((c) => c.method === "POST").body.first_name).toBe("Nowa");
    expect(ctx.toast).toHaveBeenCalledWith("Zapisano.");
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Nowa Osoba");
    expect(q(".avatar-picker")).not.toBeNull();
  });
  it("shows an existing person's form, photo, parents, partners, gallery and delete", async () => {
    mockApi(routes());
    await open("p1");
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Anna Kowal");
    expect(q("#pf-first_name").value).toBe("Anna");
    expect(q(".avatar-picker img").getAttribute("src")).toBe("/api/people/p1/avatar?v=5");
    const c = cards();
    expect(qa("li span", c.Rodzice).map((s) => s.textContent)).toEqual(["Jan Kowal"]);
    expect(qa("li span", c.Partnerzy).map((s) => s.textContent)).toEqual(["Adam Nowak · związek 1990–1995"]);
    // Everyone but the person themself, sorted, with their years.
    expect(qa("option", c.Rodzice.querySelector("select")).map((o) => o.textContent)).toEqual(["—", "Adam Nowak", "Jan Kowal 1948–†", "Ola Kowal"]);
    expect(q(".media-gallery")).not.toBeNull();
    expect(q(".media-upload")).not.toBeNull();
    expect(q(".editor > .row .danger").textContent).toBe("Usuń osobę");
  });
  it("patches on save and shows the failure inside the form", async () => {
    const calls = mockApi(routes({ "PATCH /api/admin/people/p1": { status: 422, body: { error: "invalid" } } }));
    await open("p1");
    q("form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(calls.find((c) => c.method === "PATCH").body.first_name).toBe("Anna");
    expect(q("form .error").textContent).toBe("invalid");
  });
  it("uploads a new photo and toasts, or rethrows the failure for the picker to show", async () => {
    stubCanvas();
    const calls = mockApi(routes({ "PUT /api/admin/people/p1/avatar": { status: 413, body: { error: "too_large" } } }));
    const { ctx } = await open("p1");
    pickFile(q("#avatar-file"), new File(["x"], "a.jpg", { type: "image/jpeg" }));
    await tick();
    q(".avatar-picker .btn:not(.secondary)").click();
    await tick();
    expect(calls.find((c) => c.method === "PUT").body).toBeInstanceOf(Blob);
    expect(q(".avatar-picker .error").textContent).toBe("too_large");

    mockApi(routes({ "PUT /api/admin/people/p1/avatar": {} }));
    q(".avatar-picker .btn:not(.secondary)").click();
    await tick();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("Zdjęcie zapisane.");
  });
  it("adds and removes parents, ignoring Add with nobody chosen", async () => {
    const calls = mockApi(routes({ "POST /api/admin/people/p1/parents/p3": {}, "DELETE /api/admin/people/p1/parents/p2": {} }));
    await open("p1");
    let c = cards();
    c.Rodzice.querySelector(".secondary").click();
    await tick();
    expect(calls.filter((x) => x.method === "POST").length).toBe(0);
    c.Rodzice.querySelector("select").value = "p3";
    c.Rodzice.querySelector(".secondary").click();
    await tick();
    expect(calls.map((x) => `${x.method} ${x.path}`)).toContain("POST /api/admin/people/p1/parents/p3");
    expect(calls.filter((x) => x.path === "/api/people").length).toBe(2);
    c = cards();
    c.Rodzice.querySelector("li .danger").click();
    await tick();
    expect(calls.map((x) => `${x.method} ${x.path}`)).toContain("DELETE /api/admin/people/p1/parents/p2");
  });
  it("adds a partner with kind and years, removes one, and toasts when that fails", async () => {
    const calls = mockApi(routes({ "POST /api/admin/people/p1/partners/p3": {}, "DELETE /api/admin/people/p1/partners/p4": { status: 500, body: { error: "internal" } } }));
    const { ctx } = await open("p1");
    let c = cards();
    c.Partnerzy.querySelector(".secondary").click();
    await tick();
    expect(calls.filter((x) => x.method === "POST").length).toBe(0);
    qa("select", c.Partnerzy)[0].value = "p3";
    c.Partnerzy.querySelector(".secondary").click();
    await tick();
    expect(calls.find((x) => x.method === "POST")).toMatchObject({ path: "/api/admin/people/p1/partners/p3", body: { kind: "married", start_year: null, end_year: null } });
    c = cards();
    const [who, kind] = qa("select", c.Partnerzy);
    who.value = "p3"; kind.value = "divorced";
    const [y1, y2] = qa('input[type="number"]', c.Partnerzy);
    y1.value = "1980"; y2.value = "1985";
    c.Partnerzy.querySelector(".secondary").click();
    await tick();
    expect(calls.filter((x) => x.method === "POST")[1].body).toEqual({ kind: "divorced", start_year: 1980, end_year: 1985 });
    c = cards();
    c.Partnerzy.querySelector("li .danger").click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("internal");
  });
  it("deletes the person only after confirming, then closes and reports done", async () => {
    const calls = mockApi(routes({ "DELETE /api/admin/people/p1": {} }));
    globalThis.confirm = vi.fn(() => false);
    const { onDone } = await open("p1");
    q(".editor > .row .danger").click();
    await tick();
    expect(calls.filter((x) => x.method === "DELETE").length).toBe(0);
    globalThis.confirm = () => true;
    q(".editor > .row .danger").click();
    await tick();
    expect(calls.filter((x) => x.method === "DELETE").length).toBe(1);
    expect(q('[role="dialog"]')).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it("toasts when the delete is refused and keeps the editor open", async () => {
    mockApi(routes({ "DELETE /api/admin/people/p1": { status: 409, body: { error: "conflict" } } }));
    globalThis.confirm = () => true;
    const { ctx, onDone } = await open("p1");
    q(".editor > .row .danger").click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("conflict");
    expect(q('[role="dialog"]')).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
});
