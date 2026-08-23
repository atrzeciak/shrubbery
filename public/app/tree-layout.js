import { byBirth } from "./graph.js";

const centred = (ids) => ids.map((id, i) => ({ id, col: i - (ids.length - 1) / 2 }));

export function focusLayout(g, focusId) {
  const cmp = byBirth(g);
  const parents = g.parents(focusId);
  const top = [];
  for (const p of parents) {
    if (!top.includes(p)) top.push(p);
    for (const q of g.partners(p)) if (!top.includes(q.id)) top.push(q.id);
  }
  const siblings = [...g.siblings(focusId)].sort(cmp);
  const partners = g.partners(focusId).map((x) => x.id);
  const children = [...g.children(focusId)].sort(cmp);
  const nodes = [
    ...centred(top).map((n) => ({ ...n, row: 0, role: "parent" })),
    ...siblings.map((id, i) => ({ id, col: -(i + 1), row: 1, role: "sibling" })),
    { id: focusId, col: 0, row: 1, role: "focus" },
    ...partners.map((id, i) => ({ id, col: i + 1, row: 1, role: "partner" })),
    ...centred(children).map((n) => ({ ...n, row: 2, role: "child" })),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const p of parents) edges.push({ from: p, to: focusId, type: "parent" });
  for (const c of children) edges.push({ from: focusId, to: c, type: "parent" });
  for (const id of ids) for (const q of g.partners(id)) if (ids.has(q.id) && id < q.id) edges.push({ from: id, to: q.id, type: "partner" });
  return { nodes, edges };
}

// Roots sit in row 0; everyone else one below their deepest parent; partners share a row.
export function generations(g) {
  const gen = new Map(g.people.map((p) => [p.id, 0]));
  let changed = true, guard = 0;
  while (changed && guard++ <= g.people.length + 1) {
    changed = false;
    for (const p of g.people) {
      let want = gen.get(p.id);
      for (const par of g.parents(p.id)) want = Math.max(want, gen.get(par) + 1);
      for (const q of g.partners(p.id)) want = Math.max(want, gen.get(q.id));
      if (want > gen.get(p.id)) { gen.set(p.id, want); changed = true; }
    }
  }
  return gen;
}

export function familyLayout(g) {
  const gen = generations(g);
  const rows = [];
  for (const [id, r] of gen) (rows[r] ||= []).push(id);
  const col = new Map();
  const cmp = byBirth(g);
  rows.forEach((ids) => {
    ids.sort(cmp);
    const placed = new Set(), groups = [];
    for (const id of ids) {
      if (placed.has(id)) continue;
      const grp = [id];
      placed.add(id);
      const queue = [id];
      while (queue.length) {
        const cur = queue.shift();
        for (const q of g.partners(cur)) {
          if (!ids.includes(q.id) || placed.has(q.id)) continue;
          if (grp[grp.length - 1] === cur) grp.push(q.id);
          else if (grp[0] === cur) grp.unshift(q.id);
          else grp.push(q.id);
          placed.add(q.id);
          queue.push(q.id);
        }
      }
      groups.push(grp);
    }
    const bary = (grp) => {
      const xs = grp.flatMap((id) => g.parents(id)).map((p) => col.get(p)).filter((v) => v != null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.MAX_SAFE_INTEGER;
    };
    groups.sort((a, b) => bary(a) - bary(b));
    const flat = groups.flat();
    flat.forEach((id, i) => col.set(id, i - (flat.length - 1) / 2));
  });
  const nodes = g.people.map((p) => ({ id: p.id, col: col.get(p.id), row: gen.get(p.id) }));
  const edges = [];
  for (const p of g.people) for (const par of g.parents(p.id)) edges.push({ from: par, to: p.id, type: "parent" });
  for (const p of g.people) for (const q of g.partners(p.id)) if (p.id < q.id) edges.push({ from: p.id, to: q.id, type: "partner" });
  return { nodes, edges, rows: rows.length };
}
