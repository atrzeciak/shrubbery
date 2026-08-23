import { beforeEach, describe, expect, it } from "vitest";
import { makeEnv, resetDb, seedAccount, seedPerson, Client, lastCode } from "./helpers/env.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import * as q from "../src/db/queries.js";
import { dumpSql, tableInsertOrder } from "../src/backup/dump.js";

const { env, sent } = makeEnv();
beforeEach(() => resetDb(env));

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

async function seedOneMedia(bytes = new Uint8Array([1, 2, 3, 4])) {
  await seedPerson(env, { id: "p1", first_name: "Jan", last_name: "Kowalski" });
  await env.MEDIA.put("media/m1.jpg", bytes);
  await env.DB.prepare(`INSERT INTO media (id, owner_person_id, kind, content_type, size, has_thumb, uploaded_by, created_at)
                        VALUES ('m1','p1','photo','image/jpeg',?,0,'adm',1800000000)`).bind(bytes.length).run();
}

// Every table's rows, ordered, as comparable JSON — blobs included, since photos must survive too.
// ops_status is skipped: resetDb re-seeds it, so it is not part of what the dump has to carry.
async function snapshot(db) {
  const { results: tables } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
    "AND name NOT IN ('ops_status', '_cf_METADATA', 'd1_migrations') ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
    out[name] = results.map((row) => JSON.stringify(row, (k, v) => (ArrayBuffer.isView(v) ? [...v] : v))).sort();
  }
  return out;
}

