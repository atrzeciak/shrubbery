import { api } from "./api.js";
import { t } from "./i18n.js";
import { h, clear } from "./dom.js";
import { lifeSpan } from "./graph.js";
import { loadGraph, avatarUrl } from "./people.js";
import { personForm, avatarPicker } from "./person-form.js";
import { openSheet, closeSheet } from "./sheet.js";
import { mediaGallery } from "./media-gallery.js";

export async function openPersonEditor(id, ctx, { onDone = () => {} } = {}) {
  const g = await loadGraph();
  const editor = h("div", { class: "editor" });
  const redraw = () => openPersonEditor(id, ctx, { onDone });
  const run = async (fn) => { try { await fn(); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e)); } };
  const options = (exclude) => g.people.filter((p) => p.id !== exclude).sort((a, b) => a.display_name.localeCompare(b.display_name)).map((p) => h("option", { value: p.id, text: `${p.display_name} ${lifeSpan(p)}`.trim() }));

  clear(editor);
  const p = id ? g.byId.get(id) : null;
  const form = personForm(p, id ? g.links(id) : [], {
    admin: true,
    onSubmit: async (body) => {
      try {
        if (id) await api(`/api/admin/people/${id}`, { method: "PATCH", body });
        else { const r = await api("/api/admin/people", { method: "POST", body }); id = r.id; }
        ctx.toast(t("form.saved")); await redraw();
      } catch (e) { form.showError(ctx.errorText(e)); }
    },
  });
  editor.append(h("h2", { text: id ? p.display_name : t("admin.people.new") }), form);
  if (id) {
    editor.append(avatarPicker(avatarUrl(g, id), { onSave: async (blob) => { try { await api(`/api/admin/people/${id}/avatar`, { method: "PUT", body: blob }); ctx.toast(t("avatar.saved")); await redraw(); } catch (e) { throw new Error(ctx.errorText(e)); } } }));
    // parents
    const parents = h("ul", { class: "list" }, ...g.parents(id).map((pid) => {
      const rm = h("button", { class: "btn danger", type: "button", text: t("form.link.remove") });
      rm.onclick = () => run(() => api(`/api/admin/people/${id}/parents/${pid}`, { method: "DELETE" }));
      return h("li", { class: "row" }, h("span", { text: g.byId.get(pid).display_name }), rm);
    }));
    const parentSel = h("select", { "aria-label": t("admin.people.parent") }, h("option", { value: "", text: "—" }), ...options(id));
    const addParent = h("button", { class: "btn secondary", type: "button", text: t("admin.people.parent.add") });
    addParent.onclick = () => parentSel.value && run(() => api(`/api/admin/people/${id}/parents/${parentSel.value}`, { method: "POST", body: {} }));
    // partners
    const partners = h("ul", { class: "list" }, ...g.partners(id).map((q) => {
      const rm = h("button", { class: "btn danger", type: "button", text: t("form.link.remove") });
      rm.onclick = () => run(() => api(`/api/admin/people/${id}/partners/${q.id}`, { method: "DELETE" }));
      return h("li", { class: "row" }, h("span", { text: `${g.byId.get(q.id).display_name} · ${t(`person.partner.${q.kind}`)} ${[q.start_year, q.end_year].filter(Boolean).join("–")}` }), rm);
    }));
    const partnerSel = h("select", { "aria-label": t("admin.people.partner") }, h("option", { value: "", text: "—" }), ...options(id));
    const kindSel = h("select", { "aria-label": t("admin.people.partner.kind") }, ...["married", "partner", "divorced"].map((k) => h("option", { value: k, text: t(`person.partner.${k}`) })));
    const y1 = h("input", { type: "number", min: "1000", max: "2999", placeholder: t("admin.people.partner.start"), "aria-label": t("admin.people.partner.start") });
    const y2 = h("input", { type: "number", min: "1000", max: "2999", placeholder: t("admin.people.partner.end"), "aria-label": t("admin.people.partner.end") });
    const addPartner = h("button", { class: "btn secondary", type: "button", text: t("admin.people.partner.add") });
    addPartner.onclick = () => partnerSel.value && run(() => api(`/api/admin/people/${id}/partners/${partnerSel.value}`, { method: "POST", body: { kind: kindSel.value, start_year: y1.value ? Number(y1.value) : null, end_year: y2.value ? Number(y2.value) : null } }));
    const del = h("button", { class: "btn danger", type: "button", text: t("admin.people.delete") });
    del.onclick = async () => {
      if (!confirm(t("confirm"))) return;
      try { await api(`/api/admin/people/${id}`, { method: "DELETE" }); closeSheet(); onDone(); }
      catch (e) { ctx.toast(ctx.errorText(e)); }
    };
    editor.append(
      h("div", { class: "card" }, h("h2", { text: t("person.parents") }), parents, h("div", { class: "row" }, parentSel, addParent)),
      h("div", { class: "card" }, h("h2", { text: t("person.partners") }), partners, h("div", { class: "row" }, partnerSel, kindSel, y1, y2, addPartner)),
      await mediaGallery(id, ctx, { editable: true, admin: true, people: g.people }),
      h("div", { class: "row" }, del));
  }
  openSheet(editor, id ? g.byId.get(id).display_name : t("admin.people.new"), { full: true, onClose: onDone });
}
