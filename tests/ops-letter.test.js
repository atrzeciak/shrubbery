import { describe, expect, it } from "vitest";
import { sendOpsLetter } from "../src/mail.js";

const AT = Math.floor(Date.parse("2026-09-01T05:00:00Z") / 1000);
const DAY = 86400;

// A letter every admin actually reads, so these assert the words, not the plumbing.
async function letter(lang, status) {
  let out;
  await sendOpsLetter({ APP_ORIGIN: "https://example.org", EMAIL: { async send(m) { out = m; } } }, "adm@x.org", lang, { at: AT, admins: 2, warnings: [], ...status });
  return out;
}

const RENEWS = Date.parse("2027-04-02T00:00:00Z") / 1000;      // a renewal date, fixed by this test

const KNOWN = {
  domain_expires_at: RENEWS,
  card_expires_at: AT + 607 * DAY,
  subscription_renews_at: AT + 20 * DAY,
  backup_at: AT - 49 * DAY,
};

describe("the monthly letter", () => {
  it("never shows a reader a raw warning key", async () => {
    const warnings = ["checks_stale", "domain_unknown", "domain_soon", "card_soon", "backup_never", "backup_stale", "check_failing"];
    for (const lang of ["pl", "en"]) {
      const { text } = await letter(lang, { ...KNOWN, warnings });
      for (const w of warnings) expect(text, `${lang}/${w}`).not.toContain(w);
      // and every one of them still put a sentence in front of the reader
      expect(text.split("\n").filter((l) => l.trim()).length).toBeGreaterThan(warnings.length);
    }
  });

  it("refuses to call it all well while it knows nothing about the card or the subscription", async () => {
    // The default configuration: no CF_BILLING_TOKEN, so billing is simply unknown.
    const pl = await letter("pl", { ...KNOWN, card_expires_at: null, subscription_renews_at: null });
    expect(pl.subject).not.toContain("wszystko");
    expect(pl.text).toContain("Nie wiem, kiedy traci ważność karta");
    expect(pl.text).toContain("Nie wiem, kiedy odnawia się abonament");
    expect(pl.text).not.toContain("Wszystko jest opłacone");

    const en = await letter("en", { ...KNOWN, card_expires_at: null, subscription_renews_at: null });
    expect(en.subject).not.toMatch(/everything is paid up/i);
    expect(en.text).toContain("I do not know when the card at Cloudflare expires");
    expect(en.text).toContain("I do not know when the Cloudflare subscription renews");
  });

  it("says the domain date is missing rather than leaving the line out", async () => {
    const pl = await letter("pl", { ...KNOWN, domain_expires_at: null, warnings: ["domain_unknown"] });
    expect(pl.text).toContain("Nie wiem, do kiedy opłacona jest domena example.org");
    expect(pl.subject).toBe("Nasze Korzenie: jest co zrobić");
  });

  it("only says all is well when it actually knows everything and nothing is wrong", async () => {
    expect((await letter("pl", KNOWN)).subject).toBe("Nasze Korzenie: wszystko opłacone i sprawdzone");
    expect((await letter("en", KNOWN)).subject).toBe("Our Roots: everything is paid up and checked");
  });

  it("counts days the way a person says them, in both languages", async () => {
    for (const lang of ["pl", "en"]) {
      const { text } = await letter(lang, {
        domain_expires_at: AT + DAY,          // exactly one
        card_expires_at: AT,                  // today
        subscription_renews_at: AT - 5 * DAY, // already gone by
        backup_at: AT - DAY,
      });
      expect(text, lang).not.toMatch(/\b1 dni\b/);
      expect(text, lang).not.toMatch(/\b1 days\b/);
      expect(text, lang).not.toMatch(/\b0 (dni|days)\b/);
      expect(text, lang).not.toMatch(/-\d+ (dni|days)/);       // never "za -5 dni"
    }
    const pl = await letter("pl", { domain_expires_at: AT + DAY, card_expires_at: AT, subscription_renews_at: AT - 5 * DAY, backup_at: AT - DAY });
    expect(pl.text).toContain("jeszcze przez 1 dzień");
    expect(pl.text).toContain("traci ważność dzisiaj");
    expect(pl.text).toContain("miał się odnowić 27 sierpnia 2026, 5 dni temu");
    expect(pl.text).toContain("pobrano 31 sierpnia 2026, 1 dzień temu");
  });

  it("never calls it all well over a date that has already passed", async () => {
    // A failed monthly payment leaves exactly this behind: a renewal date in the past and no warning,
    // because section F removed the only warning a subscription date could ever fire.
    const overdue = { ...KNOWN, subscription_renews_at: AT - 5 * DAY };

    const pl = await letter("pl", overdue);
    expect(pl.subject).toBe("Nasze Korzenie: sprawdź, czy wszystko się odnowiło");
    expect(pl.subject).not.toContain("wszystko opłacone");
    expect(pl.text).not.toContain("Wszystko jest opłacone, sprawdzone i nic nie wymaga uwagi.");
    expect(pl.text).toContain("Któraś z dat powyżej już minęła");

    const en = await letter("en", overdue);
    expect(en.subject).toBe("Our Roots: check that everything renewed");
    expect(en.text).not.toContain("Everything is paid up, checked, and nothing needs attention.");
    expect(en.text).toContain("One of the dates above has already passed");
  });

  it("treats a lapsed domain or an expired card the same way, whatever the warnings say", async () => {
    for (const field of ["domain_expires_at", "card_expires_at", "subscription_renews_at"]) {
      const pl = await letter("pl", { ...KNOWN, [field]: AT - DAY });
      expect(pl.subject, field).not.toContain("wszystko opłacone i sprawdzone");
      const en = await letter("en", { ...KNOWN, [field]: AT - DAY });
      expect(en.subject, field).not.toContain("everything is paid up and checked");
    }
  });

  it("gives every date in full next to its count, not a bare number", async () => {
    expect((await letter("pl", KNOWN)).text).toContain("opłacona do 2 kwietnia 2027 — jeszcze przez 212 dni");
    expect((await letter("en", KNOWN)).text).toContain("paid up until April 2, 2027 — 212 days left");
  });

  it("says how many admins it reached, and treats one as the warning it is", async () => {
    expect((await letter("pl", { ...KNOWN, admins: 3 })).text).toContain("poszedł do 3 osób");
    expect((await letter("en", { ...KNOWN, admins: 3 })).text).toContain("went to 3 people");

    const alone = await letter("pl", { ...KNOWN, admins: 1 });
    expect(alone.text).toContain("jesteś jedynym administratorem strony");
    expect((await letter("en", { ...KNOWN, admins: 1 })).text).toContain("you are the site's only admin");
  });

  it("falls back to Polish for a language it does not have", async () => {
    expect((await letter("de", KNOWN)).text).toContain("Cześć,");
  });
});
