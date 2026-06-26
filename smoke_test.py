#!/usr/bin/env python3
"""Small smoke test for News2Signal integrations."""

from __future__ import annotations

import json
import os
import subprocess
import sys

from ask_gemini import call_gemini, extract_text, get_api_key
from event_strategy import run_pipeline
from market_data import fetch_yahoo_chart, summarize_yahoo_chart
from propagation_graph import build_propagation_facts
from search_tavily import ENV_PATH, call_tavily, load_dotenv


def run_component_tests() -> int:
    load_dotenv(ENV_PATH)

    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    gemini_key = get_api_key()

    print("News2Signal smoke test\n")

    if not tavily_key:
        print("FAIL: missing TAVILY_API_KEY")
        return 1
    print("PASS: TAVILY_API_KEY present")

    if gemini_key:
        print("PASS: GEMINI_API_KEY present")
    else:
        print("WARN: GEMINI_API_KEY missing, Gemini test will be skipped")

    try:
        yahoo = summarize_yahoo_chart(fetch_yahoo_chart("NVDA"))
        print(f"PASS: Yahoo Finance returned NVDA price {yahoo.get('regular_market_price')}")
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: Yahoo Finance test failed: {exc}")
        return 2

    try:
        tavily = call_tavily(tavily_key, "Latest market-moving headlines for NVDA stock")
        result_count = len(tavily.get("results", [])) if isinstance(tavily.get("results", []), list) else 0
        print(f"PASS: Tavily returned {result_count} results")
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: Tavily test failed: {exc}")
        return 3

    if gemini_key:
        try:
            data = call_gemini(gemini_key, "Reply with exactly: GEMINI_OK")
            text = extract_text(data)
            print(f"PASS: Gemini returned: {text}")
        except subprocess.CalledProcessError as exc:
            details = f"{exc.stdout}\n{exc.stderr}".lower()
            if "quota" in details or "429" in details or "resource_exhausted" in details:
                print("WARN: Gemini quota exhausted, pipeline will rely on keyword fallback")
            else:
                print(f"FAIL: Gemini test failed: {exc}")
                return 4
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL: Gemini test failed: {exc}")
            return 4

    synthetic_facts = [
        {
            "symbol": "TSM",
            "event_type": "supply_disruption",
            "macro_theme": "supply_chain",
            "base_event_score": -0.82,
            "source_url": "synthetic://test",
            "article_title": "Synthetic TSM disruption",
        }
    ]
    propagation = build_propagation_facts(synthetic_facts, ["TSM", "NVDA", "AMD"])
    if not any(item.get("target_symbol") == "NVDA" for item in propagation):
        print("FAIL: propagation graph did not map TSM -> NVDA")
        return 5
    print(f"PASS: propagation graph produced {len(propagation)} downstream facts")

    print("\nComponent smoke test passed.")
    return 0


def main(argv: list[str]) -> int:
    full = "--full" in argv
    status = run_component_tests()
    if status != 0 or not full:
        return status

    print("\nRunning full pipeline on TSM, NVDA, and AMD...\n")
    return run_pipeline("custom", ["TSM", "NVDA", "AMD"], 2, raw=False)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
