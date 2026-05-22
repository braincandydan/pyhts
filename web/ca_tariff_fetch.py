#!/usr/bin/env python3
"""Download Canadian Customs Tariff (CBSA 2026) and convert to ca_tariff.db (SQLite)."""

import re
import sqlite3
import sys
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parent
ZIP_URL = "https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/2026/01-99/01-99-2026-0-eng.zip"
ZIP_PATH = ROOT / "_ca_tariff_temp.zip"
EXTRACT_DIR = ROOT / "_ca_tariff_extracted"
DB_PATH = ROOT / "ca_tariff.db"
_DIGS = re.compile(r"[^\d]")


def _digits(s: str) -> str:
    return _DIGS.sub("", s or "")


def find_accdb() -> Path | None:
    for ext in ("*.accdb", "*.mdb"):
        found = list(EXTRACT_DIR.glob(ext))
        if found:
            return found[0]
    return None


def download_and_extract() -> Path:
    EXTRACT_DIR.mkdir(exist_ok=True)
    if not ZIP_PATH.is_file():
        print(f"Downloading Canadian Customs Tariff 2026…")
        urlretrieve(ZIP_URL, ZIP_PATH)
        print(f"  {ZIP_PATH.stat().st_size // 1024:,} KB downloaded")
    with zipfile.ZipFile(ZIP_PATH) as zf:
        for name in zf.namelist():
            if name.endswith((".accdb", ".mdb")):
                zf.extract(name, EXTRACT_DIR)
                print(f"  Extracted {name}")
    accdb = find_accdb()
    if not accdb:
        print("ERROR: No .accdb / .mdb in ZIP", file=sys.stderr)
        sys.exit(1)
    return accdb


def main() -> None:
    # 1. Locate ACCDB
    accdb = find_accdb()
    if accdb:
        print(f"Found {accdb.name} ({accdb.stat().st_size // 1024 // 1024} MB)")
    else:
        accdb = download_and_extract()

    # 2. Open with pyodbc
    try:
        import pyodbc
    except ImportError:
        print("ERROR: pyodbc not installed.  Run: pip install pyodbc", file=sys.stderr)
        sys.exit(1)

    conn_str = f"Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};Dbq={accdb};"
    try:
        src = pyodbc.connect(conn_str)
    except Exception as e:
        print(f"ERROR: Cannot open database: {e}", file=sys.stderr)
        print("Install Microsoft Access Database Engine 2016 (64-bit):", file=sys.stderr)
        print("  https://www.microsoft.com/en-us/download/details.aspx?id=54920", file=sys.stderr)
        sys.exit(1)

    # 3. Read TPHS table
    cur = src.cursor()
    cur.execute(
        "SELECT TARIFF, DESC1, DESC2, DESC3, MFN, UST, MXT, [General Tariff], UOM "
        "FROM TPHS"
    )
    rows = cur.fetchall()
    src.close()
    print(f"  Read {len(rows):,} rows from TPHS")

    # 4. Write to SQLite
    if DB_PATH.is_file():
        DB_PATH.unlink()
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE ca_tariff (
            digits      TEXT PRIMARY KEY,
            tariff      TEXT,
            description TEXT,
            mfn         TEXT,
            ust         TEXT,
            mxt         TEXT,
            general_rate TEXT,
            uom         TEXT
        )
    """)

    written = 0
    for tariff, d1, d2, d3, mfn, ust, mxt, gen, uom in rows:
        if not tariff:
            continue
        d = _digits(tariff)
        if not d:
            continue
        desc = " ".join(filter(None, [
            (d1 or "").strip(),
            (d2 or "").strip(),
            (d3 or "").strip(),
        ]))
        db.execute(
            "INSERT OR REPLACE INTO ca_tariff VALUES (?,?,?,?,?,?,?,?)",
            (d, tariff, desc,
             (mfn or "").strip(), (ust or "").strip(), (mxt or "").strip(),
             (gen or "").strip(), (uom or "").strip()),
        )
        written += 1

    db.commit()
    db.close()
    print(f"  Wrote {written:,} rows to {DB_PATH.name}")


if __name__ == "__main__":
    main()
