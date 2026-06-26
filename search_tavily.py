#!/usr/bin/env python3
"""Minimal Tavily search probe for generic market/event questions."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request

API_URL = "https://api.tavily.com/search"
DEFAULT_QUERY = (
    "What are the latest market-moving headlines for NVDA stock?"
)
PROJECT_DIR = Path(__file__).resolve().parent
ENV_PATH = PROJECT_DIR / ".env"


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE pairs from a local .env file."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')

        if key and key not in os.environ:
            os.environ[key] = value


def build_payload(api_key: str, query: str) -> dict[str, object]:
    return {
        "api_key": api_key,
        "query": query,
        "topic": "finance",
        "search_depth": "basic",
        "max_results": 5,
        "include_answer": True,
        "include_favicon": True,
    }


def call_tavily(api_key: str, query: str) -> dict[str, object]:
    payload = build_payload(api_key, query)
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        message = str(exc)
        if "CERTIFICATE_VERIFY_FAILED" not in message:
            raise

    # macOS Python sometimes misses local CA roots; curl uses the system store.
    curl_result = subprocess.run(
        [
            "curl",
            "-sS",
            API_URL,
            "-H",
            "Content-Type: application/json",
            "-d",
            json.dumps(payload),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(curl_result.stdout)


def print_pretty(data: dict[str, object]) -> None:
    print(f"Query: {data.get('query', '')}\n")

    answer = data.get("answer")
    if answer:
        print("Answer")
        print("------")
        print(textwrap.fill(str(answer), width=90))
        print()

    results = data.get("results", [])
    if isinstance(results, list) and results:
        print("Top Results")
        print("-----------")
        for index, item in enumerate(results, start=1):
            if not isinstance(item, dict):
                continue

            title = item.get("title", "(untitled)")
            url = item.get("url", "")
            score = item.get("score", "")
            content = str(item.get("content", "")).strip()

            print(f"{index}. {title}")
            print(f"   URL: {url}")
            if score != "":
                print(f"   Score: {score}")
            if content:
                snippet = textwrap.shorten(" ".join(content.split()), width=220)
                print(f"   Snippet: {snippet}")
            print()

    usage = data.get("usage")
    if isinstance(usage, dict) and "credits" in usage:
        print(f"Credits used: {usage['credits']}")


def parse_args(argv: list[str]) -> tuple[bool, str]:
    raw = False
    parts: list[str] = []

    for arg in argv:
        if arg == "--raw":
            raw = True
        else:
            parts.append(arg)

    query = " ".join(parts).strip() or DEFAULT_QUERY
    return raw, query


def main(argv: list[str]) -> int:
    load_dotenv(ENV_PATH)
    raw, query = parse_args(argv)
    api_key = os.environ.get("TAVILY_API_KEY", "").strip()

    if not api_key:
        print("Missing TAVILY_API_KEY environment variable.", file=sys.stderr)
        print("Example: export TAVILY_API_KEY='tvly-...'", file=sys.stderr)
        return 1

    try:
        data = call_tavily(api_key, query)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Tavily HTTP error: {exc.code}", file=sys.stderr)
        print(body, file=sys.stderr)
        return 2
    except urllib.error.URLError as exc:
        print(f"Network error calling Tavily: {exc}", file=sys.stderr)
        return 3

    if raw:
        print(json.dumps(data, indent=2))
    else:
        print_pretty(data)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
