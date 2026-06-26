#!/usr/bin/env python3
"""Explicit multi-agent orchestration for the News2Signal demo."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any

from article_filters import filter_articles
from ask_gemini import call_gemini, extract_text, get_api_key
from clickhouse_support import clickhouse_quote, has_clickhouse_config, run_clickhouse_json
from market_data import fetch_yahoo_chart, summarize_yahoo_chart
from propagation_graph import build_propagation_facts
from prometheux_support import (
    evaluate_vadalog_program,
    get_vadalog_status,
    has_prometheux_config,
    is_no_active_compute_error,
)
from search_tavily import ENV_PATH, call_tavily, load_dotenv

from event_strategy import (
    RUNS_DIR,
    SYSTEMIC_EVENT_TYPES,
    aggregate_direct_signal,
    aggregate_propagation_signal,
    build_sector_alerts,
    build_tavily_query,
    clamp,
    dedupe_event_facts,
    extract_facts_with_gemini,
    extract_facts_with_keywords,
    extract_json_payload,
    fact_domain,
    format_signal_line,
    infer_region,
    infer_sector,
    is_material_fact,
    json_dumps,
    normalize_articles,
    price_change_pct,
    score_sign,
    session_price_change_pct,
    write_jsonl,
)


def average(values: list[float], default: float = 0.0) -> float:
    """Return the arithmetic mean or a default value."""
    if not values:
        return default
    return sum(values) / len(values)


def is_gemini_quota_error(exc: Exception) -> bool:
    """Return whether a Gemini failure looks like quota or transient exhaustion."""
    if isinstance(exc, subprocess.CalledProcessError):
        details = f"{exc.stdout}\n{exc.stderr}".lower()
    else:
        details = str(exc).lower()
    markers = ["quota", "429", "resource_exhausted", "rate limit", "overloaded"]
    return any(marker in details for marker in markers)


def response_json_text(data: dict[str, object]) -> dict[str, Any]:
    """Parse Gemini text output as a JSON object."""
    return extract_json_payload(extract_text(data))


def sql_in(values: list[str]) -> str:
    """Return a simple SQL IN clause fragment."""
    if not values:
        return "('')"
    return "(" + ",".join(clickhouse_quote(value) for value in values) + ")"


def material_facts(event_facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return material event facts only."""
    return [fact for fact in dedupe_event_facts(event_facts) if is_material_fact(fact)]


def aggregate_macro_theme_signal(event_facts: list[dict[str, Any]]) -> dict[str, Any]:
    """Create a separate macro-theme score sleeve for multi-agent aggregation."""
    candidates = material_facts(event_facts)
    if not candidates:
        return {
            "score": 0.0,
            "dominant_theme": "other",
            "theme_count": 0,
            "driver_facts": [],
        }

    buckets: dict[str, list[dict[str, Any]]] = {}
    for fact in candidates:
        theme = str(fact.get("macro_theme", "other")).strip() or "other"
        buckets.setdefault(theme, []).append(fact)

    theme_rows: list[dict[str, Any]] = []
    for theme, facts in buckets.items():
        ranked = sorted(
            facts,
            key=lambda item: abs(float(item.get("base_event_score", 0.0) or 0.0)),
            reverse=True,
        )
        score = sum(
            float(item.get("base_event_score", 0.0) or 0.0) * weight
            for item, weight in zip(ranked[:2], (1.0, 0.45), strict=False)
        )
        theme_rows.append(
            {
                "theme": theme,
                "score": score,
                "top_fact": ranked[0],
            }
        )

    theme_rows.sort(key=lambda item: abs(float(item["score"])), reverse=True)
    total = sum(
        float(item["score"]) * weight
        for item, weight in zip(theme_rows[:3], (1.0, 0.55, 0.3), strict=False)
    )
    total = clamp(total, -0.45, 0.45)
    return {
        "score": round(total, 6),
        "dominant_theme": str(theme_rows[0]["theme"]) if theme_rows else "other",
        "theme_count": len(theme_rows),
        "driver_facts": [item["top_fact"] for item in theme_rows[:2]],
    }


def build_reasoning_explanation(
    gemini_key: str,
    symbol: str,
    direct: dict[str, Any],
    propagated: dict[str, Any],
    macro: dict[str, Any],
    gate: dict[str, Any],
) -> dict[str, Any]:
    """Use Gemini for a structured reasoning explanation, not for the score itself."""
    prompt = "\n".join(
        [
            "Return JSON only.",
            "Summarize this deterministic event-driven signal reasoning stack.",
            f"Symbol: {symbol}",
            f"Direct score: {float(direct.get('score', 0.0)):+.4f}",
            f"Propagation score: {float(propagated.get('score', 0.0)):+.4f}",
            f"Macro score: {float(macro.get('score', 0.0)):+.4f}",
            f"Dominant event: {direct.get('dominant_event_type', 'none')}",
            f"Dominant theme: {macro.get('dominant_theme', 'other')}",
            f"Rules fired: {', '.join(gate.get('rules_fired', [])) or 'none'}",
            "",
            "Schema:",
            "{",
            '  "dominant_thesis": "string",',
            '  "signal_horizon": "intraday|short_term|medium_term",',
            '  "short_explanation": "one sentence"',
            "}",
        ]
    )
    response = call_gemini(
        gemini_key,
        prompt,
        temperature=0.0,
        response_mime_type="application/json",
    )
    payload = response_json_text(response)
    return {
        "dominant_thesis": str(payload.get("dominant_thesis", "")).strip(),
        "signal_horizon": str(payload.get("signal_horizon", "short_term")).strip() or "short_term",
        "short_explanation": str(payload.get("short_explanation", "")).strip(),
        "model_used": str(response.get("_model_used", "")),
    }


