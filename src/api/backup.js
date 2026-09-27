import * as q from "../db/queries.js";
import { json, nowSec } from "../util.js";
import { keyFor, thumbKeyFor } from "./media.js";
import { dumpSql } from "../backup/dump.js";
import { zipStream } from "../backup/zip.js";
import { adminSession } from "./common.js";
import { host } from "../mail.js";

const restoreNote = (env) => {
  const db = env.DB_NAME || 'twoja-baza';
  const bucket = env.BUCKET_NAME || 'twoj-bucket';
  return `NASZE KORZENIE — JAK ODZYSKAĆ TĘ KOPIĘ

W tym archiwum jest wszystko: dane rodziny i pliki.

  dane.sql          cała baza danych jako zwykły SQL
  media/            zdjęcia i dokumenty, w oryginale, oraz ich miniatury
  ODZYSKIWANIE.txt  ten plik
  BRAKUJACE.txt     pojawia się tylko, gdy jakiegoś pliku nie dało się odczytać

1. ŻEBY PO PROSTU PRZECZYTAĆ DANE (bez stawiania strony)

   sqlite3 nowa.db < dane.sql

   To wystarczy, żeby na zawsze mieć dostęp do drzewa, dat i opisów.
   Zdjęcia i dokumenty leżą obok, w katalogu media/ — otwiera je każdy komputer.
   Nazwa pliku to identyfikator z tabeli "media" (kolumna id) plus rozszerzenie.
   Do tego kroku nie potrzeba niczego poza tym archiwum.

2. ŻEBY POSTAWIĆ STRONĘ OD NOWA NA CLOUDFLARE

   Do tego już potrzeba więcej niż tego archiwum: kodu strony, z repozytorium
   ${env.REPO_URL || '(repozytorium kodu strony)'}, oraz kilku sekretów w
   nowym koncie Cloudflare/GitHub, których to archiwum nie niesie:

     - token API Cloudflare dla GitHub Actions (wdraża stronę po każdym pushu)
     - IP_HASH_SECRET (src/history.js) — bez niego historia zmian traci hasze IP
     - zweryfikowana domena nadawcy dla wiązania send_email (e-maile z kodami
       logowania i powiadomieniami)

   wrangler d1 create ${db}
   wrangler d1 execute ${db} --remote --file dane.sql
   wrangler r2 bucket create ${bucket}
   for f in media/*; do
     wrangler r2 object put ${bucket}/media/$(basename "$f") --file "$f" --remote
   done

   Potem w pliku wrangler.toml wpisz nowe database_id i wypchnij zmiany —
   resztę zrobi GitHub Actions, o ile powyższe sekrety już tam są.

3. CZEGO SIĘ SPODZIEWAĆ

   - Kopia zawiera tabelę d1_migrations, więc odtworzona baza nie uruchomi
     migracji jeszcze raz.
   - Klucze (passkeys) są przypisane do adresu ${host(env)}. Ten sam adres —
     działają dalej. Nowy adres — stare klucze nie zadziałają; najpierw je usuń:

       wrangler d1 execute ${db} --remote --command "DELETE FROM passkeys"

     potem każdy loguje się kodem z e-maila i dodaje klucz od nowa.
   - Wysyłka e-maili wymaga zweryfikowanej domeny w nowym koncie; tego
     archiwum nie da się w to wyręczyć.
   - Sesje nie przechodzą: wszyscy logują się ponownie.

4. GRANICA

   Dane są przenośne wszędzie. Sama aplikacja jest napisana pod Cloudflare
   (Workers, D1, R2). Przeniesienie na inny hosting znaczy: przepisać aplikację,
   ale nie stracić ani jednego zdjęcia i ani jednej daty.
`;
};

// Admin plus a fresh passkey: the archive holds every address in the family.
const guard = (request, env) => adminSession(request, env, true);

