#!/usr/bin/env python3
"""Turn the Mermaid family diagrams in family_tree.md into a CSV preview and SQL for D1.

Dev-only. Node ids become person ids (p_<id>); the same id in several diagrams is one person
(first label wins for names, all labels go to notes). "-->" edges are parent_of, "---" partner_of.
"""
import argparse
import csv
import html
import re
import sys
import time
from pathlib import Path

EDGE = re.compile(r'^\s*([A-Za-z0-9_]+)(?:\["(.*?)"\])?\s*(-->|---)\s*([A-Za-z0-9_]+)(?:\["(.*?)"\])?\s*$')
DOK = re.compile(r"\s*\((dok\.[^)]*)\)")
PAREN = re.compile(r"\([^)]*\)")
DMY = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")
YEARS = re.compile(r"(~?\d{4})\s*[–-]\s*†?\s*(?:(\d{2})\.(\d{2})\.)?(\d{4})")
BORN = re.compile(r"ur\.\s*(~?\d{4}(?:-\d{2}-\d{2})?|\d{2}\.\d{2}\.\d{4})\s*([^,()<]*)")
GENERIC = ("Unknown", "Daughter", "Son", "Children", "Half-brother", "parents", "brother of")
COLS = ["id", "first_name", "last_name", "display_name", "sex", "birth_date", "birth_place", "death_date", "death_place", "deceased", "notes", "unverified"]


def parse(md: str) -> tuple[dict[str, list[str]], list[tuple[str, str, str]]]:
    labels: dict[str, list[str]] = {}
    edges: list[tuple[str, str, str]] = []
    for line in md.splitlines():
        m = EDGE.match(line)
        if not m:
            continue
        a, la, kind, b, lb = m.groups()
        for node, label in ((a, la), (b, lb)):
            labels.setdefault(node, [])
            if label and label not in labels[node]:
                labels[node].append(html.unescape(label))
        edges.append((a, kind, b))
    return labels, edges


def iso(date: str) -> str:
    m = DMY.fullmatch(date)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else date


def person(node_id: str, labels: list[str]) -> dict:
    label = labels[0] if labels else node_id
    documented = any(DOK.search(l) for l in labels)
    text = DOK.sub("", label).partition("<br>")[0].strip()
    p = {"id": f"p_{node_id.lower()}", "first_name": None, "last_name": None, "display_name": text, "sex": None,
         "birth_date": None, "birth_place": None, "death_date": None, "death_place": None, "deceased": 0,
         "notes": "\n".join(labels), "unverified": 0 if documented else 1}
    name_part = PAREN.sub("", text).partition(",")[0].replace("†", "").strip()
    if not any(w in text for w in GENERIC):
        words = name_part.replace(" / ", "/").split()
        if len(words) >= 2 and words[-1][:1].isupper():
            p["first_name"], p["last_name"] = " ".join(words[:-1]).replace("/", " / "), words[-1]
        elif words:
            p["first_name"] = " ".join(words).replace("/", " / ")
    if "Daughter" in text or "sister" in text:
        p["sex"] = "f"
    if "Son" in text or "brother" in text:
        p["sex"] = "m"
    if "†" in text:
        p["deceased"] = 1
    m = YEARS.search(text)
    if m:
        p["birth_date"] = m.group(1)
        p["death_date"] = f"{m.group(4)}-{m.group(3)}-{m.group(2)}" if m.group(2) else m.group(4)
        p["deceased"] = 1
        tail = text[m.end():].strip(" ,")
        if tail and not tail.startswith("("):
            p["death_place"] = tail.split(",")[0].strip()
    else:
        m = BORN.search(text)
        if m:
            p["birth_date"] = iso(m.group(1))
            place = m.group(2).strip(" ,")
            if place:
                p["birth_place"] = place
    return p


def partner_kind(labels: list[str]) -> tuple[str, int | None, int | None]:
    joined = " ".join(labels)
    kind, start, end = "married", None, None
    m = re.search(r"m\.\s*(\d{4})", joined)
    if m:
        start = int(m.group(1))
    m = re.search(r"rozw[óo]d\s*(\d{4})", joined)
    if m:
        kind, end = "divorced", int(m.group(1))
    return kind, start, end


def sql(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("markdown", type=Path)
    ap.add_argument("--csv", type=Path, required=True, help="preview for review")
    ap.add_argument("--sql", type=Path, required=True, help="statements for wrangler d1 execute --file")
    args = ap.parse_args()
    labels, edges = parse(args.markdown.read_text(encoding="utf-8"))
    people = {node: person(node, ls) for node, ls in labels.items()}
    now = int(time.time())
    with args.csv.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for p in people.values():
            w.writerow({k: p[k] for k in COLS})
    out = [f"INSERT INTO people ({', '.join(COLS)}, created_at, updated_at) VALUES ({', '.join(sql(p[k]) for k in COLS)}, {now}, {now});" for p in people.values()]
    seen: set[tuple[str, str]] = set()
    n_par = n_part = 0
    for a, kind, b in edges:
        pa, pb = f"p_{a.lower()}", f"p_{b.lower()}"
        if kind == "-->":
            if (pa, pb) in seen:
                continue
            seen.add((pa, pb))
            out.append(f"INSERT INTO parent_of (parent_id, child_id) VALUES ({sql(pa)}, {sql(pb)});")
            n_par += 1
        else:
            k, s, e = partner_kind(labels[a] + labels[b])
            x, y = sorted((pa, pb))
            out.append(f"INSERT INTO partner_of (a_id, b_id, kind, start_year, end_year) VALUES ({sql(x)}, {sql(y)}, {sql(k)}, {sql(s)}, {sql(e)});")
            n_part += 1
    args.sql.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"{len(people)} people, {n_par} parent edges, {n_part} partner edges", file=sys.stderr)


if __name__ == "__main__":
    main()
