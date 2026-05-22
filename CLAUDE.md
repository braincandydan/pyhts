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

`run.bat` handles everything for new users: checks for Python (installs via `winget` if missing), verifies data files exist, runs `hts_fetch.py` automatically if `hts.db` is absent, runs `ca_tariff_fetch.py` if `ca_tariff.db` is absent, kills any existing process on port 8765, then starts the server.

Startup takes ~20 seconds — loads and indexes both JSONL files from the parent directory.

## Data Files

Located one level up (`../`):
- `train.jsonl` — 315 agent trajectory records (multi-turn tool-call conversations)
- `train (1).jsonl` — 18,254 ruling Q&A records (user query + assistant HTS code answer)
- `inter_mtn_cusma_descriptions_hs_codes.csv` — CUSMA reference codes (repo root). Columns: `HS_Code`, `Description`. Loaded at startup into `CUSMA_DB`.

Optional (not tracked in git):
- `hts-review-airtable.csv` — product review list. Searched at `../hts-review-airtable.csv` then `D:\Rodney Wiki\...\hts-review-airtable.csv`. Columns: `Name`, `ProductCode`, `Substrate`, `Category`, `Suggested_HTS_Code`, `Notes`. Creates a `products` source in the index.

Records are indexed into memory at startup. Full record content is re-read from disk on demand via `/api/record/{id}`.

## HTS Code Enrichment

```
cd web
python hts_fetch.py
```

Downloads the full HTS schedule from USITC (`exportList?from=0101&to=9999&format=JSON&styles=false`) and creates `web/hts.db`. `run.bat` runs this automatically on first launch. Re-run manually to refresh after USITC publishes a new revision.

When `hts.db` is present, the server adds to each INDEX entry a `top_desc` field (description of first primary code) and the `/api/record/{id}` response gains an `enrichment` dict keyed by code, containing `description`, `general_rate`, `hierarchy` (chapter→heading→subheading→full), `agreement` (count of dataset records sharing that code), and `usitc_url`.

## Canadian Tariff Enrichment

```
cd web
python ca_tariff_fetch.py
```

