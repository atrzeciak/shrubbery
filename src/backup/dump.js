// The database as plain SQL: `sqlite3 nowa.db < dane.sql` rebuilds it anywhere, with no Cloudflare and
// no tool that has to still exist in twenty years.

const HEX = "0123456789abcdef";

function hex(bytes) {
  let out = "";
  for (const b of bytes) out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  return out;
}

// D1 returns BLOBs as Uint8Array remotely and as a plain array locally; both mean bytes.
function asBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return null;
}

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  // A raw NUL cuts the line in the sqlite3 shell and the restore loses every table after it.
  if (typeof v === "string") return v.includes("\0") ? `CAST(X'${hex(new TextEncoder().encode(v))}' AS TEXT)` : `'${v.replaceAll("'", "''")}'`;
  const bytes = asBytes(v);
  if (bytes) return `X'${hex(bytes)}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}

const BLOB_SLICE = 40 * 1024;   // hex doubles it; D1 refuses a statement over 100,000 bytes

// One row as an INSERT, a blob over BLOB_SLICE cut into the INSERT plus one UPDATE per further slice.
function* rowStatements(table, row) {
  const { __rowid: rowid, ...fields } = row;
  const cols = Object.keys(fields);
  const rest = [];
  const values = cols.map((c) => {
    const bytes = asBytes(fields[c]);
    if (!bytes || bytes.length <= BLOB_SLICE) return sqlValue(fields[c]);
    for (let i = BLOB_SLICE; i < bytes.length; i += BLOB_SLICE) rest.push([c, bytes.subarray(i, i + BLOB_SLICE)]);
    return sqlValue(bytes.subarray(0, BLOB_SLICE));
  });
  // The UPDATEs find the row by rowid, so it is carried only when there are UPDATEs to follow.
  const names = (rest.length ? ["rowid", ...cols] : cols).map((c) => `"${c}"`).join(", ");
  yield `INSERT INTO "${table}" (${names}) VALUES (${rest.length ? `${rowid}, ` : ""}${values.join(", ")});\n`;
  for (const [c, slice] of rest) yield `UPDATE "${table}" SET "${c}" = CAST("${c}" || ${sqlValue(slice)} AS BLOB) WHERE rowid = ${rowid};\n`;
}

// Rows per query. A blob row runs up to 204800 bytes, so those tables stay small; the rest go in large
// pages, because D1 allows a Worker invocation 1,000 queries and the log tables only grow.
const pageFor = (table) => (/\bBLOB\b/i.test(table.sql) ? 20 : 500);

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

// Sign-in state: restored, a session would work again on the same domain, even one revoked since.
// The tables are kept, empty; the restore note already says everyone signs in again.
const TRANSIENT = new Set(["sessions", "login_codes", "rate_limits", "webauthn_challenges"]);

export async function* dumpSql(db) {
  // No BEGIN/COMMIT: a D1 import refuses both, so the sqlite3 restore runs in autocommit.
  yield "PRAGMA foreign_keys=OFF;\n";
  const { results: all } = await db.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all();
  const objects = all.filter((o) => !isInternal(o.name));
  for (const o of objects) yield `${o.sql};\n`;
  for (const table of tableInsertOrder(objects.filter((o) => o.type === "table"))) {
    if (TRANSIENT.has(table.name)) continue;
    // Paged by rowid rather than OFFSET: a row deleted mid-dump cannot shift the next page past a live one.
    const page = pageFor(table);
    for (let after = 0; ;) {
      const { results } = await db.prepare(`SELECT rowid AS "__rowid", * FROM "${table.name}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(after, page).all();
      for (const row of results) yield* rowStatements(table.name, row);
      if (results.length < page) break;
      after = results[results.length - 1].__rowid;
    }
  }
}
