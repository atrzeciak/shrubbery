import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "../../public/app/views/account.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, byText } from "./helpers.js";

const root = () => q("#root");
const button = (text) => byText("button", text);
// "Wyloguj" names both a session's button and the sign-out button; the sign-out one is last.
const until = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await tick(); };
const signOut = () => qa("button").filter((b) => b.textContent === "Wyloguj").at(-1);
const passkeys = [{ id: "k1", name: "phone", created_at: 1700000000 }, { id: "k2", name: "laptop", created_at: 1710000000 }];
const sessions = [{ id: "s1", current: true, user_agent: "Mozilla", last_seen_at: 1 }, { id: "s2", current: false, user_agent: "x".repeat(60), last_seen_at: 1 }, { id: "s3", current: false, user_agent: null, last_seen_at: 1 }];
const base = () => ({ "GET /api/me/passkeys": { passkeys: [] }, "GET /api/me/sessions": { sessions: [sessions[0]] } });

// A WebAuthn attestation the way a browser hands it back.
const attestation = { id: "cred1", rawId: new Uint8Array([1]).buffer, type: "public-key", response: { attestationObject: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, getTransports: () => ["internal"] } };
function withPasskeys(create = async () => attestation) {
  vi.stubGlobal("PublicKeyCredential", class {});
  Object.defineProperty(navigator, "credentials", { value: { create }, configurable: true });
}

async function start(routes = base(), me = meFixture()) {
  document.body.innerHTML = '<div id="root"></div>';
  const calls = mockApi(routes);
  const ctx = viewCtx(me);
  await render(root(), ctx);
  return { calls, ctx };
}

