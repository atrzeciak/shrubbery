import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, sentence, sentenceNodes } from "../../public/app/views/news.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa } from "./helpers.js";

// Fixed clock: 15 June 2026, so Anna's birthday is today and Jan's anniversary is in five days.
const NOW = Date.parse("2026-06-15T12:00:00Z");
const graph = {
  people: [
    { id: "p1", display_name: "Anna Nowak", first_name: "Anna", last_name: "Nowak", birth_date: "1990-06-15", deceased: 0 },
    { id: "p2", display_name: "Jan Nowak", first_name: "Jan", last_name: "Nowak", birth_date: "1950-01-01", death_date: "2000-06-20", deceased: 1 },
    { id: "p3", display_name: "Ewa Nowak", first_name: "Ewa", last_name: "Nowak", birth_date: "1985-12-01", deceased: 0 },
  ],
};
const items = [
  { id: 40, at: 1000, action: "login", actor_person_id: "p1", actor_name: "Anna", target_type: "account", target_id: "acc1", details: {} },
  { id: 30, at: 900, action: "person_updated", actor_person_id: null, actor_name: "me@x.org", target_type: "person", target_id: "p2", details: { name: "Jan Nowak" } },
  { id: 20, at: 800, action: "invite_accepted", actor_person_id: null, actor_name: null, target_type: "account", target_id: "acc9", details: { email: "new@x.org" } },
  { id: 10, at: 700, action: "moon_landing", actor_person_id: null, actor_name: null, target_type: "account", target_id: "acc1", details: {} },
];
const base = () => ({ "GET /api/people": graph, "GET /api/gatherings": { gathering: null }, "GET /api/news": { items, next: null }, "PATCH /api/me": {} });
const root = () => q("#root");
const feed = () => qa("ul.card > li");

async function start(routes = base(), me = meFixture({ account: { news_seen_at: 850 } })) {
  document.body.innerHTML = '<div id="root"></div>';
  const calls = mockApi(routes);
  const ctx = viewCtx(me);
  await render(root(), ctx);
  await tick();
  return { calls, ctx };
}

