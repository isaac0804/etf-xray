#!/usr/bin/env python3
"""Preset watchlists for the generic event-driven signal demo."""

from __future__ import annotations

PRESET_WATCHLISTS: dict[str, list[str]] = {
    "mag7": ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"],
    "semis": ["NVDA", "AMD", "AVGO", "QCOM", "MU", "TXN", "INTC"],
    "energy": ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX"],
    "banks": ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW"],
    "indices": ["SPY", "QQQ", "IWM", "DIA"],
}


def resolve_symbols(symbols: list[str], watchlist_name: str | None) -> tuple[str, list[str]]:
    """Resolve either explicit symbols or a named preset watchlist."""
    clean_symbols = [symbol.upper() for symbol in symbols if symbol.strip()]
    if clean_symbols:
        return "custom", clean_symbols

    selected = (watchlist_name or "mag7").lower()
    return selected, PRESET_WATCHLISTS.get(selected, PRESET_WATCHLISTS["mag7"])
