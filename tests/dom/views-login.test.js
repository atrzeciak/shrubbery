import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "../../public/app/views/login.js";
import { ApiError } from "../../public/app/api.js";
import { mockApi, lang, viewCtx, tick, q, submit, byText } from "./helpers.js";

const root = () => q("#root");
const button = (text) => byText("button", text);

// A WebAuthn assertion the way a browser hands it back; the view only forwards it.
const assertion = { id: "cred1", rawId: new Uint8Array([1, 2]).buffer, type: "public-key", response: { authenticatorData: new Uint8Array([3]).buffer, clientDataJSON: new Uint8Array([4]).buffer, signature: new Uint8Array([5]).buffer, userHandle: null } };
function withPasskeys(get = async () => assertion) {
  vi.stubGlobal("PublicKeyCredential", class {});
  Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
}

// The view remembers its step between renders, as a real page would across re-renders; every
// test starts from the address form by walking whatever step is showing back to it.
async function start(ctx = viewCtx(null)) {
  document.body.innerHTML = '<div id="root"></div>';
  mockApi({ "POST /api/auth/code/request": {} });
  await render(root(), ctx);
  const skip = button("Pomiń — wyślij mi kod");
  if (skip) { skip.click(); await tick(); }
  const other = button("Inny adres");
  if (other) other.click();
  expect(q("#email")).not.toBeNull();
  return ctx;
}

async function sendEmail(ctx, routes, address = "Anna@Example.org ") {
  const calls = mockApi(routes);
  q("#email").value = address;
  submit(q("form"));
  await tick();
  return calls;
}

async function toCodeStep(ctx) {
  await sendEmail(ctx, { "POST /api/auth/email": {}, "POST /api/auth/code/request": {} });
  expect(q("#code")).not.toBeNull();
}

beforeEach(async () => { await lang("pl"); vi.stubGlobal("PublicKeyCredential", undefined); });
afterEach(() => vi.stubGlobal("PublicKeyCredential", undefined));

describe("email step", () => {
  it("shows the address form with a link to join, in the chosen language", async () => {
    await start();
    expect(q("h1").textContent).toBe("Logowanie");
    expect(q("a[data-link]").getAttribute("href")).toBe("/app/join");
    await lang("en");
    await start();
    expect(q("h1").textContent).toBe("Sign in");
    expect(button("Continue")).not.toBeNull();
  });

  it("without passkeys, registers the address, asks for a code, and moves to the code step", async () => {
    const ctx = await start();
    const calls = await sendEmail(ctx, { "POST /api/auth/email": {}, "POST /api/auth/code/request": {} });
    expect(calls).toEqual([
      { method: "POST", path: "/api/auth/email", body: { email: "anna@example.org" } },
      { method: "POST", path: "/api/auth/code/request", body: { email: "anna@example.org" } },
    ]);
    expect(q("form p").textContent).toContain("anna@example.org");
    expect(q("#code")).not.toBeNull();
  });

  it("shows the error and lets the visitor try again when the address is refused", async () => {
    const ctx = await start();
    await sendEmail(ctx, { "POST /api/auth/email": { status: 429, body: { error: "rate_limited" } } });
    expect(q(".error").textContent).toBe("rate_limited");
    expect(button("Dalej").disabled).toBe(false);
    expect(q("#email")).not.toBeNull();
  });

  it("with passkeys, offers the passkey step instead of sending a code", async () => {
    withPasskeys();
    const ctx = await start();
    const calls = await sendEmail(ctx, { "POST /api/auth/email": {} });
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/email"]);
    expect(q("h2").textContent).toBe("Klucz dostępu");
  });
});

