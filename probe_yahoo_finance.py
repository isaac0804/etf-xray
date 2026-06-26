#!/usr/bin/env python3
"""Tiny Yahoo Finance probe for ETF price data."""

from __future__ import annotations

import json
import sys

from market_data import fetch_yahoo_chart, summarize_yahoo_chart

DEFAULT_SYMBOL = "QQQ"


def parse_args(argv: list[str]) -> tuple[bool, str]:
    raw = False
    parts: list[str] = []

    for arg in argv:
        if arg == "--raw":
            raw = True
        else:
            parts.append(arg)

    symbol = (parts[0] if parts else DEFAULT_SYMBOL).upper()
    return raw, symbol


def print_pretty(summary: dict[str, object]) -> None:
    closes = summary.get("close_series", [])
    start_close = closes[0] if isinstance(closes, list) and closes else None
    end_close = closes[-1] if isinstance(closes, list) and closes else None
    pct_change = None
    if isinstance(start_close, (int, float)) and isinstance(end_close, (int, float)) and start_close:
        pct_change = ((end_close / start_close) - 1.0) * 100.0

    print(f"Symbol: {summary.get('symbol', '')}")
    print(f"Name: {summary.get('name', '')}")
    print(f"Instrument type: {summary.get('instrument_type', '')}")
    print(f"Regular market price: {summary.get('regular_market_price', '')}")
    print(f"Previous close: {summary.get('previous_close', '')}")
    print(f"Day range: {summary.get('day_low', '')} - {summary.get('day_high', '')}")
    print(f"Volume: {summary.get('regular_market_volume', '')}")
    if pct_change is not None:
        print(f"Approx. {len(closes)}-point close change: {pct_change:.2f}%")


def main(argv: list[str]) -> int:
    raw, symbol = parse_args(argv)
    data = fetch_yahoo_chart(symbol)

    if raw:
        print(json.dumps(data, indent=2))
        return 0

    summary = summarize_yahoo_chart(data)
    print_pretty(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
