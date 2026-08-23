import { h } from "./dom.js";
import { t } from "./i18n.js";
import { lifeSpan } from "./graph.js";
import { avatarEl } from "./people.js";
import { openPersonEditor } from "./person-editor.js";
import { mediaGallery } from "./media-gallery.js";

const kindLabel = (q) => {
  const years = [q.start_year, q.end_year].filter(Boolean).join("–");
  return `${t(`person.partner.${q.kind}`)}${years ? ` ${years}` : ""}`;
};

// onPerson(id) is called when a related person is tapped; ctx.navigate for Edit.
export function personCard(g, id, ctx, { onPerson }) {
  const p = g.byId.get(id);
  const me = ctx.state.me.account;
  const canEdit = me.role === "admin" || me.person_id === id;
  const row = (label, value) => (value ? h("div", { class: "kv" }, h("span", { class: "muted", text: `${label}: ` }), value) : null);
  const place = (d, pl) => [d, pl].filter(Boolean).join(", ");
  const rel = (label, ids, extra = () => "") => ids.length
    ? h("div", { class: "kv" }, h("span", { class: "muted", text: `${label}: ` }),
        ...ids.map((rid, i) => [i ? ", " : null, h("button", { class: "linklike", type: "button", text: `${g.byId.get(rid).display_name}${extra(rid)}`, onclick: () => onPerson(rid) })]))
    : null;
  const partners = g.partners(id);
  const edit = canEdit ? h("button", { class: "btn secondary", type: "button", text: t("person.edit") }) : null;
  if (edit) edit.onclick = () => {
    if (me.role === "admin" && me.person_id !== id) openPersonEditor(id, ctx, { onDone: () => ctx.navigate(location.pathname, { replace: true }) });
    else ctx.navigate("/app/me");
  };
  const gallery = h("div");
  mediaGallery(id, ctx).then((el) => gallery.append(el));
  return h("div", { class: "person-card" },
    h("div", { class: "row" }, avatarEl(g, id, 72),
      h("div", {}, h("h2", { text: p.display_name }), p.nickname ? h("div", { class: "muted", text: `„${p.nickname}”` }) : null,
        h("div", { class: "muted", text: lifeSpan(p) }), p.deceased ? h("span", { class: "badge", text: t("person.gone") }) : p.unverified ? h("span", { class: "badge", text: t("person.unverified") }) : null)),
    row(t("person.born"), place(p.birth_date, p.birth_place)),
    row(t("person.died"), p.deceased ? place(p.death_date, p.death_place) || "†" : null),
    row(t("person.residence"), p.residence),
    row(t("person.phone"), p.phone && !p.deceased ? h("a", { href: `tel:${p.phone}`, text: p.phone }) : null),
    row(t("person.email"), p.email && !p.deceased ? h("a", { href: `mailto:${p.email}`, text: p.email }) : null),
    g.links(id).length ? h("div", { class: "kv" }, h("span", { class: "muted", text: `${t("person.links")}: ` }),
      ...g.links(id).map((l, i) => [i ? ", " : null, h("a", { href: l.url, target: "_blank", rel: "noopener", text: l.label || t(`person.link.${l.kind}`) })])) : null,
    rel(t("person.parents"), g.parents(id)),
    rel(t("person.partners"), partners.map((q) => q.id), (rid) => ` (${kindLabel(partners.find((q) => q.id === rid))})`),
    rel(t("person.children"), g.children(id)),
    rel(t("person.siblings"), g.siblings(id)),
    p.notes ? h("div", { class: "kv notes" }, h("span", { class: "muted", text: `${t("person.notes")}: ` }), h("div", { class: "prewrap", text: p.notes })) : null,
    p.account_email ? row(t("person.login"), p.account_email) : null,
    gallery,
    edit ? h("div", { class: "row" }, edit) : null);
}
