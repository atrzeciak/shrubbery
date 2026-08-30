import { describe, it, expect } from "vitest";
import { fullDate, plural, today, upcoming } from "../../public/app/events.js";

describe("fullDate", () => {
  it("accepts only a complete YYYY-MM-DD string", () => {
    expect(fullDate("1950-03-04")).toBe(true);
    expect(fullDate("1950-03")).toBe(false);
    expect(fullDate("~1950")).toBe(false);
    expect(fullDate(null)).toBe(false);
  });
});

describe("plural", () => {
  it("picks the form for the language, falling back to other", () => {
    const forms = { one: "rok", few: "lata", many: "lat", other: "roku" };
    expect(plural(1, "pl", forms)).toBe("rok");
    expect(plural(3, "pl", forms)).toBe("lata");
    expect(plural(11, "pl", forms)).toBe("lat");
    expect(plural(2, "en", { one: "year", other: "years" })).toBe("years");
    expect(plural(3, "pl", { one: "rok", other: "x" })).toBe("x");
  });
});

describe("today", () => {
  it("gives the calendar date at the family's zone, not the viewer's", () => {
    const late = new Date("2026-06-30T23:30:00Z");
    expect(today(late, "Europe/Warsaw")).toBe("2026-07-01");
    expect(today(late, "America/Los_Angeles")).toBe("2026-06-30");
  });
});

describe("upcoming", () => {
  const people = [
    { id: "a", birth_date: "1980-03-10" },
    { id: "b", birth_date: "1990-03-05", death_date: "2020-03-08" },
    { id: "c", birth_date: "1975-03-20", deceased: 1 },
    { id: "d", birth_date: "1975-03" },
    { id: "e", birth_date: "2026-03-05" },
    { id: "f", birth_date: "1960-02-29" },
  ];
  it("lists birthdays of the living and death anniversaries within the window, nearest first", () => {
    const out = upcoming(people, "2026-03-01", 30);
    expect(out.map((x) => `${x.person_id}:${x.type}:${x.inDays}:${x.years}`)).toEqual(["b:death:7:6", "a:birthday:9:46"]);
    expect(out[1].when).toBe("2026-03-10");
    expect(out[1].date).toBe("1980-03-10");
  });
  it("rolls over into next year and moves a leap-day birthday to the 28th", () => {
    const out = upcoming(people, "2027-02-20", 10);
    expect(out.map((x) => `${x.person_id}:${x.when}:${x.years}`)).toEqual(["f:2027-02-28:67"]);
    const roll = upcoming([{ id: "a", birth_date: "1980-01-02" }], "2026-12-30", 5);
    expect(roll[0].when).toBe("2027-01-02");
    expect(roll[0].inDays).toBe(3);
  });
  it("keeps the leap day itself in a leap year", () => {
    expect(upcoming([people[5]], "2028-02-20", 10)[0].when).toBe("2028-02-29");
  });
  it("skips a birthday that has already passed and one further out than the window", () => {
    expect(upcoming([people[0]], "2026-03-11", 30)).toEqual([]);
    expect(upcoming([people[0]], "2026-02-01", 30)).toEqual([]);
  });
  it("breaks ties by person id so the order is stable", () => {
    const tie = upcoming([{ id: "z", birth_date: "1980-03-10" }, { id: "a", birth_date: "1970-03-10" }], "2026-03-10");
    expect(tie.map((x) => x.person_id)).toEqual(["a", "z"]);
  });
});