describe("passkey step", () => {
  async function toPasskeyStep(get) {
    withPasskeys(get);
    const ctx = await start();
    await sendEmail(ctx, { "POST /api/auth/email": {} });
    expect(button("Użyj klucza dostępu")).not.toBeNull();
    return ctx;
  }

  it("signs in with the assertion, refreshes the session, and goes home", async () => {
    const ctx = await toPasskeyStep();
    const calls = mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" }, "POST /api/auth/passkey/login": {} });
    button("Użyj klucza dostępu").click();
    await tick();
    const login = calls.find((c) => c.path === "/api/auth/passkey/login");
    expect(login.body.email).toBe("anna@example.org");
    expect(login.body.credential.id).toBe("cred1");
    expect(ctx.refreshMe).toHaveBeenCalled();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/", { replace: true });
  });

  it("explains a cancelled passkey prompt in plain words and leaves the code path open", async () => {
    const ctx = await toPasskeyStep(async () => { throw Object.assign(new Error("cancel"), { name: "NotAllowedError" }); });
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" } });
    button("Użyj klucza dostępu").click();
    await tick();
    expect(q(".error").textContent).toBe("Nie udało się użyć klucza. Możesz zalogować się kodem.");
    expect(button("Użyj klucza dostępu").disabled).toBe(false);
    expect(button("Pomiń — wyślij mi kod").disabled).toBe(false);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("shows the server's refusal of the assertion", async () => {
    await toPasskeyStep();
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AAAA", rpId: "test.local" }, "POST /api/auth/passkey/login": { status: 401, body: { error: "unauthorized" } } });
    button("Użyj klucza dostępu").click();
    await tick();
    expect(q(".error").textContent).toBe("unauthorized");
  });

  it("skipping asks for a code and moves on; a refused request stays put with the error", async () => {
    await toPasskeyStep();
    mockApi({ "POST /api/auth/code/request": { status: 429, body: { error: "rate_limited" } } });
    button("Pomiń — wyślij mi kod").click();
    await tick();
    expect(q(".error").textContent).toBe("rate_limited");
    expect(button("Pomiń — wyślij mi kod").disabled).toBe(false);
    const calls = mockApi({ "POST /api/auth/code/request": {} });
    button("Pomiń — wyślij mi kod").click();
    await tick();
    expect(calls).toEqual([{ method: "POST", path: "/api/auth/code/request", body: { email: "anna@example.org" } }]);
    expect(q("#code")).not.toBeNull();
  });
});

describe("code step", () => {
  it("submits the code, refreshes the session, and goes home", async () => {
    const ctx = await start();
    await toCodeStep(ctx);
    const calls = mockApi({ "POST /api/auth/code": {} });
    q("#code").value = " 123456 ";
    submit(q("form"));
    await tick();
    expect(calls).toEqual([{ method: "POST", path: "/api/auth/code", body: { email: "anna@example.org", code: "123456" } }]);
    expect(ctx.refreshMe).toHaveBeenCalled();
    expect(ctx.navigate).toHaveBeenCalledWith("/app/", { replace: true });
  });

  it("shows a wrong code and keeps the form usable", async () => {
    const ctx = await start();
    await toCodeStep(ctx);
    mockApi({ "POST /api/auth/code": { status: 400, body: { error: "invalid_code" } } });
    q("#code").value = "000000";
    submit(q("form"));
    await tick();
    expect(q(".error").textContent).toBe("invalid_code");
    expect(button("Zaloguj").disabled).toBe(false);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("sends a new code on request and says so; a refusal shows instead", async () => {
    const ctx = await start();
    await toCodeStep(ctx);
    const calls = mockApi({ "POST /api/auth/code/request": {} });
    button("Wyślij nowy kod").click();
    await tick();
    expect(calls).toEqual([{ method: "POST", path: "/api/auth/code/request", body: { email: "anna@example.org" } }]);
    expect(ctx.toast).toHaveBeenCalledWith("Jeśli ten adres jest zaproszony, kod jest w drodze.");
    mockApi({ "POST /api/auth/code/request": { status: 429, body: { error: "rate_limited" } } });
    button("Wyślij nowy kod").click();
    await tick();
    expect(q(".error").textContent).toBe("rate_limited");
    expect(button("Wyślij nowy kod").disabled).toBe(false);
  });

  it("'different address' returns to the address form with the address kept", async () => {
    const ctx = await start();
    await toCodeStep(ctx);
    button("Inny adres").click();
    expect(q("#email").value).toBe("anna@example.org");
  });

  it("errors the app raises without a code still read as text", async () => {
    const ctx = await start({ ...viewCtx(null), errorText: (e) => (e instanceof ApiError ? e.code : "network") });
    await toCodeStep(ctx);
    globalThis.__api = async () => { throw new TypeError("offline"); };
    q("#code").value = "123456";
    submit(q("form"));
    await tick();
    expect(q(".error").textContent).toBe("network");
  });
});
