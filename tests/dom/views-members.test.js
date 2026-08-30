import { describe, it, expect, beforeEach } from "vitest";
import { render } from "../../public/app/views/members.js";
import { closeSheet } from "../../public/app/sheet.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, byText } from "./helpers.js";

const root = () => q("#root");
const people = [
  { id: "p1", display_name: "Anna Nowak", first_name: "Anna", last_name: "Nowak", nickname: "Ania", birth_date: "1990-06-15", residence: "Kraków", account_email: "anna@x.org", deceased: 0 },
  { id: "p2", display_name: "Jan Nowak", first_name: "Jan", last_name: "Nowak", birth_date: "1950-01-01", death_date: "2000-06-20", birth_place: "Lublin", deceased: 1 },
  { id: "p3", display_name: "Ewa Kowal", first_name: "Ewa", last_name: "Kowal", maiden_name: "Wiśniewska", deceased: 1, unverified: 0 },
  { id: "p4", display_name: "Ola Kowal", first_name: "Ola", last_name: "Kowal", birth_date: "~1975", unverified: 1, deceased: 0 },
];
const media = { media: [], counts: { used: 0, cap: 6 } };
const base = () => ({ "GET /api/people": { people }, "GET /api/people/p1/media": media, "GET /api/people/p2/media": media });
const names = () => qa("tbody tr").map((tr) => q("td span span", tr)?.firstChild.textContent).filter(Boolean);
const header = (text) => qa("th button").find((b) => b.textContent.startsWith(text));
const search = (text) => { q("#members-q").value = text; q("#members-q").dispatchEvent(new Event("input")); };

async function start(role = "family") {
  document.body.innerHTML = '<div id="root"></div>';
  const calls = mockApi(base());
  const ctx = viewCtx(meFixture({ account: { role } }));
  await render(root(), ctx);
  // The view remembers the search and the sort between renders; start every test from the default.
  search("");
  while (!qa("th button")[0].textContent.endsWith("▲")) qa("th button")[0].click();
  return { calls, ctx };
}

beforeEach(async () => { await lang("pl"); closeSheet(); });

describe("the table", () => {
  it("lists everyone by name with their years, places, logins and badges", async () => {
    await start();
    expect(q("h1").textContent).toBe("Członkowie rodziny");
    expect(names()).toEqual(["Anna Nowak", "Ewa Kowal", "Jan Nowak", "Ola Kowal"]);
    const cells = (i) => qa("td", qa("tbody tr")[i]).slice(1).map((td) => td.textContent);
    expect(cells(0)).toEqual(["1990-06-15", "", "Kraków", "anna@x.org"]);
    expect(cells(1)).toEqual(["", "†", "", ""]);
    expect(cells(2)).toEqual(["1950-01-01", "2000-06-20", "Lublin", ""]);
    expect(qa("tbody .badge").map((b) => b.textContent)).toEqual(["Nie ma już wśród nas", "Nie ma już wśród nas", "niepotwierdzone"]);
    expect(byText("button", "Dodaj osobę")).toBeNull();
  });

  it("finds people by nickname, maiden name, place or login, and says when nobody matches", async () => {
    await start();
    search("ania");
    expect(names()).toEqual(["Anna Nowak"]);
    search("wiśniewska");
    expect(names()).toEqual(["Ewa Kowal"]);
    search("lublin");
    expect(names()).toEqual(["Jan Nowak"]);
    search("nobody");
    expect(names()).toEqual([]);
    expect(q("tbody td").textContent).toBe("Nikogo nie znaleziono.");
    await lang("en");
    await start();
    search("nobody");
    expect(q("tbody td").textContent).toBe("Nobody found.");
  });

  it("sorts by any column, and again by the same column reverses it", async () => {
    await start();
    header("Ur.").click();
    expect(names()).toEqual(["Jan Nowak", "Ola Kowal", "Anna Nowak", "Ewa Kowal"]);
    expect(header("Ur.").textContent).toBe("Ur. ▲");
    header("Ur.").click();
    expect(names()).toEqual(["Ewa Kowal", "Anna Nowak", "Ola Kowal", "Jan Nowak"]);
    expect(header("Ur.").textContent).toBe("Ur. ▼");
    header("Zm.").click();
    expect(names()).toEqual(["Jan Nowak", "Ewa Kowal", "Anna Nowak", "Ola Kowal"]);
    header("Miejsce").click();
    expect(names().slice(2)).toEqual(["Kraków", "Lublin"].map((pl) => people.find((p) => (p.residence || p.birth_place) === pl).display_name));
    header("Login").click();
    expect(names().at(-1)).toBe("Anna Nowak");
  });
});

describe("opening a person", () => {
  it("opens the card on click, Enter or Space, but not on other keys", async () => {
    await start();
    const row = qa("tbody tr")[2];
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(q('[role="dialog"]')).toBeNull();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await tick();
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Jan Nowak");
    closeSheet();
    qa("tbody tr")[0].dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Anna Nowak");
    closeSheet();
    qa("tbody tr")[2].click();
    expect(q('[role="dialog"]').getAttribute("aria-label")).toBe("Jan Nowak");
  });
});

describe("as an admin", () => {
  it("offers to add a person and opens the editor", async () => {
    await start("admin");
    const add = byText("button", "Dodaj osobę");
    expect(add).not.toBeNull();
    add.click();
    await tick();
    expect(q('[role="dialog"] h2').textContent).toBe("Nowa osoba");
  });
});
