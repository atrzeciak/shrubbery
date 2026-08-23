import { api, ApiError } from "../api.js";
import { h, clear } from "../dom.js";
import { t } from "../i18n.js";
import { loadGraph, avatarUrl } from "../people.js";
import { personForm, avatarPicker } from "../person-form.js";
import { openSheet } from "../sheet.js";
import { personCard } from "../person-card.js";
import { mediaGallery } from "../media-gallery.js";

export async function render(root, ctx) {
  clear(root);
  root.append(h("h1", { text: t("me.title") }));
  let data;
  try { data = await api("/api/me/person"); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) { root.append(h("p", { class: "card", text: t("me.unlinked") })); return; }
    throw e;
  }
  const g = await loadGraph();
  const id = data.person.id;
  const form = personForm(data.person, data.links, {
    admin: false,
    onSubmit: async (body) => {
      try { await api("/api/me/person", { method: "PATCH", body }); ctx.toast(t("form.saved")); await render(root, ctx); }
      catch (e) { form.showError(ctx.errorText(e)); }
    },
  });
  const picker = avatarPicker(avatarUrl(g, id), {
    onSave: async (blob) => {
      try { await api("/api/me/person/avatar", { method: "PUT", body: blob }); ctx.toast(t("avatar.saved")); await render(root, ctx); }
      catch (e) { throw new Error(ctx.errorText(e)); }
    },
  });
  const onPerson = (rid) => openSheet(personCard(g, rid, ctx, { onPerson }), g.byId.get(rid).display_name);
  const relList = (label, ids) => h("div", { class: "kv" }, h("span", { class: "muted", text: `${label}: ` }),
    ids.length ? ids.map((rid, i) => [i ? ", " : null, h("button", { class: "linklike", type: "button", text: g.byId.get(rid).display_name, onclick: () => onPerson(rid) })]).flat() : "—");
  root.append(picker, form,
    h("div", { class: "card" }, h("h2", { text: t("me.relations") }), h("p", { class: "muted", text: t("me.relations.hint") }),
      relList(t("person.parents"), g.parents(id)), relList(t("person.partners"), g.partners(id).map((q) => q.id)), relList(t("person.children"), g.children(id)), relList(t("person.siblings"), g.siblings(id))));
  root.append(await mediaGallery(id, ctx, { editable: true }));
}
