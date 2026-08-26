import { api } from "./api.js";
import { h, s, clear } from "./dom.js";
import { t } from "./i18n.js";
import { openViewer } from "./viewer.js";
import { uploadForm, toastApiError } from "./media-upload.js";

const docIcon = () => s("svg", { class: "doc-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round", "aria-hidden": "true" },
  s("path", { d: "M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" }),
  s("path", { d: "M13.75 2.5V8.25h5.75" }));

const src = (m) => (m.has_thumb ? `/api/media/${m.id}/thumb` : `/api/media/${m.id}`);

// The admin panel behind "Edytuj": caption, year, owner, tags. Its own toggle lives in the actions
// row, so this is a plain sibling rather than a <details> that would drag the summary out of line.
function editPanel(m, ctx, { people, reload }) {
  const caption = h("input", { type: "text", maxlength: "200", value: m.caption || "", placeholder: t("media.caption"), "aria-label": t("media.caption") });
  const year = h("input", { type: "number", min: "1000", max: "2999", value: m.year || "", placeholder: t("media.year"), "aria-label": t("media.year") });
  const ownerSel = h("select", { "aria-label": t("media.owner") },
    ...people.map((p) => h("option", { value: p.id, text: p.display_name, selected: p.id === m.owner_person_id })));
  const tagged = new Set(m.people || []);
  const tagBoxes = people.filter((p) => p.id !== m.owner_person_id).map((p) => {
    const cb = h("input", { type: "checkbox", checked: tagged.has(p.id) });
    cb.dataset.personId = p.id;
    return h("label", { class: "check" }, cb, ` ${p.display_name}`);
  });
  const save = h("button", { class: "btn secondary", type: "button", text: t("media.save") });
  save.onclick = async () => {
    save.disabled = true;
    const tags = tagBoxes.map((row) => row.firstChild).filter((cb) => cb.checked).map((cb) => cb.dataset.personId);
    try {
      await api(`/api/media/${m.id}`, {
        method: "PATCH",
        body: { caption: caption.value.trim() || null, year: year.value ? Number(year.value) : null, owner_person_id: ownerSel.value, tags },
      });
      ctx.toast(t("form.saved"));
      await reload();
    } catch (e) { toastApiError(ctx, e); save.disabled = false; }
  };
  return h("div", { class: "media-file-edit", hidden: true },
    h("div", { class: "row" }, caption, year),
    ownerSel,
    h("p", { class: "muted", text: t("media.tags") }), ...tagBoxes,
    h("div", { class: "row" }, save));
}

// Quiet text actions, and the edit panel they reveal. Deleting is the rarest thing anyone does
// here and no longer looks like the point of the row.
function fileControls(m, ctx, { admin, people, reload }) {
  const actions = h("div", { class: "media-actions" });
  const nodes = [actions];
  if (admin) {
    const panel = editPanel(m, ctx, { people, reload });
    const toggle = h("button", { class: "link-btn", type: "button", text: t("media.edit"), "aria-expanded": "false" });
    toggle.onclick = () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    };
    actions.append(toggle);
    nodes.push(panel);
  }
  if (admin || m.uploaded_by === ctx.state.me.account.id) {
    const del = h("button", { class: "link-btn danger", type: "button", text: t("media.delete") });
    del.onclick = async () => {
      if (!confirm(t("confirm"))) return;
      try { await api(`/api/media/${m.id}`, { method: "DELETE" }); await reload(); }
      catch (e) { toastApiError(ctx, e); }
    };
    actions.append(del);
  }
  return nodes;
}

// Gallery section for one person: a photo grid, a document list, and what may still be added.
export async function mediaGallery(personId, ctx, { editable = false, admin = false, people = [] } = {}) {
  const wrap = h("div", { class: "media-gallery" });
  const reload = async () => {
    let data;
    try { data = await api(`/api/people/${personId}/media`); }
    catch { clear(wrap); wrap.append(h("p", { class: "muted", text: t("media.error") })); return; }
    build(data);
  };
  function build(data) {
    clear(wrap);
    const { media, counts } = data;
    const photos = media.filter((m) => m.kind === "photo");
    const documents = media.filter((m) => m.kind === "document");
    const items = photos.map((m) => ({ src: `/api/media/${m.id}`, caption: m.caption, year: m.year }));

    wrap.append(h("div", { class: "media-head" },
      h("span", { text: t("media.title") }),
      h("span", { class: "muted", text: `${counts.used}/${counts.cap}` })));

    if (photos.length) {
      wrap.append(h("h3", { class: "media-group", text: t("media.photos") }));
      wrap.append(h("div", { class: "media-strip" }, ...photos.map((m, idx) => {
        const im = h("img", { class: "media-thumb", src: src(m), alt: m.caption || "", loading: "lazy" });
        im.onclick = () => openViewer(items, idx);
        const label = [m.caption, m.year].filter(Boolean).join(" · ");
        const figure = h("figure", { class: "media-item" }, im,
          h("figcaption", { class: "muted small", text: label || t("media.nocaption") }));
        if (!editable) return figure;
        figure.append(...fileControls(m, ctx, { admin, people, reload }));
        return figure;
      })));
    }

    if (documents.length) {
      wrap.append(h("h3", { class: "media-group", text: t("media.documents") }));
      wrap.append(h("ul", { class: "list media-docs" }, ...documents.map((m) => {
        const a = h("a", { href: `/api/media/${m.id}`, target: "_blank", rel: "noopener", text: m.caption || t("media.document") });
        const body = h("div", { class: "media-doc-body" }, a, m.year ? h("span", { class: "muted small", text: String(m.year) }) : null);
        const row = h("li", {}, docIcon(), body);
        if (editable) row.append(...fileControls(m, ctx, { admin, people, reload }));
        return row;
      })));
    }

    if (!photos.length && !documents.length) wrap.append(h("p", { class: "muted", text: t("media.empty") }));
    if (editable && counts.used < counts.cap) wrap.append(uploadForm(personId, ctx, reload));
    else if (editable) wrap.append(h("p", { class: "muted small", text: t("media.atcap") }));
  }
  await reload();
  return wrap;
}
