import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { personCard } from "../../public/app/person-card.js";
import { buildGraph } from "../../public/app/graph.js";
import { closeSheet } from "../../public/app/sheet.js";
import { mockApi, appCtx, lang, q, qa, tick, byText, stubCanvas, pickFile } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => closeSheet());

const people = [
  { id: "p1", first_name: "Anna", last_name: "Kowal", display_name: "Anna Kowal", nickname: "Ania", birth_date: "1950-03-04", birth_place: "Kraków", residence: "Gdańsk", phone: "123", email: "a@x.org", notes: "line1\nline2", account_email: "anna@x.org" },
  { id: "p2", display_name: "Jan Kowal", birth_date: "1948", deceased: 1, death_date: null, phone: "999", email: "j@x.org" },
  { id: "p3", display_name: "Ola Kowal", birth_date: "1975-01-01", unverified: 1 },
  { id: "p4", display_name: "Ewa Kowal", birth_date: "1978", deceased: 1, death_date: "2000-01-01", death_place: "Łódź" },
  { id: "p5", display_name: "Maria Nowak" },
];
const data = {
  people,
  parents: [{ parent_id: "p1", child_id: "p3" }, { parent_id: "p2", child_id: "p3" }, { parent_id: "p1", child_id: "p4" }, { parent_id: "p5", child_id: "p1" }],
  partners: [{ a_id: "p1", b_id: "p2", kind: "married", start_year: 1970, end_year: null }, { a_id: "p4", b_id: "p5", kind: "partner", start_year: null, end_year: null }],
  links: [{ person_id: "p1", kind: "instagram", label: "ig", url: "https://i.example/a" }, { person_id: "p1", kind: "other", label: null, url: "https://x.example/" }],
  avatars: [],
};
const g = buildGraph(data);
const rows = () => Object.fromEntries(qa(".kv").map((r) => [r.firstChild.textContent.replace(": ", ""), r]));
const mediaRoutes = { "GET /api/people/p1/media": { media: [], counts: { used: 0, cap: 6 } }, "GET /api/people/p2/media": { media: [], counts: { used: 0, cap: 6 } } };