export async function backupCheck(request, env) {
  await guard(request, env);
  const { results } = await q.listAllMedia(env.DB).all();
  const status = await q.opsStatus(env.DB).first();
  const files = results.length + results.filter((m) => m.has_thumb).length;
  // The ZIP writer refuses past 65535 entries (dane.sql, ODZYSKIWANIE.txt, one per file/thumbnail),
  // and each file read costs one R2 operation inside the same Worker invocation, which Cloudflare
  // caps around 1000 — worth a heads-up here rather than a download that fails partway.
  const nearLimits = [];
  if (files + 2 > 60000) nearLimits.push("zip_entries");
  if (files > 900) nearLimits.push("r2_reads");
  return json({
    files,
    media_bytes: results.reduce((n, m) => n + (m.size || 0), 0),
    backup_at: status?.backup_at ?? null,
    backup_failed_at: status?.backup_failed_at ?? null,
    backup_error: status?.backup_error ?? null,
    ...(nearLimits.length ? { near_limits: nearLimits } : {}),
  });
}

export async function backupDownload(request, env, ctx) {
  await guard(request, env);
  const at = new Date();
  const enc = new TextEncoder();
  const { results: media } = await q.listAllMedia(env.DB).all();

  async function* entries() {
    // Encoded chunk by chunk: one string of the whole dump plus its encoded copy held it three times over.
    const parts = [];
    let size = 0;
    for await (const chunk of dumpSql(env.DB)) { const b = enc.encode(chunk); parts.push(b); size += b.length; }
    const sql = new Uint8Array(size);
    for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) sql.set(parts[i], at);
    parts.length = 0;
    yield { name: "dane.sql", bytes: sql };
    yield { name: "ODZYSKIWANIE.txt", bytes: enc.encode(restoreNote(env)) };
    const missing = [];
    for (const m of media) {
      const key = keyFor(m);
      const obj = await env.MEDIA.get(key);
      if (obj) yield { name: key, bytes: new Uint8Array(await obj.arrayBuffer()) };
      else missing.push(`${m.id}  ${key}`);              // a missing object must not cost the rest of the archive
      if (m.has_thumb) {
        const thumbKey = thumbKeyFor(m);
        const thumb = await env.MEDIA.get(thumbKey);
        if (thumb) yield { name: thumbKey, bytes: new Uint8Array(await thumb.arrayBuffer()) };
        else missing.push(`${m.id}  ${thumbKey}`);
      }
    }
    if (missing.length) {
      const note = "Te pliki są w bazie (tabela \"media\"), ale w chwili tworzenia kopii nie dało się\n"
        + "ich odczytać z R2 — baza wie o nich, samych plików tu brakuje.\n\n" + missing.join("\n") + "\n";
      yield { name: "BRAKUJACE.txt", bytes: enc.encode(note) };
    }
  }

  // zipStream only produces the next entry once the consumer pulls for it, so the generator above
  // — and the R2 reads and dump query inside it — advance solely at the pace the client downloads
  // at. flush() below runs only once the archive's very last chunk (the end-of-central-directory
  // record) has been produced and handed to the client's stream; a mid-stream failure errors the
  // pipe before flush() ever runs, so /backup/check never reports a backup that never finished
  // streaming. HTTP still can't prove the bytes reached disk — only that the Worker sent them all.
  // The response is already a 200 with an attachment name by the time anything can go wrong, so a
  // failure cannot be told to the browser — it arrives as a truncated file. It is written down here
  // instead, and waitUntil keeps the Worker alive long enough to finish saying so.
  const recordFailure = (err) => {
    const reason = String(err && err.message ? err.message : err).slice(0, 200);
    ctx?.waitUntil?.(q.setBackupFailure(env.DB, nowSec(), reason).run().catch((e) => console.error(e)));
  };
  const body = zipStream(entries(), at, recordFailure).pipeThrough(new TransformStream({
    transform: (chunk, controller) => controller.enqueue(chunk),
    flush: () => q.setBackupAt(env.DB, nowSec()).run(),
  }));

  const day = at.toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="nasze-korzenie-${day}.zip"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export const routes = [
  ["GET", /^\/api\/admin\/backup$/, backupDownload],
  ["GET", /^\/api\/admin\/backup\/check$/, backupCheck],
];