beforeEach(async () => { await lang("pl"); vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
afterEach(() => vi.useRealTimers());

describe("sentence", () => {
  it("names the actor by address and name, and falls back to a generic line for an unknown action", () => {
    expect(sentence({ action: "login", actor_email: "a@x.org", actor_name: "Anna", details: {} })).toBe("a@x.org (Anna) zalogował(a) się");
    expect(sentence({ action: "login", actor_email: "a@x.org" })).toBe("a@x.org zalogował(a) się");
    expect(sentence({ action: "moon_landing", target_id: "t1" })).toBe("—: moon_landing");
  });
  it("links the actor and the person when there is a person to link to", () => {
    const text = (nodes) => nodes.map((n) => n.textContent).join("");
    const linked = sentenceNodes(items[0]);
    expect(linked[0].tagName).toBe("A");
    expect(linked[0].getAttribute("href")).toBe("/app/tree/p1");
    expect(text(linked)).toBe("Anna zalogował(a) się");
    const updated = sentenceNodes(items[1]);
    expect(updated[0].nodeType).toBe(Node.TEXT_NODE);
    expect(updated.find((n) => n.tagName === "A").getAttribute("href")).toBe("/app/tree/p2");
    expect(text(sentenceNodes(items[3]))).toBe("ktoś: moon_landing");
    expect(text(sentenceNodes({ action: "link_added", actor_name: "Anna", target_type: "person", target_id: "p2", details: { other_name: "Ola" } }))).toBe("Anna połączył(a)  i Ola");
    expect(text(sentenceNodes({ action: "role_changed", actor_name: "Anna", target_type: "account", target_id: "acc2", details: { role: "admin" } }))).toBe("Anna zmienił(a) rolę acc2 na admin");
    expect(text(sentenceNodes({ action: "lang_changed", actor_name: "Anna", target_type: "account", target_id: "acc2", details: { lang: "en" } }))).toBe("Anna zmienił(a) język na en");
  });
});

describe("the feed", () => {
  it("lists each entry, marks the ones since the last visit, and records the visit", async () => {
    const { calls, ctx } = await start();
    const rows = feed();
    expect(rows.map((li) => li.firstChild.textContent)).toEqual(["Anna zalogował(a) się", "me@x.org zaktualizował(a) dane: Jan Nowak", "new@x.org dołączył(a) do strony", "ktoś: moon_landing"]);
    expect(rows.map((li) => li.classList.contains("fresh"))).toEqual([true, true, false, false]);
    expect(q("button[hidden]")).not.toBeNull();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/me", body: { news_seen_at: Math.floor(NOW / 1000) } });
    expect(ctx.state.me.account.news_seen_at).toBe(Math.floor(NOW / 1000));
  });

  it("says so when there is nothing yet, in either language", async () => {
    await start({ ...base(), "GET /api/news": { items: [], next: null } });
    expect(feed()[0].textContent).toBe("Na razie cisza. Tu pojawią się nowe wpisy.");
    await lang("en");
    await start({ ...base(), "GET /api/news": { items: [], next: null } });
    expect(feed()[0].textContent).toBe("Quiet for now. New entries will appear here.");
  });

  it("offers older entries page by page and toasts when a page fails", async () => {
    const { calls, ctx } = await start({ ...base(), "GET /api/news": (body, path) => (path.includes("before=") ? { items: [items[3]], next: null } : { items: items.slice(0, 1), next: 40 }) });
    const more = q("button.btn");
    expect(more.hidden).toBe(false);
    more.click();
    await tick();
    expect(calls.filter((c) => c.path.startsWith("/api/news")).map((c) => c.path)).toEqual(["/api/news", "/api/news?before=40"]);
    expect(feed().map((li) => li.firstChild.textContent)).toEqual(["Anna zalogował(a) się", "ktoś: moon_landing"]);
    expect(more.hidden).toBe(true);
    mockApi({});
    more.click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("not_found");
  });

  it("still renders when the news visit cannot be recorded", async () => {
    const { ctx } = await start({ ...base(), "PATCH /api/me": { status: 500, body: { error: "internal" } } });
    expect(feed().length).toBe(4);
    expect(ctx.state.me.account.news_seen_at).toBe(850);
  });

  it("treats everything as new on a first visit", async () => {
    await start(base(), meFixture());
    expect(feed().every((li) => li.classList.contains("fresh"))).toBe(true);
  });
});

describe("the upcoming box", () => {
  const box = () => q(".upcoming");
  it("shows the birthday today and the anniversary within thirty days, linked to the person", async () => {
    await start();
    const rows = qa("li", box());
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("today")).toBe(true);
    expect(rows[0].textContent).toContain("Anna Nowak");
    expect(rows[0].textContent).toContain("36");
    expect(rows[0].textContent).toContain("dzisiaj");
    expect(q("a", rows[0]).getAttribute("href")).toBe("/app/tree/p1");
    expect(rows[1].classList.contains("today")).toBe(false);
    expect(rows[1].textContent).toContain("Jan Nowak");
    expect(rows[1].textContent).toContain("26");
    expect(rows[1].textContent).toContain("20 czerwca");
  });

  it("puts a future gathering first, and a gathering today reads as today", async () => {
    await start({ ...base(), "GET /api/gatherings": { gathering: { on_date: "2026-08-01", cancelled_at: null } } });
    const first = q("li", box());
    expect(q("a", first).getAttribute("href")).toBe("/app/gathering");
    expect(first.textContent).toContain("1 sierpnia 2026");
    expect(first.classList.contains("today")).toBe(false);
    await lang("en");
    await start({ ...base(), "GET /api/gatherings": { gathering: { on_date: "2026-06-15", cancelled_at: null } } });
    expect(q("li", box()).textContent).toContain("family gathering, today");
    expect(q("li", box()).classList.contains("today")).toBe(true);
  });

  it("ignores a cancelled or past gathering", async () => {
    await start({ ...base(), "GET /api/gatherings": { gathering: { on_date: "2026-08-01", cancelled_at: 5 } } });
    expect(qa("li", box()).length).toBe(2);
    await start({ ...base(), "GET /api/gatherings": { gathering: { on_date: "2026-06-01", cancelled_at: null } } });
    expect(qa("li", box()).length).toBe(2);
  });

  it("is left out when nothing is coming, and its failures never take the feed down", async () => {
    await start({ ...base(), "GET /api/people": { people: [graph.people[2]] }, "GET /api/gatherings": { status: 500, body: { error: "internal" } } });
    expect(box()).toBeNull();
    expect(feed().length).toBe(4);
    await start({ ...base(), "GET /api/people": { status: 500, body: { error: "internal" } } });
    expect(box()).toBeNull();
    expect(feed().length).toBe(4);
  });
});
