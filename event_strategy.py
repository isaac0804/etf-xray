#!/usr/bin/env python3
"""Fact-based event strategy with retrieval, extraction, propagation, and rules."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlparse

from article_filters import filter_articles
from ask_gemini import call_gemini, extract_text, get_api_key
from market_data import fetch_yahoo_chart, summarize_yahoo_chart
from propagation_graph import build_propagation_facts, metadata_for
from search_tavily import ENV_PATH, call_tavily, load_dotenv
from watchlists import resolve_symbols

DEFAULT_RESULTS_PER_SYMBOL = 4
RUNS_DIR = Path(__file__).resolve().parent / "runs"
EVENT_TYPE_MULTIPLIERS = {
    "supply_disruption": 1.35,
    "guidance_raise": 1.20,
    "guidance_cut": 1.25,
    "earnings_beat": 1.10,
    "earnings_miss": 1.15,
    "regulatory_probe": 1.30,
    "litigation": 1.05,
    "analyst_upgrade": 0.70,
    "analyst_downgrade": 0.70,
    "mna": 0.85,
    "product_launch": 0.65,
    "partnership": 0.60,
    "capex": 0.65,
    "demand_signal": 0.75,
    "macro_theme": 0.70,
    "generic_positive": 0.50,
    "generic_negative": 0.50,
    "other": 0.45,
}
KEYWORD_RULES = [
    {
        "event_type": "supply_disruption",
        "direction": -1,
        "severity_score": 0.92,
        "severity_label": "high",
        "macro_theme": "supply_chain",
        "keywords": ["supply disruption", "production halt", "shutdown", "factory fire", "earthquake", "export curbs"],
    },
    {
        "event_type": "guidance_raise",
        "direction": 1,
        "severity_score": 0.90,
        "severity_label": "high",
        "macro_theme": "demand",
        "keywords": ["raises guidance", "lifts outlook", "boosts forecast", "raises outlook"],
    },
    {
        "event_type": "guidance_cut",
        "direction": -1,
        "severity_score": 0.92,
        "severity_label": "high",
        "macro_theme": "demand",
        "keywords": ["cuts guidance", "lowers outlook", "slashes forecast", "warns on outlook"],
    },
    {
        "event_type": "earnings_beat",
        "direction": 1,
        "severity_score": 0.84,
        "severity_label": "medium",
        "macro_theme": "earnings",
        "keywords": ["beats estimates", "tops estimates", "earnings beat", "profit beat", "revenue beat"],
    },
    {
        "event_type": "earnings_miss",
        "direction": -1,
        "severity_score": 0.84,
        "severity_label": "medium",
        "macro_theme": "earnings",
        "keywords": ["misses estimates", "missed estimates", "earnings miss", "profit miss", "revenue miss"],
    },
    {
        "event_type": "regulatory_probe",
        "direction": -1,
        "severity_score": 0.90,
        "severity_label": "high",
        "macro_theme": "geopolitical_risk",
        "keywords": ["antitrust", "probe", "investigation", "regulator", "doj", "sec", "ftc", "export ban"],
    },
    {
        "event_type": "mna",
        "direction": 1,
        "severity_score": 0.68,
        "severity_label": "medium",
        "macro_theme": "strategic_activity",
        "keywords": ["acquires", "acquisition", "buyout", "merger", "takeover"],
    },
    {
        "event_type": "product_launch",
        "direction": 1,
        "severity_score": 0.56,
        "severity_label": "medium",
        "macro_theme": "innovation",
        "keywords": ["launches", "unveils", "introduces", "releases"],
    },
    {
        "event_type": "analyst_upgrade",
        "direction": 1,
        "severity_score": 0.46,
        "severity_label": "low",
        "macro_theme": "sell_side",
        "keywords": ["upgraded", "buy rating", "raised price target", "outperform"],
    },
    {
        "event_type": "analyst_downgrade",
        "direction": -1,
        "severity_score": 0.46,
        "severity_label": "low",
        "macro_theme": "sell_side",
        "keywords": ["downgraded", "sell rating", "cut price target", "underperform"],
    },
]
POSITIVE_WORDS = {"surge", "gain", "strong", "wins", "expands", "growth", "record", "bullish"}
NEGATIVE_WORDS = {"drop", "weak", "falls", "cuts", "risk", "delay", "bearish", "concern"}


def parse_args(argv: list[str]) -> tuple[bool, bool, str | None, int, list[str]]:
    raw = False
    sync_clickhouse = False
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
        if arg == "--sync-clickhouse":
            sync_clickhouse = True
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

    return raw, sync_clickhouse, watchlist_name, results_per_symbol, symbols


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
        f"Latest discrete market-moving news articles for {label} {instrument_type}. "
        f"Prefer real article pages, not quote/profile pages. Focus on earnings, "
        f"guidance, regulation, supply disruption, litigation, M&A, analyst moves, "
        f"capex, and product launches."
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


def build_gemini_fact_prompt(symbol: str, summary: dict[str, Any], articles: list[dict[str, Any]]) -> str:
    lines = [
        "Extract structured market-event facts from the supplied article evidence.",
        f"Ticker: {symbol}",
        f"Instrument name: {summary.get('name', '')}",
        "",
        "Return JSON only with this schema:",
        "{",
        '  "symbol": "TICKER",',
        '  "facts": [',
        "    {",
        '      "article_title": "string",',
        '      "source_url": "string",',
        '      "entity_name": "string",',
        '      "event_type": "supply_disruption|guidance_raise|guidance_cut|earnings_beat|earnings_miss|regulatory_probe|litigation|analyst_upgrade|analyst_downgrade|mna|product_launch|partnership|capex|demand_signal|macro_theme|other",',
        '      "severity_label": "low|medium|high",',
        '      "severity_score": 0.0,',
        '      "confidence": 0.0,',
        '      "sentiment_score": -1.0,',
        '      "direction": "up|down|neutral",',
        '      "time_horizon": "intraday|short_term|medium_term",',
        '      "macro_theme": "geopolitical_risk|supply_chain|demand|earnings|innovation|regulation|strategic_activity|sell_side|other",',
        '      "region": "US|APAC|Europe|Global|other",',
        '      "affected_sectors": ["string"],',
        '      "summary": "one short sentence" ',
        "    }",
        "  ]",
        "}",
        "",
        "Rules:",
        "- Use only the supplied evidence.",
        "- Ignore profile pages, quote pages, and non-event pages.",
        "- If there is no discrete event, omit that article entirely.",
        "- severity_score and confidence must be between 0 and 1.",
        "- sentiment_score must be between -1 and 1.",
        "- Be conservative and avoid hallucination.",
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


def direction_sign(direction: str, sentiment_score: float) -> int:
    mapping = {"up": 1, "down": -1, "neutral": 0}
    if direction in {"up", "down"}:
        return mapping[direction]
    if sentiment_score > 0:
        return 1
    if sentiment_score < 0:
        return -1
    return 0


def severity_label_from_score(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"


def base_event_score(fact: dict[str, Any]) -> float:
    event_type = str(fact.get("event_type", "other"))
    multiplier = EVENT_TYPE_MULTIPLIERS.get(event_type, EVENT_TYPE_MULTIPLIERS["other"])
    severity_score = clamp(float(fact.get("severity_score", 0.0) or 0.0), 0.0, 1.0)
    confidence = clamp(float(fact.get("confidence", 0.0) or 0.0), 0.0, 1.0)
    sentiment_score = clamp(float(fact.get("sentiment_score", 0.0) or 0.0), -1.0, 1.0)
    quality_score = clamp(float(fact.get("quality_score", 0.0) or 0.0), 0.0, 1.0)
    sign = direction_sign(str(fact.get("direction", "neutral")), sentiment_score)
    magnitude = abs(sentiment_score) if sentiment_score != 0 else 0.25
    quality_weight = clamp(0.45 + 0.55 * quality_score, 0.35, 1.0)
    return sign * multiplier * severity_score * confidence * magnitude * quality_weight


def extract_facts_with_gemini(
    symbol: str,
    summary: dict[str, Any],
    articles: list[dict[str, Any]],
    gemini_key: str,
) -> list[dict[str, Any]]:
    prompt = build_gemini_fact_prompt(symbol, summary, articles)
    response = call_gemini(gemini_key, prompt)
    payload = extract_json_payload(extract_text(response))
    items = payload.get("facts", [])
    facts: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return facts

    article_index = {article["url"]: article for article in articles}
    for item in items:
        if not isinstance(item, dict):
            continue
        url = str(item.get("source_url", "")).strip()
        article = article_index.get(url, {})
        direction = str(item.get("direction", "neutral")).strip().lower() or "neutral"
        fact = {
            "symbol": symbol,
            "article_title": str(item.get("article_title", article.get("title", ""))).strip(),
            "source_url": url,
            "entity_name": str(item.get("entity_name", summary.get("name", symbol))).strip(),
            "event_type": str(item.get("event_type", "other")).strip() or "other",
            "severity_score": clamp(float(item.get("severity_score", 0.0) or 0.0), 0.0, 1.0),
            "severity_label": str(item.get("severity_label", "")).strip().lower(),
            "confidence": clamp(float(item.get("confidence", 0.0) or 0.0), 0.0, 1.0),
            "sentiment_score": clamp(float(item.get("sentiment_score", 0.0) or 0.0), -1.0, 1.0),
            "direction": direction,
            "time_horizon": str(item.get("time_horizon", "short_term")).strip() or "short_term",
            "macro_theme": str(item.get("macro_theme", "other")).strip() or "other",
            "region": str(item.get("region", metadata_for(symbol).get("region", "Global"))).strip() or "Global",
            "affected_sectors": item.get("affected_sectors", []) if isinstance(item.get("affected_sectors", []), list) else [],
            "summary": str(item.get("summary", "")).strip(),
            "source_score": float(article.get("source_score", 0.65) or 0.65),
            "quality_score": float(article.get("quality_score", 0.6) or 0.6),
            "extractor": "gemini",
        }
        if not fact["severity_label"]:
            fact["severity_label"] = severity_label_from_score(fact["severity_score"])
        fact["base_event_score"] = round(base_event_score(fact), 6)
        facts.append(fact)
    return facts


def keyword_sentiment(text: str) -> int:
    words = set(re.findall(r"[a-z]+", text.lower()))
    positive_hits = len(words & POSITIVE_WORDS)
    negative_hits = len(words & NEGATIVE_WORDS)
    if positive_hits > negative_hits:
        return 1
    if negative_hits > positive_hits:
        return -1
    return 0


def infer_region(symbol: str) -> str:
    return str(metadata_for(symbol).get("region", "Global"))


def infer_sector(symbol: str) -> str:
    return str(metadata_for(symbol).get("sector", "unknown"))


def extract_facts_with_keywords(symbol: str, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []

    for article in articles:
        text = f"{article['title']} {article['snippet']}".lower()
        matched_rule = None
        for rule in KEYWORD_RULES:
            if any(keyword in text for keyword in rule["keywords"]):
                matched_rule = rule
                break

        sentiment = 0
        if matched_rule is None:
            sentiment = keyword_sentiment(text)
            if sentiment == 0:
                continue
            matched_rule = {
                "event_type": "generic_positive" if sentiment > 0 else "generic_negative",
                "direction": sentiment,
                "severity_score": 0.42,
                "severity_label": "low",
                "macro_theme": "other",
            }
        else:
            sentiment = matched_rule["direction"]

        fact = {
            "symbol": symbol,
            "article_title": article["title"],
            "source_url": article["url"],
            "entity_name": symbol,
            "event_type": matched_rule["event_type"],
            "severity_score": matched_rule["severity_score"],
            "severity_label": matched_rule["severity_label"],
            "confidence": 0.58,
            "sentiment_score": 0.72 * sentiment,
            "direction": "up" if sentiment > 0 else "down",
            "time_horizon": "short_term",
            "macro_theme": matched_rule["macro_theme"],
            "region": infer_region(symbol),
            "affected_sectors": [infer_sector(symbol)],
            "summary": "Keyword fallback matched the article headline/snippet.",
            "source_score": float(article["source_score"]),
            "quality_score": float(article.get("quality_score", article["source_score"])),
            "extractor": "keyword_rules",
        }
        fact["base_event_score"] = round(base_event_score(fact), 6)
        facts.append(fact)

    return facts


def build_sector_alerts(
    event_facts: list[dict[str, Any]],
    propagation_facts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str], dict[str, Any]] = {}

    for fact in event_facts:
        score = float(fact.get("base_event_score", 0.0) or 0.0)
        if score == 0:
            continue
        sectors = fact.get("affected_sectors", [])
        if not isinstance(sectors, list) or not sectors:
            sectors = [infer_sector(str(fact.get("symbol", "")))]
        for sector in sectors:
            key = (sector, str(fact.get("macro_theme", "other")))
            bucket = buckets.setdefault(
                key,
                {"sector": sector, "macro_theme": key[1], "score": 0.0, "symbols": set(), "drivers": []},
            )
            bucket["score"] += score
            bucket["symbols"].add(str(fact.get("symbol", "")))
            bucket["drivers"].append(str(fact.get("event_type", "")))

    for fact in propagation_facts:
        score = float(fact.get("impact_score", 0.0) or 0.0)
        if score == 0:
            continue
        key = (str(fact.get("target_sector", "unknown")), str(fact.get("macro_theme", "other")))
        bucket = buckets.setdefault(
            key,
            {"sector": key[0], "macro_theme": key[1], "score": 0.0, "symbols": set(), "drivers": []},
        )
        bucket["score"] += score
        bucket["symbols"].add(str(fact.get("target_symbol", "")))
        bucket["drivers"].append(str(fact.get("event_type", "")))

    alerts: list[dict[str, Any]] = []
    for (_, _), bucket in buckets.items():
        symbols = sorted(bucket["symbols"])
        if len(symbols) < 2:
            continue
        score = round(float(bucket["score"]), 6)
        if score <= -0.60:
            alert_level = "HIGH"
        elif score <= -0.30:
            alert_level = "MEDIUM"
        elif score >= 0.60:
            alert_level = "HIGH_POSITIVE"
        elif score >= 0.30:
            alert_level = "MEDIUM_POSITIVE"
        else:
            continue

        alerts.append(
            {
                "sector": bucket["sector"],
                "macro_theme": bucket["macro_theme"],
                "score": score,
                "alert_level": alert_level,
                "affected_symbols": symbols,
                "driver_event_types": sorted(set(bucket["drivers"])),
                "explanation": (
                    f"{bucket['sector']} has {alert_level.lower()} event pressure from "
                    f"{bucket['macro_theme']} across {len(symbols)} symbols."
                ),
            }
        )

    alerts.sort(key=lambda item: abs(float(item["score"])), reverse=True)
    return alerts


def summarize_symbol(
    symbol: str,
    summary: dict[str, Any],
    event_facts: list[dict[str, Any]],
    propagation_facts: list[dict[str, Any]],
) -> dict[str, Any]:
    direct_score = sum(float(fact.get("base_event_score", 0.0) or 0.0) for fact in event_facts)
    propagated_score = sum(float(fact.get("impact_score", 0.0) or 0.0) for fact in propagation_facts)
    total_score = direct_score + propagated_score

    if total_score >= 0.55:
        signal = "long"
    elif total_score <= -0.55:
        signal = "short"
    else:
        signal = "neutral"

    risk_level = "LOW"
    if total_score <= -0.75:
        risk_level = "HIGH"
    elif total_score <= -0.40:
        risk_level = "MEDIUM"
    elif total_score >= 0.75:
        risk_level = "HIGH_POSITIVE"
    elif total_score >= 0.40:
        risk_level = "MEDIUM_POSITIVE"

    top_direct = sorted(event_facts, key=lambda item: abs(float(item.get("base_event_score", 0.0) or 0.0)), reverse=True)
    top_prop = sorted(propagation_facts, key=lambda item: abs(float(item.get("impact_score", 0.0) or 0.0)), reverse=True)
    rules_fired: list[str] = []
    if top_direct:
        strongest = top_direct[0]
        if strongest.get("severity_label") == "high" and float(strongest.get("base_event_score", 0.0)) < 0:
            rules_fired.append("direct_high_severity_event")
        if strongest.get("event_type") in {"supply_disruption", "regulatory_probe"}:
            rules_fired.append("systemic_event_type")
    if top_prop and abs(float(top_prop[0].get("impact_score", 0.0) or 0.0)) >= 0.12:
        rules_fired.append("downstream_contagion")

    explanation_parts = []
    if top_direct:
        explanation_parts.append(
            f"direct driver: {top_direct[0].get('event_type', 'none')}"
        )
    if top_prop:
        explanation_parts.append(
            f"propagation from {top_prop[0].get('source_symbol', 'unknown')}"
        )
    if not explanation_parts:
        explanation_parts.append("no material event facts survived filtering")

    return {
        "symbol": symbol,
        "name": summary.get("name", symbol),
        "sector": infer_sector(symbol),
        "region": infer_region(symbol),
        "signal": signal,
        "risk_level": risk_level,
        "direct_score": round(direct_score, 6),
        "propagated_score": round(propagated_score, 6),
        "total_score": round(total_score, 6),
        "price_change_pct": round(price_change_pct(summary), 4) if price_change_pct(summary) is not None else None,
        "event_count": len(event_facts),
        "propagation_count": len(propagation_facts),
        "rules_fired": rules_fired,
        "top_driver_titles": [fact.get("article_title", "") for fact in top_direct[:3]],
        "explanation": f"{symbol} is {signal}: " + "; ".join(explanation_parts),
    }


def format_signal_line(score: dict[str, Any]) -> str:
    move = score.get("price_change_pct")
    move_text = f"{move:+.2f}%" if isinstance(move, (int, float)) else "n/a"
    return (
        f"{score['symbol']:>5}  {score['signal']:<7}  total={score['total_score']:+.3f}  "
        f"direct={score['direct_score']:+.3f}  prop={score['propagated_score']:+.3f}  "
        f"move={move_text}  rules={','.join(score['rules_fired']) or 'none'}"
    )


def run_pipeline(
    watchlist_name: str,
    symbols: list[str],
    results_per_symbol: int,
    raw: bool,
    sync_clickhouse: bool = False,
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
    propagation_rows: list[dict[str, Any]] = []
    signal_rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    per_symbol_facts: dict[str, list[dict[str, Any]]] = {}
    price_summaries: dict[str, dict[str, Any]] = {}

    for symbol in symbols:
        try:
            yahoo_raw = fetch_yahoo_chart(symbol)
            price_summary = summarize_yahoo_chart(yahoo_raw)
        except Exception as exc:  # noqa: BLE001
            price_summary = {"symbol": symbol, "name": symbol, "instrument_type": "stock"}
            warnings.append(f"Yahoo Finance failed for {symbol}: {exc}")
        price_summaries[symbol] = price_summary

        tavily_query = build_tavily_query(symbol, price_summary)
        tavily_data = call_tavily(tavily_key, tavily_query)
        tavily_answer = str(tavily_data.get("answer", "")).strip()
        raw_articles = normalize_articles(symbol, tavily_data, tavily_query)
        selected_articles, rejected_articles = filter_articles(raw_articles, results_per_symbol)

        for article in selected_articles + rejected_articles:
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
                    "quality_score": article.get("quality_score", 0.0),
                    "kept": bool(article.get("kept", False)),
                    "filter_reason": article.get("filter_reason", ""),
                    "snippet": article["snippet"],
                    "raw_json": json_dumps(article["raw_result"]),
                }
            )

        facts: list[dict[str, Any]] = []
        if gemini_key and selected_articles:
            try:
                facts = extract_facts_with_gemini(symbol, price_summary, selected_articles, gemini_key)
            except subprocess.CalledProcessError as exc:
                details = f"{exc.stdout}\n{exc.stderr}".lower()
                if "quota" in details or "429" in details or "resource_exhausted" in details:
                    warnings.append(f"Gemini quota exhausted for {symbol}; falling back to keywords.")
                else:
                    warnings.append(f"Gemini extraction failed for {symbol}; falling back to keywords: {exc}")
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Gemini extraction failed for {symbol}; falling back to keywords: {exc}")

        if not facts:
            facts = extract_facts_with_keywords(symbol, selected_articles)

        per_symbol_facts[symbol] = facts

    all_event_facts = [fact for facts in per_symbol_facts.values() for fact in facts]
    propagation_facts = build_propagation_facts(all_event_facts, symbols)
    extractors_used = sorted({str(fact.get("extractor", "unknown")) for fact in all_event_facts})

    for fact in all_event_facts:
        event_rows.append(
            {
                "run_id": run_id,
                "watchlist": watchlist_name,
                "symbol": fact["symbol"],
                "article_title": fact["article_title"],
                "source_url": fact["source_url"],
                "entity_name": fact["entity_name"],
                "event_type": fact["event_type"],
                "severity_label": fact["severity_label"],
                "severity_score": fact["severity_score"],
                "confidence": fact["confidence"],
                "sentiment_score": fact["sentiment_score"],
                "direction": fact["direction"],
                "time_horizon": fact["time_horizon"],
                "macro_theme": fact["macro_theme"],
                "region": fact["region"],
                "affected_sectors": fact["affected_sectors"],
                "source_score": fact["source_score"],
                "quality_score": fact["quality_score"],
                "base_event_score": fact["base_event_score"],
                "summary": fact["summary"],
                "extractor": fact["extractor"],
            }
        )

    for fact in propagation_facts:
        propagation_rows.append(
            {
                "run_id": run_id,
                "watchlist": watchlist_name,
                **fact,
            }
        )

    for symbol in symbols:
        direct_facts = [fact for fact in all_event_facts if fact["symbol"] == symbol]
        downstream = [fact for fact in propagation_facts if fact["target_symbol"] == symbol]
        score = summarize_symbol(symbol, price_summaries.get(symbol, {"name": symbol}), direct_facts, downstream)
        score["run_id"] = run_id
        score["watchlist"] = watchlist_name
        signal_rows.append(score)

    signal_rows.sort(key=lambda item: float(item["total_score"]), reverse=True)
    sector_alerts = build_sector_alerts(all_event_facts, propagation_facts)
    sector_alert_rows = [{"run_id": run_id, "watchlist": watchlist_name, **alert} for alert in sector_alerts]

    summary = {
        "run_id": run_id,
        "watchlist": watchlist_name,
        "symbols": symbols,
        "extractor_mode": "+".join(extractors_used) if extractors_used else ("gemini_unavailable" if gemini_key else "keyword_rules"),
        "article_count": len(article_rows),
        "event_fact_count": len(event_rows),
        "propagation_fact_count": len(propagation_rows),
        "signal_count": len(signal_rows),
        "sector_alert_count": len(sector_alert_rows),
        "top_longs": [row["symbol"] for row in signal_rows if row["signal"] == "long"][:3],
        "top_shorts": [row["symbol"] for row in signal_rows if row["signal"] == "short"][:3],
        "warnings": warnings,
    }

    write_jsonl(run_dir / "articles_raw.jsonl", article_rows)
    write_jsonl(run_dir / "event_facts.jsonl", event_rows)
    write_jsonl(run_dir / "propagation_facts.jsonl", propagation_rows)
    write_jsonl(run_dir / "signal_outputs.jsonl", signal_rows)
    write_jsonl(run_dir / "sector_alerts.jsonl", sector_alert_rows)
    write_jsonl(run_dir / "events_extracted.jsonl", event_rows)
    write_jsonl(run_dir / "ticker_scores.jsonl", signal_rows)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    clickhouse_sync_message = ""
    if sync_clickhouse:
        try:
            from sync_clickhouse import main as sync_clickhouse_main

            sync_status = sync_clickhouse_main([str(run_dir)])
            if sync_status == 0:
                clickhouse_sync_message = "ClickHouse sync: success"
            else:
                clickhouse_sync_message = f"ClickHouse sync: failed with status {sync_status}"
        except Exception as exc:  # noqa: BLE001
            clickhouse_sync_message = f"ClickHouse sync: failed ({exc})"

    if raw:
        print(
            json.dumps(
                {
                    "summary": summary,
                    "signals": signal_rows,
                    "sector_alerts": sector_alert_rows,
                    "clickhouse_sync": clickhouse_sync_message,
                },
                indent=2,
            )
        )
        return 0

    print(f"Run ID: {run_id}")
    print(f"Watchlist: {watchlist_name} ({', '.join(symbols)})")
    if extractors_used:
        print(f"Extractor mode: {' + '.join(extractors_used)}")
    else:
        print(f"Extractor mode: {'Gemini unavailable or no material facts' if gemini_key else 'keyword_rules'}")
    print(f"Output dir: {run_dir}")
    print("\nSignals")
    print("-------")
    for row in signal_rows:
        print(format_signal_line(row))

    if sector_alert_rows:
        print("\nSector Alerts")
        print("-------------")
        for alert in sector_alert_rows[:5]:
            print(
                f"{alert['sector']:<24} {alert['alert_level']:<15} "
                f"score={alert['score']:+.3f} theme={alert['macro_theme']} "
                f"symbols={','.join(alert['affected_symbols'])}"
            )

    if clickhouse_sync_message:
        print(f"\n{clickhouse_sync_message}")

    if warnings:
        print("\nWarnings")
        print("--------")
        for warning in warnings:
            print(warning)
    return 0


def main(argv: list[str]) -> int:
    raw, sync_clickhouse, watchlist_name, results_per_symbol, symbol_args = parse_args(argv)
    selected_watchlist, symbols = resolve_symbols(symbol_args, watchlist_name)
    return run_pipeline(selected_watchlist, symbols, results_per_symbol, raw, sync_clickhouse=sync_clickhouse)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
