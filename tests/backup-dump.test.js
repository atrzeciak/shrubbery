import { beforeEach, describe, expect, it } from "vitest";
import { dumpSql, sqlValue } from "../src/backup/dump.js";
import { makeEnv, resetDb, seedPerson } from "./helpers/env.js";

const { env } = makeEnv();
beforeEach(() => resetDb(env));

async function dumpText(db) {
  let out = "";
  for await (const chunk of dumpSql(db)) out += chunk;
  return out;
}

describe("sqlValue", () => {
  it("quotes every type the way SQLite expects", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(42)).toBe("42");
    expect(sqlValue(-1.5)).toBe("-1.5");
    expect(sqlValue("Kowalski")).toBe("'Kowalski'");
    expect(sqlValue("O'Brien")).toBe("'O''Brien'");                 // the apostrophe that breaks dumps
    expect(sqlValue("wiersz\nnowy")).toBe("'wiersz\nnowy'");
    expect(sqlValue(new Uint8Array([0xde, 0xad]))).toBe("X'dead'");
    expect(sqlValue([0xbe, 0xef])).toBe("X'beef'");                  // D1 hands blobs back as arrays
    expect(sqlValue(new Uint8Array([1, 2, 3]).buffer)).toBe("X'010203'");
  });

  it("writes text holding a NUL as hex cast back to text, since the sqlite3 shell cuts a line at a NUL", () => {
    expect(sqlValue("a\u0000b")).toBe("CAST(X'610062' AS TEXT)");
    expect(sqlValue("ż\u0000")).toBe("CAST(X'c5bc00' AS TEXT)");
  });
});

describe("dumpSql", () => {
  it("writes the schema, then every row, with no transaction statement, which a D1 import refuses", async () => {
    await seedPerson(env, { id: "p1", first_name: "Anna", last_name: "O'Brien" });
    const sql = await dumpText(env.DB);
    expect(sql.startsWith("PRAGMA foreign_keys=OFF;\nCREATE ")).toBe(true);
    expect(sql).not.toMatch(/^(BEGIN|COMMIT)/m);
    expect(sql).toContain("CREATE TABLE people");
    expect(sql).toContain("INSERT INTO \"people\"");
    expect(sql).toContain("'O''Brien'");
    expect(sql).not.toContain("sqlite_sequence");                    // SQLite's own bookkeeping
  });

  it("carries avatar blobs as hex, so photos survive the round trip", async () => {
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    await env.DB.prepare("INSERT INTO avatars (person_id, jpeg, updated_at) VALUES (?, ?, ?)")
      .bind("p1", new Uint8Array([0xff, 0xd8, 0xff]), 1_800_000_000).run();
    const sql = await dumpText(env.DB);
    expect(sql).toContain("X'ffd8ff'");
  });

  it("keeps every statement under D1's 100,000-byte limit, even for the largest avatar", async () => {
    await seedPerson(env, { id: "p1", first_name: "Jan" });
    await env.DB.prepare("INSERT INTO avatars (person_id, jpeg, updated_at) VALUES (?, ?, ?)")
      .bind("p1", new Uint8Array(204800).fill(0xab), 1_800_000_000).run();
    const lines = (await dumpText(env.DB)).split("\n");
    expect(Math.max(...lines.map((l) => new TextEncoder().encode(l).length))).toBeLessThan(100_000);
  });

  // A real D1 carries Cloudflare's own _cf_KV table and answers "not authorized: SQLITE_AUTH" to any
  // read of it — and refuses to let a test create one, so this stands in for the remote database.
  // The dump used to walk into that table, which errored the ZIP on its first read and handed the
  // admin a 0-byte archive that recorded no backup at all.
  function remoteLikeDb() {
    const master = [
      { type: "table", name: "_cf_KV", sql: 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID' },
      { type: "table", name: "people", sql: "CREATE TABLE people (id TEXT PRIMARY KEY)" },
    ];
    return {
      prepare(sql) {
        let args = [];
        const stmt = {
          bind(...a) { args = a; return stmt; },
          async all() {
            if (sql.includes("sqlite_master")) return { results: master };
            const name = sql.match(/FROM "([^"]+)"/)[1];
            if (name.startsWith("_cf_")) throw new Error("D1_ERROR: not authorized: SQLITE_AUTH");
            const [after] = args;
            return { results: after === 0 ? [{ __rowid: 1, id: "p1" }] : [] };
          },
        };
        return stmt;
      },
    };
  }

  it("skips Cloudflare's internal tables, which a real D1 refuses to read", async () => {
    const sql = await dumpText(remoteLikeDb());
    expect(sql).not.toContain("_cf_KV");
    expect(sql).toContain('INSERT INTO "people"');
  });

  it("pages through tables larger than one page without skipping or duplicating", async () => {
    // Seed 1,100 people to cross two page boundaries
    for (let i = 0; i < 1100; i++) {
      await seedPerson(env, { id: `p${i}`, first_name: `Person${i}` });
    }
    const sql = await dumpText(env.DB);
    // Count INSERT statements for people table
    const peopleInserts = (sql.match(/INSERT INTO "people"/g) || []).length;
    expect(peopleInserts).toBe(1100);  // All 1,100 rows appear exactly once
  });

  // Passes every read through to the real database and lets a test act after each one.
  const watched = (db, onRead) => ({
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async all() { const r = await db.prepare(sql).bind(...args).all(); await onRead(sql, r); return r; },
      };
      return stmt;
    },
  });

  it("reads a table without blobs in pages large enough to stay far below D1's query cap", async () => {
    for (let i = 0; i < 250; i++) await seedPerson(env, { id: `p${i}`, first_name: `Person${i}` });
    const reads = [];
    await dumpText(watched(env.DB, (sql) => { if (sql.includes('FROM "people"')) reads.push(sql); }));
    expect(reads).toHaveLength(1);
  });

  it("keeps every row when an earlier one is deleted while the dump is running", async () => {
    for (let i = 0; i < 45; i++) {
      await seedPerson(env, { id: `p${i}` });
      await env.DB.prepare("INSERT INTO avatars (person_id, jpeg, updated_at) VALUES (?, ?, ?)").bind(`p${i}`, new Uint8Array([i]), 1_800_000_000).run();
    }
    let deleted = false;
    const sql = await dumpText(watched(env.DB, async (s) => {
      if (!deleted && s.includes('FROM "avatars"')) { deleted = true; await env.DB.prepare("DELETE FROM avatars WHERE person_id = 'p0'").run(); }
    }));
    expect((sql.match(/INSERT INTO "avatars"/g) || []).length).toBe(45);   // p0 was read before it went
  });
});
