import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mockApi, meFixture, tick, q, qa } from "./helpers.js";

const html = (await readFile(resolve(process.cwd(), "public/app/index.html"), "utf8")).match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
const pl = JSON.parse(await readFile(resolve(process.cwd(), "public/app/i18n/pl.json"), "utf8"));
const en = JSON.parse(await readFile(resolve(process.cwd(), "public/app/i18n/en.json"), "utf8"));

const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await tick(); };
const settled = () => until(() => q("#main h1, #main form, #main .error"));
const navText = () => qa("#side a").map((a) => a.textContent);

// app.js runs on import, so each test gets a fresh module registry and a fresh page. The document
// outlives the modules, so listeners a previous import hung on it are taken down again.
const hung = [];
function fresh() {
  for (const [target, type, fn, opts] of hung.splice(0)) target.removeEventListener(type, fn, opts);
  vi.resetModules();
}
async function boot({ me = meFixture(), path = "/app/", routes = {} } = {}) {
  fresh();
  document.body.innerHTML = html;
  history.replaceState(null, "", path);
  const calls = mockApi({
    "GET /api/me": me === null ? { status: 401, body: { error: "unauthorized" } } : () => me,
    "GET /api/people": { people: [] }, "GET /api/gatherings": { gathering: null, guests: [], totals: {} },
    "GET /api/news": { items: [], next: null }, "PATCH /api/me": { ok: true },
    "GET /api/me/passkeys": { passkeys: [] }, "GET /api/me/sessions": { sessions: [] },
    ...routes,
  });
  const app = await import("../../public/app/app.js");
  await settled();
  return { app, calls };
}

beforeEach(() => {
  for (const target of [document, window]) {
    const real = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, fn, opts) => { hung.push([target, type, fn, opts]); real(type, fn, opts); });
  }
});
afterEach(() => { fresh(); vi.restoreAllMocks(); });

describe("boot", () => {
  it("signs a visitor out to the login page and hides the chrome", async () => {
    await boot({ me: null, path: "/app/members" });
    expect(location.pathname).toBe("/app/login");
    expect(q("#side").hidden).toBe(true);
    expect(q("#menu-btn").hidden).toBe(true);
    expect(q("#user-btn").hidden).toBe(true);
    expect(document.title).toBe(pl["app.title"]);
    expect(q(".brand").textContent).toBe(pl["app.brand"]);
  });

  it("sends a signed-in member away from the public pages", async () => {
    await boot({ path: "/app/login" });
    expect(location.pathname).toBe("/app/");
    expect(q("#main h1").textContent).toBe(pl["news.title"]);
  });

  it("follows the account's language", async () => {
    await boot({ me: meFixture({ account: { lang: "en" } }) });
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe(en["app.title"]);
    expect(navText()).toContain(en["nav.tree"]);
  });

  it("lets the join page through without a session", async () => {
    await boot({ me: null, path: "/app/join" });
    expect(location.pathname).toBe("/app/join");
    expect(q("#main form")).not.toBeNull();
  });

  it("treats /app with and without a slash as the news page", async () => {
    await boot({ path: "/app" });
    expect(q("#side a[aria-current=page]").getAttribute("href")).toBe("/app/");
  });
});

