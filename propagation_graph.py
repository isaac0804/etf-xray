#!/usr/bin/env python3
"""Static dependency graph used for deterministic contagion mapping."""

from __future__ import annotations

from typing import Any

TICKER_METADATA: dict[str, dict[str, Any]] = {
    "NVDA": {"sector": "semiconductors", "region": "US", "themes": ["ai_infrastructure", "gpu_compute"]},
    "AMD": {"sector": "semiconductors", "region": "US", "themes": ["ai_infrastructure", "cpu_gpu"]},
    "AVGO": {"sector": "semiconductors", "region": "US", "themes": ["networking", "ai_infrastructure"]},
    "QCOM": {"sector": "semiconductors", "region": "US", "themes": ["mobile", "connectivity"]},
    "MU": {"sector": "semiconductors", "region": "US", "themes": ["memory", "ai_infrastructure"]},
    "TXN": {"sector": "semiconductors", "region": "US", "themes": ["analog", "industrial"]},
    "INTC": {"sector": "semiconductors", "region": "US", "themes": ["foundry", "compute"]},
    "TSM": {"sector": "semiconductors", "region": "APAC", "themes": ["foundry", "ai_infrastructure"]},
    "ASML": {"sector": "semiconductor_equipment", "region": "Europe", "themes": ["lithography", "equipment"]},
    "AMAT": {"sector": "semiconductor_equipment", "region": "US", "themes": ["equipment", "materials"]},
    "AAPL": {"sector": "consumer_technology", "region": "US", "themes": ["devices"]},
    "MSFT": {"sector": "software", "region": "US", "themes": ["cloud", "ai_platforms"]},
    "AMZN": {"sector": "internet", "region": "US", "themes": ["cloud", "consumer"]},
    "META": {"sector": "internet", "region": "US", "themes": ["ads", "ai_platforms"]},
    "GOOGL": {"sector": "internet", "region": "US", "themes": ["search", "cloud", "ai_platforms"]},
    "TSLA": {"sector": "autos", "region": "US", "themes": ["ev", "autonomy"]},
}

PROPAGATION_EDGES: dict[str, list[dict[str, Any]]] = {
    "TSM": [
        {"target": "NVDA", "strength": 0.95, "reason": "fab_capacity_dependency"},
        {"target": "AMD", "strength": 0.88, "reason": "fab_capacity_dependency"},
        {"target": "QCOM", "strength": 0.72, "reason": "fab_capacity_dependency"},
        {"target": "AVGO", "strength": 0.68, "reason": "fab_capacity_dependency"},
        {"target": "MU", "strength": 0.56, "reason": "supply_chain_dependency"},
    ],
    "ASML": [
        {"target": "TSM", "strength": 0.90, "reason": "lithography_dependency"},
        {"target": "INTC", "strength": 0.72, "reason": "equipment_dependency"},
        {"target": "AMD", "strength": 0.50, "reason": "fab_equipment_dependency"},
        {"target": "NVDA", "strength": 0.48, "reason": "fab_equipment_dependency"},
    ],
    "AMAT": [
        {"target": "TSM", "strength": 0.78, "reason": "equipment_dependency"},
        {"target": "INTC", "strength": 0.72, "reason": "equipment_dependency"},
        {"target": "MU", "strength": 0.62, "reason": "memory_capex_dependency"},
    ],
    "MU": [
        {"target": "NVDA", "strength": 0.68, "reason": "memory_supply_dependency"},
        {"target": "AMD", "strength": 0.58, "reason": "memory_supply_dependency"},
    ],
    "NVDA": [
        {"target": "AVGO", "strength": 0.42, "reason": "ai_infrastructure_spillover"},
        {"target": "AMD", "strength": 0.32, "reason": "peer_repricing"},
    ],
}

EVENT_CONTAGION_MULTIPLIERS = {
    "supply_disruption": 1.00,
    "regulatory_probe": 0.75,
    "guidance_cut": 0.55,
    "earnings_miss": 0.45,
    "macro_theme": 0.60,
    "demand_signal": 0.55,
    "capex": 0.55,
    "guidance_raise": 0.35,
    "earnings_beat": 0.30,
    "mna": 0.22,
    "product_launch": 0.18,
    "partnership": 0.18,
    "other": 0.15,
}


def metadata_for(symbol: str) -> dict[str, Any]:
    """Return lightweight metadata for a ticker."""
    return TICKER_METADATA.get(symbol, {"sector": "unknown", "region": "Global", "themes": []})


def build_propagation_facts(
    event_facts: list[dict[str, Any]],
    universe_symbols: list[str],
) -> list[dict[str, Any]]:
    """Map direct events into downstream contagion facts using a static graph."""
    universe = set(universe_symbols)
    propagation_facts: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()

    for fact in event_facts:
        source_symbol = str(fact.get("symbol", "")).upper()
        base_score = float(fact.get("base_event_score", 0.0) or 0.0)
        event_type = str(fact.get("event_type", "other"))
        if source_symbol not in PROPAGATION_EDGES:
            continue
        if abs(base_score) < 0.10:
            continue

        multiplier = EVENT_CONTAGION_MULTIPLIERS.get(event_type, EVENT_CONTAGION_MULTIPLIERS["other"])
        for edge in PROPAGATION_EDGES[source_symbol]:
            target = str(edge["target"]).upper()
            if target not in universe or target == source_symbol:
                continue
            impact_score = base_score * float(edge["strength"]) * multiplier
            if abs(impact_score) < 0.05:
                continue

            key = (source_symbol, target, event_type, str(fact.get("source_url", "")))
            if key in seen:
                continue
            seen.add(key)

            target_meta = metadata_for(target)
            propagation_facts.append(
                {
                    "source_symbol": source_symbol,
                    "target_symbol": target,
                    "event_type": event_type,
                    "macro_theme": fact.get("macro_theme", "other"),
                    "impact_direction": "down" if impact_score < 0 else "up",
                    "impact_score": round(impact_score, 6),
                    "relationship": edge["reason"],
                    "edge_strength": edge["strength"],
                    "source_url": fact.get("source_url", ""),
                    "article_title": fact.get("article_title", ""),
                    "target_sector": target_meta.get("sector", "unknown"),
                    "target_region": target_meta.get("region", "Global"),
                    "reason": (
                        f"{source_symbol} event propagated to {target} via {edge['reason']}"
                    ),
                }
            )

    return propagation_facts
