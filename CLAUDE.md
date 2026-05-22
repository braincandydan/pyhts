# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

```bat
web\run.bat
```
Or directly:
```
python web/server.py [port]
```
Default port: `8765`. Opens at `http://127.0.0.1:8765/`. No pip dependencies — stdlib only.

`run.bat` handles everything for new users: checks for Python (installs via `winget` if missing), verifies data files exist, runs `hts_fetch.py` automatically if `hts.db` is absent, kills any existing process on port 8765, then starts the server.

Startup takes ~20 seconds — loads and indexes both JSONL files from the parent directory.

## HTS Code Enrichment

```
cd web
python hts_fetch.py
```

Downloads the full HTS schedule from USITC (`exportList?from=0101&to=9999&format=JSON&styles=false`) and creates `web/hts.db`. `run.bat` runs this automatically on first launch. Re-run manually to refresh after USITC publishes a new revision.

When `hts.db` is present, the server adds to each INDEX entry a `top_desc` field (description of first primary code) and the `/api/record/{id}` response gains an `enrichment` dict keyed by code, containing `description`, `general_rate`, `hierarchy` (chapter→heading→subheading→full), `agreement` (count of dataset records sharing that code), and `usitc_url`.

## Data Files

Located one level up (`../`):
- `train.jsonl` — 315 agent trajectory records (multi-turn tool-call conversations)
- `train (1).jsonl` — 18,254 ruling Q&A records (user query + assistant HTS code answer)

Records are indexed into memory at startup. Full record content is re-read from disk on demand via `/api/record/{id}`.

## Architecture

**`web/server.py`** — HTTP server + search engine + enrichment loader.
- `load_data()` calls `load_hts_db()` first, indexes JSONL files, then calls `compute_agreement()` and stamps `top_desc` on each INDEX entry.
- `build_enrichment(codes)` constructs the per-code enrichment dict from `HTS_DB` and `CODE_AGREEMENT`.
- REST endpoints: `GET /api/meta`, `GET /api/search?q=&source=&mode=` (max 500 results), `GET /api/record/{id}` (includes `enrichment`).

**`web/hts_extract.py`** — HTS code parsing. `extract_codes()` returns `(primary_codes, all_codes)` — primary are codes from assistant/tool messages, all includes everything in the record. `normalize_code()` canonicalizes to `XXXX.XX` or `XXXX.XX.XXXX` format. `extract_search_text()` builds the searchable text blob.

**`web/hts_fetch.py`** — One-shot USITC downloader. Fetches the full schedule, handles envelope unwrapping for API response shape variants, writes `hts.db` (table: `hts(digits, htsno, description, general_rate, chapter, heading)`). Keyed by raw digit string (e.g. `"847710"`) — lookups also try 10-digit padded form via `_hts_lookup()`.

**`web/app.js`** — Frontend. `renderEnrichmentPanel()` builds the enriched primary-codes section in the detail view. `renderCodeTags()` accepts optional `enrichment` param to add description tooltips. Result list cards show `top_desc` in italic when available.

## Search Modes

- `word` (default) — whole-word match
- `substr` — substring match; prefix query with `*` to force
- `auto` — digit-heavy queries route to code matching, others to text

Code matching normalizes to digits-only and checks prefix/substring on both full and stripped versions.
