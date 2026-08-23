const P = (id, first, last, birth_date = null, deceased = 0, death_date = null) => ({ id, first_name: first, last_name: last, display_name: `${first} ${last}`, birth_date, deceased, death_date });
export const FAMILY = {
  people: [P("g1", "Aleksy", "A", "1900"), P("g2", "Maria", "A", "1902"), P("p1", "Jan", "A", "1930"), P("p2", "Ewa", "B", "1932"), P("p3", "Ola", "A", "1935"), P("c1", "Kuba", "A", "1960"), P("c2", "Zosia", "A", "1962"), P("x", "Solo", "Z")],
  parents: [{ parent_id: "g1", child_id: "p1" }, { parent_id: "g2", child_id: "p1" }, { parent_id: "g1", child_id: "p3" }, { parent_id: "g2", child_id: "p3" }, { parent_id: "p1", child_id: "c1" }, { parent_id: "p2", child_id: "c1" }, { parent_id: "p1", child_id: "c2" }, { parent_id: "p2", child_id: "c2" }],
  partners: [{ a_id: "g1", b_id: "g2", kind: "married", start_year: 1925, end_year: null }, { a_id: "p1", b_id: "p2", kind: "married", start_year: 1958, end_year: null }],
  links: [{ id: "l1", person_id: "p1", kind: "other", label: "w", url: "https://x" }],
  avatars: [{ person_id: "p1", updated_at: 5 }],
};
