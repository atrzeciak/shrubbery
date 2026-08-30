import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError, onStepUp, passkeysSupported, passkeyGet, passkeyCreate, stepUp } from "../../public/app/api.js";
import { mockApi } from "./helpers.js";

// Not vi.unstubAllGlobals(): that would also drop the fetch stub every test relies on.
const realNavigator = globalThis.navigator;
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
afterEach(() => { onStepUp(null); setGlobal("navigator", realNavigator); delete globalThis.PublicKeyCredential; });

describe("api", () => {
  it("GETs with same-origin credentials and no content-type, and returns the JSON", async () => {
    const calls = mockApi({ "GET /api/me": { ok: 1 } });
    expect(await api("/api/me")).toEqual({ ok: 1 });
    expect(calls).toEqual([{ method: "GET", path: "/api/me", body: undefined }]);
  });
  it("sends an object body as JSON", async () => {
    const calls = mockApi({ "POST /api/x": {} });
    await api("/api/x", { method: "POST", body: { a: 1 } });
    expect(calls[0].body).toEqual({ a: 1 });
  });
  it("sends a Blob as-is under its own type, or octet-stream when it has none", async () => {
    const seen = [];
    globalThis.__api = async (path, init) => { seen.push(init); return new Response("{}"); };
    await api("/api/x", { method: "PUT", body: new Blob(["a"], { type: "image/jpeg" }) });
    await api("/api/x", { method: "PUT", body: new Blob(["a"]) });
    expect(seen[0].headers["content-type"]).toBe("image/jpeg");
    expect(seen[0].body).toBeInstanceOf(Blob);
    expect(seen[1].headers["content-type"]).toBe("application/octet-stream");
  });
  it("returns null for a successful response that is not JSON", async () => {
    globalThis.__api = async () => new Response("not json");
    expect(await api("/api/x")).toBeNull();
  });
  it("throws ApiError with status, code and detail on failure, defaulting the code to internal", async () => {
    mockApi({ "GET /api/a": { status: 409, body: { error: "conflict", person: "Ann" } } });
    const e = await api("/api/a").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("conflict");
    expect(e.detail.person).toBe("Ann");
    globalThis.__api = async () => new Response("boom", { status: 500 });
    await expect(api("/api/b")).rejects.toMatchObject({ status: 500, code: "internal" });
  });
  it("retries once after a successful step-up, and never more than once", async () => {
    let n = 0;
    const calls = mockApi({ "POST /api/admin/x": () => (++n === 1 ? { status: 401, body: { error: "step_up_required" } } : { done: true }) });
    const handler = vi.fn(async () => true);
    onStepUp(handler);
    expect(await api("/api/admin/x", { method: "POST", body: { k: 1 } })).toEqual({ done: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.body)).toEqual([{ k: 1 }, { k: 1 }]);

    mockApi({ "POST /api/admin/y": { status: 401, body: { error: "step_up_required" } } });
    await expect(api("/api/admin/y", { method: "POST" })).rejects.toMatchObject({ code: "step_up_required" });
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it("throws when the step-up handler declines or nobody registered one", async () => {
    mockApi({ "GET /api/admin/x": { status: 401, body: { error: "step_up_required" } } });
    await expect(api("/api/admin/x")).rejects.toMatchObject({ status: 401 });
    onStepUp(async () => false);
    await expect(api("/api/admin/x")).rejects.toMatchObject({ status: 401 });
  });
});

const bytes = (...b) => Uint8Array.from(b).buffer;

describe("passkeys", () => {
  it("passkeysSupported reflects the presence of PublicKeyCredential", () => {
    expect(passkeysSupported()).toBe(false);
    setGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(passkeysSupported()).toBe(true);
  });
  it("passkeyGet decodes the challenge as base64url and encodes the assertion the same way", async () => {
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "-_8", rpId: "x.org" } });
    const get = vi.fn(async () => ({
      id: "c1", rawId: bytes(251, 255), type: "public-key",
      response: { authenticatorData: bytes(1), clientDataJSON: bytes(2), signature: bytes(3), userHandle: null },
    }));
    setGlobal("navigator", { credentials: { get } });
    const out = await passkeyGet();
    const pk = get.mock.calls[0][0].publicKey;
    expect([...pk.challenge]).toEqual([251, 255]);
    expect(pk.rpId).toBe("x.org");
    expect(out).toEqual({ id: "c1", rawId: "-_8", type: "public-key", response: { authenticatorData: "AQ", clientDataJSON: "Ag", signature: "Aw", userHandle: null } });
  });
  it("passkeyGet encodes a user handle when the authenticator returns one", async () => {
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AQID", rpId: "x.org" } });
    setGlobal("navigator", { credentials: { get: async () => ({ id: "c", rawId: bytes(1), type: "public-key", response: { authenticatorData: bytes(1), clientDataJSON: bytes(1), signature: bytes(1), userHandle: bytes(9) } }) } });
    expect((await passkeyGet()).response.userHandle).toBe("CQ");
  });
  it("passkeyCreate registers under the account id and reports transports when offered", async () => {
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AQID", rpId: "x.org" } });
    const create = vi.fn(async () => ({ id: "n", rawId: bytes(1), type: "public-key", response: { attestationObject: bytes(4), clientDataJSON: bytes(5), getTransports: () => ["internal"] } }));
    setGlobal("navigator", { credentials: { create } });
    const out = await passkeyCreate({ id: "acc1", email: "me@x.org" });
    const pk = create.mock.calls[0][0].publicKey;
    expect([...pk.challenge]).toEqual([1, 2, 3]);
    expect(pk.rp.id).toBe("x.org");
    expect(new TextDecoder().decode(pk.user.id)).toBe("acc1");
    expect(pk.user.name).toBe("me@x.org");
    expect(out.response).toEqual({ attestationObject: "BA", clientDataJSON: "BQ", transports: ["internal"] });
  });
  it("passkeyCreate sends an empty transport list when the browser cannot say", async () => {
    mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AQID", rpId: "x.org" } });
    setGlobal("navigator", { credentials: { create: async () => ({ id: "n", rawId: bytes(1), type: "public-key", response: { attestationObject: bytes(4), clientDataJSON: bytes(5) } }) } });
    expect((await passkeyCreate({ id: "a", email: "e" })).response.transports).toEqual([]);
  });
  it("stepUp posts the assertion to the step-up route", async () => {
    const calls = mockApi({ "POST /api/auth/passkey/challenge": { challenge: "AQID", rpId: "x.org" }, "POST /api/auth/passkey/step-up": {} });
    setGlobal("navigator", { credentials: { get: async () => ({ id: "c1", rawId: bytes(1), type: "public-key", response: { authenticatorData: bytes(1), clientDataJSON: bytes(1), signature: bytes(1), userHandle: null } }) } });
    await stepUp();
    expect(calls[1].path).toBe("/api/auth/passkey/step-up");
    expect(calls[1].body.credential.id).toBe("c1");
  });
});
