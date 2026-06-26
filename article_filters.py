#!/usr/bin/env python3
"""Article filtering and quality heuristics for market-event retrieval."""

from __future__ import annotations

import re
from urllib.parse import urlparse

BLOCKED_DOMAINS = {
    "www.youtube.com",
    "youtube.com",
    "youtu.be",
    "video.yahoo.com",
    "public.com",
}

DOMAIN_WEIGHTS = {
    "www.reuters.com": 1.00,
    "reuters.com": 1.00,
    "www.bloomberg.com": 0.98,
    "www.wsj.com": 0.96,
    "www.ft.com": 0.96,
    "www.cnbc.com": 0.86,
    "www.marketwatch.com": 0.82,
    "finance.yahoo.com": 0.78,
    "www.investing.com": 0.76,
    "seekingalpha.com": 0.74,
    "www.fool.com": 0.68,
}

EVENT_KEYWORDS = {
    "earnings",
    "guidance",
    "forecast",
    "outlook",
    "merger",
    "acquisition",
    "buyout",
    "probe",
    "investigation",
    "regulator",
    "lawsuit",
    "recall",
    "launch",
    "unveils",
    "approval",
    "export",
    "tariff",
    "supply",
    "disruption",
    "demand",
    "contract",
    "capex",
    "upgrade",
    "downgrade",
    "rating",
}

REJECT_TITLE_PATTERNS = [
    re.compile(r"^financial analysis for\b", re.IGNORECASE),
    re.compile(r"stock price & latest news", re.IGNORECASE),
    re.compile(r"latest news & stock updates", re.IGNORECASE),
    re.compile(r"stock price, quote, news & analysis", re.IGNORECASE),
]

ROOT_QUOTE_PATTERNS = [
    re.compile(r"^/quote/[^/]+/?$", re.IGNORECASE),
    re.compile(r"^/markets/companies/[^/]+/?$", re.IGNORECASE),
    re.compile(r"^/symbol/[^/]+/?$", re.IGNORECASE),
    re.compile(r"^/quotes/[^/]+/?$", re.IGNORECASE),
]


def domain_weight(domain: str) -> float:
    """Return a heuristic quality weight for a news domain."""
    return DOMAIN_WEIGHTS.get(domain.lower(), 0.62)


def text_has_event_keyword(*parts: str) -> bool:
    """Check whether title/snippet text looks like a discrete event article."""
    text = " ".join(parts).lower()
    return any(keyword in text for keyword in EVENT_KEYWORDS)


def classify_article(article: dict[str, object]) -> tuple[bool, str, float]:
    """Decide whether to keep a Tavily result and assign a quality score."""
    url = str(article.get("url", "")).strip()
    title = str(article.get("title", "")).strip()
    snippet = str(article.get("snippet", "")).strip()
    domain = str(article.get("domain", "")).strip().lower()
    path = urlparse(url).path or ""
    source_score = float(article.get("source_score", 0.0) or 0.0)
    has_event = text_has_event_keyword(title, snippet)

    if domain in BLOCKED_DOMAINS:
        return False, "blocked_domain", 0.0

    if len(snippet) < 35:
        return False, "snippet_too_short", 0.0

    for pattern in ROOT_QUOTE_PATTERNS:
        if pattern.search(path):
            return False, "profile_or_quote_page", 0.0

    if "/markets/companies/" in path.lower():
        return False, "company_profile_page", 0.0

    if path.lower().startswith("/symbol/"):
        return False, "symbol_overview_page", 0.0

    if path.lower().startswith("/quotes/"):
        return False, "quote_overview_page", 0.0

    for pattern in REJECT_TITLE_PATTERNS:
        if pattern.search(title) and not has_event:
            return False, "non_article_title", 0.0

    quality = source_score * domain_weight(domain)
    if has_event:
        quality += 0.22
    if "/news" in path.lower():
        quality += 0.12
    if re.search(r"/\d{4}/\d{2}/\d{2}/", path):
        quality += 0.12

    quality = max(0.0, min(1.0, quality))

    if quality < 0.46 and not has_event:
        return False, "low_quality_non_event", quality

    return True, "accepted", quality


def filter_articles(
    articles: list[dict[str, object]],
    max_results: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Filter, score, and cap raw Tavily results."""
    kept: list[dict[str, object]] = []
    rejected: list[dict[str, object]] = []

    for article in articles:
        keep, reason, quality = classify_article(article)
        enriched = dict(article)
        enriched["filter_reason"] = reason
        enriched["quality_score"] = round(quality, 6)
        enriched["kept"] = keep
        if keep:
            kept.append(enriched)
        else:
            rejected.append(enriched)

    kept.sort(key=lambda item: float(item.get("quality_score", 0.0)), reverse=True)
    selected = kept[:max_results]

    if selected:
        return selected, rejected + kept[max_results:]

    fallback = []
    for article in articles:
        url = str(article.get("url", "")).strip()
        domain = str(article.get("domain", "")).strip().lower()
        if domain in BLOCKED_DOMAINS:
            continue
        if any(pattern.search(urlparse(url).path or "") for pattern in ROOT_QUOTE_PATTERNS):
            continue
        enriched = dict(article)
        enriched["filter_reason"] = "fallback_keep"
        enriched["quality_score"] = round(max(0.25, float(article.get("source_score", 0.0) or 0.0)), 6)
        enriched["kept"] = True
        fallback.append(enriched)

    fallback.sort(key=lambda item: float(item.get("quality_score", 0.0)), reverse=True)
    return fallback[:max_results], rejected
