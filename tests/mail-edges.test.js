import { describe, expect, it } from "vitest";
import { sendAdminGranted, sendGatheringMail, sendJoinedNotice, sendOpsLetter } from "../src/mail.js";

// Every letter has a Polish and an English version; the English one is read by the relatives
// abroad and must say the same things, with the site's own name and address filled in.
async function captured(send) {
  let out;
  await send({ APP_ORIGIN: "https://example.org", EMAIL: { async send(m) { out = m; } } });
  return out;
}

describe("the English letters", () => {
  it("tells a new admin what they can do now", async () => {
    const m = await captured((env) => sendAdminGranted(env, "a@x.org", "en"));
    expect(m.subject).toBe("You are now an admin");
    expect(m.text).toContain("The Admin tab: https://example.org/app/admin");
    expect(m.text).not.toContain("{app}");
  });

  it("tells the admins who has just joined", async () => {
    const m = await captured((env) => sendJoinedNotice(env, "a@x.org", "en", "Anna L", "anna@x.org"));
    expect(m.subject).toBe("Anna L has joined");
    expect(m.text).toContain("Anna L (anna@x.org) signed in for the first time");
    expect(m.text).toContain("https://example.org/app/");
  });

  it("admits it does not know the domain date rather than leaving the line out", async () => {
    const at = Math.floor(Date.parse("2026-09-01T05:00:00Z") / 1000);
    const m = await captured((env) => sendOpsLetter(env, "a@x.org", "en", { at, admins: 2, warnings: ["domain_unknown"], domain_expires_at: null, card_expires_at: null, subscription_renews_at: null, backup_at: null }));
    expect(m.text).toContain("I do not know how long the domain example.org is paid up for");
  });

  it("says 'today' when a date falls on the day the letter goes out, in both languages", async () => {
    const at = Math.floor(Date.parse("2026-09-01T05:00:00Z") / 1000);
    const status = { at, admins: 2, warnings: [], domain_expires_at: at, card_expires_at: at, subscription_renews_at: at, backup_at: at };
    const en = await captured((env) => sendOpsLetter(env, "a@x.org", "en", status));
    expect(en.text).toContain("The domain example.org is paid up only until today, September 1, 2026.");
    expect(en.text).toContain("The Cloudflare subscription renews today, September 1, 2026.");
    expect(en.text).toContain("The last backup was downloaded today, September 1, 2026.");
    const pl = await captured((env) => sendOpsLetter(env, "a@x.org", "pl", status));
    expect(pl.text).toContain("Domena example.org jest opłacona tylko do dzisiaj, 1 września 2026.");
    expect(pl.text).toContain("Abonament w Cloudflare odnawia się dzisiaj, 1 września 2026.");
    expect(pl.text).toContain("Ostatnią kopię zapasową pobrano dzisiaj, 1 września 2026.");
  });

  it("speaks about the gathering in every tone it is sent in", async () => {
    const g = { on_date: "2027-06-12", place: "Ciechanowiec", note: "Bring the albums" };
    const subjects = {};
    for (const kind of ["announce", "nudge", "week", "day"]) {
      const m = await captured((env) => sendGatheringMail(env, "a@x.org", "en", g, kind, "Anna"));
      subjects[kind] = m.subject;
      expect(m.text).toContain("When: 2027-06-12");
      expect(m.text).toContain("Where: Ciechanowiec");
      expect(m.text).toContain("Bring the albums");
      expect(m.text).toContain("https://example.org/app/gathering");
      expect(m.text.trim().endsWith("Anna")).toBe(true);
    }
    expect(subjects).toEqual({ announce: "Family gathering — 2027-06-12", nudge: "Will you be coming?", week: "The family gathering is in a week", day: "The family gathering is today" });
    const bare = await captured((env) => sendGatheringMail(env, "a@x.org", "en", { on_date: "2027-06-12", place: null, note: null }, "announce"));
    expect(bare.text).not.toContain("Where:");
  });
});
