// The database as plain SQL: `sqlite3 nowa.db < dane.sql` rebuilds it anywhere, with no Cloudflare and
// no tool that has to still exist in twenty years.

const HEX = "0123456789abcdef";

function hex(bytes) {
  let out = "";
  for (const b of bytes) out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  return out;
}

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  // D1 returns BLOBs as Uint8Array remotely and as a plain array locally; both mean bytes.
  if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
  if (ArrayBuffer.isView(v)) return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
  if (Array.isArray(v)) return `X'${hex(Uint8Array.from(v))}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}

const PAGE = 20;    // rows per query: avatars rows run up to 204800 bytes, so this stays small on purpose

// PRAGMA foreign_keys=OFF only holds for the session that runs it, and a restore may replay each
// INSERT as its own call (`wrangler d1 execute --remote`, or this test's D1 binding). So tables are
// inserted parent-before-child, walking each table's REFERENCES rather than trusting the pragma.
export function tableInsertOrder(tables) {
  const deps = new Map(tables.map((t) => [t.name, new Set(
    [...t.sql.matchAll(/REFERENCES\s+"?(\w+)"?/gi)].map((m) => m[1]).filter((n) => n !== t.name))]));
  const ordered = [];
  const done = new Set();
  const visiting = new Set();   // tables on the current DFS path, to catch a cycle rather than silently misorder it
  const visit = (name) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dumpSql: circular foreign key reference involving "${name}"`);
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) if (deps.has(dep)) visit(dep);   // a REFERENCES target outside the dump is not this dump's problem to order
    visiting.delete(name);
    done.add(name);
    ordered.push(name);
  };
  for (const t of tables) visit(t.name);
  return ordered.map((name) => tables.find((t) => t.name === name));
}

// SQLite's own bookkeeping and Cloudflare's. A real D1 answers any read of _cf_KV with
// "not authorized: SQLITE_AUTH", which used to abort the archive on its first byte and leave the
// admin with a 0-byte file. Filtered here rather than in the query so it is visible and testable.
const isInternal = (name) => name.startsWith("sqlite_") || name.startsWith("_cf_");

export async function* dumpSql(db) {
  yield "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n";
  const { results: all } = await db.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all();
  const objects = all.filter((o) => !isInternal(o.name));
  for (const o of objects) yield `${o.sql};\n`;
  for (const table of tableInsertOrder(objects.filter((o) => o.type === "table"))) {
    for (let offset = 0; ; offset += PAGE) {
      const { results } = await db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid LIMIT ? OFFSET ?`)
        .bind(PAGE, offset).all();
      if (!results.length) break;
      for (const row of results) {
        const cols = Object.keys(row);
        const names = cols.map((c) => `"${c}"`).join(", ");
        const values = cols.map((c) => sqlValue(row[c])).join(", ");
        yield `INSERT INTO "${table.name}" (${names}) VALUES (${values});\n`;
      }
      if (results.length < PAGE) break;
    }
  }
  yield "COMMIT;\n";
}
