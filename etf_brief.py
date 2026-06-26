#!/usr/bin/env python3
"""Tiny Tavily -> Gemini ETF brief generator."""

from __future__ import annotations

import os
import re
import sys
import textwrap

from ask_gemini import call_gemini, extract_text, get_api_key
from market_data import (
    fetch_alpha_vantage_etf_profile,
    fetch_yahoo_chart,
    summarize_alpha_vantage_etf_profile,
    summarize_yahoo_chart,
)
from search_tavily import ENV_PATH, call_tavily, load_dotenv

DEFAULT_TOPIC = "QQQ and SPY"
STOPWORDS = {"AND", "ETF", "ETFS", "WHY", "WHAT", "THE", "FOR", "WITH"}


def build_tavily_query(topic: str) -> str:
    return (
        f"For {topic}, identify the biggest disclosed holdings, sector "
        f"concentration, overlap, and the simplest explanation of concentration "
        f"risk for a retail ETF investor."
    )


def extract_symbols(topic: str) -> list[str]:
    found = re.findall(r"\b[A-Z]{1,5}\b", topic.upper())
    symbols: list[str] = []
    for token in found:
        if token in STOPWORDS or token in symbols:
            continue
        symbols.append(token)
    return symbols


def format_alpha_summary(symbol: str, summary: dict[str, object]) -> list[str]:
    lines = [f"Alpha Vantage ETF profile for {symbol}:"]
    if summary.get("net_assets", ""):
        lines.append(f"- Net assets: {summary['net_assets']}")
    if summary.get("expense_ratio", ""):
        lines.append(f"- Expense ratio: {summary['expense_ratio']}")

    sectors = summary.get("sectors", [])
    if isinstance(sectors, list) and sectors:
        sector_text = ", ".join(
            f"{item.get('sector', '')} {item.get('weight', '')}"
            for item in sectors[:3]
            if isinstance(item, dict)
        )
        if sector_text:
            lines.append(f"- Top sectors: {sector_text}")

    holdings = summary.get("holdings", [])
    if isinstance(holdings, list) and holdings:
        holding_text = ", ".join(
            f"{item.get('symbol', '')} {item.get('weight', '')}"
            for item in holdings[:5]
            if isinstance(item, dict)
        )
        if holding_text:
            lines.append(f"- Top holdings: {holding_text}")

    if summary.get("error_message", ""):
        lines.append(f"- Provider note: {summary['error_message']}")
    return lines


def format_yahoo_summary(symbol: str, summary: dict[str, object]) -> list[str]:
    lines = [f"Yahoo Finance market snapshot for {symbol}:"]
    if summary.get("regular_market_price") is not None:
        lines.append(f"- Regular market price: {summary['regular_market_price']}")
    if summary.get("previous_close") is not None:
        lines.append(f"- Previous close: {summary['previous_close']}")
    if summary.get("day_low") is not None and summary.get("day_high") is not None:
        lines.append(f"- Day range: {summary['day_low']} to {summary['day_high']}")
    if summary.get("regular_market_volume") is not None:
        lines.append(f"- Volume: {summary['regular_market_volume']}")

    closes = summary.get("close_series", [])
    if isinstance(closes, list) and len(closes) >= 2 and closes[0]:
        pct_change = ((closes[-1] / closes[0]) - 1.0) * 100.0
        lines.append(f"- Approx. recent close move: {pct_change:.2f}%")
    return lines