beforeEach(async () => {
  await lang("pl");
  vi.stubGlobal("PublicKeyCredential", undefined);
  vi.stubGlobal("prompt", vi.fn(() => "new name"));
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(() => vi.stubGlobal("PublicKeyCredential", undefined));

describe("the account card", () => {
  it("shows the address and the role in the reader's language", async () => {
    await start(base(), meFixture({ account: { role: "admin" } }));
    expect(q(".card").textContent).toBe("Adres e-mail: me@x.orgRola: administrator");
    await lang("en");
    await start();
    expect(q(".card").textContent).toBe("Email address: me@x.orgRole: family");
  });
});

describe("passkeys", () => {
  it("says there are none and explains when the browser cannot add one", async () => {
    await start();
    expect(q("ul.list li").textContent).toBe("Brak kluczy dostępu.");
    expect(button("Dodaj klucz dostępu").disabled).toBe(true);
    expect(byText("p", "Ta przeglądarka nie obsługuje kluczy dostępu.")).not.toBeNull();
  });

  it("lists them with their dates; renaming asks for a name and saves it, cancelling does nothing", async () => {
    const { calls } = await start({ ...base(), "GET /api/me/passkeys": { passkeys }, "PATCH /api/me/passkeys/k1": {} });
    const rows = qa("ul.list")[0].children;
    expect([...rows].map((li) => q("strong", li).textContent)).toEqual(["phone", "laptop"]);
    expect(rows[0].textContent).toContain("2023");
    prompt.mockReturnValueOnce("");
    byText("button", "Zmień nazwę", rows[0]).click();
    await tick();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    byText("button", "Zmień nazwę", rows[0]).click();
    await tick();
    expect(prompt).toHaveBeenLastCalledWith("Nazwa (np. telefon)", "phone");
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", path: "/api/me/passkeys/k1", body: { name: "new name" } }]);
    expect(calls.filter((c) => c.path === "/api/me/passkeys").length).toBe(2);
  });

  it("removing asks first, then deletes and refreshes; a refusal is toasted", async () => {
    const { calls, ctx } = await start({ ...base(), "GET /api/me/passkeys": { passkeys }, "DELETE /api/me/passkeys/k1": {}, "DELETE /api/me/passkeys/k2": { status: 409, body: { error: "last_passkey" } } });
    const rows = qa("ul.list li");
    confirm.mockReturnValueOnce(false);
    byText("button", "Usuń", rows[0]).click();
    await tick();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    byText("button", "Usuń", rows[0]).click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/me/passkeys/k1"]);
    expect(ctx.refreshMe).toHaveBeenCalled();
    byText("button", "Usuń", qa("ul.list li")[1]).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("last_passkey");
    prompt.mockReturnValueOnce("");
    byText("button", "Zmień nazwę", qa("ul.list li")[0]).click();
  });

  it("toasts a failed rename", async () => {
    const { ctx } = await start({ ...base(), "GET /api/me/passkeys": { passkeys }, "PATCH /api/me/passkeys/k1": { status: 400, body: { error: "bad_request" } } });
    byText("button", "Zmień nazwę", q("ul.list li")).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("bad_request");
  });

  it("adds one: registers the credential under the name given, then refreshes", async () => {
    withPasskeys();
    const { calls, ctx } = await start({ ...base(), "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" }, "POST /api/me/passkeys": { id: "k9" } });
    const add = button("Dodaj klucz dostępu");
    expect(add.disabled).toBe(false);
    add.click();
    await tick();
    const post = calls.find((c) => c.path === "/api/me/passkeys" && c.method === "POST");
    expect(post.body.name).toBe("new name");
    expect(post.body.credential.id).toBe("cred1");
    expect(post.body.credential.response.transports).toEqual(["internal"]);
    expect(ctx.toast).toHaveBeenCalledWith("Klucz dodany.");
    expect(ctx.refreshMe).toHaveBeenCalled();
    // With no platform name to suggest and no name typed, it still gets a name.
    Object.defineProperty(navigator, "platform", { value: "", configurable: true });
    prompt.mockReturnValueOnce("");
    button("Dodaj klucz dostępu").click();
    await tick();
    expect(prompt).toHaveBeenLastCalledWith("Nazwa (np. telefon)", "");
    expect(calls.filter((c) => c.path === "/api/me/passkeys" && c.method === "POST").at(-1).body.name).toBe("passkey");
  });

  it("stays quiet when the browser prompt was dismissed, and toasts any other failure", async () => {
    withPasskeys(async () => { throw Object.assign(new Error("cancel"), { name: "NotAllowedError" }); });
    const { ctx } = await start({ ...base(), "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" } });
    button("Dodaj klucz dostępu").click();
    await tick();
    expect(ctx.toast).not.toHaveBeenCalled();
    expect(button("Dodaj klucz dostępu").disabled).toBe(false);
    withPasskeys();
    const second = await start({ ...base(), "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" }, "POST /api/me/passkeys": { status: 400, body: { error: "bad_request" } } });
    button("Dodaj klucz dostępu").click();
    await tick();
    expect(second.ctx.toast).toHaveBeenCalledWith("bad_request");
  });
});

describe("sessions", () => {
  it("names this device, shortens other agents, and signs out one of them", async () => {
    const { calls } = await start({ ...base(), "GET /api/me/sessions": { sessions }, "DELETE /api/me/sessions/s2": {} });
    const rows = qa("ul.list")[1].children;
    expect(q("strong", rows[0]).textContent).toBe("to urządzenie");
    expect(byText("button", "Wyloguj", rows[0]).hidden).toBe(true);
    expect(q("strong", rows[1]).textContent).toBe("x".repeat(40));
    expect(q("strong", rows[2]).textContent).toBe("");
    byText("button", "Wyloguj", rows[1]).click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/me/sessions/s2"]);
    expect(calls.filter((c) => c.path === "/api/me/sessions").length).toBe(2);
  });

  it("toasts when a session cannot be signed out", async () => {
    const { ctx } = await start({ ...base(), "GET /api/me/sessions": { sessions }, "DELETE /api/me/sessions/s2": { status: 404, body: { error: "not_found" } } });
    byText("button", "Wyloguj", qa("ul.list")[1].children[1]).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("not_found");
  });

  it("'sign out everywhere' asks, then ends every session and returns to the login page", async () => {
    const { calls, ctx } = await start({ ...base(), "POST /api/me/sessions/revoke-all": {} });
    confirm.mockReturnValueOnce(false);
    button("Wyloguj wszędzie").click();
    await tick();
    expect(calls.some((c) => c.path.endsWith("revoke-all"))).toBe(false);
    button("Wyloguj wszędzie").click();
    await tick();
    expect(calls.some((c) => c.path.endsWith("revoke-all"))).toBe(true);
    expect(ctx.state.me).toBeNull();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/login", { replace: true });
    const failed = await start({ ...base(), "POST /api/me/sessions/revoke-all": { status: 500, body: { error: "internal" } } });
    button("Wyloguj wszędzie").click();
    await tick();
    expect(failed.ctx.toast).toHaveBeenCalledWith("internal");
    expect(failed.ctx.state.me).not.toBeNull();
  });
});

