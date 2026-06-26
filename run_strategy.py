"""
SSE wrapper for event_strategy.py.
Drives each sub-function directly so we can emit live progress per ticker.
All output is JSON-lines on stdout so the Next.js route can parse events.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Load .env.local ───────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
env_local = ROOT / ".env.local"
if env_local.exists():
    for raw in env_local.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if k and k not in os.environ:
            os.environ[k] = v

# Write teammate's .env so her load_dotenv(ENV_PATH) calls succeed
keys = ("TAVILY_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
        "ALPHA_VANTAGE_API_KEY", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
        "CLICKHOUSE_PASSWORD", "CLICKHOUSE_PORT")
(ROOT / ".env").write_text(
    "\n".join(f"{k}={os.environ.get(k, '')}" for k in keys if os.environ.get(k, "")) + "\n",
    encoding="utf-8",
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def emit(step: str, **kwargs) -> None:
    sys.stdout.write(
        json.dumps({"step": step, "ts": datetime.now(timezone.utc).isoformat(), **kwargs}) + "\n"
    )
    sys.stdout.flush()

def err(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()

# ── Imports from teammate's modules ──────────────────────────────────────────

import urllib.request, urllib.error

try:
    import ask_gemini as _ask_gemini
    import event_strategy as _event_strategy
    from event_strategy import (
        normalize_articles,
        extract_events_with_gemini, extract_events_with_keywords,
        summarize_symbol, write_jsonl, json_dumps,
        RUNS_DIR,
    )
    from market_data import fetch_yahoo_chart, summarize_yahoo_chart
    from search_tavily import ENV_PATH, API_URL, load_dotenv
    from ask_gemini import get_api_key
    from watchlists import resolve_symbols
except ImportError as e:
    emit("ERROR", message=f"Import failed: {e}")
    sys.exit(1)

RESULTS_PER_SYMBOL = 8
SNIPPET_MAX_CHARS  = 400   # keep prompt under Gemini context limit

# ── Replace curl-based call_gemini with native urllib (avoids Windows arg limit) ──

def _call_gemini_native(api_key: str, prompt: str, model: str | None = None) -> dict:
    model_name = model or _ask_gemini.get_model()
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model_name}:generateContent"
    )
    payload = _ask_gemini.build_payload(prompt)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())

# Patch event_strategy's local binding (from ask_gemini import call_gemini creates
# a module-level name in event_strategy — patch that directly)
_event_strategy.call_gemini = _call_gemini_native

NEWS_DOMAINS = [
    "reuters.com", "bloomberg.com", "cnbc.com", "wsj.com",
    "marketwatch.com", "ft.com", "barrons.com", "seekingalpha.com",
    "finance.yahoo.com", "investing.com", "thestreet.com",
]

def call_tavily_news(api_key: str, query: str) -> dict:
    """Advanced news-focused Tavily call: 7-day recency, 8 results."""
    payload = {
        "api_key": api_key,
        "query": query,
        "topic": "news",
        "search_depth": "advanced",
        "days": 7,
        "max_results": RESULTS_PER_SYMBOL,
        "include_answer": True,
        "include_domains": NEWS_DOMAINS,
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def build_news_query(symbol: str, summary: dict) -> str:
    name = summary.get("name", symbol)
    return (
        f"{name} {symbol} stock news past week: "
        "earnings results guidance analyst upgrade downgrade "
        "regulatory action lawsuit M&A acquisition"
    )

# ── Main pipeline ─────────────────────────────────────────────────────────────

symbols_arg = sys.argv[1:] if len(sys.argv) > 1 else []
emit("PIPELINE_START", message=f"Starting scan for: {' '.join(symbols_arg) or 'mag7'}")

try:
    load_dotenv(ENV_PATH)

    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not tavily_key:
        emit("ERROR", message="TAVILY_API_KEY not set")
        sys.exit(1)

    gemini_key = get_api_key()

    watchlist_name, symbols = resolve_symbols(symbols_arg, None)
    emit("SYMBOLS_RESOLVED", symbols=symbols, watchlist=watchlist_name,
         message=f"Watchlist: {watchlist_name} ({len(symbols)} tickers)")

    run_id = Path(os.urandom(8).hex()).name
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    article_rows: list = []
    event_rows: list = []
    score_rows: list = []
    warnings: list = []

    for symbol in symbols:
        emit("SYMBOL_START", symbol=symbol, message=f"Processing {symbol}…")

        # Yahoo Finance price data
        try:
            emit("YAHOO_FETCH", symbol=symbol, message=f"Fetching price data for {symbol}")
            price_summary = summarize_yahoo_chart(fetch_yahoo_chart(symbol))
        except Exception as exc:
            price_summary = {"symbol": symbol, "name": "", "instrument_type": "stock"}
            w = f"Yahoo Finance failed for {symbol}: {exc}"
            warnings.append(w)
            err(w)

        # Tavily news search (advanced, 7-day, news-only domains)
        tavily_query = build_news_query(symbol, price_summary)
        emit("TAVILY_FETCH", symbol=symbol, message=f"Searching news for {symbol}")
        try:
            tavily_data = call_tavily_news(tavily_key, tavily_query)
        except Exception as exc:
            w = f"Tavily failed for {symbol}: {exc}"
            warnings.append(w)
            err(w)
            tavily_data = {"results": [], "answer": ""}

        tavily_answer = str(tavily_data.get("answer", "")).strip()
        articles = normalize_articles(symbol, tavily_data, tavily_query)[:RESULTS_PER_SYMBOL]
        for a in articles:
            a["snippet"] = a["snippet"][:SNIPPET_MAX_CHARS]
        emit("TAVILY_DONE", symbol=symbol, count=len(articles),
             message=f"{len(articles)} articles retrieved for {symbol}")

        for article in articles:
            article_rows.append({
                "run_id": run_id, "watchlist": watchlist_name, "symbol": symbol,
                "tavily_query": tavily_query, "tavily_answer": tavily_answer,
                "title": article["title"], "url": article["url"],
                "domain": article["domain"], "rank": article["rank"],
                "source_score": article["source_score"], "snippet": article["snippet"],
                "raw_json": json_dumps(article["raw_result"]),
            })

        # Event extraction
        events: list = []
        if gemini_key and articles:
            emit("GEMINI_EXTRACT", symbol=symbol, message=f"Gemini extracting events for {symbol}…")
            try:
                events = extract_events_with_gemini(symbol, price_summary, articles, gemini_key)
                emit("GEMINI_DONE", symbol=symbol, count=len(events),
                     message=f"{len(events)} event(s) extracted by Gemini for {symbol}")
            except Exception as exc:
                w = f"Gemini failed for {symbol}; using keywords: {exc}"
                warnings.append(w)
                err(w)

        if not events:
            events = extract_events_with_keywords(symbol, articles)
            emit("KEYWORDS_DONE", symbol=symbol, count=len(events),
                 message=f"{len(events)} event(s) from keyword rules for {symbol}")

        for event in events:
            event_rows.append({
                "run_id": run_id, "watchlist": watchlist_name, "symbol": symbol,
                "article_title": event["article_title"], "source_url": event["source_url"],
                "event_type": event["event_type"], "direction": event["direction"],
                "severity": event["severity"], "relevance": event["relevance"],
                "confidence": event["confidence"], "horizon": event["horizon"],
                "source_score": event["source_score"],
                "event_score": round(float(event["event_score"]), 6),
                "rationale": event["rationale"], "extractor": event["extractor"],
            })

        # Score and emit
        score = summarize_symbol(symbol, price_summary, events)
        score["run_id"] = run_id
        score["watchlist"] = watchlist_name
        score_rows.append(score)

        emit("TICKER_SCORE", **score)

    # Write JSONL output files
    score_rows.sort(key=lambda r: float(r["total_score"]), reverse=True)
    summary = {
        "run_id": run_id, "watchlist": watchlist_name, "symbols": symbols,
        "extractor_mode": "gemini" if gemini_key else "keyword_rules",
        "article_count": len(article_rows), "event_count": len(event_rows),
        "top_longs":  [r["symbol"] for r in score_rows if r["signal"] == "long"][:3],
        "top_shorts": [r["symbol"] for r in score_rows if r["signal"] == "short"][:3],
        "warnings": warnings,
    }

    write_jsonl(run_dir / "articles_raw.jsonl", article_rows)
    write_jsonl(run_dir / "events_extracted.jsonl", event_rows)
    write_jsonl(run_dir / "ticker_scores.jsonl", score_rows)
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    emit("SUMMARY", **summary, message=f"Run {run_id} saved to runs/{run_id}/")
    emit("PIPELINE_DONE",
         message=f"Scan complete — {len(score_rows)} ticker(s) scored. "
                 f"{sum(1 for r in score_rows if r['signal']=='long')} long, "
                 f"{sum(1 for r in score_rows if r['signal']=='short')} short, "
                 f"{sum(1 for r in score_rows if r['signal']=='neutral')} neutral.")

except Exception as exc:
    import traceback
    emit("ERROR", message=str(exc), traceback=traceback.format_exc())
    sys.exit(1)
