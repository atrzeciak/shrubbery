import { api } from "../api.js";
import { t } from "../i18n.js";
import { h, clear, fmtDate, fmtAgo } from "../dom.js";
import { sentence } from "./news.js";
import { lifeSpan } from "../graph.js";
import { loadGraph } from "../people.js";
import { openSheet, closeSheet } from "../sheet.js";

let tab = "invitations";
const TABS = ["invitations", "accounts", "history", "backup"];

export async function render(root, ctx) {
  closeSheet();
  clear(root);
  root.append(h("h1", { text: t("admin.title") }));
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const panel = h("div");
  for (const name of TABS) {
    const b = h("button", { type: "button", role: "tab", "aria-selected": String(tab === name), text: t(`admin.tab.${name}`) });
    b.onclick = () => { tab = name; render(root, ctx); };
    tabs.append(b);
  }
  root.append(tabs, panel);
  await PANELS[tab](panel, ctx, () => render(root, ctx));
}

const act = (ctx, redraw) => async (fn) => { try { await fn(); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e)); } };

// A type-to-find person input. The label carries the years and the parents, which is what tells
// two people with the same name apart; when even that collides, a counter is added.
// `value()` yields the id only when the text names exactly one person, so nothing links blind.
function personPicker(g, people, { id, initial = null, placeholder }) {
  const parents = (p) => g.parents(p.id).map((pid) => g.byId.get(pid)?.display_name).filter(Boolean).join(" & ");
  const detail = (p) => [lifeSpan(p), parents(p) && t("admin.person.of", { parents: parents(p) })].filter(Boolean).join(" · ");
  const labels = new Map(), seen = new Map();
  for (const p of people) {
    const base = [p.display_name, detail(p)].filter(Boolean).join(" · ");
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    labels.set(n > 1 ? `${base} #${n}` : base, p.id);
  }
  const byId = new Map([...labels].map(([l, pid]) => [pid, l]));
  const el = h("input", { id, type: "search", list: `${id}-list`, placeholder, autocomplete: "off", value: byId.get(initial) || "" });
  const list = h("datalist", { id: `${id}-list` }, ...[...labels.keys()].map((l) => h("option", { value: l })));
  return { el, list, value: () => labels.get(el.value.trim()) || null };
}

