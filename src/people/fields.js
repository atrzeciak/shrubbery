import { ApiError, EMAIL_RE } from "../api/common.js";

export const DATE_RE = /^(~\d{4}|\d{4}|\d{4}-(0[1-9]|1[0-2])|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/;
export const yearOf = (d) => (d ? Number(String(d).replace("~", "").slice(0, 4)) : null);

export const TEXT_LIMITS = { first_name: 80, last_name: 80, maiden_name: 80, nickname: 80, birth_place: 120, death_place: 120, phone: 40, residence: 120, notes: 4000 };
export const DATE_FIELDS = ["birth_date", "death_date"];
export const FLAG_FIELDS = ["deceased"];
export const LINK_KINDS = ["instagram", "facebook", "linkedin", "other"];
export const PARTNER_KINDS = ["married", "partner", "divorced"];
export const PERSON_COLUMNS = [...Object.keys(TEXT_LIMITS), ...DATE_FIELDS, "sex", "email", "deceased", "unverified"];

const bad = () => { throw new ApiError(400, "bad_request"); };
const str = (v, max) => {
  if (v == null) return null;
  if (typeof v !== "string") bad();
  const s = v.trim();
  if (s.length > max) bad();
  return s || null;
};

// Returns only the keys present in `body`; unknown keys are dropped, `unverified` needs admin.
export function cleanPersonInput(body, { admin }) {
  if (!body || typeof body !== "object") bad();
  const fields = {};
  for (const [k, max] of Object.entries(TEXT_LIMITS)) if (k in body) fields[k] = str(body[k], max);
  for (const k of DATE_FIELDS) if (k in body) {
    const s = str(body[k], 10);
    if (s !== null && !DATE_RE.test(s)) bad();
    fields[k] = s;
  }
  if ("sex" in body) {
    const s = str(body.sex, 1);
    if (s !== null && s !== "f" && s !== "m") bad();
    fields.sex = s;
  }
  if ("email" in body) {
    const s = str(body.email, 254);
    if (s !== null && !EMAIL_RE.test(s)) bad();
    fields.email = s ? s.toLowerCase() : null;
  }
  for (const k of ["deceased", "unverified"]) if (k in body) {
    if (k === "unverified" && !admin) bad();
    if (body[k] !== 0 && body[k] !== 1 && body[k] !== true && body[k] !== false) bad();
    fields[k] = body[k] ? 1 : 0;
  }
  let links = null;
  if ("links" in body) {
    if (!Array.isArray(body.links) || body.links.length > 20) bad();
    links = body.links.map((l) => {
      if (!l || typeof l !== "object" || !LINK_KINDS.includes(l.kind)) bad();
      const url = str(l.url, 300);
      if (!url || !/^https:\/\/[^\s]+$/.test(url)) bad();
      return { kind: l.kind, label: str(l.label, 60), url };
    });
  }
  return { fields, links };
}

export function displayNameOf({ first_name, last_name, maiden_name }, fallback) {
  const base = [first_name, last_name].filter(Boolean).join(" ");
  if (!base) return fallback;
  return maiden_name ? `${base} (${maiden_name})` : base;
}
