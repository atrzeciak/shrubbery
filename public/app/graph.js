export const yearOf = (d) => (d ? Number(String(d).replace("~", "").slice(0, 4)) : null);

export function buildGraph({ people = [], parents = [], partners = [], links = [], avatars = [] }) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const parentsOf = new Map(), childrenOf = new Map(), partnersOf = new Map(), linksOf = new Map(), avatarAt = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of parents) if (byId.has(e.parent_id) && byId.has(e.child_id)) { push(parentsOf, e.child_id, e.parent_id); push(childrenOf, e.parent_id, e.child_id); }
  for (const e of partners) if (byId.has(e.a_id) && byId.has(e.b_id)) {
    push(partnersOf, e.a_id, { id: e.b_id, kind: e.kind, start_year: e.start_year, end_year: e.end_year });
    push(partnersOf, e.b_id, { id: e.a_id, kind: e.kind, start_year: e.start_year, end_year: e.end_year });
  }
  for (const l of links) push(linksOf, l.person_id, l);
  for (const a of avatars) avatarAt.set(a.person_id, a.updated_at);
  const get = (m, id) => m.get(id) || [];
  return {
    people, byId,
    parents: (id) => get(parentsOf, id),
    children: (id) => get(childrenOf, id),
    partners: (id) => get(partnersOf, id),
    links: (id) => get(linksOf, id),
    avatarAt: (id) => avatarAt.get(id) ?? null,
    siblings(id) {
      const out = new Set();
      for (const p of get(parentsOf, id)) for (const c of get(childrenOf, p)) if (c !== id) out.add(c);
      return [...out];
    },
  };
}

export function lifeSpan(p) {
  const b = yearOf(p.birth_date), d = yearOf(p.death_date);
  if (b && d) return `${b}–${d}`;
  if (b && p.deceased) return `${b}–†`;
  if (b) return String(b);
  if (d) return `†${d}`;
  return p.deceased ? "†" : "";
}

export function initials(p) {
  const words = [p.first_name, p.last_name].filter(Boolean);
  const src = words.length ? words : String(p.display_name || "").trim().split(/\s+/).filter(Boolean);
  return src.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export const byBirth = (g) => (a, b) => {
  const pa = g.byId.get(a), pb = g.byId.get(b);
  const ya = yearOf(pa.birth_date) ?? 99999, yb = yearOf(pb.birth_date) ?? 99999;
  return ya - yb || String(pa.display_name).localeCompare(String(pb.display_name));
};
