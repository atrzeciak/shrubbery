import { api, passkeyCreate, passkeysSupported } from "../api.js";
import { getLang, setLang, t } from "../i18n.js";
import { h, clear, fmtDate, fmtAgo } from "../dom.js";

export async function render(root, ctx) {
  const me = ctx.state.me;
  const redraw = () => render(root, ctx);
  clear(root);
  root.append(
    h("h1", { text: t("account.title") }),
    h("div", { class: "card" },
      h("div", {}, h("span", { class: "muted", text: `${t("account.email")}: ` }), me.account.email),
      h("div", {}, h("span", { class: "muted", text: `${t("account.role")}: ` }), t(`account.role.${me.account.role}`))),
    h("h2", { text: t("account.passkeys") }), await passkeys(ctx, redraw),
    h("h2", { text: t("account.sessions") }), await sessions(ctx, redraw),
    h("h2", { text: t("account.lang") }), language(ctx),
    h("h2", { text: t("account.notify.title") }), reminders(ctx),
    h("div", { class: "row" }, signOut(ctx)),
    h("h2", { text: t("about.title") }), await about(),
  );
}

async function passkeys(ctx, redraw) {
  const list = h("ul", { class: "list" });
  const { passkeys } = await api("/api/me/passkeys");
  if (!passkeys.length) list.append(h("li", { class: "muted", text: t("account.passkeys.empty") }));
  for (const p of passkeys) {
    const rename = h("button", { class: "btn secondary", type: "button", text: t("account.passkeys.rename") });
    const remove = h("button", { class: "btn danger", type: "button", text: t("account.passkeys.remove") });
    rename.onclick = async () => {
      const name = prompt(t("account.passkeys.name"), p.name);
      if (!name) return;
      try { await api(`/api/me/passkeys/${p.id}`, { method: "PATCH", body: { name } }); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e)); }
    };
    remove.onclick = async () => {
      if (!confirm(t("confirm"))) return;
      try { await api(`/api/me/passkeys/${p.id}`, { method: "DELETE" }); await ctx.refreshMe(); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e)); }
    };
    list.append(h("li", { class: "row" }, h("span", {}, h("strong", { text: p.name }), " ", h("span", { class: "muted", text: fmtDate(p.created_at) })), rename, remove));
  }
  const add = h("button", { class: "btn", type: "button", text: t("account.passkeys.add"), disabled: !passkeysSupported() });
  add.onclick = async () => {
    add.disabled = true;
    try {
      const credential = await passkeyCreate({ id: ctx.state.me.account.id, email: ctx.state.me.account.email });
      const name = prompt(t("account.passkeys.name"), navigator.platform || "") || "passkey";
      await api("/api/me/passkeys", { method: "POST", body: { name, credential } });
      ctx.toast(t("account.passkeys.added"));
      await ctx.refreshMe();
      await redraw();
    } catch (e) { if (!e || e.name !== "NotAllowedError") ctx.toast(ctx.errorText(e)); add.disabled = false; }
  };
  return h("div", { class: "card" }, list, h("div", { class: "row" }, add),
    passkeysSupported() ? null : h("p", { class: "muted", text: t("account.passkeys.unsupported") }));
}

async function sessions(ctx, redraw) {
  const list = h("ul", { class: "list" });
  const { sessions } = await api("/api/me/sessions");
  for (const s of sessions) {
    const revoke = h("button", { class: "btn secondary", type: "button", text: t("account.sessions.revoke"), hidden: s.current });
    revoke.onclick = async () => {
      try { await api(`/api/me/sessions/${s.id}`, { method: "DELETE" }); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e)); }
    };
    list.append(h("li", { class: "row" },
      h("span", {}, h("strong", { text: s.current ? t("account.sessions.current") : (s.user_agent || "").slice(0, 40) }), " ",
        h("span", { class: "muted", text: t("account.sessions.seen", { when: fmtAgo(s.last_seen_at) }) })),
      revoke));
  }
  const all = h("button", { class: "btn danger", type: "button", text: t("account.sessions.revokeAll") });
  all.onclick = async () => {
    if (!confirm(t("confirm"))) return;
    try { await api("/api/me/sessions/revoke-all", { method: "POST", body: {} }); ctx.state.me = null; ctx.navigate("/app/login", { replace: true }); } catch (e) { ctx.toast(ctx.errorText(e)); }
  };
  return h("div", { class: "card" }, list, h("div", { class: "row" }, all));
}

function language(ctx) {
  const select = h("select", { "aria-label": t("account.lang") },
    h("option", { value: "pl", text: t("account.lang.pl"), selected: getLang() === "pl" }),
    h("option", { value: "en", text: t("account.lang.en"), selected: getLang() === "en" }));
  select.onchange = async () => {
    try { await api("/api/me", { method: "PATCH", body: { lang: select.value } }); await setLang(select.value); await ctx.refreshMe(); ctx.navigate("/app/account", { replace: true }); }
    catch (e) { ctx.toast(ctx.errorText(e)); }
  };
  return h("div", { class: "card" }, select);
}

function reminders(ctx) {
  const me = ctx.state.me;
  const box = h("input", { type: "checkbox", id: "notify-events", checked: me.account.notify_events === 1, disabled: !me.account.person_id });
  box.onchange = async () => {
    try { await api("/api/me", { method: "PATCH", body: { notify_events: box.checked ? 1 : 0 } }); await ctx.refreshMe(); }
    catch (e) { box.checked = !box.checked; ctx.toast(ctx.errorText(e)); }
  };
  return h("div", { class: "card" },
    h("label", { class: "check", for: "notify-events" }, box, ` ${t("account.notify")}`),
    h("p", { class: "muted", text: me.account.person_id ? t("account.notify.hint") : t("account.notify.unlinked") }));
}

function signOut(ctx) {
  const btn = h("button", { class: "btn secondary", type: "button", text: t("account.signout") });
  btn.onclick = async () => {
    try { await api("/api/auth/logout", { method: "POST", body: {} }); } finally { ctx.state.me = null; ctx.navigate("/app/login", { replace: true }); }
  };
  return btn;
}

async function about() {
  let v = null;
  try { const res = await fetch("/app/version.json", { cache: "no-cache" }); if (res.ok) v = await res.json(); } catch { /* dev */ }
  const line = v && v.version
    ? t("about.version", { version: v.version, date: new Date(v.at * 1000).toLocaleString(document.documentElement.lang, { dateStyle: "long", timeStyle: "short" }) })
    : t("about.dev");
  return h("div", { class: "card" }, h("p", { class: "muted", text: line }));
}
