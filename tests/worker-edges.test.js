import { beforeEach, describe, expect, it } from "vitest";
import { capturingErrors } from "./helpers/logging.js";
import { Client, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";
import * as q from "../src/db/queries.js";
import { accountIdentity } from "../src/api/common.js";

let env;
beforeEach(async () => { ({ env } = makeEnv()); await resetDb(env); });

describe("the router", () => {
  it("answers 500 with a neutral body, and logs, when a handler blows up", async () => {
    const broken = { ...env, DB: { prepare() { throw new Error("D1 is gone"); } } };
    const c = new Client(broken);
    await c.json("/api/auth/email", { method: "POST", body: { email: "a@x.org" } });       // the nonce cookie; no database needed yet
    const { value: r, logged } = await capturingErrors(() => c.json("/api/auth/code/request", { method: "POST", body: { email: "a@x.org" } }));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal" });
    expect(logged.map((e) => e.message)).toEqual(["D1 is gone"]);
  });
});

describe("who an invitation comes from", () => {
  it("is nobody when there is no account to speak of", async () => {
    expect(await accountIdentity(env, null)).toBe(null);
    expect(await accountIdentity(env, "ghost")).toBe(null);
  });

  it("signs with the person's name when one is linked, and with the address alone when not", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    expect(await accountIdentity(env, "a1")).toEqual({ name: null, email: "a@x.org", founder: false });
    await seedPerson(env, { id: "p1", first_name: "Anna", last_name: "L" });
    await q.linkAccountPerson(env.DB, "a1", "p1").run();
    expect(await accountIdentity(env, "a1")).toEqual({ name: "Anna L", email: "a@x.org", founder: false });
  });
});

describe("reading a JSON body", () => {
  const post = (body) => new Client(env).json("/api/auth/email", { method: "POST", body: new TextEncoder().encode(body) });

  it("refuses a body that is not JSON", async () => {
    expect((await post("{nope")).status).toBe(400);
  });

  it("refuses JSON that is not an object, so handlers never read fields off a number or null", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    for (const body of ["1", "null", '"a@x.org"']) expect((await post(body)).status, body).toBe(400);
  });
});
