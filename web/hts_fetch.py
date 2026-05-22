#!/usr/bin/env python3
"""
Fetch the full HTS schedule from USITC and build web/hts.db.

Run once before starting the server:
    cd web
    python hts_fetch.py

Re-run any time to refresh (e.g. after USITC publishes a new revision).
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import urllib.request
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "hts.db"
EXPORT_URL = (
    "https://hts.usitc.gov/reststop/exportList"
    "?from=0101&to=9999&format=JSON&styles=false"
)
_DIGS = re.compile(r"[^\d]")


def _digits(s: str) -> str:
    return _DIGS.sub("", s)


def fetch_schedule() -> list[dict]:
    print("Fetching HTS schedule from USITC (may take ~30 s)…")
    req = urllib.request.Request(
        EXPORT_URL,
        headers={"User-Agent": "HTSTrainingSearch/1.0"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read()
    print(f"  Downloaded {len(raw):,} bytes")
    data = json.loads(raw)

    # Unwrap if the response is an envelope object
    if isinstance(data, dict):
        for key in ("data", "results", "records", "htsList"):
            if isinstance(data.get(key), list):
                print(f"  Unwrapped from key '{key}'")
                data = data[key]
                break
        else:
            # Last resort: find any large list value
            for k, v in data.items():
                if isinstance(v, list) and len(v) > 100:
                    print(f"  Unwrapped from key '{k}'")
                    data = v
                    break
            else:
                print(f"ERROR: Unexpected response shape. Keys: {list(data.keys())}", file=sys.stderr)
                print("  First 500 chars of response:", file=sys.stderr)
                print(json.dumps(data)[:500], file=sys.stderr)
                sys.exit(1)

    if not isinstance(data, list):
        print(f"ERROR: Expected list, got {type(data).__name__}", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(data):,} entries received")
    return data


def build_db(records: list[dict]) -> None:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS hts (
            digits       TEXT PRIMARY KEY,
            htsno        TEXT,
            description  TEXT,
            general_rate TEXT,
            chapter      TEXT,
            heading      TEXT
        );
        DELETE FROM hts;
    """)

    rows: list[tuple] = []
    for rec in records:
        htsno = (rec.get("htsno") or "").strip()
        desc = (rec.get("description") or "").strip()
        if not htsno or not desc:
            continue
        d = _digits(htsno)
        if len(d) < 2:
            continue
        rows.append((
            d,
            htsno,
            desc,
            (rec.get("general") or "").strip(),
            d[:2],
            d[:4] if len(d) >= 4 else d,
        ))

    cur.executemany("INSERT OR REPLACE INTO hts VALUES (?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()
    print(f"  Stored {len(rows):,} descriptions → {DB_PATH.name}")


def main() -> None:
    records = fetch_schedule()
    build_db(records)
    print("Done. Restart server.py to load enrichment data.")


if __name__ == "__main__":
    main()
