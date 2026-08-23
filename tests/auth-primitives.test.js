import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { prepareSession, resolveSession, sessionCookie, clearSessionCookie, hasFreshPasskey, STEP_UP_WINDOW } from "../src/auth/sessions.js";
import { generateCode, prepareCode, verifyCode, CODE_MAX_ATTEMPTS } from "../src/auth/codes.js";
import { allow } from "../src/auth/ratelimit.js";

const db = env.DB;
const T = 1_800_000_000;
const TABLES = ["history", "rate_limits", "invitations", "login_codes", "sessions", "passkeys", "accounts"];

beforeEach(async () => {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  await q.insertAccount(db, { id: "a1", email: "a@x.org", role: "family", lang: "pl", createdAt: T, invitedBy: null }).run();
});

const reqWithCookie = (token) => new Request("https://example.org/api/me", { headers: { cookie: `session=${token}` } });

// verifyCode no longer writes; it returns the bump/mark-used statement for the caller to batch.
async function verifyAndCommit(...args) {
  const r = await verifyCode(...args);
  if (r.stmt) await r.stmt.run();
  return r;
}

describe("sessions", () => {
  it("stores only the hash and resolves the cookie to the account", async () => {
    const { token, id, stmt } = await prepareSession(db, { accountId: "a1", passkeyAt: null, userAgent: "ua" }, T);
    await stmt.run();
    expect(id).not.toBe(token);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await q.sessionById(db, token).first()).toBeNull();
    const r = await resolveSession(db, reqWithCookie(token), T + 5);
    expect(r.account.id).toBe("a1");
    expect(r.session.passkey_at).toBeNull();
  });

  it("cookie attributes", () => {
    const c = sessionCookie("tok");
    expect(c).toContain("session=tok");
    expect(c).toContain("Max-Age=31536000");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("rejects missing, unknown, expired, revoked sessions and disabled accounts", async () => {
    expect(await resolveSession(db, new Request("https://example.org/api/me"), T)).toBeNull();
    expect(await resolveSession(db, reqWithCookie("nope"), T)).toBeNull();
    const { token, id, stmt } = await prepareSession(db, { accountId: "a1", passkeyAt: T, userAgent: "ua" }, T);
    await stmt.run();
    expect(await resolveSession(db, reqWithCookie(token), T + 31536000)).toBeNull();
    expect(await resolveSession(db, reqWithCookie(token), T + 10)).not.toBeNull();
    await q.revokeSession(db, id, "a1", T + 11).run();
    expect(await resolveSession(db, reqWithCookie(token), T + 12)).toBeNull();
    const s2 = await prepareSession(db, { accountId: "a1", passkeyAt: null, userAgent: "ua" }, T);
    await s2.stmt.run();
    await q.disableAccount(db, "a1", T + 1).run();
    expect(await resolveSession(db, reqWithCookie(s2.token), T + 2)).toBeNull();
  });

  it("touches last_seen_at at most hourly", async () => {
    const { token, id, stmt } = await prepareSession(db, { accountId: "a1", passkeyAt: null, userAgent: "ua" }, T);
    await stmt.run();
    await resolveSession(db, reqWithCookie(token), T + 100);
    expect((await q.sessionById(db, id).first()).last_seen_at).toBe(T);
    await resolveSession(db, reqWithCookie(token), T + 3600);
    expect((await q.sessionById(db, id).first()).last_seen_at).toBe(T + 3600);
  });

  it("step-up freshness is 600 s", () => {
    expect(STEP_UP_WINDOW).toBe(600);
    expect(hasFreshPasskey({ passkey_at: T }, T + 599)).toBe(true);
    expect(hasFreshPasskey({ passkey_at: T }, T + 600)).toBe(false);
    expect(hasFreshPasskey({ passkey_at: null }, T)).toBe(false);
  });
});

describe("codes", () => {
  it("generates six digits", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("verifies once, bound to email + nonce, and burns after use", async () => {
    const { code, stmt } = await prepareCode(db, { email: "a@x.org", nonce: "n1" }, T);
    await stmt.run();
    const row = await db.prepare("SELECT * FROM login_codes").first();
    expect(row.code_hash).not.toBe(code);
    expect(await verifyAndCommit(db, { email: "a@x.org", nonce: "other", code }, T + 1)).toEqual({ ok: false, error: "expired", stmt: null });
    expect(await verifyAndCommit(db, { email: "b@x.org", nonce: "n1", code }, T + 1)).toEqual({ ok: false, error: "expired", stmt: null });
    const ok = await verifyAndCommit(db, { email: "a@x.org", nonce: "n1", code }, T + 1);
    expect(ok.ok).toBe(true);
    expect(await verifyAndCommit(db, { email: "a@x.org", nonce: "n1", code }, T + 2)).toEqual({ ok: false, error: "expired", stmt: null });
  });

  it("expires after 10 minutes and burns after 5 wrong attempts", async () => {
    const { code, stmt } = await prepareCode(db, { email: "a@x.org", nonce: "n1" }, T);
    await stmt.run();
    expect(await verifyAndCommit(db, { email: "a@x.org", nonce: "n1", code }, T + 600)).toEqual({ ok: false, error: "expired", stmt: null });
    const c2 = await prepareCode(db, { email: "a@x.org", nonce: "n2" }, T);
    await c2.stmt.run();
    const wrong = c2.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      const r = await verifyAndCommit(db, { email: "a@x.org", nonce: "n2", code: wrong }, T + 1);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("invalid_code");
    }
    expect(await verifyAndCommit(db, { email: "a@x.org", nonce: "n2", code: c2.code }, T + 1)).toEqual({ ok: false, error: "expired", stmt: null });
  });

  it("markCodeUsed is single-use even called directly: the second run changes nothing", async () => {
    const { stmt } = await prepareCode(db, { email: "a@x.org", nonce: "n1" }, T);
    await stmt.run();
    const row = await db.prepare("SELECT id FROM login_codes").first();
    const first = await q.markCodeUsed(db, row.id, T + 1).run();
    expect(first.meta.changes).toBe(1);
    const second = await q.markCodeUsed(db, row.id, T + 2).run();
    expect(second.meta.changes).toBe(0);
  });
});

describe("rate limits", () => {
  it("allows `limit` hits per window then blocks, and resets after the window", async () => {
    for (let i = 0; i < 5; i++) expect(await allow(db, "code:a@x.org", 5, 3600, T + i)).toBe(true);
    expect(await allow(db, "code:a@x.org", 5, 3600, T + 10)).toBe(false);
    expect(await allow(db, "code:b@x.org", 5, 3600, T + 10)).toBe(true);
    expect(await allow(db, "code:a@x.org", 5, 3600, T + 3600)).toBe(true);
  });
});
