import { h } from "./dom.js";
import { t } from "./i18n.js";

let el = null, onCloseCb = null, opener = null;
function userClose() { const cb = onCloseCb; closeSheet(); if (cb) cb(); }

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// aria-modal tells a screen reader the rest of the page is inert; nothing stops a Tab from walking
// out of the sheet into it. Keyboard and screen-reader users would be editing a person behind a
// dialog they cannot see, so the cycle is closed here by hand.
function trapTab(ev) {
  const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const inside = el.contains(document.activeElement);
  if (ev.shiftKey && (!inside || document.activeElement === first)) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && (!inside || document.activeElement === last)) { ev.preventDefault(); first.focus(); }
}

function onKey(ev) {
  if (ev.key === "Escape") userClose();
  else if (ev.key === "Tab" && el) trapTab(ev);
}

// full: covers the whole page (blocking editor). onClose fires only when the user closes it
// (× or Escape), not when the app closes it programmatically on navigation/redraw.
export function openSheet(content, label, { full = false, onClose = null } = {}) {
  const opening = document.activeElement;      // captured before closeSheet moves focus anywhere
  closeSheet();
  opener = opening;
  const close = h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": t("close"), text: "×" });
  close.onclick = userClose;
  onCloseCb = onClose;
  el = h("div", { class: full ? "sheet full" : "sheet", role: "dialog", "aria-modal": "true", "aria-label": label }, close, content);
  document.body.append(el);
  document.body.classList.add("sheet-open");
  document.addEventListener("keydown", onKey);
  close.focus();
}

export function closeSheet() {
  if (!el) return;
  el.remove();
  el = null;
  onCloseCb = null;
  document.body.classList.remove("sheet-open");
  document.removeEventListener("keydown", onKey);
  // Back to whatever opened it, so the keyboard does not start again from the top of the page.
  const back = opener;
  opener = null;
  if (back && document.contains(back)) back.focus();
}
