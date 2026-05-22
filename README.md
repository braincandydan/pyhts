# pyhts

Browse and search HTS (Harmonized Tariff Schedule) training data: agent trajectories and ruling Q&A records, with USITC schedule enrichment.

## Quick start

```bat
web\run.bat
```

Opens at http://127.0.0.1:8765/ (default port 8765). Requires Python 3 — stdlib only, no pip install.

On first run, `run.bat` downloads the USITC HTS schedule into `web/hts.db` if missing.

## Data

Place these JSONL files in the repo root (included in this repo):

- `train.jsonl` — agent trajectory records
- `train (1).jsonl` — ruling Q&A records

## Manual HTS refresh

```bat
cd web
python hts_fetch.py
```

See [CLAUDE.md](CLAUDE.md) for architecture and API details.