describe("language", () => {
  it("saves the choice, switches the page, and redraws; a refusal is toasted", async () => {
    const { calls, ctx } = await start({ ...base(), "PATCH /api/me": {} });
    const select = q("select");
    expect(select.value).toBe("pl");
    select.value = "en";
    select.dispatchEvent(new Event("change"));
    await until(() => ctx.navigate.mock.calls.length);
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/me", body: { lang: "en" } });
    expect(document.documentElement.lang).toBe("en");
    expect(ctx.refreshMe).toHaveBeenCalled();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/account", { replace: true });
    const failed = await start({ ...base(), "PATCH /api/me": { status: 400, body: { error: "bad_request" } } });
    expect(q("select").value).toBe("en");
    q("select").value = "pl";
    q("select").dispatchEvent(new Event("change"));
    await until(() => failed.ctx.toast.mock.calls.length);
    expect(failed.ctx.toast).toHaveBeenCalledWith("bad_request");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("reminders", () => {
  it("cannot be switched on until the login is linked to a person", async () => {
    await start();
    expect(q("#notify-events").disabled).toBe(true);
    expect(q("#notify-events").checked).toBe(false);
    expect(q("#notify-events").closest(".card").querySelector("p").textContent).toBe("Najpierw administrator musi połączyć Twoje konto z osobą w drzewie.");
  });

  it("saves the switch and refreshes; a refusal flips it back and is toasted", async () => {
    const me = meFixture({ account: { person_id: "p1", notify_events: 1 } });
    const { calls, ctx } = await start({ ...base(), "PATCH /api/me": {} }, me);
    const box = q("#notify-events");
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await tick();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/me", body: { notify_events: 0 } });
    expect(ctx.refreshMe).toHaveBeenCalled();
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await tick();
    expect(calls.filter((c) => c.method === "PATCH").at(-1).body).toEqual({ notify_events: 1 });
    const failed = await start({ ...base(), "PATCH /api/me": { status: 500, body: { error: "internal" } } }, me);
    q("#notify-events").checked = false;
    q("#notify-events").dispatchEvent(new Event("change"));
    await tick();
    expect(q("#notify-events").checked).toBe(true);
    expect(failed.ctx.toast).toHaveBeenCalledWith("internal");
  });
});

describe("sign out", () => {
  it("ends the session and leaves for the login page", async () => {
    const { calls, ctx } = await start({ ...base(), "POST /api/auth/logout": {} });
    signOut().click();
    await tick();
    expect(calls.some((c) => c.path === "/api/auth/logout")).toBe(true);
    expect(ctx.state.me).toBeNull();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/login", { replace: true });
  });
});

describe("about", () => {
  it("names the released version and date, or calls itself a development build", async () => {
    await start({ ...base(), "GET /app/version.json": { version: "1.4.0", at: 1750000000 } });
    const line = qa(".card p.muted").at(-1).textContent;
    expect(line).toContain("Wersja 1.4.0");
    expect(line).toContain("2025");
    await start();
    expect(qa(".card p.muted").at(-1).textContent).toBe("Wersja robocza (dev)");
  });
});
