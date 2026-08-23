import { api } from "../api.js";
import { h, clear } from "../dom.js";
import { getLang, t } from "../i18n.js";

const EMPTY = () => ({ first_name: "", last_name: "", birth_date: "", parent_text: "", email: "", message: "" });
let step = "form", form = EMPTY();

export async function render(root, ctx) {
  const draw = () => { clear(root); root.append(h("h1", { text: t("join.title") }), STEPS[step](ctx, draw)); };
  draw();
}

const STEPS = {
  form(ctx, draw) {
    const f = (name, type = "text", extra = {}) => { const id = `join-${name}`; const i = h("input", { type, id, required: true, value: form[name], autocomplete: "off", ...extra }); return [h("label", { for: id, text: t(`join.${name}`) }), i, [name, i]]; };
    const parts = [f("first_name"), f("last_name"), f("birth_date", "text", { placeholder: getLang() === "en" ? "YYYY-MM-DD" : "RRRR-MM-DD", pattern: "(~?\\d{4}|\\d{4}-\\d{2}|\\d{4}-\\d{2}-\\d{2})" }), f("parent_text"), f("email", "email", { autocomplete: "email" })];
    const message = h("textarea", { id: "join-message", rows: "3" }); message.value = form.message;
    const hp = h("input", { type: "text", name: "website", class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const err = h("p", { class: "error" });
    const send = h("button", { class: "btn", type: "submit", text: t("join.send") });
    const back = h("a", { href: "/app/login", "data-link": true, text: t("join.back") });
    const el = h("form", { class: "card" }, h("p", { text: t("join.intro") }), ...parts.flatMap(([l, i]) => [l, i]), h("label", { for: "join-message", text: t("join.message") }), message, hp, err, h("div", { class: "row" }, send), h("p", {}, back));
    el.onsubmit = async (ev) => {
      ev.preventDefault();
      for (const [, , [name, i]] of parts) form[name] = i.value.trim();
      form.message = message.value.trim();
      send.disabled = true; err.textContent = "";
      try { await api("/api/join/request", { method: "POST", body: { ...form, lang: getLang(), website: hp.value } }); step = "code"; draw(); }
      catch (e) { err.textContent = ctx.errorText(e); send.disabled = false; }
    };
    return el;
  },
  code(ctx, draw) {
    const input = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{6}", maxlength: "6", autocomplete: "one-time-code", class: "code", id: "join-code", required: true, autofocus: true });
    const err = h("p", { class: "error" });
    const btn = h("button", { class: "btn", type: "submit", text: t("join.confirm") });
    const other = h("button", { class: "btn secondary", type: "button", text: t("join.edit") });
    const el = h("form", { class: "card" }, h("h2", { text: t("login.code.title") }), h("p", { text: t("login.code.text", { email: form.email }) }), h("label", { for: "join-code", text: t("login.code.label") }), input, err, h("div", { class: "row" }, btn, other));
    el.onsubmit = async (ev) => {
      ev.preventDefault(); btn.disabled = true; err.textContent = "";
      try { const r = await api("/api/join/confirm", { method: "POST", body: { ...form, lang: getLang(), code: input.value.trim() } }); step = r.auto ? "auto" : "done"; draw(); }
      catch (e) { err.textContent = ctx.errorText(e); btn.disabled = false; }
    };
    other.onclick = () => { step = "form"; draw(); };
    return el;
  },
  done() { step = "form"; form = EMPTY(); return h("div", { class: "card" }, h("p", { text: t("join.done") }), h("p", {}, h("a", { href: "/app/login", "data-link": true, text: t("join.back") }))); },
  auto() { step = "form"; form = EMPTY(); return h("div", { class: "card" }, h("p", { text: t("join.auto") }), h("p", {}, h("a", { href: "/app/login", "data-link": true, text: t("login.title") }))); },
};
