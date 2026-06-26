#!/usr/bin/env python3
"""Tiny Alpha Vantage probe for ETF profile and daily price data."""

from __future__ import annotations

import json
import os
import sys

from market_data import (
    fetch_alpha_vantage_daily,
    fetch_alpha_vantage_etf_profile,
    summarize_alpha_vantage_etf_profile,
)
from search_tavily import ENV_PATH, load_dotenv

DEFAULT_SYMBOL = "QQQ"


def parse_args(argv: list[str]) -> tuple[bool, bool, str]:
    raw = False
    daily = False
    parts: list[str] = []

    for arg in argv:
        if arg == "--raw":
            raw = True
        elif arg == "--daily":
            daily = True
        else:
            parts.append(arg)

    symbol = (parts[0] if parts else DEFAULT_SYMBOL).upper()
    return raw, daily, symbol


def print_profile(summary: dict[str, object]) -> None:
    print(f"Net assets: {summary.get('net_assets', '')}")
    print(f"Expense ratio: {summary.get('expense_ratio', '')}")
    print(f"Dividend yield: {summary.get('dividend_yield', '')}")
    print(f"Inception date: {summary.get('inception_date', '')}")
    print(f"Leveraged: {summary.get('leveraged', '')}")

    sectors = summary.get("sectors", [])
    if isinstance(sectors, list) and sectors:
        print("\nTop sectors:")
        for item in sectors[:5]:
            if isinstance(item, dict):
                print(f"- {item.get('sector', '')}: {item.get('weight', '')}")

    holdings = summary.get("holdings", [])
    if isinstance(holdings, list) and holdings:
        print("\nTop holdings:")
        for item in holdings[:5]:
            if isinstance(item, dict):
                print(
                    f"- {item.get('symbol', '')}: "
                    f"{item.get('description', '')} ({item.get('weight', '')})"
                )

    error_message = summary.get("error_message", "")
    if error_message:
        print(f"\nProvider note: {error_message}")


def print_daily(data: dict[str, object]) -> None:
    meta = data.get("Meta Data", {})
    series = data.get("Time Series (Daily)", {})

    if not isinstance(meta, dict) or not isinstance(series, dict):
        print(json.dumps(data, indent=2))
        return

    dates = sorted(series.keys(), reverse=True)
    print(f"Symbol: {meta.get('2. Symbol', '')}")
    print(f"Last refreshed: {meta.get('3. Last Refreshed', '')}")

    for date in dates[:5]:
        row = series.get(date, {})
        if isinstance(row, dict):
            print(
                f"- {date}: close={row.get('4. close', '')} "
                f"volume={row.get('5. volume', '')}"
            )


def main(argv: list[str]) -> int:
    load_dotenv(ENV_PATH)
    raw, daily, symbol = parse_args(argv)
    api_key = os.environ.get("ALPHA_VANTAGE_API_KEY", "").strip()

    if daily:
        data = fetch_alpha_vantage_daily(symbol, api_key=api_key)
        if raw:
            print(json.dumps(data, indent=2))
        else:
            if not api_key:
                print("Using Alpha Vantage demo key.\n")
            print_daily(data)
        return 0

    data = fetch_alpha_vantage_etf_profile(symbol, api_key=api_key)
    if raw:
        print(json.dumps(data, indent=2))
        return 0

    if not api_key:
        print("Using Alpha Vantage demo key.\n")
    print_profile(summarize_alpha_vantage_etf_profile(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
