import { api } from "../api.js";
import { t } from "../i18n.js";
import { h, clear } from "../dom.js";
import { today as dayIn } from "../events.js";

const daysUntil = (onDate, tz) => Math.round((Date.parse(`${onDate}T00:00:00Z`) - Date.parse(`${dayIn(new Date(), tz)}T00:00:00Z`)) / 86400000);

const longDate = (onDate) =>
  new Date(`${onDate}T12:00:00`).toLocaleDateString(document.documentElement.lang, { day: "numeric", month: "long", year: "numeric" });

// The admin form doubles as create and edit: the same four fields either way.
function form(g, onSaved, ctx) {
  const date = h("input", { type: "date", value: g?.on_date || "", "aria-label": t("gathering.admin.date"), required: true });
  const place = h("input", { type: "text", value: g?.place || "", "aria-label": t("gathering.admin.place"), placeholder: t("gathering.admin.place"), maxlength: "120" });
  const note = h("textarea", { "aria-label": t("gathering.admin.note"), placeholder: t("gathering.admin.note"), maxlength: "500" });
  note.value = g?.note || "";
  const save = h("button", { class: "btn", type: "button", text: t("gathering.admin.save") });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = { on_date: date.value, place: place.value, note: note.value };
      if (g) await api(`/api/admin/gatherings/${g.id}`, { method: "PATCH", body });
      else await api("/api/admin/gatherings", { method: "POST", body });
      await onSaved();
    } catch (e) {
      ctx.toast(ctx.errorText(e));
      save.disabled = false;
    }
  };
  return h("div", { class: "card" },
    h("h2", { text: g ? t("gathering.admin.edit") : t("gathering.admin.new") }),
    h("div", { class: "field" }, h("label", { text: t("gathering.admin.date") }), date),
    h("div", { class: "field" }, h("label", { text: t("gathering.admin.place") }), place),
    h("div", { class: "field" }, h("label", { text: t("gathering.admin.note") }), note),
    h("div", { class: "row" }, save));
}

// One answer, whoever it is for: the member answering for themselves and the admin answering for
// somebody who telephoned use the same two controls.
function answerControls(current, onSave) {
  const yes = h("button", { class: current?.coming === 1 ? "btn" : "btn secondary", type: "button", text: t("gathering.rsvp.yes") });
  const no = h("button", { class: current?.coming === 0 ? "btn" : "btn secondary", type: "button", text: t("gathering.rsvp.no") });
  const count = h("input", { type: "number", min: "1", max: "50", value: String(current?.headcount || 1), "aria-label": t("gathering.rsvp.howmany") });
  const countField = h("label", { class: "field inline" }, h("span", { text: t("gathering.rsvp.howmany") }), count);
  countField.hidden = current?.coming === 0;
  yes.onclick = () => { countField.hidden = false; onSave({ coming: 1, headcount: Number(count.value) || 1 }); };
  no.onclick = () => { countField.hidden = true; onSave({ coming: 0 }); };
  count.onchange = () => { if (!countField.hidden) onSave({ coming: 1, headcount: Number(count.value) || 1 }); };
  return h("div", { class: "row rsvp" }, yes, no, countField);
}

