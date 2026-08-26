// What the browser will hand to the upload route, decided before anything crosses the wire.
// Drag-and-drop ignores the picker's accept filter, so the type check has to live here too.
const PDF_MAX = 10 * 1024 * 1024;

export function pickKind(file) {
  if (file.type === "application/pdf") return file.size > PDF_MAX ? { error: "toobig" } : { kind: "document" };
  if (file.type.startsWith("image/")) return { kind: "photo" };
  return { error: "badtype" };
}

export function formatSize(bytes, lang = "en") {
  const units = ["B", "kB", "MB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  const digits = i === 0 || n >= 10 ? 0 : 1;
  const fmt = new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${fmt.format(n)} ${units[i]}`;
}
