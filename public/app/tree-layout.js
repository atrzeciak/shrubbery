import { buildGraph, byBirth, yearOf } from "./graph.js";

// Children grouped by the parents they share among `ids`: one drop per couple or single parent,
// one bar per set of siblings. Half-siblings share a parent, not a bar.
function families(g, ids) {
  const out = new Map();
  for (const id of ids) {
    const parents = g.parents(id).filter((p) => ids.has(p)).sort();
    if (!parents.length) continue;
    const key = parents.join("|");
    if (!out.has(key)) out.set(key, { type: "family", parents, children: [] });
    out.get(key).children.push(id);
  }
  return [...out.values()];
}

// Around one person: their parents and the parents' partners, their siblings, their spouses and
// their children, laid out exactly like the whole family and shifted so they sit at column 0, row 1.
export function focusLayout(g, focusId) {
  const role = new Map([[focusId, "focus"]]);
  const add = (ids, r) => { for (const id of ids) if (!role.has(id)) role.set(id, r); };
  const parents = g.parents(focusId);
  add(parents, "parent");
  for (const p of parents) add(g.partners(p).map((q) => q.id), "parent");
  add(g.siblings(focusId), "sibling");
  add(g.partners(focusId).map((q) => q.id), "partner");
  add(coParents(g, focusId), "partner");
  add(g.children(focusId), "child");
  const ids = [...role.keys()], has = (id) => role.has(id);
  const sub = buildGraph({
    people: ids.map((id) => g.byId.get(id)),
    parents: ids.flatMap((id) => g.parents(id).filter(has).map((p) => ({ parent_id: p, child_id: id }))),
    partners: ids.flatMap((id) => g.partners(id).filter((q) => has(q.id) && id < q.id).map((q) => ({ a_id: id, b_id: q.id, kind: q.kind, start_year: q.start_year, end_year: q.end_year }))),
  });
  const { nodes, edges } = familyLayout(sub);
  const me = nodes.find((n) => n.id === focusId);
  // reading order, row by row, which is also the keyboard order
  const placed = nodes.map((n) => ({ id: n.id, col: n.col - me.col, row: n.row - me.row + 1, role: role.get(n.id) }));
  return { nodes: placed.sort((a, b) => a.row - b.row || a.col - b.col), edges };
}

// Everyone who had a child with `id`, partner or not.
function coParents(g, id) {
  const out = new Set();
  for (const c of g.children(id)) for (const p of g.parents(c)) if (p !== id) out.add(p);
  return [...out];
}

// Roots sit in row 0; everyone else one below their deepest parent. Partners share a row, and so
// do two people who share a child. Parents sit just above their shallowest child, so an in-law's
// parents are not stranded rows above them.
export function generations(g) {
  const gen = new Map(g.people.map((p) => [p.id, 0]));
  let changed = true, guard = 0;
  while (changed && guard++ <= 2 * g.people.length + 2) {
    changed = false;
    for (const p of g.people) {
      let want = gen.get(p.id);
      for (const par of g.parents(p.id)) want = Math.max(want, gen.get(par) + 1);
      for (const q of g.partners(p.id)) want = Math.max(want, gen.get(q.id));
      for (const q of coParents(g, p.id)) want = Math.max(want, gen.get(q));
      const kids = g.children(p.id);
      if (kids.length) want = Math.max(want, Math.min(...kids.map((c) => gen.get(c))) - 1);
      if (want > gen.get(p.id)) { gen.set(p.id, want); changed = true; }
    }
  }
  return gen;
}