export async function render(root, ctx) {
  const isAdmin = ctx.state.me.account.role === "admin";
  const myPerson = ctx.state.me.account.person_id;
  root.append(h("h1", { text: t("gathering.title") }));
  const body = h("div");
  root.append(body);

  const draw = async () => {
    clear(body);
    const data = await api("/api/gatherings");
    const g = data.gathering;
    if (!g) {
      body.append(h("p", { class: "muted", text: isAdmin ? t("gathering.none.admin") : t("gathering.none") }));
      if (isAdmin) body.append(form(null, draw, ctx));
      return;
    }
    const days = daysUntil(g.on_date, ctx.state.me.tz);
    body.append(h("div", { class: "card" },
      h("h2", { text: longDate(g.on_date) }),
      g.cancelled_at ? h("p", { class: "error", text: t("gathering.cancelled") }) : null,
      days >= 0 ? h("p", { class: "muted", text: days === 0 ? t("gathering.today") : t("gathering.in.days", { days }) }) : null,
      g.place ? h("p", { text: t("gathering.where", { place: g.place }) }) : null,
      g.note ? h("p", { text: g.note }) : null));

    body.append(h("div", { class: "card totals" },
      h("p", {}, `${t("gathering.totals.coming")}: `, h("strong", { text: t("gathering.totals.people", { n: data.totals.coming }) })),
      h("p", { class: "muted", text: `${t("gathering.totals.not")}: ${data.totals.not_coming}` }),
      h("p", { class: "muted", text: `${t("gathering.totals.unanswered")}: ${data.totals.unanswered}` })));

    // Own answer first, so a member does not have to hunt for their own name in the family.
    if (!g.cancelled_at) {
      const mine = data.guests.find((x) => x.person_id === myPerson);
      const card = h("div", { class: "card" }, h("h2", { text: t("gathering.rsvp.question") }));
      if (!myPerson) card.append(h("p", { class: "muted", text: t("gathering.rsvp.nolink") }));
      else {
        card.append(answerControls(mine, async (answer) => {
          try {
            await api(`/api/gatherings/${g.id}/rsvp`, { method: "PUT", body: answer });
            ctx.toast(t("gathering.rsvp.saved"));
            await draw();
          } catch (e) { ctx.toast(ctx.errorText(e)); }
        }));
      }
      body.append(card);
    }

    // The whole living family, unanswered first for an admin because that list is the telephone
    // worklist; answered first for everyone else, because for them it is news.
    const guests = data.guests.slice().sort((a, b) => {
      const rank = (x) => (x.coming === null ? 0 : 1);
      return isAdmin ? rank(a) - rank(b) || a.display_name.localeCompare(b.display_name)
        : rank(b) - rank(a) || a.display_name.localeCompare(b.display_name);
    });
    const list = h("ul", { class: "list card" });
    for (const guest of guests) {
      const answer = guest.coming === null ? t("gathering.guest.noanswer")
        : guest.coming ? t("gathering.guest.coming", { n: guest.headcount })
          : t("gathering.guest.not");
      const row = h("li", {},
        h("div", {}, h("a", { href: `/app/tree/${guest.person_id}`, "data-link": true, text: guest.display_name })),
        h("div", { class: "muted", text: guest.on_behalf ? `${answer} · ${t("gathering.guest.onbehalf")}` : answer }));
      if (isAdmin && !g.cancelled_at) {
        const open = h("button", { class: "btn secondary small", type: "button", text: t("gathering.guest.answer") });
        open.onclick = () => {
          open.replaceWith(answerControls(guest, async (a) => {
            try {
              await api(`/api/admin/gatherings/${g.id}/rsvp/${guest.person_id}`, { method: "PUT", body: a });
              await draw();
            } catch (e) { ctx.toast(ctx.errorText(e)); }
          }));
        };
        row.append(open);
      }
      list.append(row);
    }
    body.append(list);

    if (isAdmin) {
      body.append(form(g, draw, ctx));
      const cancel = h("button", { class: "btn danger", type: "button", text: g.cancelled_at ? t("gathering.admin.uncancel") : t("gathering.admin.cancel") });
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          await api(`/api/admin/gatherings/${g.id}`, { method: "PATCH", body: { cancelled: g.cancelled_at ? 0 : 1 } });
          await draw();
        } catch (e) { ctx.toast(ctx.errorText(e)); cancel.disabled = false; }
      };
      const del = h("button", { class: "btn danger", type: "button", text: t("gathering.admin.delete") });
      del.onclick = async () => {
        if (!confirm(t("gathering.admin.delete.confirm"))) return;
        del.disabled = true;
        try {
          await api(`/api/admin/gatherings/${g.id}`, { method: "DELETE" });
          await draw();
        } catch (e) { ctx.toast(ctx.errorText(e)); del.disabled = false; }
      };
      // Both of these write to real people and cannot be taken back, so each asks first and each
      // disappears once it has been done.
      const mailButton = (key, path) => {
        const b = h("button", { class: "btn secondary", type: "button", text: t(`gathering.admin.${key}`) });
        b.onclick = async () => {
          if (!confirm(t("gathering.admin.confirm"))) return;
          b.disabled = true;
          try {
            const r = await api(`/api/admin/gatherings/${g.id}/${path}`, { method: "POST", body: {} });
            ctx.toast(t("gathering.admin.sent", { n: r.sent }));
            await draw();
          } catch (e) { ctx.toast(ctx.errorText(e)); b.disabled = false; }
        };
        return b;
      };
      const mailRow = h("div", { class: "row" });
      if (!g.announced_at) mailRow.append(mailButton("announce", "announce"));
      else if (!g.nudged_at) mailRow.append(mailButton("nudge", "nudge"));
      body.append(mailRow, h("div", { class: "row" }, cancel, del));
    }
  };
  await draw();
}
