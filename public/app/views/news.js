import { api } from "../api.js";
import { t } from "../i18n.js";
import { h, clear, fmtAgo } from "../dom.js";
import { loadGraph } from "../people.js";
import { upcoming, todayInWarsaw, plural } from "../events.js";

export function sentence(item) {
  const d = item.details || {};
  const vars = { actor: item.actor_email ? (item.actor_name ? `${item.actor_email} (${item.actor_name})` : item.actor_email) : "—", email: d.email || item.target_id || "", role: d.role || "", lang: d.lang || "", action: item.action, name: d.name || "", other: d.other_name || "" };
  const key = `news.${item.action}`;
  const s = t(key, vars);
  return s === key ? t("news.other", vars) : s;
}

// Same templates as sentence(), but renders {actor} and {name} as clickable links to the
// person's tree page (falling back to plain text when there is nothing to link to).
export function sentenceNodes(item, ctx) {
  const d = item.details || {};
  const vars = { email: d.email || item.target_id || "", role: d.role || "", lang: d.lang || "", action: item.action, other: d.other_name || "" };
  const key = `news.${item.action}`;
  let s = t(key, vars);
  if (s === key) s = t("news.other", vars);
  const actorNode = () => item.actor_person_id
    ? h("a", { href: `/app/tree/${item.actor_person_id}`, "data-link": true, text: item.actor_name })
    : document.createTextNode(t("news.someone"));
  const nameNode = () => item.target_type === "person"
    ? h("a", { href: `/app/tree/${item.target_id}`, "data-link": true, text: d.name || "" })
    : document.createTextNode(d.name || "");
  return s.split(/(\{actor\}|\{name\})/).filter((part) => part !== "").map((part) => {
    if (part === "{actor}") return actorNode();
    if (part === "{name}") return nameNode();
    return document.createTextNode(part);
  });
}

export async function render(root, ctx) {
  clear(root);
  root.append(h("h1", { text: t("news.title") }));
  try {
    const g = await loadGraph();
    const events = upcoming(g.people, todayInWarsaw(new Date()), 30);
    // A gathering is the one date here that somebody decided on rather than one worked out from a
    // birth or death, and it is worth seeing from further off than thirty days.
    let meeting = null;
    try {
      const data = await api("/api/gatherings");
      if (data.gathering && !data.gathering.cancelled_at) {
        const days = Math.round((Date.parse(`${data.gathering.on_date}T00:00:00Z`) - Date.parse(`${todayInWarsaw(new Date())}T00:00:00Z`)) / 86400000);
        if (days >= 0) meeting = { on_date: data.gathering.on_date, days };
      }
    } catch { /* the gathering is not worth losing the birthdays over */ }
    if (events.length || meeting) {
      const lang = document.documentElement.lang;
      root.append(h("div", { class: "card upcoming" },
        h("h2", { text: t("events.title") }),
        h("ul", { class: "list" }, ...(meeting ? [h("li", { class: meeting.days === 0 ? "today" : null },
          "\u{1F389} ",
          h("a", { href: "/app/gathering", "data-link": true, text: t("gathering.title") }),
          ` — ${t("events.gathering")}, ${meeting.days === 0 ? t("events.today") : new Date(`${meeting.on_date}T12:00:00`).toLocaleDateString(document.documentElement.lang, { day: "numeric", month: "long", year: "numeric" })}`)] : []),
          ...events.map((ev) => {
          const p = g.byId.get(ev.person_id);
          const date = ev.inDays === 0 ? t("events.today") : new Date(`${ev.when}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "long" });
          const v = { years: ev.years };
          const text = plural(ev.years, lang, {
            one: t(`events.${ev.type}.one`, v), few: t(`events.${ev.type}.few`, v),
            many: t(`events.${ev.type}.many`, v), other: t(`events.${ev.type}.other`, v),
          });
          return h("li", { class: ev.inDays === 0 ? "today" : null },
            `${ev.type === "birthday" ? "🎂" : "🕯️"} `,
            h("a", { href: `/app/tree/${p.id}`, "data-link": true, text: p.display_name }),
            ` — ${text}, ${date}`);
        }))));
    }
  } catch { /* the box is decoration; the feed below must still render */ }
  const seenAt = ctx.state.me.account.news_seen_at || 0;
  const list = h("ul", { class: "list card" });
  const more = h("button", { class: "btn secondary", type: "button", text: t("news.more"), hidden: true });
  root.append(list, more);
  let next = null;
  const run = (p) => p.catch((e) => ctx.toast(ctx.errorText(e)));
  async function load(before) {
    const page = await api(`/api/news${before ? `?before=${before}` : ""}`);
    for (const item of page.items) {
      list.append(h("li", { class: item.at > seenAt ? "fresh" : null }, h("div", {}, ...sentenceNodes(item, ctx)), h("div", { class: "muted", text: fmtAgo(item.at) })));
    }
    next = page.next;
    more.hidden = !next;
    if (!list.children.length) list.append(h("li", { class: "muted", text: t("news.empty") }));
  }
  more.onclick = () => run(load(next));
  await load(null);
  api("/api/me", { method: "PATCH", body: { news_seen_at: Math.floor(Date.now() / 1000) } })
    .then(() => { ctx.state.me.account.news_seen_at = Math.floor(Date.now() / 1000); })
    .catch(() => {});
}
