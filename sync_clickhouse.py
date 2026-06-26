#!/usr/bin/env python3
"""Sync a News2Signal run directory into ClickHouse Cloud."""

from __future__ import annotations

from pathlib import Path
import sys

from clickhouse_support import apply_clickhouse_schema, has_clickhouse_config, insert_jsonl

PROJECT_DIR = Path(__file__).resolve().parent
RUNS_DIR = PROJECT_DIR / "runs"
SCHEMA_PATH = PROJECT_DIR / "clickhouse_schema.sql"
TABLE_FILE_MAP = [
    ("articles_raw", "articles_raw.jsonl"),
    ("event_facts", "event_facts.jsonl"),
    ("propagation_facts", "propagation_facts.jsonl"),
    ("signal_outputs", "signal_outputs.jsonl"),
    ("sector_alerts", "sector_alerts.jsonl"),
]


def latest_run_dir() -> Path | None:
    """Return the most recently modified run directory."""
    if not RUNS_DIR.exists():
        return None
    candidates = [path for path in RUNS_DIR.iterdir() if path.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.stat().st_mtime)


def resolve_run_dir(argv: list[str]) -> Path | None:
    """Resolve a run directory from CLI args or default to the latest run."""
    if argv:
        candidate = Path(argv[0]).expanduser()
        if not candidate.is_absolute():
            candidate = RUNS_DIR / candidate
        return candidate
    return latest_run_dir()


def main(argv: list[str]) -> int:
    if not has_clickhouse_config():
        print("Missing ClickHouse configuration in .env.", file=sys.stderr)
        return 1

    run_dir = resolve_run_dir(argv)
    if run_dir is None or not run_dir.exists():
        print("Could not find a run directory to sync.", file=sys.stderr)
        return 2

    apply_clickhouse_schema(SCHEMA_PATH)
    print(f"Applied schema to ClickHouse for run {run_dir.name}")

    for table_name, filename in TABLE_FILE_MAP:
        path = run_dir / filename
        if not path.exists():
            continue
        insert_jsonl(table_name, path)
        print(f"Synced {filename} -> {table_name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
