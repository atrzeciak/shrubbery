import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries.js";
import { cleanPersonInput } from "../src/people/fields.js";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";
import { fakeJpeg } from "./helpers/jpeg.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function login(email) {
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email } });
  await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } });
  return c;
}

const bad = (body, admin = false) => expect(() => cleanPersonInput(body, { admin })).toThrow(expect.objectContaining({ status: 400 }));

describe("cleanPersonInput", () => {
  it("refuses a body that is not an object at all", () => {
    bad(null);
    bad("Jan");
  });

  it("refuses a text field that is not a string", () => {
    bad({ first_name: 12 });
    bad({ birth_date: ["1950"] });
  });

  it("lowercases an e-mail and keeps an empty one as null", () => {
    expect(cleanPersonInput({ email: " Jan@Example.ORG " }, { admin: false }).fields.email).toBe("jan@example.org");
    expect(cleanPersonInput({ email: "  " }, { admin: false }).fields.email).toBe(null);
  });

  it("takes the flags only as 0, 1, true or false", () => {
    expect(cleanPersonInput({ deceased: true }, { admin: false }).fields.deceased).toBe(1);
    expect(cleanPersonInput({ deceased: 0 }, { admin: false }).fields.deceased).toBe(0);
    bad({ deceased: "yes" });
    bad({ deceased: 2 });
  });

  it("refuses links that are not a list, or more than twenty of them", () => {
    bad({ links: { kind: "other", url: "https://x" } });
    bad({ links: Array.from({ length: 21 }, () => ({ kind: "other", url: "https://x" })) });
  });
});

describe("a member editing their own person", () => {
  async function linked() {
    await seedPerson(env, { id: "p_me", first_name: "Ja", last_name: "T" });
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    await q.linkAccountPerson(env.DB, "a1", "p_me").run();
    return login("a@x.org");
  }

  it("is told when the patch carries nothing it can change", async () => {
    const c = await linked();
    expect((await c.json("/api/me/person", { method: "PATCH", body: {} })).status).toBe(400);
    expect((await c.json("/api/me/person", { method: "PATCH", body: { id: "other", role: "admin" } })).status).toBe(400);
  });

  it("cannot upload an avatar that is not declared as a JPEG", async () => {
    const c = await linked();
    const r = await c.fetch("/api/me/person/avatar", { method: "PUT", body: fakeJpeg(64, 64), headers: { "content-type": "image/png" } });
    expect(r.status).toBe(400);
    expect(await q.avatarByPerson(env.DB, "p_me").first()).toBe(null);
  });

  it("has nowhere to put an avatar while no person is linked", async () => {
    await seedAccount(env, { id: "a1", email: "a@x.org" });
    const c = await login("a@x.org");
    const r = await c.fetch("/api/me/person/avatar", { method: "PUT", body: fakeJpeg(64, 64), headers: { "content-type": "image/jpeg" } });
    expect(r.status).toBe(404);
  });
});
