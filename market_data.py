#!/usr/bin/env python3
"""Small HTTP helpers for Yahoo Finance and Alpha Vantage ETF probes."""

from __future__ import annotations

import json
import subprocess
from urllib.parse import urlencode


def curl_json(url: str, headers: dict[str, str] | None = None, timeout: int = 30) -> dict[str, object]:
    """Fetch JSON over curl using the system certificate store."""
    command = ["curl", "--fail-with-body", "-sS", url]

    for key, value in (headers or {}).items():
        command.extend(["-H", f"{key}: {value}"])

    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return json.loads(result.stdout)


def fetch_yahoo_chart(symbol: str, range_name: str = "5d", interval: str = "1d") -> dict[str, object]:
    """Fetch a simple market snapshot from Yahoo Finance's public chart endpoint."""
    query = urlencode({"range": range_name, "interval": interval})
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}?{query}"
    return curl_json(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        },
    )


def summarize_yahoo_chart(data: dict[str, object]) -> dict[str, object]:
    """Reduce Yahoo chart JSON to the tiny fields we care about."""
    chart = data.get("chart", {})
    if not isinstance(chart, dict):
        return {}

    results = chart.get("result", [])
    if not isinstance(results, list) or not results:
        return {}

    first = results[0]
    if not isinstance(first, dict):
        return {}

    meta = first.get("meta", {})
    timestamps = first.get("timestamp", [])
    indicators = first.get("indicators", {})
    if not isinstance(meta, dict) or not isinstance(indicators, dict):
        return {}

    quote_list = indicators.get("quote", [])
    quote = quote_list[0] if isinstance(quote_list, list) and quote_list else {}
    closes = quote.get("close", []) if isinstance(quote, dict) else []
    volumes = quote.get("volume", []) if isinstance(quote, dict) else []

    clean_closes = [value for value in closes if isinstance(value, (int, float))]
    clean_volumes = [value for value in volumes if isinstance(value, (int, float))]

    return {
        "symbol": meta.get("symbol", ""),
        "name": meta.get("shortName") or meta.get("longName") or "",
        "instrument_type": meta.get("instrumentType", ""),
        "currency": meta.get("currency", ""),
        "regular_market_price": meta.get("regularMarketPrice"),
        "previous_close": meta.get("chartPreviousClose"),
        "day_high": meta.get("regularMarketDayHigh"),
        "day_low": meta.get("regularMarketDayLow"),
        "regular_market_volume": meta.get("regularMarketVolume"),
        "timestamps": timestamps if isinstance(timestamps, list) else [],
        "close_series": clean_closes,
        "volume_series": clean_volumes,
    }


def fetch_alpha_vantage_etf_profile(symbol: str, api_key: str | None = None) -> dict[str, object]:
    """Fetch ETF holdings/sectors from Alpha Vantage's official ETF_PROFILE endpoint."""
    key = (api_key or "").strip() or "demo"
    query = urlencode({"function": "ETF_PROFILE", "symbol": symbol, "apikey": key})
    url = f"https://www.alphavantage.co/query?{query}"
    return curl_json(url)


def fetch_alpha_vantage_daily(symbol: str, api_key: str | None = None) -> dict[str, object]:
    """Fetch daily price history from Alpha Vantage."""
    key = (api_key or "").strip() or "demo"
    query = urlencode({"function": "TIME_SERIES_DAILY", "symbol": symbol, "apikey": key})
    url = f"https://www.alphavantage.co/query?{query}"
    return curl_json(url)


def summarize_alpha_vantage_etf_profile(data: dict[str, object]) -> dict[str, object]:
    """Reduce Alpha Vantage ETF profile JSON to the main hackathon fields."""
    sectors = data.get("sectors", [])
    holdings = data.get("holdings", [])

    clean_sectors = []
    if isinstance(sectors, list):
        for item in sectors[:5]:
            if isinstance(item, dict):
                clean_sectors.append(
                    {
                        "sector": item.get("sector", ""),
                        "weight": item.get("weight", ""),
                    }
                )

    clean_holdings = []
    if isinstance(holdings, list):
        for item in holdings[:10]:
            if isinstance(item, dict):
                clean_holdings.append(
                    {
                        "symbol": item.get("symbol", ""),
                        "description": item.get("description", ""),
                        "weight": item.get("weight", ""),
                    }
                )

    return {
        "net_assets": data.get("net_assets", ""),
        "expense_ratio": data.get("net_expense_ratio", ""),
        "turnover": data.get("portfolio_turnover", ""),
        "dividend_yield": data.get("dividend_yield", ""),
        "inception_date": data.get("inception_date", ""),
        "leveraged": data.get("leveraged", ""),
        "sectors": clean_sectors,
        "holdings": clean_holdings,
        "error_message": (
            data.get("Error Message")
            or data.get("Note")
            or data.get("Information")
            or ""
        ),
    }
