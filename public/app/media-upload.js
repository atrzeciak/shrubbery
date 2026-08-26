import { api } from "./api.js";
import { h, s } from "./dom.js";
import { t } from "./i18n.js";
import { pickKind, formatSize } from "./upload-rules.js";

// 409-with-person conflict gets its own message; everything else goes through errorText.
export function toastApiError(ctx, e) {
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

// The drop zone, the preview that replaces it, and the fields that only exist once a file does.
export function uploadForm(personId, ctx, reload) {
  let chosen = null;
  let previewUrl = null;

  const input = h("input", { type: "file", accept: "image/*,application/pdf", class: "vh" });
  const zone = h("label", { class: "media-drop" },
    input,
    h("span", { text: t("media.drop") }),
    h("span", { class: "muted small", text: t("media.accepts") }));

  const thumb = h("span", { class: "media-preview" });
  const name = h("span", { class: "media-name" });
  const size = h("span", { class: "muted small" });
  const drop = h("button", { class: "icon-btn small", type: "button", text: "✕", "aria-label": t("media.clear") });
  const card = h("div", { class: "media-chosen", hidden: true }, thumb, h("span", { class: "media-meta" }, name, size), drop);

  const caption = h("input", { type: "text", maxlength: "200", placeholder: t("media.caption"), "aria-label": t("media.caption") });
  const year = h("input", { type: "number", min: "1000", max: "2999", placeholder: t("media.year"), "aria-label": t("media.year") });
  const btn = h("button", { class: "btn secondary", type: "button", text: t("media.upload") });
  const fields = h("div", { class: "media-fields", hidden: true }, caption, h("div", { class: "row" }, year, btn));

  function release() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function reset() {
    release();
    chosen = null;
    input.value = "";
    zone.hidden = false;
    card.hidden = true;
    fields.hidden = true;
  }

  function choose(file) {
    const verdict = pickKind(file);
    if (verdict.error) { ctx.toast(t(`media.${verdict.error}`)); return; }
    release();
    chosen = file;
    name.textContent = file.name;
    size.textContent = formatSize(file.size, document.documentElement.lang);
    thumb.textContent = "";
    thumb.className = "media-preview";
    if (verdict.kind === "photo") {
      previewUrl = URL.createObjectURL(file);
      thumb.append(h("img", { src: previewUrl, alt: "" }));
    } else {
      thumb.classList.add("doc");
      thumb.append(s("svg", { class: "doc-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round", "aria-hidden": "true" },
        s("path", { d: "M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" }),
        s("path", { d: "M13.75 2.5V8.25h5.75" })));
    }
    zone.hidden = true;
    card.hidden = false;
    fields.hidden = false;
  }

  input.onchange = () => { if (input.files[0]) choose(input.files[0]); };
  drop.onclick = reset;

  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const ev of ["dragenter", "dragover"]) zone.addEventListener(ev, (e) => { swallow(e); zone.classList.add("is-over"); });
  for (const ev of ["dragleave", "dragend"]) zone.addEventListener(ev, (e) => { swallow(e); zone.classList.remove("is-over"); });
  zone.addEventListener("drop", (e) => {
    swallow(e);
    zone.classList.remove("is-over");
    if (e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
  });

  btn.onclick = async () => {
    if (!chosen) return;
    const verdict = pickKind(chosen);
    if (verdict.error) { ctx.toast(t(`media.${verdict.error}`)); return; }
    btn.disabled = true;
    btn.textContent = t("media.sending");
    try {
      const qs = new URLSearchParams({ owner: personId, kind: verdict.kind });
      if (caption.value.trim()) qs.set("caption", caption.value.trim());
      if (year.value) qs.set("year", year.value);
      if (verdict.kind === "document") {
        await api(`/api/media?${qs}`, { method: "POST", body: chosen });
      } else {
        const full = await toJpeg(chosen, 2048, 0.85);
        const r = await api(`/api/media?${qs}`, { method: "POST", body: full });
        // Thumb is best-effort: has_thumb stays 0 and the gallery falls back to the full image.
        try {
          const small = await toJpeg(chosen, 400, 0.8);
          await api(`/api/media/${r.id}/thumb`, { method: "PUT", body: small });
        } catch { /* upload already succeeded; degrade gracefully */ }
      }
      release();
      ctx.toast(t("media.uploaded"));
      await reload();
    } catch (e) {
      toastApiError(ctx, e);
      btn.disabled = false;
      btn.textContent = t("media.upload");
    }
  };

  return h("div", { class: "media-upload" }, zone, card, fields);
}