const PANELS = {
  async invitations(panel, ctx, redraw) {
    const run = act(ctx, redraw);
    const { requests } = await api("/api/admin/join-requests");
    const g = await loadGraph();
    const reqList = h("ul", { class: "list card" });
    const open = requests.filter((r) => r.status === "pending");
    if (!open.length) reqList.append(h("li", { class: "muted", text: t("admin.requests.empty") }));
    for (const r of open) {
      const pick = personPicker(g, g.people, { id: `req-person-${r.id}`, initial: r.match, placeholder: t("admin.requests.create") });
      const approve = h("button", { class: "btn", type: "button", text: t("admin.requests.approve") });
      const reject = h("button", { class: "btn danger", type: "button", text: t("admin.requests.reject") });
      pick.el.oninput = () => { approve.disabled = !!pick.el.value.trim() && !pick.value(); };
      approve.onclick = () => { const pid = pick.value(); run(() => api(`/api/admin/join-requests/${r.id}/approve`, { method: "POST", body: pid ? { person_id: pid } : { create: true } })); };
      reject.onclick = () => { const note = prompt(t("admin.requests.note")); if (note !== null) run(() => api(`/api/admin/join-requests/${r.id}/reject`, { method: "POST", body: { note } })); };
      reqList.append(h("li", {},
        h("div", {}, h("strong", { text: `${r.first_name} ${r.last_name}` }), " ", h("span", { class: "muted", text: `${r.birth_date} · ${r.email} · ${fmtDate(r.created_at)}` })),
        h("div", { text: `${t("admin.requests.parent")}: ${r.parent_text}` }), r.message ? h("div", { class: "muted prewrap", text: r.message }) : null,
        r.match ? h("div", { class: "muted", text: t("admin.requests.match", { name: g.byId.get(r.match).display_name }) }) : null,
        h("div", { class: "row" }, pick.el, pick.list, approve, reject)));
    }
    panel.append(h("h2", { text: t("admin.requests.title") }), reqList, h("h2", { text: t("admin.tab.invitations") }));
    const email = h("input", { type: "email", required: true, id: "inv-email", autocomplete: "off" });
    const lang = h("select", { id: "inv-lang" }, h("option", { value: "pl", text: "Polski" }), h("option", { value: "en", text: "English" }));
    const { documents } = await api("/api/admin/documents");
    const attachment = h("select", { id: "inv-attachment" }, h("option", { value: "", text: t("admin.invite.attachment.none") }),
      ...documents.map((d) => h("option", { value: d.id, text: `${d.caption || d.id}${d.year ? ` (${d.year})` : ""} · ${Math.round(d.size / 1024)} KB` })));
    const send = h("button", { class: "btn", type: "submit", text: t("admin.invite.send") });
    const form = h("form", { class: "card" },
      h("label", { for: "inv-email", text: t("admin.invite.email") }), email,
      h("label", { for: "inv-lang", text: t("admin.invite.lang") }), lang,
      h("label", { for: "inv-attachment", text: t("admin.invite.attachment") }), attachment,
      h("div", { class: "row" }, send));
    form.onsubmit = (ev) => { ev.preventDefault(); run(async () => { await api("/api/admin/invitations", { method: "POST", body: { email: email.value, lang: lang.value, attachment: attachment.value || null } }); ctx.toast(t("admin.invite.sent")); }); };
    const list = h("ul", { class: "list card" });
    const { invitations } = await api("/api/admin/invitations");
    if (!invitations.length) list.append(h("li", { class: "muted", text: t("admin.invite.empty") }));
    for (const inv of invitations) {
      const resend = h("button", { class: "btn secondary", type: "button", text: t("admin.invite.resend") });
      const revoke = h("button", { class: "btn danger", type: "button", text: t("admin.invite.revoke") });
      resend.onclick = () => run(() => api(`/api/admin/invitations/${inv.id}/resend`, { method: "POST", body: {} }));
      revoke.onclick = () => confirm(t("confirm")) && run(() => api(`/api/admin/invitations/${inv.id}`, { method: "DELETE" }));
      const meta = `${inv.lang} · ${t("admin.invite.expires", { when: fmtDate(inv.expires_at) })}${inv.attachment_media_id ? " · 📎" : ""}`;
      list.append(h("li", { class: "row" }, h("span", {}, h("strong", { text: inv.email }), " ", h("span", { class: "muted", text: meta })), resend, revoke));
    }
    panel.append(form, list);
  },

  async accounts(panel, ctx, redraw) {
    const run = act(ctx, redraw);
    const { accounts } = await api("/api/admin/accounts");
    const g = await loadGraph();
    const list = h("ul", { class: "list card" });
    for (const a of accounts) {
      const self = a.id === ctx.state.me.account.id;
      const iAmFounder = ctx.state.me.account.founder === 1;
      const shielded = !!a.founder || (!!a.protected && !iAmFounder);   // out of this admin's reach
      const granting = a.role !== "admin";
      const role = h("button", {
        class: granting ? "btn grant" : "btn warn", type: "button",
        text: granting ? t("admin.accounts.grant") : t("admin.accounts.revoke"), hidden: self || !!a.disabled_at || shielded,
      });
      const disable = h("button", { class: "btn danger", type: "button", text: t("admin.accounts.disable"), hidden: self || !!a.disabled_at || shielded });
      const enable = h("button", { class: "btn secondary", type: "button", text: t("admin.accounts.enable"), hidden: !a.disabled_at });
      const signout = h("button", { class: "btn secondary", type: "button", text: t("admin.accounts.signout"), hidden: !!a.disabled_at });
      role.onclick = () => {
        const who = (a.person_id && g.byId.get(a.person_id)?.display_name) || a.email;
        if (!confirm(t(granting ? "admin.accounts.grant_confirm" : "admin.accounts.revoke_confirm", { who }))) return;
        run(() => api(`/api/admin/accounts/${a.id}`, { method: "PATCH", body: { role: granting ? "admin" : "family" } }));
      };
      disable.onclick = () => confirm(t("confirm")) && run(() => api(`/api/admin/accounts/${a.id}/disable`, { method: "POST", body: {} }));
      enable.onclick = () => run(() => api(`/api/admin/accounts/${a.id}/enable`, { method: "POST", body: {} }));
      signout.onclick = () => {
        const who = (a.person_id && g.byId.get(a.person_id)?.display_name) || a.email;
        if (!confirm(t("admin.accounts.signout_confirm", { who }))) return;
        run(() => api(`/api/admin/accounts/${a.id}/revoke-sessions`, { method: "POST", body: {} }));
      };
      const shield = h("button", {
        class: a.protected ? "btn warn" : "btn secondary", type: "button",
        text: a.protected ? t("admin.accounts.unprotect") : t("admin.accounts.protect"),
        hidden: !iAmFounder || self || !!a.founder || a.role !== "admin" || !!a.disabled_at,
      });
      shield.onclick = () => {
        const who = (a.person_id && g.byId.get(a.person_id)?.display_name) || a.email;
        const key = a.protected ? "admin.accounts.unprotect_confirm" : "admin.accounts.protect_confirm";
        if (!confirm(t(key, { who }))) return;
        run(() => api(`/api/admin/accounts/${a.id}`, { method: "PATCH", body: { protected: a.protected ? 0 : 1 } }));
      };
      const link = h("button", { class: "btn secondary", type: "button", text: a.person_id ? t("admin.accounts.unlink") : t("admin.accounts.link"), hidden: !!a.disabled_at });
      link.onclick = () => {
        if (a.person_id) {
          const who = g.byId.get(a.person_id)?.display_name || a.email;
          if (!confirm(t("admin.accounts.unlink_confirm", { who }))) return;
          return run(() => api(`/api/admin/accounts/${a.id}/unlink`, { method: "POST", body: {} }));
        }
        const free = g.people.filter((p) => !p.account_id);
        const same = free.find((p) => p.email && p.email.toLowerCase() === a.email);
        const pick = personPicker(g, free, { id: "link-person", initial: same?.id, placeholder: t("admin.accounts.link.find") });
        const ok = h("button", { class: "btn", type: "button", text: t("admin.accounts.link"), disabled: !pick.value() });
        pick.el.oninput = () => { ok.disabled = !pick.value(); };
        ok.onclick = () => run(() => api(`/api/admin/accounts/${a.id}/link`, { method: "POST", body: { person_id: pick.value() } }));
        openSheet(h("div", {}, h("h2", { text: a.email }), h("label", { for: "link-person", text: t("admin.accounts.link.person") }), pick.el, pick.list, h("div", { class: "row" }, ok)), a.email);
      };
      const meta = `${t(`account.role.${a.role}`)} · ${t("admin.accounts.passkeys", { n: a.passkeys })} · ${t("admin.accounts.seen", { when: fmtAgo(a.last_seen_at) })}${a.founder ? ` · ${t("admin.accounts.founder")}` : a.protected ? ` · ${t("admin.accounts.protected")}` : ""}${a.disabled_at ? ` · ${t("admin.accounts.disabled")}` : ""}${a.person_id ? ` · ${g.byId.get(a.person_id)?.display_name || "?"}` : ""}`;
      list.append(h("li", {},
        h("div", {}, h("strong", { text: a.email }), " ", h("span", { class: "muted", text: meta })),
        h("div", { class: "actions" },
          h("div", { class: "slot" }, role),
          h("div", { class: "slot" }, shield),
          h("div", { class: "slot" }, disable, enable),   // never both at once
          h("div", { class: "slot" }, signout),
          h("div", { class: "slot" }, link))));
    }
    panel.append(list, h("p", { class: "muted", text: t("admin.accounts.link_help") }));
  },

  async history(panel, ctx) {
    const { accounts } = await api("/api/admin/accounts");
    const filter = h("select", { "aria-label": t("admin.history.filter") }, h("option", { value: "", text: t("admin.history.all") }), ...accounts.map((a) => h("option", { value: a.id, text: a.email })));
    const list = h("ul", { class: "list card" });
    const more = h("button", { class: "btn secondary", type: "button", text: t("admin.history.more"), hidden: true });
    let next = null;
    const run = (p) => p.catch((e) => ctx.toast(ctx.errorText(e)));
    async function load(before) {
      const qs = new URLSearchParams();
      if (before) qs.set("before", before);
      if (filter.value) qs.set("account", filter.value);
      const page = await api(`/api/admin/history${qs.toString() ? `?${qs}` : ""}`);
      for (const item of page.items) list.append(h("li", {}, h("div", { text: sentence(item) }), h("div", { class: "muted", text: `${fmtDate(item.at)} · ${item.action}` })));
      next = page.next;
      more.hidden = !next;
      if (!list.children.length) list.append(h("li", { class: "muted", text: t("admin.history.empty") }));
    }
    filter.onchange = () => { clear(list); run(load(null)); };
    more.onclick = () => run(load(next));
    panel.append(h("div", { class: "card" }, filter), list, more);
    await load(null);
  },

  async backup(panel, ctx) {
    const info = await api("/api/admin/backup/check");
    const mb = Math.max(1, Math.round(info.media_bytes / 1_000_000));
    const button = h("button", { class: "btn", type: "button", text: t("admin.backup.download") });
    let lastAt = info.backup_at;
    let failedAt = info.backup_failed_at;
    // A failure only speaks while it is the most recent word: a good download afterwards settles it.
    const stateText = () => (failedAt && failedAt > (lastAt || 0)
      ? t("admin.backup.failed", { when: fmtDate(failedAt) })
      : lastAt ? t("admin.backup.last", { when: fmtDate(lastAt) }) : t("admin.backup.never"));
    const lastLine = h("p", { class: "muted", text: stateText() });
    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    button.onclick = async () => {
      button.disabled = true;
      try {
        // The check runs through api() first: a stale session answers with a step-up here, where the
        // passkey prompt still works, rather than in the middle of a file download.
        await api("/api/admin/backup/check");
      } catch (e) {
        ctx.toast(ctx.errorText(e));
        button.disabled = false;
        return;
      }
      location.href = "/api/admin/backup";
      // The server only writes backup_at once the ZIP body has fully streamed, so it is the one
      // signal the download actually completed — poll for it instead of trusting location.href.
      lastLine.textContent = t("admin.backup.pending");
      // The archive can be tens of megabytes and streams at the pace the browser reads it, so a slow
      // download is not a failed one. Either outcome is written down by the server, so this waits for
      // one of them rather than guessing from a timeout.
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        try {
          const check = await api("/api/admin/backup/check");
          if (check.backup_at !== lastAt || check.backup_failed_at !== failedAt) {
            lastAt = check.backup_at;
            failedAt = check.backup_failed_at;
            break;
          }
        } catch {
          // transient — keep polling until the loop gives up
        }
      }
      lastLine.textContent = stateText();
      button.disabled = false;
    };
    panel.append(h("div", { class: "card" },
      h("h2", { text: t("admin.backup.title") }),
      h("p", { class: "muted", text: t("admin.backup.what") }),
      h("p", { class: "muted", text: t("admin.backup.size", { files: info.files, mb }) }),
      lastLine,
      h("div", { class: "row" }, button)));
  },
};
