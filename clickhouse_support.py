#!/usr/bin/env python3
"""Small HTTPS helper for ClickHouse Cloud sync."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
from urllib.parse import quote

from search_tavily import ENV_PATH, load_dotenv


def get_clickhouse_config() -> dict[str, str]:
    """Load ClickHouse connection details from environment."""
    load_dotenv(ENV_PATH)
    return {
        "host": os.environ.get("CLICKHOUSE_HOST", "").strip(),
        "user": os.environ.get("CLICKHOUSE_USER", "").strip(),
        "password": os.environ.get("CLICKHOUSE_PASSWORD", "").strip(),
        "port": os.environ.get("CLICKHOUSE_PORT", "").strip() or "8443",
    }


def has_clickhouse_config() -> bool:
    """Return whether all required ClickHouse settings are present."""
    config = get_clickhouse_config()
    return all(config.values())


def clickhouse_base_url() -> str:
    """Build the ClickHouse HTTPS base URL."""
    config = get_clickhouse_config()
    return f"https://{config['host']}:{config['port']}/"


def clickhouse_user_arg() -> str:
    """Return the user:password string for curl basic auth."""
    config = get_clickhouse_config()
    return f"{config['user']}:{config['password']}"


def run_clickhouse_query(query: str) -> str:
    """Execute a SQL statement over ClickHouse HTTP."""
    result = subprocess.run(
        [
            "curl",
            "--fail-with-body",
            "-sS",
            clickhouse_base_url(),
            "--user",
            clickhouse_user_arg(),
            "--data-binary",
            query,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.stdout


def apply_clickhouse_schema(schema_path: Path) -> None:
    """Create or update tables from the local schema file."""
    schema_text = schema_path.read_text(encoding="utf-8")
    statements = [statement.strip() for statement in schema_text.split(";") if statement.strip()]
    for statement in statements:
        run_clickhouse_query(statement)


def insert_jsonl(table_name: str, jsonl_path: Path) -> str:
    """Insert a JSONEachRow file into ClickHouse."""
    query = quote(f"INSERT INTO {table_name} FORMAT JSONEachRow", safe="")
    result = subprocess.run(
        [
            "curl",
            "--fail-with-body",
            "-sS",
            f"{clickhouse_base_url()}?query={query}",
            "--user",
            clickhouse_user_arg(),
            "--data-binary",
            f"@{jsonl_path}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return result.stdout
