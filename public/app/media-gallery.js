import { api } from "./api.js";
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { openViewer } from "./viewer.js";

const src = (m) => (m.has_thumb ? `/api/media/${m.id}/thumb` : `/api/media/${m.id}`);

// 409-with-person conflict gets its own message; everything else goes through errorText.
function toastApiError(ctx, e) {
  if (e && e.code === "conflict" && e.detail && e.detail.person) ctx.toast(t("media.full", { person: e.detail.person }));
  else ctx.toast(e && e.code ? ctx.errorText(e) : String((e && e.message) || e));
}

async function toJpeg(file, maxSide, quality) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { try { bitmap = await createImageBitmap(file); } catch { throw new Error(t("avatar.bad")); } }
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => { canvas.toBlob(resolve, "image/jpeg", quality); });
}

function uploadForm(personId, ctx, reload) {
  const file = h("input", { type: "file", accept: "image/*,application/pdf", id: `mg-file-${personId}` });
  const caption = h("input", { type: "text", maxlength: "200", placeholder: t("media.caption"), "aria-label": t("media.caption") });
  const year = h("input", { type: "number", min: "1000", max: "2999", placeholder: t("media.year"), "aria-label": t("media.year") });
  const btn = h("button", { class: "btn secondary", type: "button", text: t("media.upload") });
  btn.onclick = async () => {
    const f = file.files[0];
    if (!f) return;
    btn.disabled = true;
    try {
      const qs = new URLSearchParams({ owner: personId });
      if (caption.value.trim()) qs.set("caption", caption.value.trim());
      if (year.value) qs.set("year", year.value);
      if (f.type === "application/pdf") {
        if (f.size > 10 * 1024 * 1024) throw new Error(t("media.toobig"));
        qs.set("kind", "document");
        await api(`/api/media?${qs}`, { method: "POST", body: f });
      } else {
        qs.set("kind", "photo");
        const full = await toJpeg(f, 2048, 0.85);
        const r = await api(`/api/media?${qs}`, { method: "POST", body: full });
        // Thumb is best-effort: has_thumb stays 0 and src() falls back to the full image if it fails.
        try {
          const thumb = await toJpeg(f, 400, 0.8);
          await api(`/api/media/${r.id}/thumb`, { method: "PUT", body: thumb });
        } catch { /* upload already succeeded; degrade gracefully */ }
      }
      ctx.toast(t("media.uploaded"));
      await reload();
    } catch (e) { toastApiError(ctx, e); btn.disabled = false; }
  };
  return h("div", { class: "media-upload row" }, file, caption, year, btn);
}

// Delete button (own files or admin) plus, for admins, an "Edytuj" disclosure with caption/year/owner/tags.
function fileControls(m, ctx, { admin, people, reload }) {
  const nodes = [];
  if (admin || m.uploaded_by === ctx.state.me.account.id) {
    const del = h("button", { class: "btn danger", type: "button", text: t("media.delete") });
    del.onclick = async () => {
      if (!confirm(t("confirm"))) return;
      try { await api(`/api/media/${m.id}`, { method: "DELETE" }); await reload(); }
      catch (e) { toastApiError(ctx, e); }
    };
    nodes.push(del);
  }
  if (admin) {
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
    const editForm = h("div", { class: "media-file-edit" },
      h("div", { class: "row" }, caption, year),
      ownerSel,
      h("p", { class: "muted", text: t("media.tags") }), ...tagBoxes,
      h("div", { class: "row" }, save));
    nodes.push(h("details", {}, h("summary", { text: t("media.edit") }), editForm));
  }
  return nodes;
}

// Gallery section for one person: photo strip + document list + counter.
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
    wrap.append(h("div", { class: "kv" }, h("span", { class: "muted", text: `${t("media.title")}: ` }), h("span", { class: "muted", text: `${counts.used}/${counts.cap}` })));
    if (photos.length) wrap.append(h("div", { class: "media-strip" }, ...photos.map((m, idx) => {
      const im = h("img", { class: "media-thumb", src: src(m), alt: m.caption || "", loading: "lazy" });
      im.onclick = () => openViewer(items, idx);
      if (!editable) return im;
      return h("div", { class: "media-item" }, im, ...fileControls(m, ctx, { admin, people, reload }));
    })));
    if (documents.length) wrap.append(h("ul", { class: "list media-docs" }, ...documents.map((m) => {
      const a = h("a", { href: `/api/media/${m.id}`, target: "_blank", rel: "noopener", text: `📄 ${m.caption || t("media.document")}${m.year ? ` (${m.year})` : ""}` });
      return editable ? h("li", {}, a, ...fileControls(m, ctx, { admin, people, reload })) : h("li", {}, a);
    })));
    if (!photos.length && !documents.length) wrap.append(h("p", { class: "muted", text: t("media.empty") }));
    if (editable && counts.used < counts.cap) wrap.append(uploadForm(personId, ctx, reload));
  }
  await reload();
  return wrap;
}