// Whole-family layout: every family is a block. A person sits in one row with their spouses
// beside them, each couple's children directly under that couple, and blocks side by side, so a
// family's lines never have to cross another family's. Someone whose parents are also in the
// tree can only be in one place: beside their spouse, with one long line back to their parents.
export function familyLayout(g) {
  const gen = generations(g);
  const cmp = byBirth(g);
  const col = new Map();
  const unit = new Map();
  for (const p of g.people) {
    const key = g.parents(p.id).slice().sort().join("|");
    if (key) unit.set(key, [...(unit.get(key) || []), p.id]);
  }
  const kids = (...parents) => (unit.get(parents.slice().sort().join("|")) || []).filter((c) => !col.has(c)).sort(cmp);
  // Partners and co-parents in the order the relationships came: by the recorded year, failing
  // that by the birth of the first shared child, so the earliest ties sit closest.
  const spouses = (id) => {
    const when = new Map();
    for (const q of g.partners(id)) when.set(q.id, Math.min(when.get(q.id) ?? 9999, q.start_year ?? 9999));
    for (const c of g.children(id)) for (const o of g.parents(c)) if (o !== id) when.set(o, Math.min(when.get(o) ?? 9999, yearOf(g.byId.get(c).birth_date) ?? 9999));
    return [...when.keys()].sort((a, b) => when.get(a) - when.get(b) || cmp(a, b));
  };
  // The row a person shares with their spouses: first spouse to the right, next to the left, and
  // a spouse's own other spouses beyond them, so every couple that can be adjacent is.
  const chainOf = (id) => {
    const chain = [id], queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const q of spouses(cur)) {
        if (col.has(q) || chain.includes(q)) continue;
        if (chain[chain.length - 1] === cur) chain.push(q);
        else if (chain[0] === cur) chain.unshift(q);
        else chain.push(q);
        queue.push(q);
      }
    }
    return chain;
  };
  // Lays out `id`, their spouses and everyone below them, from column x0 to the right.
  // Returns the block's width and the ids it placed.
  // Where a couple's drop leaves the row, as a position along the chain: between them when they
  // are side by side, otherwise at whichever end is not already taken by another partner (the
  // view draws the bridge the same way).
  const dropAt = (chain, i, j) => {
    if (j === i + 1) return i + 0.5;
    const taken = (k, d) => spouses(chain[k]).includes(chain[k + d]);
    return !taken(i, 1) ? i + 0.5 : !taken(j, -1) ? j - 0.5 : (i + j) / 2;
  };
  // Lays out `id`, their spouses and everyone below them, from column x0 to the right.
  // Returns the block's width and the ids it placed.
  function block(id, x0) {
    const chain = chainOf(id);
    for (const m of chain) col.set(m, x0);
    const groups = [];
    chain.forEach((m, i) => {
      const alone = kids(m);
      if (alone.length) groups.push({ at: i, kids: alone });
      for (let j = i + 1; j < chain.length; j++) { const k = kids(m, chain[j]); if (k.length) groups.push({ at: dropAt(chain, i, j), kids: k }); }
    });
    groups.sort((a, b) => a.at - b.at);
    const ids = [...chain];
    let x = 0;
    for (const grp of groups) {
      grp.ids = []; grp.own = [];
      for (const c of grp.kids) { if (col.has(c)) continue; const b = block(c, x0 + x); x += b.width; grp.ids.push(...b.ids); grp.own.push(c); }
      ids.push(...grp.ids);
      const at = grp.own.map((c) => col.get(c) - x0);
      grp.left = Math.min(...at); grp.right = Math.max(...at); grp.mid = at.reduce((a, b) => a + b, 0) / at.length;
    }
    // Each couple would like to sit right over its children. It must at least drop between the
    // neighbouring groups' children, or its bar would reach over them; where the packed groups
    // leave no such position, they are spread apart until they do.
    const active = groups.filter((grp) => grp.own.length);
    let off = active.length ? active.reduce((sum, grp) => sum + grp.mid - grp.at, 0) / active.length : (x - chain.length) / 2;
    for (let pass = 0; active.length && pass < 2 * active.length + 2; pass++) {
      let lo = -Infinity, hi = Infinity;
      active.forEach((grp, k) => {
        if (k > 0) lo = Math.max(lo, active[k - 1].right + 0.5 - grp.at);
        if (k + 1 < active.length) hi = Math.min(hi, active[k + 1].left - 0.5 - grp.at);
      });
      if (lo <= hi) { off = Math.min(Math.max(off, lo), hi); break; }
      off = lo;
      for (let k = 1; k < active.length; k++) {
        const gap = off + active[k - 1].at + 0.5 - active[k].left;
        if (gap <= 0) continue;
        for (const grp of active.slice(k)) { for (const m of grp.ids) col.set(m, col.get(m) + gap); grp.left += gap; grp.right += gap; grp.mid += gap; }
        x += gap;
      }
    }
    const shift = Math.max(0, -off);
    for (const m of ids) if (!chain.includes(m)) col.set(m, col.get(m) + shift);
    chain.forEach((m, i) => col.set(m, x0 + off + shift + i));
    const width = Math.max(x + shift, off + shift + chain.length);
    return { width, ids };
  }
  // The biggest family first, so in-laws attach to the main line rather than the other way round.
  const below = new Map();
  const count = (id, seen = new Set()) => {
    if (below.has(id)) return below.get(id);
    let n = 0;
    for (const c of g.children(id)) if (!seen.has(c)) { seen.add(c); n += 1 + count(c, seen); }
    below.set(id, n);
    return n;
  };
  const roots = g.people.map((p) => p.id).filter((id) => !g.parents(id).length).sort((a, b) => count(b) - count(a) || cmp(a, b));
  const free = (row, xc, gap) => ![...col].some(([id, c]) => gen.get(id) === row && Math.abs(c - xc) < gap);
  // A row of people whose children are all placed already (an in-law's parents, typically) goes
  // straight above those children when nothing is in the way, so the link back to them is short.
  const seatAbove = (chain) => {
    const placedKids = [...new Set(chain.flatMap((m) => g.children(m)))].filter((c) => col.has(c));
    if (!placedKids.length || chain.some((m) => kids(m).length || chain.some((o) => o !== m && kids(m, o).length))) return false;
    const row = gen.get(chain[0]), childRow = Math.min(...placedKids.map((c) => gen.get(c)));
    const target = placedKids.reduce((sum, c) => sum + col.get(c), 0) / placedKids.length;
    const centred = target - (chain.length - 1) / 2;
    for (let d = 0; d <= 40; d += 0.5) {
      for (const start of d ? [centred - d, centred + d] : [centred]) {
        const mid = start + (chain.length - 1) / 2;
        let ok = chain.every((m, i) => free(gen.get(m), start + i, 1));
        for (let r = row + 1; ok && r < childRow; r++) ok = free(r, mid, 0.5);
        if (ok) { chain.forEach((m, i) => col.set(m, start + i)); return true; }
      }
    }
    return false;
  };
  let x = 0;
  for (const id of [...roots, ...g.people.map((p) => p.id).sort(cmp)]) {
    if (col.has(id)) continue;
    if (!seatAbove(chainOf(id))) x += block(id, x).width;
  }
  const cols = [...col.values()], centre = (Math.min(...cols) + Math.max(...cols)) / 2;
  const nodes = g.people.map((p) => ({ id: p.id, col: col.get(p.id) - centre, row: gen.get(p.id) }));
  const edges = families(g, new Set(g.people.map((p) => p.id)));
  for (const p of g.people) for (const q of g.partners(p.id)) if (p.id < q.id) edges.push({ from: p.id, to: q.id, type: "partner", kind: q.kind });
  return { nodes, edges, rows: g.people.length ? Math.max(...gen.values()) + 1 : 0 };
}
