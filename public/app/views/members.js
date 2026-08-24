import { h, clear } from "../dom.js";
import { t } from "../i18n.js";
import { yearOf } from "../graph.js";
import { loadGraph, avatarEl } from "../people.js";
import { openSheet } from "../sheet.js";
import { personCard } from "../person-card.js";
import { openPersonEditor } from "../person-editor.js";

let sortKey = "name", sortDir = 1, query = "";
const COLS = ["name", "born", "died", "place", "login"];
const val = (p, k) => k === "name" ? p.display_name : k === "born" ? yearOf(p.birth_date) ?? 99999 : k === "died" ? yearOf(p.death_date) ?? (p.deceased ? 99998 : 99999) : k === "place" ? p.residence || p.birth_place || "" : p.account_email || "";

export async function render(root, ctx) {
  clear(root);
  const g = await loadGraph();
  const search = h("input", { type: "search", id: "members-q", placeholder: t("members.search"), value: query, "aria-label": t("members.search") });
  const add = ctx.state.me.account.role === "admin" ? h("button", { class: "btn", type: "button", text: t("admin.people.add") }) : null;
  if (add) add.onclick = () => openPersonEditor(null, ctx, { onDone: () => render(root, ctx) });
  const table = h("table", { class: "members" });
  const draw = () => {
    clear(table);
    const head = h("tr", {}, ...COLS.map((k) => {
      const b = h("button", { type: "button", class: "linklike", text: `${t(`members.col.${k}`)}${sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : ""}` });
      b.onclick = () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; } draw(); };
      return h("th", { scope: "col" }, b);
    }));
    const q = query.trim().toLowerCase();
    const rows = g.people.filter((p) => !q || [p.display_name, p.nickname, p.maiden_name, p.residence, p.birth_place, p.account_email].some((v) => v && v.toLowerCase().includes(q)))
      .sort((a, b) => { const x = val(a, sortKey), y = val(b, sortKey); return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir; });
    const body = h("tbody", {}, ...rows.map((p) => {
      const tr = h("tr", { tabindex: "0", role: "button" },
        h("td", { "data-label": t("members.col.name") }, h("span", { class: "row nowrap" }, avatarEl(g, p.id, 32), h("span", {}, p.display_name, p.deceased ? h("span", { class: "badge", text: t("person.gone") }) : p.unverified ? h("span", { class: "badge", text: t("person.unverified") }) : null))),
        h("td", { "data-label": t("members.col.born"), text: p.birth_date || "" }),
        h("td", { "data-label": t("members.col.died"), text: p.deceased ? p.death_date || "†" : "" }),
        h("td", { "data-label": t("members.col.place"), text: p.residence || p.birth_place || "" }),
        h("td", { "data-label": t("members.col.login"), text: p.account_email || "" }));
      const onPerson = (id) => openSheet(personCard(g, id, ctx, { onPerson }), g.byId.get(id).display_name);
      const open = () => onPerson(p.id);
      tr.onclick = open;
      tr.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } };
      return tr;
    }));
    if (!rows.length) body.append(h("tr", {}, h("td", { colspan: "5", class: "muted", text: t("members.empty") })));
    table.append(h("thead", {}, head), body);
  };
  search.oninput = () => { query = search.value; draw(); };
  root.append(h("h1", { text: t("members.title") }), h("div", { class: "card row" }, search, add), h("div", { class: "table-wrap card" }, table));
  draw();
}