describe("personCard", () => {
  it("shows the living person's details, contacts, relatives, links and notes, with the login address as the e-mail", async () => {
    mockApi(mediaRoutes);
    const onPerson = vi.fn();
    document.body.append(personCard(g, "p1", appCtx(), { onPerson }));
    await tick();
    expect(q("h2").textContent).toBe("Anna Kowal");
    expect(q(".row .muted").textContent).toBe("„Ania”");
    expect(q(".badge")).toBeNull();
    const r = rows();
    expect(r["Urodzony(a)"].textContent).toContain("1950-03-04, Kraków");
    expect(r["Zmarł(a)"]).toBeUndefined();
    expect(r.Telefon.querySelector("a").getAttribute("href")).toBe("tel:123");
    expect(r["E-mail"].querySelector("a").getAttribute("href")).toBe("mailto:anna@x.org");
    const links = qa("a", r.Profile);
    expect(links.map((a) => a.textContent)).toEqual(["ig", "Strona"]);
    expect(links[0].getAttribute("rel")).toBe("noopener");
    expect(qa("button", r.Rodzice).map((b) => b.textContent)).toEqual(["Maria Nowak"]);
    expect(qa("button", r.Partnerzy).map((b) => b.textContent)).toEqual(["Jan Kowal (małżeństwo 1970)"]);
    expect(qa("button", r.Dzieci).map((b) => b.textContent)).toEqual(["Ola Kowal", "Ewa Kowal"]);
    expect(r["Rodzeństwo"]).toBeUndefined();
    expect(q(".notes .prewrap").textContent).toBe("line1\nline2");
    expect(r.Konto).toBeUndefined();
    expect(q(".media-gallery")).not.toBeNull();
    qa("button", r.Dzieci)[1].click();
    expect(onPerson).toHaveBeenCalledWith("p4");
  });
  it("marks the dead, hides their phone and e-mail, and shows a cross when the death is undated", () => {
    mockApi(mediaRoutes);
    document.body.append(personCard(g, "p2", appCtx(), { onPerson: vi.fn() }));
    expect(q(".badge").textContent).toBe("Nie ma już wśród nas");
    const r = rows();
    expect(r["Zmarł(a)"].textContent).toBe("Zmarł(a): †");
    expect(r.Telefon).toBeUndefined();
    expect(r["E-mail"]).toBeUndefined();
    expect(qa("button", r.Partnerzy).map((b) => b.textContent)).toEqual(["Anna Kowal (małżeństwo 1970)"]);
  });
  it("shows where and when the death was, and siblings through a shared parent", () => {
    mockApi({});
    document.body.append(personCard(g, "p4", appCtx(), { onPerson: vi.fn() }));
    const r = rows();
    expect(r["Zmarł(a)"].textContent).toContain("2000-01-01, Łódź");
    expect(qa("button", r["Rodzeństwo"]).map((b) => b.textContent)).toEqual(["Ola Kowal"]);
    expect(qa("button", r.Partnerzy).map((b) => b.textContent)).toEqual(["Maria Nowak (związek)"]);
    expect(q("h2 + .muted").textContent).toBe("1978–2000");
  });
  it("marks an unverified person and shows nothing for what is unknown", () => {
    mockApi({});
    document.body.append(personCard(g, "p3", appCtx(), { onPerson: vi.fn() }));
    expect(q(".badge").textContent).toBe("niepotwierdzone");
    const r = rows();
    expect(Object.keys(r)).toEqual(["Urodzony(a)", "Rodzice", "Rodzeństwo"]);
    expect(q(".notes")).toBeNull();
  });
  it("offers Edit only to the person themself or an admin", () => {
    mockApi({});
    document.body.append(personCard(g, "p1", appCtx(), { onPerson: vi.fn() }));
    expect(q(".person-card .btn")).toBeNull();
    document.body.innerHTML = "";
    const ctx = appCtx({ person_id: "p1" });
    document.body.append(personCard(g, "p1", ctx, { onPerson: vi.fn() }));
    q(".person-card .btn").click();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/me");
    document.body.innerHTML = "";
    const admin = appCtx({ role: "admin", person_id: "p1" });
    document.body.append(personCard(g, "p1", admin, { onPerson: vi.fn() }));
    q(".person-card .btn").click();
    expect(admin.navigate).toHaveBeenCalledWith("/app/me");
  });
  it("opens the editor for an admin looking at somebody else, and redraws when it closes", async () => {
    mockApi({ ...mediaRoutes, "GET /api/people": data });
    const admin = appCtx({ role: "admin", person_id: "p1" });
    document.body.append(personCard(g, "p2", admin, { onPerson: vi.fn() }));
    q(".person-card .btn").click();
    await tick();
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Jan Kowal");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(admin.navigate).toHaveBeenCalledWith(location.pathname, { replace: true });
  });
  it("gives a parent the upload form and the avatar picker for a child with no account", async () => {
    stubCanvas();
    const calls = mockApi({ "GET /api/people/p3/media": { media: [], counts: { used: 0, cap: 6 } }, "PUT /api/people/p3/avatar": {} });
    const ctx = appCtx({ person_id: "p1" });
    document.body.append(personCard(g, "p3", ctx, { onPerson: vi.fn() }));
    await tick();
    expect(q(".media-upload")).not.toBeNull();
    expect(q(".person-card > .row .btn")).toBeNull();
    pickFile(q("#avatar-file"), new File(["x"], "kid.jpg", { type: "image/jpeg" }));
    await tick();
    byText("button", "Zapisz zdjęcie").click();
    await tick();
    expect(calls.find((c) => c.method === "PUT").path).toBe("/api/people/p3/avatar");
    expect(ctx.toast).toHaveBeenCalledWith("Zdjęcie zapisane.");
    expect(ctx.navigate).toHaveBeenCalledWith(location.pathname, { replace: true });
  });
  it("shows a refusal to save the child's avatar inside the picker", async () => {
    stubCanvas();
    mockApi({ "GET /api/people/p3/media": { media: [], counts: { used: 0, cap: 6 } }, "PUT /api/people/p3/avatar": { status: 403, body: { error: "forbidden" } } });
    document.body.append(personCard(g, "p3", appCtx({ person_id: "p1" }), { onPerson: vi.fn() }));
    await tick();
    pickFile(q("#avatar-file"), new File(["x"], "kid.jpg", { type: "image/jpeg" }));
    await tick();
    byText("button", "Zapisz zdjęcie").click();
    await tick();
    expect(q(".avatar-picker .error").textContent).toBe("forbidden");
  });
  it("gives a parent nothing once the child has an account, and gives nothing to anyone else", async () => {
    const media = { "GET /api/people/p3/media": { media: [], counts: { used: 0, cap: 6 } } };
    const joined = buildGraph({ ...data, people: people.map((p) => (p.id === "p3" ? { ...p, account_id: "acc3" } : p)) });
    for (const [graph, account] of [[joined, { person_id: "p1" }], [g, { person_id: "p5" }], [g, {}], [g, { role: "admin", person_id: "p1" }]]) {
      document.body.innerHTML = "";
      mockApi(media);
      document.body.append(personCard(graph, "p3", appCtx(account), { onPerson: vi.fn() }));
      await tick();
      expect(q(".media-upload")).toBeNull();
      expect(q(".avatar-picker")).toBeNull();
    }
  });
});
