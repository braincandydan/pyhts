#!/usr/bin/env python3
"""Local web UI to search HTS training data (multiple JSONL sources)."""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from hts_extract import extract_codes, extract_product, extract_search_text, is_code_query, text_matches

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT.parent
DB_PATH = ROOT / "hts.db"

# (source label, filename)
DATA_FILES: list[tuple[str, str]] = [
    ("agent", "train.jsonl"),
    ("rulings", "train (1).jsonl"),
]

INDEX: list[dict] = []
HTS_DB: dict[str, dict] = {}      # digits → {description, general_rate}
CODE_AGREEMENT: dict[str, int] = {}  # code → count of records containing it
_DIGS = re.compile(r"[^\d]")


def discover_data_files() -> list[tuple[str, Path]]:
    files: list[tuple[str, Path]] = []
    for label, name in DATA_FILES:
        path = DATA_DIR / name
        if path.is_file():
            files.append((label, path))
    return files


def code_matches(codes: list[str], query: str) -> bool:
    q = query.strip()
    if not q:
        return True
    if not is_code_query(q):
        return False
    q_digits = re.sub(r"[^\d]", "", q)
    for code in codes:
        c_digits = re.sub(r"[^\d]", "", code)
        if q in code or code.startswith(q):
            return True
        if q_digits and (c_digits.startswith(q_digits) or q_digits in c_digits):
            return True
    return False


def record_matches(
    record: dict, query: str, match_mode: str = "auto"
) -> tuple[bool, bool, bool]:
    q = query.strip()
    if not q:
        return True, False, False
    codes = record.get("codes_all") or record.get("codes") or []
    by_code = code_matches(codes, q)
    by_text = text_matches(record.get("search_text", ""), q, match_mode)
    return by_code or by_text, by_code, by_text


def load_record(entry: dict) -> dict:
    path = Path(entry["file"])
    line_no = entry["line"]
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i == line_no:
                return json.loads(line)
    raise KeyError(f"Record not found: {entry['id']}")


def _digits(code: str) -> str:
    return _DIGS.sub("", code)


def load_hts_db() -> None:
    global HTS_DB
    if not DB_PATH.is_file():
        print("hts.db not found — run: python hts_fetch.py  (optional, enables code enrichment)")
        return
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT digits, description, general_rate FROM hts")
    HTS_DB = {
        row["digits"]: {
            "description": row["description"],
            "general_rate": row["general_rate"] or "",
        }
        for row in cur.fetchall()
    }
    conn.close()
    print(f"Loaded {len(HTS_DB):,} HTS descriptions from hts.db")


def compute_agreement() -> None:
    global CODE_AGREEMENT
    counts: dict[str, int] = {}
    for r in INDEX:
        for code in r.get("codes_all") or []:
            counts[code] = counts.get(code, 0) + 1
    CODE_AGREEMENT = counts


def _hts_lookup(d: str) -> dict | None:
    return HTS_DB.get(d) or HTS_DB.get(d.ljust(10, "0"))


def build_enrichment(codes: list[str]) -> dict:
    if not HTS_DB:
        return {}
    result: dict = {}
    for code in codes:
        d = _digits(code)
        if len(d) < 4:
            continue
        own = _hts_lookup(d)
        # Build hierarchy: chapter → heading → subheading → full
        hierarchy = []
        seen: set[str] = set()
        for lvl_name, lvl_d in [
            ("chapter", d[:2]),
            ("heading", d[:4]),
            ("subheading", d[:6]),
            ("full", d),
        ]:
            if lvl_d in seen or len(lvl_d) < 2:
                continue
            seen.add(lvl_d)
            entry = _hts_lookup(lvl_d)
            if not entry:
                continue
            if lvl_name == "chapter":
                display = lvl_d
            elif lvl_name == "heading":
                display = lvl_d
            elif lvl_name == "subheading":
                display = f"{lvl_d[:4]}.{lvl_d[4:6]}"
            else:
                display = code
            hierarchy.append({
                "level": lvl_name,
                "code": display,
                "description": entry["description"],
            })
        if not hierarchy and not own:
            continue
        result[code] = {
            "description": own["description"] if own else "",
            "general_rate": own["general_rate"] if own else "",
            "hierarchy": hierarchy,
            "agreement": CODE_AGREEMENT.get(code, 0),
            "usitc_url": f"https://hts.usitc.gov/search?query={d.ljust(10, '0')}",
        }
    return result