describe("navigation", () => {
  it("shows the admin section only to an admin", async () => {
    await boot({ path: "/app/admin" });
    expect(navText()).not.toContain(pl["nav.admin"]);
    expect(q("#main h1").textContent).toBe(pl["news.title"]);   // an unknown section reads as news
    await boot({ me: meFixture({ account: { role: "admin" } }), path: "/app/admin", routes: { "GET /api/admin/join-requests": { requests: [] }, "GET /api/admin/documents": { documents: [] }, "GET /api/admin/invitations": { invitations: [] } } });
    expect(navText()).toContain(pl["nav.admin"]);
    expect(q("#main h1").textContent).toBe(pl["admin.title"]);
  });

  it("follows in-app links, marks the current section, and leaves a modified click to the browser", async () => {
    const { calls } = await boot();
    q('#side a[href="/app/tree/"], #side a[href="/app/tree"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settled();
    expect(location.pathname).toBe("/app/tree");
    expect(q("#side a[aria-current=page]").textContent).toBe(pl["nav.tree"]);
    expect(q("#main h1").textContent).toBe(pl["tree.title"]);
    const before = calls.length;
    q('#side a[href="/app/members"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(calls.length).toBe(before);
    expect(q("#main h1").textContent).toBe(pl["tree.title"]);
  });

  it("treats a person's tree page as the tree section", async () => {
    await boot({ path: "/app/tree/p1" });
    expect(q("#side a[aria-current=page]").textContent).toBe(pl["nav.tree"]);
  });

  it("redraws on back and forward, but not when only a dialog's entry popped", async () => {
    const { calls } = await boot();
    history.replaceState(null, "", "/app/gathering");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settled();
    expect(q("#main h1").textContent).toBe(pl["gathering.title"]);
    const before = calls.length;
    window.dispatchEvent(new PopStateEvent("popstate"));
    await tick();
    expect(calls.length).toBe(before);
  });

  it("keeps only the latest of two overlapping renders", async () => {
    const { app } = await boot();
    app.navigate("/app/gathering");
    app.navigate("/app/members");
    await settled();
    await tick();
    expect(q("#main h1").textContent).toBe(pl["members.title"]);
    expect(qa("#main h1")).toHaveLength(1);
  });

  it("opens and closes the menu, and the avatar button goes to the account", async () => {
    await boot();
    q("#menu-btn").click();
    expect(q("#side").classList.contains("open")).toBe(true);
    expect(q("#backdrop").hidden).toBe(false);
    expect(q("#menu-btn").getAttribute("aria-expanded")).toBe("true");
    q("#menu-btn").click();
    expect(q("#side").classList.contains("open")).toBe(false);
    q("#menu-btn").click();
    q("#backdrop").click();
    expect(q("#backdrop").hidden).toBe(true);
    q("#user-btn").click();
    await settled();
    expect(location.pathname).toBe("/app/account");
    expect(q("#side").classList.contains("open")).toBe(false);
  });
});

describe("the user button", () => {
  it("shows initials of the e-mail when no person is linked", async () => {
    await boot();
    expect(q("#user-btn").textContent).toBe("MX");
    expect(q("#user-btn").title).toBe(pl["nav.account"]);
  });

  it("shows the person's initials, or their photo when they have one", async () => {
    await boot({ me: meFixture({ person: { id: "p1", display_name: "Anna Nowak", avatar_at: null } }) });
    expect(q("#user-btn").textContent).toBe("AN");
    expect(q("#user-btn").title).toBe("Anna Nowak");
    await boot({ me: meFixture({ person: { id: "p1", display_name: "Anna Nowak", avatar_at: 9 } }) });
    expect(q("#user-btn img").getAttribute("src")).toBe("/api/people/p1/avatar?v=9");
  });
});

describe("toast and errors", () => {
  it("shows a toast and hides it again after a moment", async () => {
    const { app } = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    app.toast("hello");
    expect(q("#toast").hidden).toBe(false);
    expect(q("#toast").textContent).toBe("hello");
    app.toast("again");
    vi.advanceTimersByTime(3400);
    expect(q("#toast").hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(q("#toast").hidden).toBe(true);
    vi.useRealTimers();
  });

  it("turns errors into the right sentence", async () => {
    const { app } = await boot();
    const { ApiError } = await import("../../public/app/api.js");
    expect(app.errorText(new ApiError(403, "forbidden"))).toBe(pl["error.forbidden"]);
    expect(app.errorText(new ApiError(500, "no_such_code"))).toBe(pl["error.internal"]);
    expect(app.errorText(new TypeError("fetch failed"))).toBe(pl["error.network"]);
    expect(app.errorText(new Error("x"))).toBe(pl["error.internal"]);
  });

  it("shows a view's failure in place, and a lost session sends you to login", async () => {
    await boot({ path: "/app/tree", routes: { "GET /api/people": { status: 403, body: { error: "forbidden" } } } });
    expect(q("#main .error").textContent).toBe(pl["error.forbidden"]);
    const { app } = await boot({ path: "/app/tree", routes: { "GET /api/people": { status: 401, body: { error: "unauthorized" } } } });
    expect(location.pathname).toBe("/app/login");
    expect(app.state.me).toBeNull();
  });

  it("refreshMe rethrows anything that is not a lost session", async () => {
    const { app } = await boot();
    mockApi({ "GET /api/me": { status: 500, body: { error: "internal" } } });
    await expect(app.refreshMe()).rejects.toMatchObject({ code: "internal" });
  });
});

describe("banners", () => {
  it("lists the site's own warnings for an admin, with dates where they apply", async () => {
    const ops = { warnings: ["domain_soon", "backup_never", "card_soon"], domain_expires_at: 1_700_000_000, card_expires_at: 1_800_000_000, checked_at: 1_690_000_000 };
    await boot({ me: meFixture({ account: { role: "admin" }, ops }) });
    const lines = qa("#main .banner p").map((p) => p.textContent);
    expect(lines[0]).toContain(location.hostname);
    expect(lines[0]).toMatch(/2023/);
    expect(lines[1]).toBe(pl["ops.warning.backup_never"]);
    expect(lines[2]).toMatch(/2027/);
    expect(lines[3]).toMatch(/2023/);
    await boot({ me: meFixture({ account: { role: "admin" }, ops: { warnings: [], checked_at: 1 } }) });
    expect(q("#main .banner")).toBeNull();
  });

  it("offers a passkey only to a browser that can make one and an account without", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    await boot();
    expect(q("#main .banner")).toBeNull();
    vi.stubGlobal("PublicKeyCredential", class {});
    await boot({ me: meFixture({ passkeys: 1 }) });
    expect(q("#main .banner")).toBeNull();
    await boot();
    expect(q("#main .banner").textContent).toContain(pl["banner.passkey"]);
  });
});

const cred = { id: "c1", rawId: new Uint8Array([1, 2]).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([3]).buffer, attestationObject: new Uint8Array([4]).buffer, authenticatorData: new Uint8Array([5]).buffer, signature: new Uint8Array([6]).buffer, userHandle: null, getTransports: () => ["internal"] } };
const passkeyRoutes = { "POST /api/auth/passkey/challenge": { challenge: "AQID", rpId: "test.local" }, "POST /api/me/passkeys": { id: "k1" }, "POST /api/auth/passkey/step-up": { ok: true } };

describe("passkeys", () => {
  beforeEach(() => vi.stubGlobal("PublicKeyCredential", class {}));

  it("registers one from the banner and then stops asking", async () => {
    const create = vi.fn(async () => cred);
    vi.stubGlobal("navigator", { platform: "TestOS", credentials: { create } });
    let passkeys = 0;
    const { calls } = await boot({ routes: { ...passkeyRoutes, "GET /api/me": () => meFixture({ passkeys }) } });
    q("#main .banner button").click();
    passkeys = 1;
    await until(() => q("#main .banner") === null);
    const posted = calls.find((c) => c.path === "/api/me/passkeys");
    expect(posted.body.name).toBe("TestOS");
    expect(posted.body.credential.rawId).toBe("AQI");
    expect(posted.body.credential.response.transports).toEqual(["internal"]);
    expect(create.mock.calls[0][0].publicKey.rp.id).toBe("test.local");
    expect(q("#toast").textContent).toBe(pl["account.passkeys.added"]);
  });

  it("stays quiet when the user cancels, and complains about anything else", async () => {
    const create = vi.fn(async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); });
    vi.stubGlobal("navigator", { credentials: { create } });
    await boot({ routes: passkeyRoutes });
    const btn = q("#main .banner button");
    btn.click();
    await until(() => !btn.disabled);
    expect(q("#toast").hidden).toBe(true);
    create.mockRejectedValueOnce(new TypeError("offline"));
    btn.click();
    await until(() => !q("#toast").hidden);
    expect(q("#toast").textContent).toBe(pl["error.network"]);
  });

  it("answers a step-up demand with the passkey and retries the call", async () => {
    const get = vi.fn(async () => cred);
    vi.stubGlobal("navigator", { credentials: { get } });
    let asked = 0;
    const { calls } = await boot({ routes: { ...passkeyRoutes, "POST /api/admin/x": () => (asked++ ? { done: true } : { status: 401, body: { error: "step_up_required" } }) } });
    const { api } = await import("../../public/app/api.js");
    expect(await api("/api/admin/x", { method: "POST", body: {} })).toEqual({ done: true });
    const paths = calls.map((c) => c.path);
    expect(paths.indexOf("/api/auth/passkey/step-up")).toBeGreaterThan(paths.indexOf("/api/admin/x"));
    expect(paths.filter((p) => p === "/api/admin/x")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/me")).toHaveLength(2);
  });

  it("explains when the step-up cannot be done", async () => {
    vi.stubGlobal("navigator", { credentials: { get: async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); } } });
    await boot({ routes: { ...passkeyRoutes, "POST /api/admin/x": { status: 401, body: { error: "step_up_required" } } } });
    const { api } = await import("../../public/app/api.js");
    await expect(api("/api/admin/x", { method: "POST", body: {} })).rejects.toMatchObject({ code: "step_up_required" });
    expect(q("#toast").textContent).toBe(pl["stepup.needed"]);
  });
});
