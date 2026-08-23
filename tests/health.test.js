import { beforeEach, describe, expect, it } from "vitest";
import { makeEnv, resetDb, Client } from "./helpers/env.js";
import { CHECKS_STALE } from "../src/ops/checks.js";

const { env } = makeEnv();
beforeEach(async () => { await resetDb(env); });

const setCheckedAt = (at) => env.DB.prepare("UPDATE ops_status SET checked_at = ? WHERE id = 1").bind(at).run();
const now = () => Math.floor(Date.now() / 1000);

describe("health", () => {
  it("answers ok without a session, and touches the database", async () => {
    await setCheckedAt(now());
    const r = await new Client(env).json("/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, checks_stale: false });
  });

  it("reports stale checks without claiming the site is down", async () => {
    await setCheckedAt(now() - CHECKS_STALE - 60);
    const r = await new Client(env).json("/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, checks_stale: true });     // up, and nothing is watching it
  });

  it("counts a row that was never checked as stale", async () => {
    const r = await new Client(env).json("/api/health");           // resetDb leaves checked_at NULL
    expect(r.body).toEqual({ ok: true, checks_stale: true });
  });

  it("still calls a check from within the window fresh, right up to the boundary", async () => {
    await setCheckedAt(now() - CHECKS_STALE);                      // exactly 3 days: not yet stale (> 3 days)
    expect((await new Client(env).json("/api/health")).body.checks_stale).toBe(false);
  });

  it("reports 500 when the database rejects, which is how D1 really fails", async () => {
    const broken = { ...env, DB: { prepare: () => ({ bind: () => ({}), first: () => Promise.reject(new Error("D1_ERROR")) }) } };
    const r = await new Client(broken).json("/api/health");
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });

  it("reports 500 when the database cannot even be reached to prepare a statement", async () => {
    const broken = { ...env, DB: { prepare() { throw new Error("no database"); } } };
    const r = await new Client(broken).json("/api/health");
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });
});