def build_gemini_prompt(
    topic: str,
    tavily_answer: str,
    tavily_results: list[dict[str, object]],
    yahoo_summaries: list[tuple[str, dict[str, object]]],
    alpha_summaries: list[tuple[str, dict[str, object]]],
) -> str:
    lines = [
        "You are helping with a tiny ETF demo for non-experts.",
        f"Topic: {topic}",
        "",
        "Tavily answer:",
        tavily_answer or "(none)",
        "",
        "Top search results:",
    ]

    for index, item in enumerate(tavily_results[:5], start=1):
        title = str(item.get("title", "(untitled)"))
        url = str(item.get("url", ""))
        snippet = " ".join(str(item.get("content", "")).split())
        lines.append(f"{index}. {title}")
        lines.append(f"   URL: {url}")
        if snippet:
            lines.append(f"   Snippet: {snippet[:400]}")

    if yahoo_summaries:
        lines.extend(["", "Yahoo Finance structured data:"])
        for symbol, summary in yahoo_summaries:
            lines.extend(format_yahoo_summary(symbol, summary))

    if alpha_summaries:
        lines.extend(["", "Alpha Vantage structured data:"])
        for symbol, summary in alpha_summaries:
            lines.extend(format_alpha_summary(symbol, summary))

    lines.extend(
        [
            "",
            "Write a concise ETF brief with exactly these sections:",
            "1. What You Really Own",
            "2. Why That Matters",
            "3. Biggest Shared Bet",
            "4. One-Sentence Takeaway",
            "",
            "Rules:",
            "- Plain English",
            "- Do not invent holdings not supported by the input",
            "- If the data is noisy or uncertain, say so clearly",
            "- Keep it under 180 words",
        ]
    )

    return "\n".join(lines)


def main(argv: list[str]) -> int:
    load_dotenv(ENV_PATH)
    topic = " ".join(argv).strip() or DEFAULT_TOPIC
    symbols = extract_symbols(topic)

    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not tavily_key:
        print("Missing TAVILY_API_KEY in .env or shell.", file=sys.stderr)
        return 1

    tavily_query = build_tavily_query(topic)
    tavily_data = call_tavily(tavily_key, tavily_query)
    tavily_answer = str(tavily_data.get("answer", "")).strip()
    tavily_results = tavily_data.get("results", [])
    if not isinstance(tavily_results, list):
        tavily_results = []

    alpha_key = os.environ.get("ALPHA_VANTAGE_API_KEY", "").strip()
    yahoo_summaries: list[tuple[str, dict[str, object]]] = []
    alpha_summaries: list[tuple[str, dict[str, object]]] = []
    source_warnings: list[str] = []

    for symbol in symbols:
        try:
            yahoo_raw = fetch_yahoo_chart(symbol)
            yahoo_summaries.append((symbol, summarize_yahoo_chart(yahoo_raw)))
        except Exception as exc:  # noqa: BLE001
            source_warnings.append(f"Yahoo Finance failed for {symbol}: {exc}")

        try:
            alpha_raw = fetch_alpha_vantage_etf_profile(symbol, api_key=alpha_key)
            alpha_summaries.append((symbol, summarize_alpha_vantage_etf_profile(alpha_raw)))
        except Exception as exc:  # noqa: BLE001
            source_warnings.append(f"Alpha Vantage failed for {symbol}: {exc}")

    gemini_key = get_api_key()
    if not gemini_key:
        print("Tavily worked, but GEMINI_API_KEY is missing.\n")
        print("Tavily answer")
        print("-------------")
        print(textwrap.fill(tavily_answer or "(no answer returned)", width=90))
        if yahoo_summaries:
            print("\nYahoo Finance")
            print("-------------")
            for symbol, summary in yahoo_summaries:
                for line in format_yahoo_summary(symbol, summary):
                    print(line)
        if alpha_summaries:
            print("\nAlpha Vantage")
            print("-------------")
            for symbol, summary in alpha_summaries:
                for line in format_alpha_summary(symbol, summary):
                    print(line)
        if source_warnings:
            print("\nSource warnings")
            print("---------------")
            for warning in source_warnings:
                print(warning)
        print("\nAdd GEMINI_API_KEY to .env to get the tightened ETF brief.")
        return 0

    prompt = build_gemini_prompt(
        topic,
        tavily_answer,
        tavily_results,
        yahoo_summaries,
        alpha_summaries,
    )
    gemini_data = call_gemini(gemini_key, prompt)
    brief = extract_text(gemini_data)

    print(f"Topic: {topic}\n")
    print("Tight ETF Brief")
    print("----------------")
    print(textwrap.fill(brief or "(Gemini returned no text)", width=90))
    if source_warnings:
        print("\nSource warnings")
        print("---------------")
        for warning in source_warnings:
            print(warning)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
