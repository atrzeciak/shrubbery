const SUPPORTED = ["pl", "en"];
let dict = {};
let current = "pl";

export const getLang = () => current;

export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = "pl";
  const res = await fetch(`/app/i18n/${lang}.json`, { cache: "no-cache" });
  dict = await res.json();
  current = lang;
  document.documentElement.lang = lang;
  localStorage.setItem("lang", lang);
}

// Order: ?lang= on the URL > remembered choice > Polish. The account's language follows via setLang.
export async function initI18n() {
  const url = new URLSearchParams(location.search).get("lang");
  await setLang(url || localStorage.getItem("lang") || "pl");
}

export function t(key, vars = {}) {
  let s = dict[key];
  if (s == null) return key;
  // A function, not a string: a string replacement reads $& and $$ in the value as patterns.
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, () => String(v));
  return s;
}
