const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
const get = (m, k) => m.get(k) || new Set();

// Answers "may recipient R be e-mailed about person P's event?" per the SP4 spec scopes.
export function buildScope(parentRows, partnerRows) {
  const parentsOf = new Map(), childrenOf = new Map(), partnersOf = new Map();
  for (const e of parentRows) { add(parentsOf, e.child_id, e.parent_id); add(childrenOf, e.parent_id, e.child_id); }
  for (const e of partnerRows) { add(partnersOf, e.a_id, e.b_id); add(partnersOf, e.b_id, e.a_id); }

  function closeCircle(r) {
    const s = new Set([...get(parentsOf, r), ...get(childrenOf, r), ...get(partnersOf, r)]);
    for (const parent of get(parentsOf, r)) for (const child of get(childrenOf, parent)) if (child !== r) s.add(child);
    return s;
  }

  function ancestorsUpTwo(r) {
    const s = new Set(get(parentsOf, r));
    for (const parent of get(parentsOf, r)) for (const gp of get(parentsOf, parent)) s.add(gp);
    for (const a of [...s]) for (const partner of get(partnersOf, a)) s.add(partner);
    return s;
  }

  return {
    inScope(personId, recipientId, type) {
      if (personId === recipientId) return false;
      if (closeCircle(recipientId).has(personId)) return true;
      return type === "death" && ancestorsUpTwo(recipientId).has(personId);
    },
  };
}
