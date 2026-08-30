import { beforeEach, describe, expect, it } from "vitest";
import { Client, lastCode, makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import * as q from "../src/db/queries.js";
import { zipStream } from "../src/backup/zip.js";
import { sqlValue, tableInsertOrder } from "../src/backup/dump.js";

const { env, sent } = makeEnv();
beforeEach(() => resetDb(env));

const AT = new Date("2026-08-22T10:00:00Z");
const enc = new TextEncoder();

async function drain(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Every entry by name, with its stored bytes, read off the local headers.
function entries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map();
  let at = 0;
  while (at + 4 <= buf.length && dv.getUint32(at, true) === 0x04034b50) {
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const start = at + 30 + nameLen + dv.getUint16(at + 28, true);
    out.set(new TextDecoder().decode(buf.subarray(at + 30, at + 30 + nameLen)), buf.subarray(start, start + size));
    at = start + size;
  }
  return out;
}
const entryNames = (buf) => [...entries(buf).keys()];

describe("zipStream", () => {
  it("accepts a plain synchronous iterator of entries", async () => {
    const list = [{ name: "a.txt", bytes: enc.encode("a") }, { name: "b.txt", bytes: enc.encode("b") }][Symbol.iterator]();
    expect(entryNames(await drain(zipStream(list, AT)))).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses a name too long for the header, and tells the caller why", async () => {
    async function* longName() { yield { name: "x".repeat(0x10000), bytes: new Uint8Array(1) }; }
    const seen = [];
    await expect(drain(zipStream(longName(), AT, (e) => seen.push(e)))).rejects.toThrow(/exceeds u16 max/);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toMatch(/exceeds u16 max/);
  });

  it("still fails with the original error when the failure recorder itself throws", async () => {
    async function* broken() { yield { name: "huge.bin", bytes: { length: 0x1_0000_0000 } }; }
    const recorder = () => { throw new Error("the recorder is broken too"); };
    await expect(drain(zipStream(broken(), AT, recorder))).rejects.toThrow(/exceeds 4 GiB limit/);
  });
});

describe("sqlValue", () => {
  it("quotes and escapes a value of a type it did not expect rather than emitting it bare", () => {
    expect(sqlValue(true)).toBe("'true'");
    expect(sqlValue({ toString: () => "it's" })).toBe("'it''s'");
  });

  it("writes a bigint as a bare number", () => expect(sqlValue(9007199254740993n)).toBe("9007199254740993"));
});

describe("tableInsertOrder", () => {
  const t = (name, ...refs) => ({ name, sql: `CREATE TABLE ${name} (${refs.map((r) => `x REFERENCES "${r}"(id)`).join(", ")})` });

  it("refuses a cycle rather than quietly misordering it", () => {
    expect(() => tableInsertOrder([t("a", "b"), t("b", "a")])).toThrow(/circular foreign key reference/);
  });

  it("orders around a reference to a table that is not in the dump", () => {
    expect(tableInsertOrder([t("child", "parent", "elsewhere"), t("parent")]).map((x) => x.name)).toEqual(["parent", "child"]);
  });
});

describe("the archive and a file that is gone from R2", () => {
  async function login(email) {
    const c = new Client(env);
    await c.json("/api/auth/email", { method: "POST", body: { email } });
    await c.json("/api/auth/code/request", { method: "POST", body: { email } });
    await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } });
    return c;
  }

  async function steppedUpAdmin() {
    await seedAccount(env, { id: "adm", email: "adm@x.org", role: "family" });
    const c = await login("adm@x.org");
    const auth = await createAuthenticator();
    let ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } });
    await q.setRole(env.DB, "adm", "admin").run();
    ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
    await c.json("/api/auth/passkey/step-up", { method: "POST", body: { credential: await auth.get(ch.body.challenge) } });
    return c;
  }

  const mediaRow = (id, hasThumb) => env.DB.prepare(`INSERT INTO media (id, owner_person_id, kind, content_type, size, has_thumb, uploaded_by, created_at)
      VALUES (?, 'p1', 'photo', 'image/jpeg', 4, ?, 'adm', ?)`).bind(id, hasThumb, 1_800_000_000 + (hasThumb ? 1 : 0)).run();

  it("names this site's own database, bucket and repository in the restore note", async () => {
    const c = await steppedUpAdmin();
    c.env = { ...env, DB_NAME: "korzenie-db", BUCKET_NAME: "korzenie-media", REPO_URL: "https://example.org/repo" };
    const buf = new Uint8Array(await (await c.raw("/api/admin/backup")).arrayBuffer());
    const note = new TextDecoder().decode(entries(buf).get("ODZYSKIWANIE.txt"));
    for (const word of ["korzenie-db", "korzenie-media", "https://example.org/repo"]) expect(note).toContain(word);
    expect(note).not.toContain("twoja-baza");
  });

  it("warns before a download that would run into the R2 read cap", async () => {
    const c = await steppedUpAdmin();
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    const rows = Array.from({ length: 901 }, (_, i) => env.DB.prepare("INSERT INTO media (id, owner_person_id, kind, content_type, size, has_thumb, uploaded_by, created_at) VALUES (?, 'p1', 'photo', 'image/jpeg', 1, 0, 'adm', ?)").bind(`m${i}`, i));
    await env.DB.batch(rows);
    const r = await c.json("/api/admin/backup/check");
    expect(r.body.files).toBe(901);
    expect(r.body.near_limits).toEqual(["r2_reads"]);
  });

  it("writes down a failure that is not even an Error", async () => {
    const c = await steppedUpAdmin();
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    await mediaRow("m1", 0);
    c.env = { ...env, MEDIA: { get: async () => { throw "R2 said no"; } } };   // eslint-disable-line no-throw-literal
    await expect((await c.fetch("/api/admin/backup")).arrayBuffer()).rejects.toBeDefined();
    let row = await q.opsStatus(env.DB).first();
    for (let i = 0; i < 50 && row.backup_failed_at === null; i++) {
      await new Promise((r) => { setTimeout(r, 10); });
      row = await q.opsStatus(env.DB).first();
    }
    expect(row.backup_error).toBe("R2 said no");
  });

  it("lists the missing original and thumbnail by name and keeps the rest of the archive", async () => {
    const c = await steppedUpAdmin();
    await seedPerson(env, { id: "p1", first_name: "Jan", last_name: "Kowalski" });
    await mediaRow("gone", 0);                                                 // never written to R2
    await mediaRow("half", 1);                                                 // original present, thumbnail lost
    await env.MEDIA.put("media/half.jpg", new Uint8Array([1, 2, 3, 4]));

    const buf = new Uint8Array(await (await c.raw("/api/admin/backup")).arrayBuffer());
    expect(entryNames(buf)).toEqual(["dane.sql", "ODZYSKIWANIE.txt", "media/half.jpg", "BRAKUJACE.txt"]);
    const note = new TextDecoder().decode(entries(buf).get("BRAKUJACE.txt"));
    expect(note).toContain("gone  media/gone.jpg");
    expect(note).toContain("half  media/half.thumb.jpg");
    expect(note).not.toContain("half  media/half.jpg");
    expect((await q.opsStatus(env.DB).first()).backup_at).toBeGreaterThan(0);  // a gap in R2 is not a failed backup
  });
});
