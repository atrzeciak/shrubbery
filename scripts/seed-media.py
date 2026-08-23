#!/usr/bin/env python3
"""Build and apply a human-editable checklist for seeding media from the family archive.

Dev-only, two passes, never touches the network on its own:

`scan` reads `assets/` and `family_tree.md` (same mermaid-label parsing as `seed-people.py`)
and writes a TSV checklist (`file kind owner tags caption year seed`) with `seed` pre-filled
per the privacy rules below — a person must review and hand-edit it before anything uploads.

`apply` reads the edited TSV and, for `seed=yes` rows only, prints (or with `--execute` runs)
`wrangler r2 object put` and writes `media`/`media_people` INSERTs to a SQL file for
`wrangler d1 execute --file`. It enforces the 6-owned-files cap per person.

Privacy pre-fill (seed column), in order: a filename containing "rozwod" is always `no`
(divorce records); an unmatched file (no `(dok. NNN)` reference found in family_tree.md) is
`no`; a matched file whose owner is alive per `scripts/out/people.csv` is `no`; if that CSV is
missing, alive/deceased is unknown and seed is `?`; everything else (matched, deceased owner)
is `yes`.
"""
import argparse
import csv
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

EDGE = re.compile(r'^\s*([A-Za-z0-9_]+)(?:\["(.*?)"\])?\s*(-->|---)\s*([A-Za-z0-9_]+)(?:\["(.*?)"\])?\s*$')
DOK = re.compile(r"\((dok\.[^)]*)\)")
NUM_PREFIX = re.compile(r"^(\d+)_")
HINT = re.compile(r"grob|photo", re.IGNORECASE)
YEAR = re.compile(r"(?:19|20)\d{2}")
SKIP = re.compile(r"_transkrypcja", re.IGNORECASE)
NOT_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]+")
COLS = ["file", "kind", "owner", "tags", "caption", "year", "seed"]
CONTENT_TYPES = {"jpg": "image/jpeg", "pdf": "application/pdf"}


def bucket_name() -> str:
    """Return the R2 bucket to upload into, read from wrangler.toml or MEDIA_BUCKET."""
    env = os.environ.get("MEDIA_BUCKET")
    if env:
        return env
    toml = pathlib.Path(__file__).resolve().parent.parent / "wrangler.toml"
    if toml.exists():
        found = re.search(r'^bucket_name\s*=\s*"([^"]+)"', toml.read_text(), re.MULTILINE)
        if found:
            return found.group(1)
    raise SystemExit("no bucket: set MEDIA_BUCKET or add bucket_name to wrangler.toml")


def wrangler_cmd() -> list[str]:
    """Return the command prefix that runs wrangler (installed binary, else npx)."""
    return ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler"]
MEDIA_CAP = 6


def dok_owners(markdown: str) -> dict[int, str]:
    """Map each `dok. NNN` number to the mermaid node id whose label carries it."""
    owners: dict[int, str] = {}
    for line in markdown.splitlines():
        m = EDGE.match(line)
        if not m:
            continue
        node_a, label_a, _kind, node_b, label_b = m.groups()
        for node, label in ((node_a, label_a), (node_b, label_b)):
            if not label:
                continue
            for dok in DOK.finditer(label):
                for num in re.findall(r"\d+", dok.group(1)):
                    owners.setdefault(int(num), node)
    return owners


def deceased_by_person(people_csv: Path) -> dict[str, int] | None:
    """Load `id -> deceased` from SP2's people.csv, or None if it hasn't been generated yet."""
    if not people_csv.exists():
        return None
    with people_csv.open(newline="", encoding="utf-8") as f:
        return {row["id"]: int(row["deceased"]) for row in csv.DictReader(f)}


def rows_for_stem(stem: str, exts: dict[str, Path]) -> list[str]:
    """Pick which extension(s) become checklist rows for one stem.

    A pdf twin always wins for a document; a jpg is listed on its own only when there's no pdf
    twin, or when the filename hints it's a photo (e.g. a grave shot) rather than a scanned
    record — in that case both the document (pdf) and the photo (jpg) are kept.
    """
    hint = bool(HINT.search(stem))
    if "pdf" in exts and "jpg" in exts:
        return ["pdf", "jpg"] if hint else ["pdf"]
    return list(exts)


def build_row(path: Path, dok: dict[int, str], deceased: dict[str, int] | None) -> dict[str, str]:
    stem, ext = path.stem, path.suffix.lower().lstrip(".")
    hint = bool(HINT.search(stem))
    prefix = NUM_PREFIX.match(stem)
    node = dok.get(int(prefix.group(1))) if prefix else None
    owner = f"p_{node.lower()}" if node else ""
    kind = "photo" if ext == "jpg" and (hint or not owner) else "document"
    years = YEAR.findall(stem)
    caption = NUM_PREFIX.sub("", stem).replace("_", " ")

    if "rozwod" in stem.lower() or not owner:
        seed = "no"
    elif deceased is None or owner not in deceased:
        seed = "?"
    elif deceased[owner] == 1:
        seed = "yes"
    else:
        seed = "no"

    return {"file": path.name, "kind": kind, "owner": owner, "tags": "", "caption": caption,
             "year": years[-1] if years else "", "seed": seed}