describe("backup", () => {
  // The archive streams with a 200 and an attachment name, so a failure partway leaves the browser
  // holding a truncated file and the site saying nothing. The _cf_KV bug hid for a day behind exactly
  // that silence. The stream knows it died; it now writes that down.
  it("writes down a download that died partway, with the reason", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();
    const broken = { ...env, MEDIA: { get: async () => { throw new Error("R2 is having a day"); } } };
    const healthy = c.env;
    c.env = broken;
    const res = await c.fetch("/api/admin/backup");
    await expect(res.arrayBuffer()).rejects.toThrow();   // the pipe errors; the browser gets a truncated file
    c.env = healthy;
    let row = await q.opsStatus(env.DB).first();
    for (let i = 0; i < 50 && row.backup_failed_at === null; i++) {
      await new Promise((r) => setTimeout(r, 10));      // the write is handed to waitUntil, not awaited
      row = await q.opsStatus(env.DB).first();
    }
    expect(row.backup_failed_at).toBeGreaterThan(0);
    expect(row.backup_error).toContain("R2 is having a day");
    expect(row.backup_at).toBe(null);                 // and it must not look like a backup was taken
    const check = (await c.json("/api/admin/backup/check")).body;
    expect(check.backup_failed_at).toBe(row.backup_failed_at);
    expect(check.warnings).toContain("backup_failed");
  });

  it("clears the failure once a download finishes", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();
    await env.DB.prepare("UPDATE ops_status SET backup_failed_at = 1, backup_error = 'old' WHERE id = 1").run();
    const res = await c.fetch("/api/admin/backup");
    await res.arrayBuffer();                          // drain it: flush() only runs on the last byte
    const row = await q.opsStatus(env.DB).first();
    expect(row.backup_at).toBeGreaterThan(0);
    expect(row.backup_failed_at).toBe(null);
    expect(row.backup_error).toBe(null);
  });

  it("refuses everyone but a stepped-up admin", async () => {
    await seedAccount(env, { id: "f1", email: "fam@x.org" });
    const fam = await login("fam@x.org");
    expect((await fam.json("/api/admin/backup/check")).status).toBe(403);
    expect((await new Client(env).json("/api/admin/backup/check")).status).toBe(401);
  });

  it("reports what the archive will hold", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia(new Uint8Array(512));
    const r = await c.json("/api/admin/backup/check");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ files: 1, media_bytes: 512, backup_at: null });
  });

  it("reports the operational warnings alongside the archive's size", async () => {
    const c = await steppedUpAdmin();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE ops_status SET checked_at = ?, backup_at = ? WHERE id = 1").bind(now, now).run();
    env.DOMAIN_RENEWS_AT = new Date((now + 10 * 86400) * 1000).toISOString().slice(0, 10);
    const r = await c.json("/api/admin/backup/check");
    expect(r.body.warnings).toEqual(["domain_soon"]);
    expect(r.body.domain_expires_at).toBe(Date.parse(`${env.DOMAIN_RENEWS_AT}T00:00:00Z`) / 1000);
  });

  it("survives a warnings column that is not JSON, rather than 500ing the whole panel", async () => {
    const c = await steppedUpAdmin();
    // The backup button lives in this same response: an unreadable column must not take it down too.
    // The panel no longer parses that column at all — it works the warnings out from the row's own
    // facts — so corruption there cannot reach it. Pinned so nothing quietly starts reading it again.
    for (const bad of ["not json at all", '{"warnings":1}', '"a string"', "null"]) {
      await env.DB.prepare("UPDATE ops_status SET warnings = ? WHERE id = 1").bind(bad).run();
      const r = await c.json("/api/admin/backup/check");
      expect(r.status, bad).toBe(200);
      expect(Array.isArray(r.body.warnings), bad).toBe(true);
    }
  });

  it("streams a zip holding the dump, the media and the restore note, and records the date", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();

    const res = await c.raw("/api/admin/backup");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="nasze-korzenie-\d{4}-\d{2}-\d{2}\.zip"/);
    const buf = new Uint8Array(await res.arrayBuffer());

    // walk the local headers and collect what the archive contains
    const dv = new DataView(buf.buffer);
    const names = [];
    let at = 0;
    while (at + 4 <= buf.length && dv.getUint32(at, true) === 0x04034b50) {
      const size = dv.getUint32(at + 18, true);
      const nameLen = dv.getUint16(at + 26, true);
      const extraLen = dv.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(buf.subarray(at + 30, at + 30 + nameLen)));
      at += 30 + nameLen + extraLen + size;
    }
    expect(names).toEqual(["dane.sql", "ODZYSKIWANIE.txt", "media/m1.jpg"]);

    const all = new TextDecoder().decode(buf);
    expect(all).toContain("INSERT INTO \"people\"");
    expect(all).toContain("Kowalski");
    expect(all).toContain("sqlite3 nowa.db < dane.sql");
    expect((await env.DB.prepare("SELECT backup_at FROM ops_status WHERE id = 1").first()).backup_at)
      .toBeGreaterThan(0);
  });

  it("also archives thumbnails, and counts them in the check", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia(new Uint8Array(512));
    await env.MEDIA.put("media/m1.thumb.jpg", new Uint8Array(64));
    await q.setMediaThumb(env.DB, "m1").run();

    const check = await c.json("/api/admin/backup/check");
    expect(check.body.files).toBe(2);                    // the original plus its thumbnail

    const res = await c.raw("/api/admin/backup");
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const names = [];
    let at = 0;
    while (at + 4 <= buf.length && dv.getUint32(at, true) === 0x04034b50) {
      const size = dv.getUint32(at + 18, true);
      const nameLen = dv.getUint16(at + 26, true);
      const extraLen = dv.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(buf.subarray(at + 30, at + 30 + nameLen)));
      at += 30 + nameLen + extraLen + size;
    }
    expect(names).toEqual(["dane.sql", "ODZYSKIWANIE.txt", "media/m1.jpg", "media/m1.thumb.jpg"]);
  });

  it("records a missing original or thumbnail in BRAKUJACE.txt instead of staying silent", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();                                 // media/m1.jpg is never put into R2
    await q.setMediaThumb(env.DB, "m1").run();             // has_thumb=1, but no thumbnail object either

    const res = await c.raw("/api/admin/backup");
    const buf = new Uint8Array(await res.arrayBuffer());
    const all = new TextDecoder().decode(buf);
    expect(all).toContain("BRAKUJACE.txt");
    expect(all).toContain("m1");
    expect(all).toContain("media/m1.jpg");
    expect(all).toContain("media/m1.thumb.jpg");
    // the row itself still exists in the dump — only the R2 objects are missing
    expect(all).toContain("INSERT INTO \"media\"");
  });

  it("produces the archive on demand: nothing is written before the client reads", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();

    const res = await c.raw("/api/admin/backup");
    expect(res.status).toBe(200);
    // Never read a single byte from the body, and never even acquire a reader — the point is that
    // production is driven by consumption, not by the request having been made.
    expect((await env.DB.prepare("SELECT backup_at FROM ops_status WHERE id = 1").first()).backup_at)
      .toBeNull();
    await res.arrayBuffer();                              // drain it so the test doesn't leak a stream
  });

  it("leaves backup_at unset when the archive fails partway", async () => {
    const c = await steppedUpAdmin();
    await seedOneMedia();

    const realGet = env.MEDIA.get.bind(env.MEDIA);
    env.MEDIA.get = async () => { throw new Error("boom"); };
    try {
      const res = await c.raw("/api/admin/backup");
      expect(res.status).toBe(200);                        // headers are sent before the body streams and fails
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      env.MEDIA.get = realGet;
    }

    expect((await env.DB.prepare("SELECT backup_at FROM ops_status WHERE id = 1").first()).backup_at).toBeNull();
  });

  it("restores: the dump put back into an empty database rebuilds every row", async () => {
    await seedPerson(env, { id: "p1", first_name: "Jan", last_name: "O'Brien", birth_date: "1950-03-02" });
    await seedPerson(env, { id: "p2", first_name: "Anna" });
    await q.insertParent(env.DB, "p1", "p2").run();
    await env.DB.prepare("INSERT INTO avatars (person_id, jpeg, updated_at) VALUES (?, ?, ?)")
      .bind("p1", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 1_800_000_000).run();

    const before = await snapshot(env.DB);
    const chunks = [];
    for await (const chunk of dumpSql(env.DB)) chunks.push(chunk);

    // Drop every table dumpSql knows about — including ops_status and d1_migrations — so the replay
    // below has to rebuild the schema from the dump's own CREATE statements, not from tables this
    // test's harness already created by applying migrations. That is the actual state a brand-new
    // D1 database is in when `wrangler d1 execute --file dane.sql` runs against it, and it is what
    // ODZYSKIWANIE.txt promises: the dump carries d1_migrations, so restoring it does not re-run
    // migrations. (@cloudflare/vitest-pool-workers gives each test isolated storage, so dropping
    // tables here does not leak into any other test.) D1 enforces foreign keys even across a batch
    // of DROP TABLEs, so children have to go before parents — the same order dumpSql itself relies
    // on to insert rows, just reversed.
    const { results: tables } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA')").all();
    const dropOrder = tableInsertOrder(tables).reverse();
    await env.DB.batch(dropOrder.map((t) => env.DB.prepare(`DROP TABLE "${t.name}"`)));

    // Replay every statement dumpSql yields, in the order it yields them — one prepare()/run() per
    // chunk, since each chunk is exactly one statement except the opening pragma/transaction chunk
    // and the closing COMMIT, neither of which a per-statement replay needs.
    for (const chunk of chunks) {
      const statement = chunk.trim();
      if (!statement || statement.startsWith("PRAGMA") || statement === "COMMIT;") continue;
      await env.DB.prepare(statement).run();
    }

    expect(await snapshot(env.DB)).toEqual(before);
  });
});
