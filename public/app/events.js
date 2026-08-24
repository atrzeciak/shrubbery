export const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const fullDate = (d) => typeof d === "string" && FULL_DATE_RE.test(d);

export const plural = (n, lang, forms) => forms[new Intl.PluralRules(lang).select(n)] || forms.other;

// The calendar date at a given zone. The site has exactly one, because a birthday must turn over on
// the family's midnight and read the same for every relative, wherever they open the page from.
export function today(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

function occurrence(dateStr, year) {
  const m = dateStr.slice(5, 7);
  let d = dateStr.slice(8, 10);
  if (m === "02" && d === "29" && !isLeap(year)) d = "28";
  return `${year}-${m}-${d}`;
}

// All birthdays (living people) and death anniversaries falling within [today, today + days],
// for people with full dates only. `years` is the age being turned / the anniversary number.
export function upcoming(people, today, days = 30) {
  const out = [];
  const todayYear = +today.slice(0, 4);
  const consider = (p, type, dateStr) => {
    for (const year of [todayYear, todayYear + 1]) {
      const years = year - +dateStr.slice(0, 4);
      if (years < 1) continue;
      const when = occurrence(dateStr, year);
      const inDays = Math.round((toUTC(when) - toUTC(today)) / 86400000);
      if (inDays >= 0 && inDays <= days) { out.push({ person_id: p.id, type, date: dateStr, when, inDays, years }); return; }
    }
  };
  for (const p of people) {
    if (!p.deceased && !p.death_date && fullDate(p.birth_date)) consider(p, "birthday", p.birth_date);
    if (fullDate(p.death_date)) consider(p, "death", p.death_date);
  }
  return out.sort((a, b) => a.inDays - b.inDays || String(a.person_id).localeCompare(String(b.person_id)));
}