def scan(args: argparse.Namespace) -> None:
    dok = dok_owners(args.tree.read_text(encoding="utf-8"))
    deceased = deceased_by_person(Path("scripts/out/people.csv"))
    grouped: dict[str, dict[str, Path]] = {}
    for path in sorted(p for p in args.assets.iterdir() if p.is_file()):
        ext = path.suffix.lower().lstrip(".")
        if ext not in CONTENT_TYPES or SKIP.search(path.name):
            continue
        grouped.setdefault(path.stem, {})[ext] = path

    rows = []
    for stem in sorted(grouped):
        exts = grouped[stem]
        for ext in rows_for_stem(stem, exts):
            rows.append(build_row(exts[ext], dok, deceased))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS, delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows written to {args.out}", file=sys.stderr)


def sql(v: str | int | None) -> str:
    if v is None or v == "":
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def apply(args: argparse.Namespace) -> None:
    with args.checklist.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))

    now = int(time.time())
    stmts: list[str] = []
    owned_count: dict[str, int] = {}
    uploaded = skipped_cap = skipped_no = skipped_bad = 0

    for row in rows:
        if row["seed"].strip().lower() != "yes":
            skipped_no += 1
            continue
        owner = row["owner"].strip()
        if not owner:
            print(f"WARN: skipping {row['file']!r} — seed=yes but owner is blank", file=sys.stderr)
            skipped_bad += 1
            continue
        path = args.assets / row["file"]
        ext = path.suffix.lower().lstrip(".")
        if ext not in CONTENT_TYPES:
            print(f"WARN: skipping {row['file']!r} — unsupported extension {ext!r}", file=sys.stderr)
            skipped_bad += 1
            continue
        n = owned_count.get(owner, 0)
        if n >= MEDIA_CAP:
            print(f"WARN: skipping {row['file']!r} — {owner} already has {MEDIA_CAP} files", file=sys.stderr)
            skipped_cap += 1
            continue
        owned_count[owner] = n + 1

        media_id = f"s_{NOT_ID_CHARS.sub('_', path.stem)}_{ext}"
        key = f"{args.r2_prefix}{media_id}.{ext}"
        cmd = [*wrangler_cmd(), "r2", "object", "put", f"{bucket_name()}/{key}", "--file", str(path), "--remote"]
        if args.execute:
            subprocess.run(cmd, check=True)
        else:
            print("DRY RUN:", " ".join(cmd))

        size = path.stat().st_size if path.exists() else 0
        vals = [media_id, owner, row["kind"], row["caption"] or None,
                int(row["year"]) if row["year"] else None, CONTENT_TYPES[ext], size, 0, args.uploader, now]
        cols = ["id", "owner_person_id", "kind", "caption", "year", "content_type", "size",
                "has_thumb", "uploaded_by", "created_at"]
        stmts.append(f"INSERT INTO media ({', '.join(cols)}) VALUES ({', '.join(sql(v) for v in vals)});")
        for tag in (t.strip() for t in row["tags"].split(",")):
            if tag and tag != owner:
                stmts.append(f"INSERT INTO media_people (media_id, person_id) VALUES ({sql(media_id)}, {sql(tag)});")
        uploaded += 1

    args.sql.parent.mkdir(parents=True, exist_ok=True)
    args.sql.write_text("\n".join(stmts) + ("\n" if stmts else ""), encoding="utf-8")
    print(f"{uploaded} rows applied, {skipped_cap} skipped (cap), {skipped_bad} skipped (bad row), "
          f"{skipped_no} skipped (seed != yes); SQL written to {args.sql}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p_scan = sub.add_parser("scan", help="build the checklist from the archive")
    p_scan.add_argument("--assets", type=Path, required=True)
    p_scan.add_argument("--tree", type=Path, required=True)
    p_scan.add_argument("--out", type=Path, required=True)
    p_scan.set_defaults(func=scan)

    p_apply = sub.add_parser("apply", help="upload + write SQL for the edited checklist's seed=yes rows")
    p_apply.add_argument("--checklist", type=Path, required=True)
    p_apply.add_argument("--assets", type=Path, required=True)
    p_apply.add_argument("--sql", type=Path, required=True)
    p_apply.add_argument("--r2-prefix", dest="r2_prefix", default="media/")
    p_apply.add_argument("--uploader", required=True, help="accounts.id to record as uploaded_by")
    p_apply.add_argument("--execute", action="store_true", help="actually run wrangler r2 object put")
    p_apply.set_defaults(func=apply)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
