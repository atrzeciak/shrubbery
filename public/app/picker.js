import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { lifeSpan } from "./graph.js";

// A type-to-find person input with its own list: the browser's datalist matches on the whole
// label and places its popup where it likes. Rows carry the years and the parents, which is what
// tells two people with the same name apart. `value()` yields the id only once a row was chosen,
// so nothing links blind.
export function personPicker(g, people, { id, initial = null, placeholder }) {
  const parents = (p) => g.parents(p.id).map((pid) => g.byId.get(pid)?.display_name).filter(Boolean).join(" & ");
  const detail = (p) => [lifeSpan(p), parents(p) && t("admin.person.of", { parents: parents(p) })].filter(Boolean).join(" · ");
  let chosen = people.find((p) => p.id === initial) || null;
  const el = h("input", { id, type: "search", placeholder, autocomplete: "off", value: chosen?.display_name || "" });
  const list = h("ul", { class: "picker", hidden: true });
  const onChange = [];
  const choose = (p) => { chosen = p; el.value = p.display_name; list.hidden = true; for (const f of onChange) f(); };
  const fill = () => {
    const q = el.value.trim().toLowerCase();
    clear(list);
    const hits = q.length >= 2 ? people.filter((p) => p.display_name.toLowerCase().includes(q)) : [];
    for (const p of hits) list.append(h("li", { onmousedown: (e) => { e.preventDefault(); choose(p); } }, h("span", { text: p.display_name }), " ", h("span", { class: "muted", text: detail(p) })));
    list.hidden = !hits.length;
  };
  el.addEventListener("input", () => { if (chosen && el.value !== chosen.display_name) chosen = null; fill(); for (const f of onChange) f(); });
  el.addEventListener("focus", fill);
  el.addEventListener("blur", () => { list.hidden = true; });
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") list.hidden = true; if (e.key === "Enter" && list.children.length === 1) { e.preventDefault(); list.firstChild.dispatchEvent(new Event("mousedown")); } });
  return { el: h("div", { class: "picker-wrap" }, el, list), value: () => chosen?.id || null, text: () => el.value.trim(), onChange: (f) => onChange.push(f) };
}
