import { vi } from "vitest";
import { setLang } from "../../public/app/i18n.js";

// Routes: { "GET /api/people": data | (init, path) => data | { status, body } }.
// A missing route is a 404 so a test fails loudly on a request it did not expect.
export function mockApi(routes) {
  const calls = [];
  globalThis.__api = async (path, init) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body && typeof init.body === "string" && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const hit = routes[key] ?? routes[`${method} ${path.split("?")[0]}`];
    if (hit === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const out = typeof hit === "function" ? await hit(body, path) : hit;
    if (out && typeof out === "object" && "status" in out && "body" in out) return new Response(JSON.stringify(out.body), { status: out.status });
    return new Response(JSON.stringify(out ?? {}), { status: 200 });
  };
  return calls;
}

export const lang = (l = "pl") => setLang(l);

export const tick = () => new Promise((r) => { setTimeout(r, 0); });
export const q = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

// What /api/me returns for a signed-in family member with no person linked yet.
export const meFixture = ({ account = {}, ...over } = {}) => ({
  account: { id: "acc1", email: "me@x.org", role: "family", lang: "pl", person_id: null, notify_events: 0, news_seen_at: null, founder: 0, ...account },
  person: null, passkeys: 0, session: { passkey_at: null, created_at: 0 }, ops: null, tz: "UTC", ...over,
});

// What app.js hands a view: the whole /api/me object under state.me, and the app's callbacks.
export function viewCtx(me = meFixture(), over = {}) {
  return { state: { me }, navigate: vi.fn(), toast: vi.fn(), refreshMe: vi.fn(), errorText: (e) => e?.code || String(e), ...over };
}

export const submit = (form) => form.dispatchEvent(new Event("submit", { cancelable: true }));
export const byText = (sel, text, root = document) => qa(sel, root).find((el) => el.textContent.trim() === text) || null;

// The same, when all a test cares about is the signed-in account.
export const appCtx = (account = {}) => viewCtx(meFixture({ account }));

// happy-dom has no 2D canvas and cannot decode images; give the crop and upload code fakes it can drive.
// Returns the mocks so a test can assert on drawImage or make toBlob yield a blob of a chosen size.
export function stubCanvas({ width = 800, height = 600 } = {}) {
  const ctx2d = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx2d);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb, type) { cb(new Blob(["x"], { type })); });
  const bitmap = vi.fn(async () => ({ width, height, close: vi.fn() }));
  vi.stubGlobal("createImageBitmap", bitmap);
  return { ctx2d, toBlob, bitmap };
}

// Put a file in a file input and fire change, as a pick from the OS dialog would.
export function pickFile(input, file) {
  Object.defineProperty(input, "files", { value: file ? [file] : [], configurable: true });
  input.dispatchEvent(new Event("change"));
}