Downloads the CBSA 2026 Canadian Customs Tariff (ZIP containing an Access `.accdb`), reads the `TPHS` table, and writes `web/ca_tariff.db`. **Windows only** — requires `pyodbc` (`pip install pyodbc`) and [Microsoft Access Database Engine 2016 (64-bit)](https://www.microsoft.com/en-us/download/details.aspx?id=54920).

When `ca_tariff.db` is present, `build_enrichment()` adds `ca_mfn` (MFN duty rate), `ca_ust` (CUSMA/UST preferential rate), and `ca_description` to each enrichment entry. The detail panel renders these alongside the US general rate.

## Architecture

### `web/server.py` — HTTP server + search engine + enrichment loader

**Global state loaded at startup:**
- `INDEX` — list of dicts, one per record; keyed fields: `id`, `source`, `source_label`, `file`, `line`, `codes` (primary), `codes_primary`, `codes_all`, `code_count`, `product`, `search_text`, `message_count`, `top_desc`.
- `HTS_DB` — `{digits: {description, general_rate}}` from `hts.db`.
- `CODE_AGREEMENT` — `{code: count}` across the full index (how many records reference each code).
- `CUSMA_DB` — `{code: description}` from the CUSMA CSV.
- `CA_TARIFF_DB` — `{digits: {description, mfn, ust, mxt, general_rate, uom}}` from `ca_tariff.db`.
- `CROSS_CACHE` — in-memory cache of CBP CROSS API responses, keyed by `"term:page_size"`.

**Startup sequence in `load_data()`:**
1. `load_hts_db()` — reads `hts.db` into `HTS_DB`
2. `load_ca_tariff_db()` — reads `ca_tariff.db` into `CA_TARIFF_DB`
3. `load_cusma_csv()` — reads CUSMA CSV into `CUSMA_DB`
4. Index both JSONL files via `extract_codes()` and `extract_product()`
5. Try each path in `_PRODUCT_CSV_CANDIDATES` and load products CSV if found
6. `compute_agreement()` — populates `CODE_AGREEMENT`
7. Stamp `top_desc` on each INDEX entry

**Key functions:**
- `build_enrichment(codes)` — constructs per-code enrichment dict with hierarchy, Canadian rates, agreement count, and USITC link.
- `_hts_lookup(digits)` — looks up `HTS_DB` by raw digits, falling back to 10-digit zero-padded form.
- `_ca_lookup(digits)` — looks up `CA_TARIFF_DB` with prefix expansion (e.g. 6-digit → tries `+00` and `+0000`; 10-digit → tries 8- and 6-digit prefixes).
- `search_cross(term)` — queries `rulings.cbp.gov/api/search`, caches results in `CROSS_CACHE`.
- `simplify_messages(row)` — truncates system prompts to 2500 chars before sending to client.
- `load_products_csv(path)` — parses product review CSV; assigns `review_status` of `missing`, `review`, `confirmed`, or `unconfirmed` (confirmed = code exists in `CUSMA_DB`, no REVIEW flag in notes).

**REST endpoints:**
| Endpoint | Method | Description |
|---|---|---|
| `GET /api/meta` | — | Server metadata: total, version (7), source counts, flags for `hts_enriched`, `ca_tariff`, `has_products` |
| `GET /api/search` | `?q=&source=&mode=` | Search index, max 500 results. `mode`: `word`, `substr`, `auto` |
| `GET /api/record/{id}` | — | Full record with `messages` and `enrichment` dict |
| `GET /api/cross-search` | `?q=` | Proxy to CBP CROSS, returns up to 15 rulings, cached in memory |

### `web/hts_extract.py` — HTS code parsing

- `extract_codes(row)` — returns `(primary_codes, all_codes)`. Primary = codes from assistant/tool messages. Falls back to all_codes if primary is empty.
- `extract_primary_codes(row)` — scans assistant and tool messages; also parses `HTS Code -> ...` arrow patterns and tool call arguments.
- `extract_all_codes(row)` — full JSON dump scan for any HTS-like pattern.
- `normalize_code(raw)` — canonicalizes to `XXXX.XX` or `XXXX.XX.XXXX` format; returns `None` for invalid input.
- `codes_from_text(text)` — finds all HTS codes using four regexes (10-digit, 6-digit, 4-digit, loose).
- `extract_product(messages)` — extracts product description from first user message using `Product: ...` regex or falls back to first 200 chars.
- `extract_search_text(messages)` — builds search blob: skips system prompts and chapter menu user messages; includes product text, user questions (800 chars), and assistant/tool replies (6000 chars). Lowercased.
- `is_code_query(query)` — true when at least half the characters are digits (min 2).
- `parse_multi_query(query)` — tokenises a query, keeping quoted phrases together. Returns a list; all tokens must match (AND semantics).
- `parse_text_query(query)` — returns `(term, whole_word)`. Quoted phrases → substring; plain words → whole word; `*prefix` → substring.
- `text_matches(search_text, token, mode)` — single-token match respecting `word`/`substr`/`auto` mode.

### `web/hts_fetch.py` — One-shot USITC downloader

Fetches the full schedule, handles envelope unwrapping for API response shape variants, writes `hts.db` (table: `hts(digits, htsno, description, general_rate, chapter, heading)`). Keyed by raw digit string (e.g. `"847710"`) — lookups also try 10-digit padded form via `_hts_lookup()`.

### `web/ca_tariff_fetch.py` — One-shot CBSA Canadian tariff downloader

Downloads `01-99-2026-0-eng.zip` from `cbsa-asfc.gc.ca`, extracts the `.accdb`, reads the `TPHS` table via `pyodbc`, and writes `ca_tariff.db` (table: `ca_tariff(digits, tariff, description, mfn, ust, mxt, general_rate, uom)`). Windows-only due to the Access ODBC driver requirement.

### `web/app.js` — Frontend

- `init()` — fetches `/api/meta`, populates source filter dropdown, validates server version ≥ 7.
- `runSearch()` — debounced (180 ms) fetch from `/api/search`, calls `renderResults()`.
- `renderResults(records, query)` — renders result list cards. Shows `top_desc` in italic when available. Product records show `review_status` badge instead of numeric ID.
- `selectRecord(id, query)` — fetches `/api/record/{id}`, routes to `renderDetail()` or `renderProductDetail()`.
- `renderDetail(data, query)` — renders agent/ruling record with primary codes panel, all-codes panel, CBP CROSS panel, and conversation messages.
- `renderProductDetail(data, query)` — renders product review record with fields, enrichment panel, notes, and CBP CROSS panel.
- `renderEnrichmentPanel(codes, enrichment, query)` — builds enriched primary-codes section: US rate, CA UST rate, CA MFN rate, agreement signal, USITC link, description, and hierarchy breadcrumb.
- `renderCodeTags(codes, query, limit, enrichment)` — renders code badges; accepts optional `enrichment` to add description tooltips.
- `renderCrossResults(rulings, term, error)` / `initCrossPanel()` — CBP CROSS search UI, inline within detail view.
- `searchForCode(code)` — sets search input and triggers search (used by "Search training data for X" button in product detail).
- `highlightQuery(text, query)` — HTML-escapes then highlights matching terms and HTS code patterns.

## Search Modes

- `word` (default) — whole-word match (e.g. "sign" matches "sign" but not "design")
- `substr` — substring match; prefix query with `*` to force in auto mode
- `auto` — digit-heavy queries route to code matching, others to text

**Multi-token AND search:** space-separated tokens all must match (either code or text). Quoted phrases `"like this"` match as substring. `*prefix` forces substring.

**Code matching:** normalizes to digits-only; checks prefix and substring on both full and stripped forms of each code in the record.

## Product Review Statuses

| Status | Meaning |
|---|---|
| `missing` | No `Suggested_HTS_Code` in CSV row |
| `review` | Notes contain "REVIEW" |
| `confirmed` | Code found in `CUSMA_DB` (from `inter_mtn_cusma_descriptions_hs_codes.csv`) |
| `unconfirmed` | Code present but not in CUSMA reference |

## Key Conventions

- **No pip dependencies** — `server.py`, `hts_fetch.py`, and `hts_extract.py` use stdlib only. `ca_tariff_fetch.py` is the only file that requires a third-party package (`pyodbc`), and it is optional.
- **DB files are not tracked in git** — `hts.db` and `ca_tariff.db` are generated artifacts; regenerate with their respective fetch scripts.
- **Record IDs are positional** — `INDEX[id]` is the authoritative lookup; IDs are assigned sequentially at load time across all sources in order: agent → rulings → products.
- **Static assets use cache-busting query strings** — `styles.css?v=8`, `app.js?v=12`. Bump these when making breaking frontend changes.
- **Server sends `Cache-Control: no-store`** for all API and static responses to prevent stale UI during development.
- **System prompt truncation** — `simplify_messages()` caps system prompts at 2500 chars to keep API responses small.
