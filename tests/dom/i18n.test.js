import { describe, it, expect, afterEach } from "vitest";
import { setLang, getLang, initI18n, t } from "../../public/app/i18n.js";

afterEach(() => history.replaceState(null, "", "/"));

describe("setLang", () => {
  it("loads the dictionary, marks the document and remembers the choice", async () => {
    await setLang("en");
    expect(getLang()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("lang")).toBe("en");
    expect(t("close")).toBe("Close");
  });
  it("falls back to Polish for a language it does not have", async () => {
    await setLang("de");
    expect(getLang()).toBe("pl");
    expect(t("close")).toBe("Zamknij");
  });
});

describe("initI18n", () => {
  it("prefers the account language over the URL over the remembered choice", async () => {
    localStorage.setItem("lang", "en");
    history.replaceState(null, "", "/app/?lang=pl");
    await initI18n("en");
    expect(getLang()).toBe("en");
    await initI18n(null);
    expect(getLang()).toBe("pl");
    history.replaceState(null, "", "/app/");
    localStorage.setItem("lang", "en");
    await initI18n(null);
    expect(getLang()).toBe("en");
    localStorage.clear();
    await initI18n(null);
    expect(getLang()).toBe("pl");
  });
});

describe("t", () => {
  it("returns the key itself when there is no translation", async () => {
    await setLang("pl");
    expect(t("no.such.key")).toBe("no.such.key");
  });
  it("substitutes every occurrence of a variable", async () => {
    await setLang("en");
    expect(t("media.full", { person: "Ann" })).toContain("Ann");
    expect(t("media.full", { person: "Ann" })).not.toContain("{person}");
  });
});
