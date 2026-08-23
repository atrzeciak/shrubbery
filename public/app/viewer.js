import { h } from "./dom.js";
import { t } from "./i18n.js";

// Full-screen photo viewer: swipe/arrows navigate, Escape or × closes.
export function openViewer(items, index = 0) {
  let i = index;
  const img = h("img", { class: "viewer-img", alt: "" });
  const cap = h("div", { class: "viewer-caption" });
  const show = (n) => {
    i = (n + items.length) % items.length;
    img.src = items[i].src;
    cap.textContent = [items[i].caption, items[i].year].filter(Boolean).join(" · ");
  };
  let closed = false;
  // Opening pushes a history entry so the phone's back button dismisses the viewer and
  // leaves the page behind it untouched; closing any other way consumes that entry again.
  const close = (fromPopstate) => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPopstate);
    if (!fromPopstate) history.back();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") close();
    if (ev.key === "ArrowLeft") show(i - 1);
    if (ev.key === "ArrowRight") show(i + 1);
  };
  const onPopstate = () => close(true);
  const btn = (txt, label, fn) => { const b = h("button", { class: "icon-btn viewer-btn", type: "button", "aria-label": label, text: txt }); b.onclick = fn; return b; };
  const el = h("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": t("media.viewer") },
    btn("×", t("close"), () => close()),
    items.length > 1 ? btn("‹", t("media.prev"), () => show(i - 1)) : null,
    img, cap,
    items.length > 1 ? btn("›", t("media.next"), () => show(i + 1)) : null);
  let startX = null;
  let swiped = false;
  el.addEventListener("pointerdown", (ev) => { startX = ev.clientX; swiped = false; });
  el.addEventListener("pointerup", (ev) => {
    if (startX == null) return;
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 40) { show(dx > 0 ? i - 1 : i + 1); swiped = true; }
    startX = null;
  });
  // A swipe fires a click right after pointerup; don't let it also close the viewer.
  el.onclick = (ev) => { if (ev.target === el && !swiped) close(); };
  document.addEventListener("keydown", onKey);
  history.pushState({ viewer: true }, "", location.href);
  window.addEventListener("popstate", onPopstate);
  document.body.append(el);
  show(i);
  return el;
}