def load_data() -> None:
    global INDEX
    files = discover_data_files()
    if not files:
        print(f"No JSONL files found in {DATA_DIR}", file=sys.stderr)
        sys.exit(1)

    load_hts_db()
    INDEX = []
    global_id = 0
    for source, path in files:
        print(f"Indexing {path.name} ({source}) …")
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f):
                row = json.loads(line)
                primary, all_codes = extract_codes(row)
                product = extract_product(row.get("messages", []))
                INDEX.append(
                    {
                        "id": global_id,
                        "source": source,
                        "source_label": "Agent trajectories" if source == "agent" else "Ruling Q&A",
                        "file": str(path),
                        "line": line_no,
                        "codes": primary,
                        "codes_primary": primary,
                        "codes_all": all_codes,
                        "code_count": len(all_codes),
                        "product": product,
                        "search_text": extract_search_text(row.get("messages", [])),
                        "message_count": len(row.get("messages", [])),
                    }
                )
                global_id += 1
                if global_id % 5000 == 0:
                    print(f"  … {global_id} records")

    by_source = {}
    for r in INDEX:
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    print(f"Indexed {len(INDEX)} records: {by_source}")
    compute_agreement()
    if HTS_DB:
        enriched = 0
        for r in INDEX:
            first = r["codes_primary"][0] if r["codes_primary"] else None
            if first:
                e = _hts_lookup(_digits(first))
                r["top_desc"] = e["description"] if e else ""
                if e:
                    enriched += 1
            else:
                r["top_desc"] = ""
        print(f"Enriched {enriched:,} records with HTS descriptions")


def simplify_messages(row: dict) -> list[dict]:
    out = []
    for m in row["messages"]:
        role = m.get("role", "?")
        content = m.get("content") or ""
        if role == "system" and len(content) > 2500:
            content = content[:2500] + "\n\n… [system prompt truncated] …"
        entry: dict = {"role": role, "content": content}
        if m.get("tool_calls"):
            entry["tool_calls"] = m["tool_calls"]
        out.append(entry)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if args and "200" in str(args[1]):
            return
        super().log_message(fmt, *args)

    def end_headers(self) -> None:
        if self.path.endswith((".js", ".css", ".html")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        query = (qs.get("q") or [""])[0].strip()
        source_filter = (qs.get("source") or [""])[0].strip()
        match_mode = (qs.get("mode") or ["word"])[0].strip() or "word"
        if match_mode not in ("word", "substr", "auto"):
            match_mode = "word"

        if path == "/api/meta":
            by_source = {}
            for r in INDEX:
                by_source[r["source"]] = by_source.get(r["source"], 0) + 1
            self._json(
                {
                    "total": len(INDEX),
                    "version": 5,
                    "text_search": True,
                    "word_search": True,
                    "sources": by_source,
                    "files": [name for _, name in DATA_FILES],
                    "hts_enriched": bool(HTS_DB),
                }
            )
            return

        if path == "/api/search":
            pool = INDEX
            if source_filter:
                pool = [r for r in INDEX if r["source"] == source_filter]
            if query:
                results = []
                for r in pool:
                    matched, by_code, by_text = record_matches(r, query, match_mode)
                    if matched:
                        results.append(
                            {
                                **r,
                                "match_code": by_code,
                                "match_text": by_text,
                            }
                        )
            else:
                results = list(pool)
            self._json(
                {
                    "total": len(INDEX),
                    "count": len(results),
                    "results": results[:500],
                    "query": query,
                    "source": source_filter or None,
                    "mode": match_mode,
                }
            )
            return

        if path.startswith("/api/record/"):
            try:
                rid = int(path.split("/")[-1])
            except ValueError:
                self.send_error(404)
                return
            if rid < 0 or rid >= len(INDEX):
                self.send_error(404)
                return
            entry = INDEX[rid]
            row = load_record(entry)
            self._json(
                {
                    "id": rid,
                    "source": entry["source"],
                    "source_label": entry["source_label"],
                    "product": entry["product"],
                    "codes": entry["codes_primary"],
                    "codes_all": entry["codes_all"],
                    "messages": simplify_messages(row),
                    "enrichment": build_enrichment(entry["codes_all"]),
                }
            )
            return

        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def _json(self, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    load_data()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Open http://127.0.0.1:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
