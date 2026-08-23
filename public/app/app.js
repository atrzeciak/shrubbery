import { api, ApiError, onStepUp, stepUp, passkeyCreate, passkeysSupported } from "./api.js";
import { initI18n, setLang, t } from "./i18n.js";
import { h, clear, fmtDate } from "./dom.js";
import * as login from "./views/login.js";
import * as join from "./views/join.js";
import * as news from "./views/news.js";
import * as account from "./views/account.js";
import * as admin from "./views/admin.js";
import * as members from "./views/members.js";
import * as me from "./views/me.js";
import * as tree from "./views/tree.js";
import * as gathering from "./views/gathering.js";
import { closeSheet } from "./sheet.js";

const SECTIONS = [
  { path: "/app/", key: "nav.news", view: news },
  { path: "/app/tree", key: "nav.tree", view: tree, prefix: true },
  { path: "/app/members", key: "nav.members", view: members },
  { path: "/app/gathering", key: "nav.gathering", view: gathering },
  { path: "/app/me", key: "nav.me", view: me },
  { path: "/app/account", key: "nav.account", view: account },
  { path: "/app/admin", key: "nav.admin", view: admin, role: "admin" },
];
const EXTRA = { "/app/login": login, "/app/join": join };
const PUBLIC = ["/app/login", "/app/join"];
const matches = (s, path) => s.path === path || (s.prefix && path.startsWith(`${s.path}/`));

export const state = { me: null };
let renderToken = 0;
let renderedPath = null;
const $ = (id) => document.getElementById(id);
const main = $("main"), side = $("side"), backdrop = $("backdrop"), menuBtn = $("menu-btn"), userBtn = $("user-btn"), toastEl = $("toast");

let toastTimer;
export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

export function errorText(e) {
  if (e instanceof ApiError) {
    const key = `error.${e.code}`;
    return t(key) === key ? t("error.internal") : t(key);
  }
  if (e instanceof TypeError) return t("error.network");
  return t("error.internal");
}

export async function refreshMe() {
  try {
    state.me = await api("/api/me");
    if (state.me.account.lang !== document.documentElement.lang) await setLang(state.me.account.lang);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) state.me = null; else throw e;
  }
  return state.me;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  render();
}

function currentPath() {
  const p = location.pathname.replace(/\/+$/, "") || "/app";
  return p === "/app" ? "/app/" : p;
}

function openMenu(open) {
  side.classList.toggle("open", open);
  backdrop.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
}

// Two initials read as a person; one letter of an e-mail reads as a placeholder.
function initialsOf(name) {
  const parts = String(name).trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  return parts.map((w) => w[0].toUpperCase()).join("") || "?";
}

function renderChrome() {
  document.querySelector(".brand").textContent = t("app.brand");
  const signedIn = !!state.me;
  menuBtn.hidden = !signedIn;
  side.hidden = !signedIn;
  userBtn.hidden = !signedIn;
  clear(side);
  if (!signedIn) return;
  const me = state.me.person;
  clear(userBtn);
  if (me?.avatar_at != null) {
    userBtn.append(h("img", { class: "avatar", src: `/api/people/${me.id}/avatar?v=${me.avatar_at}`, alt: "" }));
  } else {
    userBtn.textContent = initialsOf(me?.display_name || state.me.account.email);
  }
  userBtn.title = me?.display_name || t("nav.account");
  const path = currentPath();
  for (const s of SECTIONS) {
    if (s.role && state.me.account.role !== s.role) continue;
    side.append(h("a", { href: s.path, "data-link": true, "aria-current": matches(s, path) ? "page" : null, text: t(s.key) }));
  }
}

function passkeyBanner() {
  if (!state.me || state.me.passkeys > 0 || !passkeysSupported()) return null;
  const btn = h("button", { class: "btn", type: "button", text: t("banner.passkey.add") });
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const credential = await passkeyCreate({ id: state.me.account.id, email: state.me.account.email });
      await api("/api/me/passkeys", { method: "POST", body: { name: navigator.platform || "passkey", credential } });
      toast(t("account.passkeys.added"));
      await refreshMe();
      render();
    } catch (e) {
      if (!e || e.name !== "NotAllowedError") toast(errorText(e));
      btn.disabled = false;
    }
  };
  return h("div", { class: "banner row" }, h("span", { text: t("banner.passkey") }), btn);
}

// Only the warnings that are about a date get one; the rest read as whole sentences on their own.
const WARNING_DATE = {
  domain_soon: (ops) => ops.domain_expires_at,
  card_soon: (ops) => ops.card_expires_at,
};

// The site's own warnings about whether it will still be here next month. /api/me carries them for
// admins, so they sit above every view rather than behind a tab behind a passkey step-up.
function opsBanner() {
  const ops = state.me && state.me.ops;
  if (!ops || !ops.warnings.length) return null;
  const lines = ops.warnings.map((w) => {
    const date = WARNING_DATE[w];
    // The site names its own domain rather than carrying one in its strings.
    const vars = { domain: location.hostname, ...(date ? { when: fmtDate(date(ops)) } : {}) };
    return h("p", { text: t(`ops.warning.${w}`, vars) });
  });
  if (ops.checked_at) lines.push(h("p", { class: "muted", text: t("ops.checked", { when: fmtDate(ops.checked_at) }) }));
  return h("div", { class: "banner" }, ...lines);
}

export async function render() {
  const my = ++renderToken;
  const path = currentPath();
  renderedPath = path;
  const ctx = { state, navigate, refreshMe, toast, errorText };
  openMenu(false);
  closeSheet();
  if (!state.me && !PUBLIC.includes(path)) return navigate("/app/login", { replace: true });
  if (state.me && PUBLIC.includes(path)) return navigate("/app/", { replace: true });
  const section = SECTIONS.find((s) => matches(s, path) && (!s.role || state.me.account.role === s.role));
  const view = section ? section.view : EXTRA[path] || news;
  renderChrome();
  clear(main);
  for (const banner of [opsBanner(), passkeyBanner()]) if (banner) main.append(banner);
  const root = h("div");
  main.append(root);
  try {
    await view.render(root, ctx);
    if (my !== renderToken) return;
  } catch (e) {
    if (my !== renderToken) return;
    if (e instanceof ApiError && e.status === 401) { state.me = null; return navigate("/app/login", { replace: true }); }
    root.append(h("p", { class: "error", text: errorText(e) }));
  }
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-link]");
  if (!a || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", () => {
  // A dialog's own history entry pops with the URL unchanged: close it, don't redraw the page.
  if (currentPath() !== renderedPath) render();
});
menuBtn.onclick = () => openMenu(!side.classList.contains("open"));
backdrop.onclick = () => openMenu(false);
userBtn.onclick = () => navigate("/app/account");
onStepUp(async () => {
  try { await stepUp(); await refreshMe(); return true; } catch { toast(t("stepup.needed")); return false; }
});

(async () => {
  await initI18n(null);
  await refreshMe();
  document.title = t("app.title");
  render();
})();
