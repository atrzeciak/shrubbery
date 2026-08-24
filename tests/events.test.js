import { describe, it, expect } from "vitest";
import { fullDate, today, upcoming, plural } from "../public/app/events.js";
import { siteTz } from "../src/api/common.js";

const P = (id, birth_date = null, death_date = null, deceased = 0) => ({ id, birth_date, death_date, deceased });

describe("fullDate", () => {
  it("accepts only YYYY-MM-DD", () => {
    expect(fullDate("1964-10-04")).toBe(true);
    for (const bad of ["1964", "1964-10", "~1964", "1964-10-4", null, undefined, 1964]) expect(fullDate(bad), String(bad)).toBe(false);
  });
});

describe("today", () => {
  it("formats in the zone it is given", () => {
    expect(today(new Date("2026-06-15T05:00:00Z"), "Europe/Warsaw")).toBe("2026-06-15");
    // 23:30 UTC on Dec 31 is already Jan 1 in Warsaw (UTC+1)
    expect(today(new Date("2026-12-31T23:30:00Z"), "Europe/Warsaw")).toBe("2027-01-01");
  });

  it("answers differently for a different zone, which is the whole point of the argument", () => {
    const at = new Date("2026-12-31T23:30:00Z");
    expect(today(at, "UTC")).toBe("2026-12-31");
    expect(today(at, "America/Chicago")).toBe("2026-12-31");
    expect(today(at, "Europe/Warsaw")).toBe("2027-01-01");
  });
});

describe("upcoming", () => {
  const today = "2026-06-15";
  it("finds birthdays and death anniversaries in the window with inDays/years", () => {
    const out = upcoming([P("a", "1960-06-22"), P("b", "1941-01-05", "2014-06-15", 1), P("c", "1990-07-20")], today, 30);
    expect(out).toEqual([
      { person_id: "b", type: "death", date: "2014-06-15", when: "2026-06-15", inDays: 0, years: 12 },
      { person_id: "a", type: "birthday", date: "1960-06-22", when: "2026-06-22", inDays: 7, years: 66 },
    ]);
  });
  it("skips partial dates, deceased birthdays, and out-of-window events", () => {
    expect(upcoming([P("a", "1960"), P("b", "~1950-06-20"), P("c", "1960-06-20", null, 1), P("d", "1960-05-01")], today, 30)).toEqual([]);
  });
  it("wraps the year boundary", () => {
    const out = upcoming([P("a", "1980-01-03")], "2026-12-28", 30);
    expect(out).toEqual([{ person_id: "a", type: "birthday", date: "1980-01-03", when: "2027-01-03", inDays: 6, years: 47 }]);
  });
  it("Feb 29 fires on Feb 28 in non-leap years and Feb 29 in leap years", () => {
    expect(upcoming([P("a", "2000-02-29")], "2026-02-20", 30)[0]).toMatchObject({ when: "2026-02-28", inDays: 8, years: 26 });
    expect(upcoming([P("a", "2000-02-29")], "2028-02-20", 30)[0]).toMatchObject({ when: "2028-02-29", inDays: 9, years: 28 });
  });
  it("never yields years === 0", () => {
    expect(upcoming([P("baby", "2026-06-20")], today, 30)).toEqual([]);
  });
  it("skips the birthday when a death_date is set even without deceased=1", () => {
    expect(upcoming([P("x", "1960-06-20", "2020-06-20", 0)], today, 30)).toEqual([
      { person_id: "x", type: "death", date: "2020-06-20", when: "2026-06-20", inDays: 5, years: 6 },
    ]);
  });
});

describe("plural", () => {
  const forms = { one: "one", few: "few", many: "many", other: "other" };
  it("selects the right Polish category", () => {
    expect(plural(1, "pl", forms)).toBe("one");
    expect(plural(22, "pl", forms)).toBe("few");
    expect(plural(25, "pl", forms)).toBe("many");
  });
  it("selects the right English category", () => {
    expect(plural(1, "en", forms)).toBe("one");
    expect(plural(2, "en", forms)).toBe("other");
  });
});

describe("siteTz", () => {
  it("falls back to UTC rather than to anybody's country", () => {
    expect(siteTz({})).toBe("UTC");
    expect(siteTz({ SITE_TZ: "Europe/Warsaw" })).toBe("Europe/Warsaw");
  });
});
