import { api, passkeyGet, passkeysSupported } from "../api.js";
import { t } from "../i18n.js";
import { h, clear } from "../dom.js";

let step = "email";
let email = "";

export async function render(root, ctx) {
  const draw = () => { clear(root); root.append(h("h1", { text: t("login.title") }), STEPS[step](ctx, draw)); };
  draw();
}

const STEPS = {
  email(ctx, draw) {
    const input = h("input", { type: "email", id: "email", autocomplete: "email", required: true, value: email, autofocus: true });
    const err = h("p", { class: "error" });
    const btn = h("button", { class: "btn", type: "submit", text: t("login.continue") });
    const form = h("form", { class: "card" }, h("label", { for: "email", text: t("login.email") }), input, err, h("div", { class: "row" }, btn), h("p", { class: "muted" }, h("a", { href: "/app/join", "data-link": true, text: t("login.join") })));
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      email = input.value.trim().toLowerCase();
      btn.disabled = true;
      err.textContent = "";
      try {
        await api("/api/auth/email", { method: "POST", body: { email } });
        if (passkeysSupported()) { step = "passkey"; draw(); }
        else {
          await api("/api/auth/code/request", { method: "POST", body: { email } });
          step = "code"; draw();
        }
      } catch (e) { err.textContent = ctx.errorText(e); btn.disabled = false; }
    };
    return form;
  },

  passkey(ctx, draw) {
    const err = h("p", { class: "error" });
    const use = h("button", { class: "btn", type: "button", text: t("login.passkey.use") });
    const skip = h("button", { class: "btn secondary", type: "button", text: t("login.passkey.skip") });
    use.onclick = async () => {
      use.disabled = true;
      skip.disabled = true;
      try {
        const credential = await passkeyGet();
        await api("/api/auth/passkey/login", { method: "POST", body: { email, credential } });
        step = "email";
        await ctx.refreshMe();
        ctx.navigate("/app/", { replace: true });
      } catch (e) {
        err.textContent = e && e.name === "NotAllowedError" ? t("login.passkey.fail") : ctx.errorText(e);
        use.disabled = false;
        skip.disabled = false;
      }
    };
    skip.onclick = async () => {
      use.disabled = true;
      skip.disabled = true;
      try { await api("/api/auth/code/request", { method: "POST", body: { email } }); step = "code"; draw(); }
      catch (e) { err.textContent = ctx.errorText(e); use.disabled = false; skip.disabled = false; }
    };
    return h("div", { class: "card" },
      h("h2", { text: t("login.passkey.title") }),
      h("p", { text: t("login.passkey.text") }),
      err,
      h("div", { class: "row" }, use, skip));
  },

  code(ctx, draw) {
    const input = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{6}", maxlength: "6", autocomplete: "one-time-code", class: "code", id: "code", required: true, autofocus: true });
    const err = h("p", { class: "error" });
    const btn = h("button", { class: "btn", type: "submit", text: t("login.code.submit") });
    const again = h("button", { class: "btn secondary", type: "button", text: t("login.code.again") });
    const other = h("button", { class: "btn secondary", type: "button", text: t("login.other") });
    const form = h("form", { class: "card" },
      h("h2", { text: t("login.code.title") }),
      h("p", { text: t("login.code.text", { email }) }),
      h("label", { for: "code", text: t("login.code.label") }), input, err,
      h("div", { class: "row" }, btn), h("div", { class: "row" }, again, other));
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      btn.disabled = true; err.textContent = "";
      try {
        await api("/api/auth/code", { method: "POST", body: { email, code: input.value.trim() } });
        step = "email";
        await ctx.refreshMe();
        ctx.navigate("/app/", { replace: true });
      } catch (e) { err.textContent = ctx.errorText(e); btn.disabled = false; }
    };
    again.onclick = async () => {
      again.disabled = true;
      try { await api("/api/auth/code/request", { method: "POST", body: { email } }); ctx.toast(t("login.sent")); }
      catch (e) { err.textContent = ctx.errorText(e); }
      again.disabled = false;
    };
    other.onclick = () => { step = "email"; draw(); };
    return form;
  },
};