def local_rule_gate(
    direct: dict[str, Any],
    propagated: dict[str, Any],
    macro: dict[str, Any],
    event_facts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Deterministic fallback and default gating logic."""
    material = material_facts(event_facts)
    rules_fired: list[str] = []
    cap_abs_score = 1.10
    score_multiplier = 1.0
    force_neutral = False
    neutral_reasons: list[str] = []

    if not material:
        force_neutral = True
        neutral_reasons.append("no_material_event")
        rules_fired.append("no_material_event")

    if bool(direct.get("low_signal_only")):
        cap_abs_score = min(cap_abs_score, 0.35)
        rules_fired.append("low_signal_cap")

    if str(direct.get("price_confirmation")) == "diverged" and int(direct.get("source_diversity", 0)) <= 1:
        score_multiplier *= 0.84
        cap_abs_score = min(cap_abs_score, 0.42)
        rules_fired.append("single_source_price_divergence")

    if int(direct.get("material_count", 0)) > 1 and float(direct.get("consensus", 0.0)) < 0.34:
        cap_abs_score = min(cap_abs_score, 0.40)
        rules_fired.append("conflicting_evidence_cap")

    if str(direct.get("dominant_event_type", "none")) in SYSTEMIC_EVENT_TYPES and int(propagated.get("count", 0)) > 0:
        score_multiplier *= 1.06
        rules_fired.append("systemic_contagion_boost")

    if str(macro.get("dominant_theme", "other")) == "geopolitical_risk":
        score_multiplier *= 1.03
        rules_fired.append("macro_geopolitical_risk")

    return {
        "force_neutral": force_neutral,
        "neutral_reasons": neutral_reasons,
        "cap_abs_score": round(cap_abs_score, 6),
        "score_multiplier": round(score_multiplier, 6),
        "rules_fired": rules_fired,
    }


def vadalog_quote(value: Any) -> str:
    """Escape a scalar for inline Vadalog fact emission."""
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def build_prometheux_program(
    event_facts: list[dict[str, Any]],
    propagation_facts: list[dict[str, Any]],
) -> str:
    """Build a compact Vadalog program for deterministic market-event flags."""
    lines = [
        '% Auto-generated by News2Signal reasoning agent.',
        'material_negative_event("supply_disruption").',
        'material_negative_event("regulatory_probe").',
        'material_negative_event("guidance_cut").',
        'material_negative_event("earnings_miss").',
        'systemic_event("supply_disruption").',
        'systemic_event("regulatory_probe").',
        'systemic_event("macro_theme").',
        'low_signal_event("analyst_upgrade").',
        'low_signal_event("analyst_downgrade").',
        'low_signal_event("product_launch").',
        '',
    ]

    for fact in event_facts:
        lines.append(
            "event_fact("
            + ",".join(
                [
                    vadalog_quote(fact.get("symbol", "")),
                    vadalog_quote(fact.get("event_type", "other")),
                    vadalog_quote(fact.get("severity_label", "low")),
                    f"{float(fact.get('confidence', 0.0) or 0.0):.6f}",
                    f"{float(fact.get('sentiment_score', 0.0) or 0.0):.6f}",
                ]
            )
            + ")."
        )
    for fact in propagation_facts:
        lines.append(
            "propagation_fact("
            + ",".join(
                [
                    vadalog_quote(fact.get("source_symbol", "")),
                    vadalog_quote(fact.get("target_symbol", "")),
                    vadalog_quote(fact.get("event_type", "other")),
                    f"{float(fact.get('impact_score', 0.0) or 0.0):.6f}",
                ]
            )
            + ")."
        )

    lines.extend(
        [
            "",
            'direct_negative(Symbol) :-',
            '  event_fact(Symbol, EventType, "high", Confidence, Sentiment),',
            "  Confidence > 0.70,",
            "  Sentiment < -0.60,",
            "  material_negative_event(EventType).",
            "",
            'contagion_negative(Symbol) :-',
            "  propagation_fact(_, Symbol, EventType, Impact),",
            "  Impact < -0.15,",
            "  systemic_event(EventType).",
            "",
            'low_signal(Symbol) :-',
            '  event_fact(Symbol, EventType, "low", Confidence, _),',
            "  Confidence < 0.60,",
            "  low_signal_event(EventType).",
            "",
            '@output("direct_negative").',
            '@output("contagion_negative").',
            '@output("low_signal").',
        ]
    )
    return "\n".join(lines)


def parse_prometheux_flags(response: dict[str, Any]) -> dict[str, set[str]]:
    """Extract symbol flags from a successful platform Vadalog response."""
    data = response.get("data", response)
    if not isinstance(data, dict):
        return {}
    result_set = data.get("resultSet", {})
    if not isinstance(result_set, dict):
        return {}

    flags: dict[str, set[str]] = {}
    for output_name, rows in result_set.items():
        if not isinstance(output_name, str) or not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, list) or not row:
                continue
            symbol = str(row[0]).strip()
            if not symbol:
                continue
            flags.setdefault(symbol, set()).add(output_name)
    return flags


class RetrievalAgent:
    """Gemini-guided query planner and Tavily retriever."""

    name = "retrieval_agent"

    def __init__(self, tavily_key: str, gemini_key: str) -> None:
        self.tavily_key = tavily_key
        self.gemini_key = gemini_key

    def build_plan(self, symbol: str, summary: dict[str, Any]) -> dict[str, Any]:
        default_query = build_tavily_query(symbol, summary)
        if not self.gemini_key:
            return {
                "backend": "default",
                "refined_query": default_query,
                "search_focuses": [],
                "notes": "Gemini unavailable; used default query.",
            }

        prompt = "\n".join(
            [
                "Return JSON only.",
                "You are the retrieval agent for an event-driven trading workflow.",
                f"Ticker: {symbol}",
                f"Instrument name: {summary.get('name', symbol)}",
                f"Default query: {default_query}",
                "",
                "Create a tighter search plan focused on discrete market-moving events.",
                "Schema:",
                "{",
                '  "refined_query": "string",',
                '  "search_focuses": ["earnings|guidance|regulation|supply_chain|litigation|mna|analyst|product|macro"],',
                '  "notes": "string"',
                "}",
            ]
        )
        try:
            response = call_gemini(
                self.gemini_key,
                prompt,
                temperature=0.0,
                response_mime_type="application/json",
            )
            payload = response_json_text(response)
            refined_query = str(payload.get("refined_query", "")).strip() or default_query
            return {
                "backend": f"gemini:{response.get('_model_used', '')}",
                "refined_query": refined_query,
                "search_focuses": payload.get("search_focuses", []) if isinstance(payload.get("search_focuses"), list) else [],
                "notes": str(payload.get("notes", "")).strip(),
            }
        except Exception:  # noqa: BLE001
            return {
                "backend": "default_fallback",
                "refined_query": default_query,
                "search_focuses": [],
                "notes": "Gemini retrieval planning failed; used default query.",
            }

    def run(
        self,
        run_id: str,
        watchlist_name: str,
        symbol: str,
        summary: dict[str, Any],
        results_per_symbol: int,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
        plan = self.build_plan(symbol, summary)
        query = str(plan["refined_query"])
        tavily_data = call_tavily(self.tavily_key, query)
        tavily_answer = str(tavily_data.get("answer", "")).strip()
        raw_articles = normalize_articles(symbol, tavily_data, query)
        selected_articles, rejected_articles = filter_articles(raw_articles, results_per_symbol)

        article_rows: list[dict[str, Any]] = []
        for article in selected_articles + rejected_articles:
            article_rows.append(
                {
                    "run_id": run_id,
                    "watchlist": watchlist_name,
                    "symbol": symbol,
                    "tavily_query": query,
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

        trace = {
            "run_id": run_id,
            "watchlist": watchlist_name,
            "symbol": symbol,
            "agent_name": self.name,
            "stage_index": 1,
            "status": "success",
            "backend": str(plan.get("backend", "default")),
            "payload_json": json_dumps(
                {
                    "refined_query": query,
                    "search_focuses": plan.get("search_focuses", []),
                    "selected_count": len(selected_articles),
                    "rejected_count": len(rejected_articles),
                    "notes": plan.get("notes", ""),
                }
            ),
            "notes": str(plan.get("notes", "")),
        }
        return selected_articles, rejected_articles, article_rows, trace


class ExtractionAgent:
    """Gemini extractor with ClickHouse fact-cache support."""

    name = "extraction_agent"

    def __init__(self, gemini_key: str) -> None:
        self.gemini_key = gemini_key

    def fetch_cached_facts(self, symbol: str, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not has_clickhouse_config() or not articles:
            return []

        urls = [str(article.get("url", "")).strip() for article in articles if str(article.get("url", "")).strip()]
        if not urls:
            return []

        query = f"""
        SELECT
          symbol,
          article_title,
          source_url,
          entity_name,
          event_type,
          severity_label,
          severity_score,
          confidence,
          sentiment_score,
          direction,
          time_horizon,
          macro_theme,
          region,
          affected_sectors,
          source_score,
          quality_score,
          base_event_score,
          summary,
          extractor
        FROM event_facts
        WHERE symbol = {clickhouse_quote(symbol)}
          AND source_url IN {sql_in(urls)}
        ORDER BY ingested_at DESC
        LIMIT 100
        """
        data = run_clickhouse_json(query)
        rows = data.get("data", [])
        if not isinstance(rows, list):
            return []

        article_map = {str(article.get("url", "")).strip(): article for article in articles}
        cached_by_url: dict[str, dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            url = str(row.get("source_url", "")).strip()
            if not url or url in cached_by_url:
                continue
            article = article_map.get(url, {})
            cached_by_url[url] = {
                "symbol": symbol,
                "article_title": str(row.get("article_title", article.get("title", ""))).strip(),
                "source_url": url,
                "entity_name": str(row.get("entity_name", symbol)).strip(),
                "event_type": str(row.get("event_type", "other")).strip() or "other",
                "severity_score": clamp(float(row.get("severity_score", 0.0) or 0.0), 0.0, 1.0),
                "severity_label": str(row.get("severity_label", "low")).strip() or "low",
                "confidence": clamp(float(row.get("confidence", 0.0) or 0.0), 0.0, 1.0),
                "sentiment_score": clamp(float(row.get("sentiment_score", 0.0) or 0.0), -1.0, 1.0),
                "direction": str(row.get("direction", "neutral")).strip() or "neutral",
                "time_horizon": str(row.get("time_horizon", "short_term")).strip() or "short_term",
                "macro_theme": str(row.get("macro_theme", "other")).strip() or "other",
                "region": str(row.get("region", infer_region(symbol))).strip() or infer_region(symbol),
                "affected_sectors": row.get("affected_sectors", []) if isinstance(row.get("affected_sectors"), list) else [],
                "summary": str(row.get("summary", "")).strip(),
                "source_score": float(row.get("source_score", article.get("source_score", 0.65)) or 0.65),
                "quality_score": float(row.get("quality_score", article.get("quality_score", 0.6)) or 0.6),
                "extractor": f"clickhouse_cache:{row.get('extractor', 'unknown')}",
                "base_event_score": round(float(row.get("base_event_score", 0.0) or 0.0), 6),
            }
        return list(cached_by_url.values())

    def run(
        self,
        run_id: str,
        watchlist_name: str,
        symbol: str,
        summary: dict[str, Any],
        selected_articles: list[dict[str, Any]],
        warnings: list[str],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        cached_facts: list[dict[str, Any]] = []
        if selected_articles:
            try:
                cached_facts = self.fetch_cached_facts(symbol, selected_articles)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"ClickHouse cache lookup failed for {symbol}: {exc}")

        cached_urls = {str(fact.get("source_url", "")).strip() for fact in cached_facts}
        uncached_articles = [
            article
            for article in selected_articles
            if str(article.get("url", "")).strip() not in cached_urls
        ]

        facts = list(cached_facts)
        extraction_backend = "clickhouse_cache_only" if cached_facts and not uncached_articles else "fallback_keywords"

        if uncached_articles and self.gemini_key:
            try:
                gemini_facts = extract_facts_with_gemini(symbol, summary, uncached_articles, self.gemini_key)
                if gemini_facts:
                    facts.extend(gemini_facts)
                    extraction_backend = "gemini_json"
            except subprocess.CalledProcessError as exc:
                details = f"{exc.stdout}\n{exc.stderr}".lower()
                if "quota" in details or "429" in details or "resource_exhausted" in details:
                    warnings.append(f"Gemini quota exhausted for {symbol}; falling back to keywords.")
                else:
                    warnings.append(f"Gemini extraction failed for {symbol}; falling back to keywords: {exc}")
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Gemini extraction failed for {symbol}; falling back to keywords: {exc}")

        missing_urls = {
            str(article.get("url", "")).strip()
            for article in uncached_articles
            if str(article.get("url", "")).strip()
        } - {str(fact.get("source_url", "")).strip() for fact in facts}
        if missing_urls:
            fallback_articles = [
                article for article in uncached_articles if str(article.get("url", "")).strip() in missing_urls
            ]
            facts.extend(extract_facts_with_keywords(symbol, fallback_articles))
            if extraction_backend == "fallback_keywords":
                extraction_backend = "keyword_rules"
            else:
                extraction_backend = f"{extraction_backend}+keyword_rules"

        trace = {
            "run_id": run_id,
            "watchlist": watchlist_name,
            "symbol": symbol,
            "agent_name": self.name,
            "stage_index": 2,
            "status": "success",
            "backend": extraction_backend,
            "payload_json": json_dumps(
                {
                    "selected_articles": len(selected_articles),
                    "cache_hit_count": len(cached_facts),
                    "uncached_articles": len(uncached_articles),
                    "fact_count": len(facts),
                }
            ),
            "notes": f"cache_hits={len(cached_facts)}",
        }
        return facts, trace


class ReasoningAgent:
    """Deterministic scorer with Prometheux-first rule execution."""

    name = "reasoning_agent"

    def __init__(self, gemini_key: str) -> None:
        self.gemini_key = gemini_key

    def try_prometheux(
        self,
        event_facts: list[dict[str, Any]],
        propagation_facts: list[dict[str, Any]],
        warnings: list[str],
    ) -> tuple[str, dict[str, set[str]], str]:
        if not has_prometheux_config():
            return "disabled", {}, "Prometheux credentials unavailable."

        try:
            status = get_vadalog_status()
            engine_state = str(status.get("data", {}).get("status", "unknown"))
            if engine_state != "ready":
                return "status_only", {}, f"Vadalog engine status is {engine_state}."
        except subprocess.CalledProcessError as exc:
            warnings.append(f"Prometheux status check failed: {exc}")
            return "status_failed", {}, "Prometheux status check failed."
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Prometheux status check failed: {exc}")
            return "status_failed", {}, "Prometheux status check failed."

        program = build_prometheux_program(event_facts, propagation_facts)
        try:
            response = evaluate_vadalog_program(program)
            return "prometheux_vadalog", parse_prometheux_flags(response), "Prometheux Vadalog evaluation succeeded."
        except subprocess.CalledProcessError as exc:
            if is_no_active_compute_error(exc):
                return "prometheux_no_compute", {}, "Prometheux compute is not active; local rules used."
            warnings.append(f"Prometheux evaluation failed; local rules used: {exc}")
            return "prometheux_error", {}, "Prometheux evaluation failed; local rules used."
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Prometheux evaluation failed; local rules used: {exc}")
            return "prometheux_error", {}, "Prometheux evaluation failed; local rules used."

    def run(
        self,
        run_id: str,
        watchlist_name: str,
        symbols: list[str],
        price_summaries: dict[str, dict[str, Any]],
        per_symbol_facts: dict[str, list[dict[str, Any]]],
        warnings: list[str],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
        all_event_facts = [fact for facts in per_symbol_facts.values() for fact in facts]
        material_event_facts = [fact for fact in all_event_facts if is_material_fact(fact)]
        propagation_facts = build_propagation_facts(material_event_facts, symbols)
        reasoning_backend, prom_flags, backend_note = self.try_prometheux(all_event_facts, propagation_facts, warnings)

        reasoning_views: dict[str, dict[str, Any]] = {}
        traces: list[dict[str, Any]] = []

        for symbol in symbols:
            direct_facts = [fact for fact in all_event_facts if fact["symbol"] == symbol]
            downstream = [fact for fact in propagation_facts if fact["target_symbol"] == symbol]
            session_move = session_price_change_pct(price_summaries.get(symbol, {}))
            direct = aggregate_direct_signal(direct_facts, session_move)
            propagated = aggregate_propagation_signal(downstream, score_sign(float(direct.get("score", 0.0))))
            macro = aggregate_macro_theme_signal(direct_facts)
            gate = local_rule_gate(direct, propagated, macro, direct_facts)

            symbol_flags = sorted(prom_flags.get(symbol, set()))
            if "direct_negative" in prom_flags.get(symbol, set()):
                gate["rules_fired"].append("prometheux_direct_negative")
            if "contagion_negative" in prom_flags.get(symbol, set()):
                gate["rules_fired"].append("prometheux_contagion_negative")
            if "low_signal" in prom_flags.get(symbol, set()):
                gate["rules_fired"].append("prometheux_low_signal")
                gate["cap_abs_score"] = min(float(gate["cap_abs_score"]), 0.35)

            explanation = {
                "dominant_thesis": "",
                "signal_horizon": "short_term",
                "short_explanation": "",
                "model_used": "",
            }
            if self.gemini_key:
                try:
                    explanation = build_reasoning_explanation(self.gemini_key, symbol, direct, propagated, macro, gate)
                except Exception as exc:  # noqa: BLE001
                    if is_gemini_quota_error(exc):
                        warnings.append(f"Gemini reasoning explanation skipped for {symbol}: quota exhausted.")
                    else:
                        warnings.append(f"Gemini reasoning explanation failed for {symbol}.")

            reasoning_views[symbol] = {
                "direct": direct,
                "propagated": propagated,
                "macro": macro,
                "gate": gate,
                "reasoning_backend": reasoning_backend,
                "prometheux_flags": symbol_flags,
                "reasoning_explanation": explanation,
                "backend_note": backend_note,
            }

            traces.append(
                {
                    "run_id": run_id,
                    "watchlist": watchlist_name,
                    "symbol": symbol,
                    "agent_name": self.name,
                    "stage_index": 3,
                    "status": "success",
                    "backend": reasoning_backend,
                    "payload_json": json_dumps(
                        {
                            "direct_score": direct.get("score", 0.0),
                            "propagation_score": propagated.get("score", 0.0),
                            "macro_score": macro.get("score", 0.0),
                            "rules_fired": gate.get("rules_fired", []),
                            "prometheux_flags": symbol_flags,
                        }
                    ),
                    "notes": backend_note,
                }
            )

        return all_event_facts, propagation_facts, reasoning_views, traces


class EvaluationAgent:
    """ClickHouse-backed memory and replay evaluator."""

    name = "evaluation_agent"

    def __init__(self, gemini_key: str) -> None:
        self.gemini_key = gemini_key

    def lookup_history(
        self,
        symbol: str,
        event_types: list[str],
        current_direction_score: float,
    ) -> dict[str, Any]:
        if not has_clickhouse_config() or not event_types:
            return {
                "similar_event_count": 0,
                "avg_past_total_score": None,
                "historical_support": 0.5,
                "confidence_adjustment": 0.0,
                "supporting_event_types": event_types,
                "backend": "unavailable",
            }

        query = f"""
        SELECT
          ef.event_type AS event_type,
          count() AS similar_event_count,
          avg(so.total_score) AS avg_total_score
        FROM event_facts AS ef
        INNER JOIN signal_outputs AS so
          ON ef.run_id = so.run_id
         AND ef.symbol = so.symbol
        WHERE ef.symbol = {clickhouse_quote(symbol)}
          AND ef.event_type IN {sql_in(event_types)}
        GROUP BY ef.event_type
        ORDER BY similar_event_count DESC
        """
        data = run_clickhouse_json(query)
        rows = data.get("data", [])
        if not isinstance(rows, list) or not rows:
            return {
                "similar_event_count": 0,
                "avg_past_total_score": None,
                "historical_support": 0.5,
                "confidence_adjustment": 0.0,
                "supporting_event_types": event_types,
                "backend": "clickhouse_no_match",
            }

        total_count = 0
        weighted_score = 0.0
        seen_types: list[str] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            event_type = str(row.get("event_type", "")).strip()
            count = int(row.get("similar_event_count", 0) or 0)
            avg_score = float(row.get("avg_total_score", 0.0) or 0.0)
            total_count += count
            weighted_score += avg_score * count
            if event_type:
                seen_types.append(event_type)

        avg_past_total_score = (weighted_score / total_count) if total_count else None
        current_sign = score_sign(current_direction_score)
        if current_sign == 0 or avg_past_total_score is None:
            historical_support = 0.5
        else:
            aligned_score = current_sign * avg_past_total_score
            historical_support = clamp(0.5 + 0.5 * clamp(aligned_score / 0.80, -1.0, 1.0), 0.0, 1.0)
        confidence_adjustment = 0.10 * min(1.0, total_count / 5.0) * (historical_support - 0.5)

        return {
            "similar_event_count": total_count,
            "avg_past_total_score": round(avg_past_total_score, 6) if avg_past_total_score is not None else None,
            "historical_support": round(historical_support, 6),
            "confidence_adjustment": round(confidence_adjustment, 6),
            "supporting_event_types": sorted(set(seen_types)) or event_types,
            "backend": "clickhouse_history",
        }

    def summarize_with_gemini(
        self,
        symbol: str,
        event_types: list[str],
        history: dict[str, Any],
    ) -> str:
        if not self.gemini_key:
            return ""

        prompt = "\n".join(
            [
                "Return JSON only.",
                "You are the evaluation agent for an event-driven signal workflow.",
                f"Symbol: {symbol}",
                f"Current event types: {', '.join(event_types) or 'none'}",
                f"Similar historical events: {history.get('similar_event_count', 0)}",
                f"Average past total score: {history.get('avg_past_total_score')}",
                f"Historical support: {history.get('historical_support', 0.5)}",
                "",
                "Schema:",
                "{",
                '  "summary": "one short sentence about whether history supports the current view"',
                "}",
            ]
        )
        response = call_gemini(
            self.gemini_key,
            prompt,
            temperature=0.0,
            response_mime_type="application/json",
        )
        payload = response_json_text(response)
        return str(payload.get("summary", "")).strip()

    def run(
        self,
        run_id: str,
        watchlist_name: str,
        symbol: str,
        event_facts: list[dict[str, Any]],
        current_direction_score: float,
        cache_hit_count: int,
        warnings: list[str],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        event_types = sorted({str(fact.get("event_type", "other")).strip() or "other" for fact in material_facts(event_facts)})
        history = self.lookup_history(symbol, event_types, current_direction_score)
        history["cache_hit_count"] = cache_hit_count
        summary_text = ""
        try:
            summary_text = self.summarize_with_gemini(symbol, event_types, history)
        except Exception as exc:  # noqa: BLE001
            if is_gemini_quota_error(exc):
                warnings.append(f"Gemini evaluation summary skipped for {symbol}: quota exhausted.")
            else:
                warnings.append(f"Gemini evaluation summary failed for {symbol}.")

        if not summary_text:
            if int(history.get("similar_event_count", 0)) > 0:
                summary_text = (
                    f"History found {history['similar_event_count']} similar events; support="
                    f"{float(history.get('historical_support', 0.5)):.2f}."
                )
            else:
                summary_text = "No similar event history was found in ClickHouse."

        snapshot = {
            "run_id": run_id,
            "watchlist": watchlist_name,
            "symbol": symbol,
            "similar_event_count": int(history.get("similar_event_count", 0)),
            "cache_hit_count": int(cache_hit_count),
            "avg_past_total_score": history.get("avg_past_total_score"),
            "historical_support": float(history.get("historical_support", 0.5)),
            "confidence_adjustment": float(history.get("confidence_adjustment", 0.0)),
            "supporting_event_types": history.get("supporting_event_types", event_types),
            "summary": summary_text,
            "backend": str(history.get("backend", "unavailable")),
        }
        trace = {
            "run_id": run_id,
            "watchlist": watchlist_name,
            "symbol": symbol,
            "agent_name": self.name,
            "stage_index": 4,
            "status": "success",
            "backend": snapshot["backend"],
            "payload_json": json_dumps(
                {
                    "similar_event_count": snapshot["similar_event_count"],
                    "cache_hit_count": snapshot["cache_hit_count"],
                    "historical_support": snapshot["historical_support"],
                    "confidence_adjustment": snapshot["confidence_adjustment"],
                }
            ),
            "notes": summary_text,
        }
        return snapshot, trace


def classify_signal(total_score: float, confidence: float) -> str:
    """Map a weighted score and confidence to a trading stance."""
    if confidence < 0.38 or abs(total_score) < 0.25:
        return "neutral"
    if total_score >= 0.32:
        return "long"
    if total_score <= -0.32:
        return "short"
    return "neutral"


def risk_level(signal: str, total_score: float, confidence: float) -> str:
    """Return a user-facing risk level for the current signal."""
    if signal == "neutral":
        return "LOW"
    if signal == "long":
        if abs(total_score) >= 0.72 and confidence >= 0.62:
            return "HIGH_POSITIVE"
        if abs(total_score) >= 0.45:
            return "MEDIUM_POSITIVE"
        return "LOW_POSITIVE"
    if abs(total_score) >= 0.72 and confidence >= 0.62:
        return "HIGH"
    if abs(total_score) >= 0.45:
        return "MEDIUM"
    return "LOW"


def build_signal_row(
    symbol: str,
    summary: dict[str, Any],
    direct_facts: list[dict[str, Any]],
    downstream_facts: list[dict[str, Any]],
    reasoning_view: dict[str, Any],
    evaluation_snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Combine multi-agent outputs into one deterministic signal row."""
    direct = reasoning_view["direct"]
    propagated = reasoning_view["propagated"]
    macro = reasoning_view["macro"]
    gate = reasoning_view["gate"]
    explanation = reasoning_view["reasoning_explanation"]

    direction_score = clamp(
        0.55 * float(direct.get("score", 0.0))
        + 0.30 * float(propagated.get("score", 0.0))
        + 0.15 * float(macro.get("score", 0.0)),
        -1.10,
        1.10,
    )

    direction_score *= float(gate.get("score_multiplier", 1.0))
    direction_score = clamp(
        direction_score,
        -float(gate.get("cap_abs_score", 1.10)),
        float(gate.get("cap_abs_score", 1.10)),
    )

    if gate.get("force_neutral"):
        direction_score = 0.0

    material_direct = material_facts(direct_facts)
    fact_quality = average([float(fact.get("quality_score", 0.0) or 0.0) for fact in material_direct], default=0.28)
    source_diversity = len({fact_domain(fact) for fact in material_direct if fact_domain(fact)})
    source_diversity_norm = clamp(source_diversity / 3.0, 0.0, 1.0)
    price_confirmation = str(direct.get("price_confirmation", "none"))
    price_conf_score = {
        "confirmed": 1.0,
        "none": 0.55,
        "diverged": 0.25,
    }.get(price_confirmation, 0.55)
    historical_support = float(evaluation_snapshot.get("historical_support", 0.5))
    confidence_adjustment = float(evaluation_snapshot.get("confidence_adjustment", 0.0))

    agent_confidence = clamp(
        0.35 * fact_quality
        + 0.30 * historical_support
        + 0.20 * source_diversity_norm
        + 0.15 * price_conf_score
        + confidence_adjustment,
        0.0,
        1.0,
    )

    signal = classify_signal(direction_score, agent_confidence)
    row = {
        "symbol": symbol,
        "name": summary.get("name", symbol),
        "sector": infer_sector(symbol),
        "region": infer_region(symbol),
        "signal": signal,
        "risk_level": risk_level(signal, direction_score, agent_confidence),
        "direct_score": round(float(direct.get("score", 0.0)), 6),
        "propagated_score": round(float(propagated.get("score", 0.0)), 6),
        "macro_score": round(float(macro.get("score", 0.0)), 6),
        "direction_score": round(direction_score, 6),
        "total_score": round(direction_score, 6),
        "signal_strength": round(abs(direction_score) * (0.65 + 0.35 * agent_confidence), 6),
        "conviction": round(agent_confidence, 6),
        "agent_confidence": round(agent_confidence, 6),
        "historical_support": round(historical_support, 6),
        "price_change_pct": round(price_change_pct(summary), 4) if price_change_pct(summary) is not None else None,
        "session_move_pct": round(session_price_change_pct(summary), 4) if session_price_change_pct(summary) is not None else None,
        "price_confirmation": price_confirmation,
        "event_count": int(direct.get("material_count", 0)),
        "propagation_count": int(propagated.get("count", 0)),
        "source_diversity": source_diversity,
        "dominant_event_type": str(direct.get("dominant_event_type", "none")),
        "dominant_theme": str(macro.get("dominant_theme", "other")),
        "rules_fired": sorted(set(gate.get("rules_fired", []))),
        "top_driver_titles": [str(fact.get("article_title", "")) for fact in list(direct.get("driver_facts", []))[:3]],
        "reasoning_backend": str(reasoning_view.get("reasoning_backend", "local")),
        "evaluation_backend": str(evaluation_snapshot.get("backend", "unavailable")),
        "cache_hit_count": int(evaluation_snapshot.get("cache_hit_count", 0)),
        "similar_event_count": int(evaluation_snapshot.get("similar_event_count", 0)),
        "explanation": explanation.get("short_explanation", "") or evaluation_snapshot.get("summary", ""),
        "evaluation_summary": evaluation_snapshot.get("summary", ""),
        "signal_horizon": explanation.get("signal_horizon", "short_term"),
    }

    if not row["explanation"]:
        row["explanation"] = (
            f"{symbol} is {signal}: direct={row['direct_score']:+.3f}, "
            f"propagation={row['propagated_score']:+.3f}, macro={row['macro_score']:+.3f}."
        )
    return row


def maybe_sync_clickhouse(run_dir: Path) -> str:
    """Sync the current run directory to ClickHouse when requested."""
    try:
        from sync_clickhouse import main as sync_clickhouse_main

        sync_status = sync_clickhouse_main([str(run_dir)])
        if sync_status == 0:
            return "ClickHouse sync: success"
        return f"ClickHouse sync: failed with status {sync_status}"
    except Exception as exc:  # noqa: BLE001
        return f"ClickHouse sync: failed ({exc})"


def run_multi_agent_pipeline(
    watchlist_name: str,
    symbols: list[str],
    results_per_symbol: int,
    raw: bool,
    sync_clickhouse: bool = False,
) -> int:
    """Run the explicit 4-agent workflow end-to-end."""
    load_dotenv(ENV_PATH)
    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not tavily_key:
        print("Missing TAVILY_API_KEY in .env or shell.", file=os.sys.stderr)
        return 1

    gemini_key = get_api_key()
    run_id = Path(os.urandom(8).hex()).name
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    article_rows: list[dict[str, Any]] = []
    event_rows: list[dict[str, Any]] = []
    propagation_rows: list[dict[str, Any]] = []
    signal_rows: list[dict[str, Any]] = []
    sector_alert_rows: list[dict[str, Any]] = []
    evaluation_rows: list[dict[str, Any]] = []
    agent_rows: list[dict[str, Any]] = []

    retrieval_agent = RetrievalAgent(tavily_key, gemini_key)
    extraction_agent = ExtractionAgent(gemini_key)
    reasoning_agent = ReasoningAgent(gemini_key)
    evaluation_agent = EvaluationAgent(gemini_key)

    per_symbol_facts: dict[str, list[dict[str, Any]]] = {}
    retrieval_meta: dict[str, dict[str, Any]] = {}
    extraction_meta: dict[str, dict[str, Any]] = {}
    price_summaries: dict[str, dict[str, Any]] = {}

    for symbol in symbols:
        try:
            yahoo_raw = fetch_yahoo_chart(symbol)
            price_summary = summarize_yahoo_chart(yahoo_raw)
        except Exception as exc:  # noqa: BLE001
            price_summary = {"symbol": symbol, "name": symbol, "instrument_type": "stock"}
            warnings.append(f"Yahoo Finance failed for {symbol}: {exc}")
        price_summaries[symbol] = price_summary

        selected_articles, rejected_articles, new_article_rows, retrieval_trace = retrieval_agent.run(
            run_id,
            watchlist_name,
            symbol,
            price_summary,
            results_per_symbol,
        )
        article_rows.extend(new_article_rows)
        agent_rows.append(retrieval_trace)
        retrieval_meta[symbol] = {
            "selected_count": len(selected_articles),
            "rejected_count": len(rejected_articles),
            "backend": retrieval_trace["backend"],
        }

        facts, extraction_trace = extraction_agent.run(
            run_id,
            watchlist_name,
            symbol,
            price_summary,
            selected_articles,
            warnings,
        )
        per_symbol_facts[symbol] = facts
        agent_rows.append(extraction_trace)
        extraction_meta[symbol] = {
            "fact_count": len(facts),
            "backend": extraction_trace["backend"],
            "cache_hits": int(extraction_trace["notes"].split("=")[-1]) if extraction_trace["notes"].startswith("cache_hits=") else 0,
        }

    all_event_facts, propagation_facts, reasoning_views, reasoning_traces = reasoning_agent.run(
        run_id,
        watchlist_name,
        symbols,
        price_summaries,
        per_symbol_facts,
        warnings,
    )
    agent_rows.extend(reasoning_traces)

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
        current_direction_score = (
            0.55 * float(reasoning_views[symbol]["direct"].get("score", 0.0))
            + 0.30 * float(reasoning_views[symbol]["propagated"].get("score", 0.0))
            + 0.15 * float(reasoning_views[symbol]["macro"].get("score", 0.0))
        )
        evaluation_snapshot, evaluation_trace = evaluation_agent.run(
            run_id,
            watchlist_name,
            symbol,
            direct_facts,
            current_direction_score,
            extraction_meta.get(symbol, {}).get("cache_hits", 0),
            warnings,
        )
        evaluation_rows.append(evaluation_snapshot)
        agent_rows.append(evaluation_trace)

        signal_row = build_signal_row(
            symbol,
            price_summaries.get(symbol, {"name": symbol}),
            direct_facts,
            downstream,
            reasoning_views[symbol],
            evaluation_snapshot,
        )
        signal_row["run_id"] = run_id
        signal_row["watchlist"] = watchlist_name
        signal_rows.append(signal_row)

    signal_rows.sort(key=lambda item: float(item["total_score"]), reverse=True)
    sector_alerts = build_sector_alerts(all_event_facts, propagation_facts)
    sector_alert_rows = [{"run_id": run_id, "watchlist": watchlist_name, **alert} for alert in sector_alerts]

    summary = {
        "run_id": run_id,
        "watchlist": watchlist_name,
        "symbols": symbols,
        "architecture": "retrieval -> extraction -> reasoning -> evaluation",
        "agent_count": 4,
        "article_count": len(article_rows),
        "event_fact_count": len(event_rows),
        "propagation_fact_count": len(propagation_rows),
        "signal_count": len(signal_rows),
        "sector_alert_count": len(sector_alert_rows),
        "top_longs": [row["symbol"] for row in signal_rows if row["signal"] == "long"][:3],
        "top_shorts": [row["symbol"] for row in signal_rows if row["signal"] == "short"][:3],
        "retrieval_backends": sorted({meta["backend"] for meta in retrieval_meta.values()}),
        "extraction_backends": sorted({meta["backend"] for meta in extraction_meta.values()}),
        "reasoning_backends": sorted({str(view["reasoning_backend"]) for view in reasoning_views.values()}),
        "evaluation_backends": sorted({row["backend"] for row in evaluation_rows}),
        "warnings": warnings,
    }

    write_jsonl(run_dir / "articles_raw.jsonl", article_rows)
    write_jsonl(run_dir / "event_facts.jsonl", event_rows)
    write_jsonl(run_dir / "propagation_facts.jsonl", propagation_rows)
    write_jsonl(run_dir / "signal_outputs.jsonl", signal_rows)
    write_jsonl(run_dir / "sector_alerts.jsonl", sector_alert_rows)
    write_jsonl(run_dir / "evaluation_snapshots.jsonl", evaluation_rows)
    write_jsonl(run_dir / "agent_runs.jsonl", agent_rows)
    write_jsonl(run_dir / "events_extracted.jsonl", event_rows)
    write_jsonl(run_dir / "ticker_scores.jsonl", signal_rows)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    clickhouse_sync_message = maybe_sync_clickhouse(run_dir) if sync_clickhouse else ""

    if raw:
        print(
            json.dumps(
                {
                    "summary": summary,
                    "signals": signal_rows,
                    "sector_alerts": sector_alert_rows,
                    "evaluation": evaluation_rows,
                    "agents": agent_rows,
                    "clickhouse_sync": clickhouse_sync_message,
                },
                indent=2,
            )
        )
        return 0

    print(f"Run ID: {run_id}")
    print(f"Watchlist: {watchlist_name} ({', '.join(symbols)})")
    print("Architecture: Retrieval Agent -> Extraction Agent -> Reasoning Agent -> Evaluation Agent")
    print(f"Reasoning backends: {', '.join(summary['reasoning_backends'])}")
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
