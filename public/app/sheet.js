import { h } from "./dom.js";
import { t } from "./i18n.js";

let el = null, onCloseCb = null, opener = null, entry = false;

// A card the back button can dismiss: opening pushes a history entry, so Back closes the card and
// leaves the list behind it exactly where the reader left it, rather than walking off the page and
// rebuilding it from the top. × and Escape consume that entry again; a close the app itself asks
// for (a redraw, a navigation) abandons it, because the router has already moved history on and
// must not be dragged back. A sheet that replaces another keeps the one entry the pair share.
function pushEntry() {
  if (entry) return;
  entry = true;
  history.pushState({ sheet: true }, "", location.href);
  window.addEventListener("popstate", onPop);
}

function dropEntry(consume) {
  if (!entry) return;
  entry = false;
  window.removeEventListener("popstate", onPop);
  if (consume) history.back();
}

function onPop() {
  const cb = onCloseCb;
  entry = false;
  window.removeEventListener("popstate", onPop);
  teardown();
  if (cb) cb();
}

function userClose() { const cb = onCloseCb; dropEntry(true); teardown(); if (cb) cb(); }

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

// Takes the sheet off the page and hands focus back, leaving the history entry to the caller.
function teardown() {
  if (!el) return;
  el.remove();
  el = null;
  onCloseCb = null;
  document.body.classList.remove("sheet-open");
  document.removeEventListener("keydown", onKey);
  // Back to whatever opened it, so the keyboard does not start again from the top of the page.
  // preventScroll: the row is already in view, and bringing it there again would throw away the
  // reader's place in a long list.
  const back = opener;
  opener = null;
  if (back && document.contains(back)) back.focus({ preventScroll: true });
}

// full: covers the whole page (blocking editor). onClose fires only when the user closes it
// (×, Escape or Back), not when the app closes it programmatically on navigation/redraw.
export function openSheet(content, label, { full = false, onClose = null } = {}) {
  const opening = document.activeElement;      // captured before teardown moves focus anywhere
  teardown();
  opener = opening;
  const close = h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": t("close"), text: "×" });
  close.onclick = userClose;
  onCloseCb = onClose;
  el = h("div", { class: full ? "sheet full" : "sheet", role: "dialog", "aria-modal": "true", "aria-label": label }, close, content);
  document.body.append(el);
  document.body.classList.add("sheet-open");
  document.addEventListener("keydown", onKey);
  pushEntry();
  // preventScroll: the sheet is fixed and already in view, so bringing the close button into view
  // has nothing to do but throw away the reader's place in a long list behind it.
  close.focus({ preventScroll: true });
}

export function closeSheet() {
  if (!el) return;
  dropEntry(false);
  teardown();
}
