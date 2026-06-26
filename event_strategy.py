#!/usr/bin/env python3
"""Generic event-driven signal engine built on Tavily, Gemini, and Python rules."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import urlparse

from ask_gemini import call_gemini, extract_text, get_api_key
from market_data import fetch_yahoo_chart, summarize_yahoo_chart
from search_tavily import ENV_PATH, call_tavily, load_dotenv
from watchlists import resolve_symbols

DEFAULT_RESULTS_PER_SYMBOL = 4
RUNS_DIR = Path(__file__).resolve().parent / "runs"
EVENT_TYPE_MULTIPLIERS = {
    "guidance_raise": 1.25,
    "guidance_cut": 1.25,
    "earnings_beat": 1.15,
    "earnings_miss": 1.15,
    "regulatory_probe": 1.30,
    "litigation": 1.10,
    "analyst_upgrade": 0.75,
    "analyst_downgrade": 0.75,
    "mna": 0.95,
    "product_launch": 0.70,
    "macro_theme": 0.60,
    "generic_positive": 0.55,
    "generic_negative": 0.55,
    "other": 0.50,
}
KEYWORD_RULES = [
    {
        "event_type": "guidance_raise",
        "direction": 1,
        "severity": 0.95,
        "keywords": ["raises guidance", "lifts outlook", "boosts forecast", "raises outlook"],
    },
    {
        "event_type": "guidance_cut",
        "direction": -1,
        "severity": 0.95,
        "keywords": ["cuts guidance", "lowers outlook", "slashes forecast", "warns on outlook"],
    },
    {
        "event_type": "earnings_beat",
        "direction": 1,
        "severity": 0.88,
        "keywords": ["beats estimates", "tops estimates", "earnings beat", "profit beat", "revenue beat"],
    },
    {
        "event_type": "earnings_miss",
        "direction": -1,
        "severity": 0.88,
        "keywords": ["misses estimates", "missed estimates", "earnings miss", "profit miss", "revenue miss"],
    },
    {
        "event_type": "regulatory_probe",
        "direction": -1,
        "severity": 0.92,
        "keywords": ["antitrust", "probe", "investigation", "regulator", "doj", "sec", "ftc"],
    },
    {
        "event_type": "litigation",
        "direction": -1,
        "severity": 0.82,
        "keywords": ["lawsuit", "sues", "settlement", "recall", "fine"],
    },
    {
        "event_type": "analyst_upgrade",
        "direction": 1,
        "severity": 0.58,
        "keywords": ["upgraded", "buy rating", "raised price target", "outperform"],
    },
    {
        "event_type": "analyst_downgrade",
        "direction": -1,
        "severity": 0.58,
        "keywords": ["downgraded", "sell rating", "cut price target", "underperform"],
    },
    {
        "event_type": "mna",
        "direction": 1,
        "severity": 0.72,
        "keywords": ["acquires", "acquisition", "buyout", "merger", "takeover"],
    },
    {
        "event_type": "product_launch",
        "direction": 1,
        "severity": 0.62,
        "keywords": ["launches", "unveils", "introduces", "releases"],
    },
]
POSITIVE_WORDS = {"surge", "gain", "strong", "wins", "expands", "growth", "record", "bullish"}
NEGATIVE_WORDS = {"drop", "weak", "falls", "cuts", "risk", "delay", "bearish", "concern"}


def parse_args(argv: list[str]) -> tuple[bool, str | None, int, list[str]]:
    raw = False
    watchlist_name: str | None = None
    results_per_symbol = DEFAULT_RESULTS_PER_SYMBOL
    symbols: list[str] = []
    index = 0

    while index < len(argv):
        arg = argv[index]
        if arg == "--raw":
            raw = True
            index += 1
            continue
        if arg == "--watchlist" and index + 1 < len(argv):
            watchlist_name = argv[index + 1]
            index += 2
            continue
        if arg == "--results" and index + 1 < len(argv):
            results_per_symbol = max(1, min(6, int(argv[index + 1])))
            index += 2
            continue
        symbols.append(arg)
        index += 1

    return raw, watchlist_name, results_per_symbol, symbols


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=True, sort_keys=True)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json_dumps(row))
            handle.write("\n")


def price_change_pct(summary: dict[str, Any]) -> float | None:
    closes = summary.get("close_series", [])
    if not isinstance(closes, list) or len(closes) < 2 or not closes[0]:
        return None
    return ((float(closes[-1]) / float(closes[0])) - 1.0) * 100.0


def build_tavily_query(symbol: str, summary: dict[str, Any]) -> str:
    company = str(summary.get("name", "")).strip()
    instrument_type = str(summary.get("instrument_type", "")).strip() or "stock"
    label = f"{symbol} {company}".strip()
    return (
        f"Latest market-moving news for {label} {instrument_type}. Focus on "
        f"earnings, guidance, regulation, lawsuits, M&A, analyst moves, product "
        f"launches, and other catalysts that could move the price."
    )


def normalize_articles(symbol: str, tavily_data: dict[str, Any], query: str) -> list[dict[str, Any]]:
    results = tavily_data.get("results", [])
    articles: list[dict[str, Any]] = []
    if not isinstance(results, list):
        return articles

    for rank, item in enumerate(results, start=1):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url", ""))
        domain = urlparse(url).netloc
        articles.append(
            {
                "symbol": symbol,
                "rank": rank,
                "query": query,
                "title": str(item.get("title", "")).strip(),
                "url": url,
                "domain": domain,
                "snippet": " ".join(str(item.get("content", "")).split()),
                "source_score": float(item.get("score", 0.0) or 0.0),
                "raw_result": item,
            }
        )
    return articles


def build_gemini_event_prompt(symbol: str, summary: dict[str, Any], articles: list[dict[str, Any]]) -> str:
    lines = [
        "Extract structured market events from the supplied articles.",
        f"Ticker: {symbol}",
        f"Instrument name: {summary.get('name', '')}",
        "",
        "Return JSON only with this schema:",
        '{',
        '  "symbol": "TICKER",',
        '  "events": [',
        "    {",
        '      "article_title": "string",',
        '      "source_url": "string",',
        '      "event_type": "guidance_raise|guidance_cut|earnings_beat|earnings_miss|regulatory_probe|litigation|analyst_upgrade|analyst_downgrade|mna|product_launch|macro_theme|other",',
        '      "direction": -1,',
        '      "severity": 0.0,',
        '      "relevance": 0.0,',
        '      "confidence": 0.0,',
        '      "horizon": "intraday|1d|1w",',
        '      "rationale": "one short sentence" ',
        "    }",
        "  ]",
        "}",
        "",
        "Rules:",
        "- Use only the supplied evidence.",
        "- Omit articles that do not contain a concrete market-moving event.",
        "- severity, relevance, and confidence must be between 0 and 1.",
        "- direction must be -1, 0, or 1.",
        "",
        "Articles:",
    ]

    for article in articles:
        lines.append(f"Title: {article['title']}")
        lines.append(f"URL: {article['url']}")
        lines.append(f"Snippet: {article['snippet']}")
        lines.append("")

    return "\n".join(lines)


def extract_json_payload(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text:
        return {}

    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fenced:
        return extract_json_payload(fenced.group(1))

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def event_score(event: dict[str, Any]) -> float:
    multiplier = EVENT_TYPE_MULTIPLIERS.get(str(event.get("event_type", "other")), 0.5)
    direction = int(event.get("direction", 0))
    severity = clamp(float(event.get("severity", 0.0) or 0.0), 0.0, 1.0)
    relevance = clamp(float(event.get("relevance", 0.0) or 0.0), 0.0, 1.0)
    confidence = clamp(float(event.get("confidence", 0.0) or 0.0), 0.0, 1.0)
    source_score = clamp(float(event.get("source_score", 0.65) or 0.65), 0.35, 1.0)
    return direction * multiplier * severity * relevance * confidence * source_score


def extract_events_with_gemini(
    symbol: str,
    summary: dict[str, Any],
    articles: list[dict[str, Any]],
    gemini_key: str,
) -> list[dict[str, Any]]:
    prompt = build_gemini_event_prompt(symbol, summary, articles)
    response = call_gemini(gemini_key, prompt)
    text = extract_text(response)
    payload = extract_json_payload(text)
    items = payload.get("events", [])
    events: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return events

    article_index = {article["url"]: article for article in articles}
    for item in items:
        if not isinstance(item, dict):
            continue
        url = str(item.get("source_url", "")).strip()
        article = article_index.get(url, {})
        event = {
            "symbol": symbol,
            "article_title": str(item.get("article_title", article.get("title", ""))).strip(),
            "source_url": url,
            "event_type": str(item.get("event_type", "other")).strip() or "other",
            "direction": int(item.get("direction", 0) or 0),
            "severity": clamp(float(item.get("severity", 0.0) or 0.0), 0.0, 1.0),
            "relevance": clamp(float(item.get("relevance", 0.0) or 0.0), 0.0, 1.0),
            "confidence": clamp(float(item.get("confidence", 0.0) or 0.0), 0.0, 1.0),
            "horizon": str(item.get("horizon", "1d")).strip() or "1d",
            "rationale": str(item.get("rationale", "")).strip(),
            "source_score": float(article.get("source_score", 0.65) or 0.65),
            "extractor": "gemini",
        }
        event["event_score"] = event_score(event)
        events.append(event)
    return events


def keyword_sentiment(text: str) -> int:
    words = set(re.findall(r"[a-z]+", text.lower()))
    positive_hits = len(words & POSITIVE_WORDS)
    negative_hits = len(words & NEGATIVE_WORDS)
    if positive_hits > negative_hits:
        return 1
    if negative_hits > positive_hits:
        return -1
    return 0


def extract_events_with_keywords(symbol: str, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    for article in articles:
        text = f"{article['title']} {article['snippet']}".lower()
        matched_rule = None
        for rule in KEYWORD_RULES:
            if any(keyword in text for keyword in rule["keywords"]):
                matched_rule = rule
                break

        if matched_rule is None:
            sentiment = keyword_sentiment(text)
            if sentiment == 0:
                continue
            matched_rule = {
                "event_type": "generic_positive" if sentiment > 0 else "generic_negative",
                "direction": sentiment,
                "severity": 0.48,
            }

        event = {
            "symbol": symbol,
            "article_title": article["title"],
            "source_url": article["url"],
            "event_type": matched_rule["event_type"],
            "direction": matched_rule["direction"],
            "severity": matched_rule["severity"],
            "relevance": clamp(0.55 + 0.35 * float(article["source_score"]), 0.0, 1.0),
            "confidence": 0.58,
            "horizon": "1d",
            "rationale": "Keyword rules matched the article headline/snippet.",
            "source_score": float(article["source_score"]),
            "extractor": "keyword_rules",
        }
        event["event_score"] = event_score(event)
        events.append(event)

    return events


def summarize_symbol(symbol: str, summary: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    total_score = sum(float(event.get("event_score", 0.0) or 0.0) for event in events)
    if total_score >= 0.35:
        signal = "long"
    elif total_score <= -0.35:
        signal = "short"
    else:
        signal = "neutral"

    sorted_events = sorted(events, key=lambda item: abs(float(item.get("event_score", 0.0) or 0.0)), reverse=True)
    strongest = sorted_events[0] if sorted_events else {}
    n = len(sorted_events)
    top_type = strongest.get("event_type", "none")
    top_score = strongest.get("event_score", 0.0)
    explanation = (
        f"{symbol} is {signal}: {n} event{'s' if n != 1 else ''} scored "
        f"(cumulative {total_score:+.3f}). "
        f"Top driver: {top_type} ({top_score:+.3f})."
    )

    return {
        "symbol": symbol,
        "name": summary.get("name", ""),
        "signal": signal,
        "total_score": round(total_score, 4),
        "price_change_pct": round(price_change_pct(summary), 4) if price_change_pct(summary) is not None else None,
        "event_count": len(events),
        "strongest_event_type": strongest.get("event_type", ""),
        "strongest_event_score": round(float(strongest.get("event_score", 0.0) or 0.0), 4) if strongest else 0.0,
        "top_driver_titles": [event.get("article_title", "") for event in sorted_events[:3]],
        "explanation": explanation,
    }


def format_signal_line(score: dict[str, Any]) -> str:
    move = score.get("price_change_pct")
    move_text = f"{move:+.2f}%" if isinstance(move, (int, float)) else "n/a"
    return (
        f"{score['symbol']:>5}  {score['signal']:<7}  score={score['total_score']:+.3f}  "
        f"move={move_text}  events={score['event_count']}  top={score['strongest_event_type'] or 'none'}"
    )


def run_pipeline(
    watchlist_name: str,
    symbols: list[str],
    results_per_symbol: int,
    raw: bool,
) -> int:
    load_dotenv(ENV_PATH)
    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not tavily_key:
        print("Missing TAVILY_API_KEY in .env or shell.", file=sys.stderr)
        return 1

    gemini_key = get_api_key()
    run_id = Path(os.urandom(8).hex()).name
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    article_rows: list[dict[str, Any]] = []
    event_rows: list[dict[str, Any]] = []
    score_rows: list[dict[str, Any]] = []
    warnings: list[str] = []

    for symbol in symbols:
        try:
            yahoo_raw = fetch_yahoo_chart(symbol)
            price_summary = summarize_yahoo_chart(yahoo_raw)
        except Exception as exc:  # noqa: BLE001
            price_summary = {"symbol": symbol, "name": "", "instrument_type": "stock"}
            warnings.append(f"Yahoo Finance failed for {symbol}: {exc}")

        tavily_query = build_tavily_query(symbol, price_summary)
        tavily_data = call_tavily(tavily_key, tavily_query)
        tavily_answer = str(tavily_data.get("answer", "")).strip()
        articles = normalize_articles(symbol, tavily_data, tavily_query)[:results_per_symbol]

        for article in articles:
            article_rows.append(
                {
                    "run_id": run_id,
                    "watchlist": watchlist_name,
                    "symbol": symbol,
                    "tavily_query": tavily_query,
                    "tavily_answer": tavily_answer,
                    "title": article["title"],
                    "url": article["url"],
                    "domain": article["domain"],
                    "rank": article["rank"],
                    "source_score": article["source_score"],
                    "snippet": article["snippet"],
                    "raw_json": json_dumps(article["raw_result"]),
                }
            )

        events: list[dict[str, Any]] = []
        if gemini_key and articles:
            try:
                events = extract_events_with_gemini(symbol, price_summary, articles, gemini_key)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Gemini extraction failed for {symbol}; falling back to keywords: {exc}")

        if not events:
            events = extract_events_with_keywords(symbol, articles)

        for event in events:
            event_rows.append(
                {
                    "run_id": run_id,
                    "watchlist": watchlist_name,
                    "symbol": symbol,
                    "article_title": event["article_title"],
                    "source_url": event["source_url"],
                    "event_type": event["event_type"],
                    "direction": event["direction"],
                    "severity": event["severity"],
                    "relevance": event["relevance"],
                    "confidence": event["confidence"],
                    "horizon": event["horizon"],
                    "source_score": event["source_score"],
                    "event_score": round(float(event["event_score"]), 6),
                    "rationale": event["rationale"],
                    "extractor": event["extractor"],
                }
            )

        score = summarize_symbol(symbol, price_summary, events)
        score["run_id"] = run_id
        score["watchlist"] = watchlist_name
        score_rows.append(score)

    score_rows.sort(key=lambda item: float(item["total_score"]), reverse=True)
    summary = {
        "run_id": run_id,
        "watchlist": watchlist_name,
        "symbols": symbols,
        "extractor_mode": "gemini" if gemini_key else "keyword_rules",
        "article_count": len(article_rows),
        "event_count": len(event_rows),
        "top_longs": [row["symbol"] for row in score_rows if row["signal"] == "long"][:3],
        "top_shorts": [row["symbol"] for row in score_rows if row["signal"] == "short"][:3],
        "warnings": warnings,
    }

    write_jsonl(run_dir / "articles_raw.jsonl", article_rows)
    write_jsonl(run_dir / "events_extracted.jsonl", event_rows)
    write_jsonl(run_dir / "ticker_scores.jsonl", score_rows)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    if raw:
        print(json.dumps({"summary": summary, "scores": score_rows}, indent=2))
        return 0

    print(f"Run ID: {run_id}")
    print(f"Watchlist: {watchlist_name} ({', '.join(symbols)})")
    print(f"Extractor mode: {'Gemini JSON' if gemini_key else 'Keyword fallback'}")
    print(f"Output dir: {run_dir}")
    print("\nSignals")
    print("-------")
    for row in score_rows:
        print(format_signal_line(row))

    if warnings:
        print("\nWarnings")
        print("--------")
        for warning in warnings:
            print(warning)
    return 0


def main(argv: list[str]) -> int:
    raw, watchlist_name, results_per_symbol, symbol_args = parse_args(argv)
    selected_watchlist, symbols = resolve_symbols(symbol_args, watchlist_name)
    return run_pipeline(selected_watchlist, symbols, results_per_symbol, raw)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
