"""
SSE wrapper for event_strategy.py (v2: propagation + article filters).
Tavily search + Gemini analysis run in parallel across symbols.
Propagation + scoring remain serial (need all facts first).
"""
from __future__ import annotations

import json
import os
import sys
import threading
import concurrent.futures
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

keys = ("TAVILY_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
        "ALPHA_VANTAGE_API_KEY", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
        "CLICKHOUSE_PASSWORD", "CLICKHOUSE_PORT")
(ROOT / ".env").write_text(
    "\n".join(f"{k}={os.environ.get(k, '')}" for k in keys if os.environ.get(k, "")) + "\n",
    encoding="utf-8",
)

# ── Helpers ───────────────────────────────────────────────────────────────────

_emit_lock = threading.Lock()

def emit(step: str, **kwargs) -> None:
    line = json.dumps({"step": step, "ts": datetime.now(timezone.utc).isoformat(), **kwargs}) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()

def err(msg: str) -> None:
    with _emit_lock:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()

# ── Imports ───────────────────────────────────────────────────────────────────

import urllib.request, urllib.error

try:
    import ask_gemini as _ask_gemini
    import event_strategy as _event_strategy
    from event_strategy import (
        normalize_articles, extract_facts_with_gemini, extract_facts_with_keywords,
        build_sector_alerts, summarize_symbol, write_jsonl, json_dumps, RUNS_DIR,
    )
    from article_filters import filter_articles
    from propagation_graph import build_propagation_facts
    from market_data import fetch_yahoo_chart, summarize_yahoo_chart
    from search_tavily import ENV_PATH, API_URL, load_dotenv
    from ask_gemini import get_api_key
    from watchlists import resolve_symbols
except ImportError as e:
    emit("ERROR", message=f"Import failed: {e}")
    sys.exit(1)

RESULTS_PER_SYMBOL = 8
SNIPPET_MAX_CHARS  = 400
PARALLEL_WORKERS   = 6   # I/O bound — more threads than CPUs is fine

# ── Replace curl-based call_gemini with native urllib ─────────────────────────

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

_event_strategy.call_gemini = _call_gemini_native

# ── News-optimised Tavily call ────────────────────────────────────────────────

NEWS_DOMAINS = [
    "reuters.com", "bloomberg.com", "cnbc.com", "wsj.com",
    "marketwatch.com", "ft.com", "barrons.com", "seekingalpha.com",
    "finance.yahoo.com", "investing.com", "thestreet.com",
]

def call_tavily_news(api_key: str, query: str) -> dict:
    payload = {
        "api_key": api_key, "query": query,
        "topic": "news", "search_depth": "advanced", "days": 7,
        "max_results": RESULTS_PER_SYMBOL, "include_answer": True,
        "include_domains": NEWS_DOMAINS,
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def build_news_query(symbol: str, summary: dict) -> str:
    name = summary.get("name", symbol)
    return (
        f"{name} {symbol} stock news past week: "
        "earnings results guidance analyst upgrade downgrade "
        "regulatory action lawsuit supply disruption M&A"
    )

# ── Per-symbol worker (runs in thread pool) ───────────────────────────────────

class SymbolResult:
    __slots__ = ("symbol", "price_summary", "tavily_query", "tavily_answer",
                 "article_rows", "event_facts", "warnings")
    def __init__(self, symbol: str):
        self.symbol = symbol
        self.price_summary: dict = {}
        self.tavily_query = ""
        self.tavily_answer = ""
        self.article_rows: list = []
        self.event_facts: list = []
        self.warnings: list = []


def process_symbol(
    symbol: str,
    tavily_key: str,
    gemini_key: str,
    watchlist_name: str,
    run_id: str,
) -> SymbolResult:
    res = SymbolResult(symbol)
    emit("SYMBOL_START", symbol=symbol, message=f"Processing {symbol}…")

    # Yahoo Finance
    try:
        emit("YAHOO_FETCH", symbol=symbol, message=f"Fetching price data for {symbol}")
        res.price_summary = summarize_yahoo_chart(fetch_yahoo_chart(symbol))
    except Exception as exc:
        res.price_summary = {"symbol": symbol, "name": "", "instrument_type": "stock"}
        w = f"Yahoo Finance failed for {symbol}: {exc}"
        res.warnings.append(w); err(w)

    # Tavily
    res.tavily_query = build_news_query(symbol, res.price_summary)
    emit("TAVILY_FETCH", symbol=symbol, message=f"Searching news for {symbol}")
    try:
        tavily_data = call_tavily_news(tavily_key, res.tavily_query)
    except Exception as exc:
        w = f"Tavily failed for {symbol}: {exc}"
        res.warnings.append(w); err(w)
        tavily_data = {"results": [], "answer": ""}

    res.tavily_answer = str(tavily_data.get("answer", "")).strip()
    raw_articles = normalize_articles(symbol, tavily_data, res.tavily_query)

    # Article quality filter
    filtered, rejected = filter_articles(raw_articles, RESULTS_PER_SYMBOL)
    for a in filtered:
        a["snippet"] = a["snippet"][:SNIPPET_MAX_CHARS]

    emit("TAVILY_DONE", symbol=symbol, count=len(filtered), rejected=len(rejected),
         message=f"{len(filtered)} articles kept, {len(rejected)} filtered for {symbol}")

    for article in filtered:
        res.article_rows.append({
            "run_id": run_id, "watchlist": watchlist_name, "symbol": symbol,
            "tavily_query": res.tavily_query, "tavily_answer": res.tavily_answer,
            "title": article["title"], "url": article["url"],
            "domain": article["domain"], "rank": article["rank"],
            "source_score": article["source_score"],
            "quality_score": article.get("quality_score", 0.0),
            "snippet": article["snippet"],
            "raw_json": json_dumps(article.get("raw_result", {})),
        })

    # Gemini / keyword extraction
    facts: list = []
    if gemini_key and filtered:
        emit("GEMINI_EXTRACT", symbol=symbol, message=f"Gemini extracting facts for {symbol}…")
        try:
            facts = extract_facts_with_gemini(symbol, res.price_summary, filtered, gemini_key)
            emit("GEMINI_DONE", symbol=symbol, count=len(facts),
                 message=f"{len(facts)} fact(s) extracted by Gemini for {symbol}")
        except Exception as exc:
            w = f"Gemini failed for {symbol}; using keywords: {exc}"
            res.warnings.append(w); err(w)

    if not facts:
        facts = extract_facts_with_keywords(symbol, filtered)
        emit("KEYWORDS_DONE", symbol=symbol, count=len(facts),
             message=f"{len(facts)} fact(s) from keyword rules for {symbol}")

    for fact in facts:
        row = {
            "run_id": run_id, "watchlist": watchlist_name, "symbol": symbol,
            "article_title": fact.get("article_title", ""),
            "source_url": fact.get("source_url", ""),
            "event_type": fact.get("event_type", ""),
            "severity_label": fact.get("severity_label", ""),
            "severity_score": fact.get("severity_score", 0.0),
            "confidence": fact.get("confidence", 0.0),
            "sentiment_score": fact.get("sentiment_score", 0.0),
            "direction": fact.get("direction", "neutral"),
            "macro_theme": fact.get("macro_theme", ""),
            "region": fact.get("region", ""),
            "base_event_score": round(float(fact.get("base_event_score", 0.0)), 6),
            "extractor": fact.get("extractor", ""),
        }
        res.article_rows  # articles already appended above
        res.event_facts.append(({**fact, "symbol": symbol}, row))

    return res

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
         message=f"Watchlist: {watchlist_name} ({len(symbols)} tickers) — parallel mode")

    run_id = Path(os.urandom(8).hex()).name
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # ── Parallel fetch + analysis ─────────────────────────────────────────────
    workers = min(PARALLEL_WORKERS, len(symbols))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_symbol, sym, tavily_key, gemini_key, watchlist_name, run_id): sym
            for sym in symbols
        }
        results_by_symbol: dict[str, SymbolResult] = {}
        for fut in concurrent.futures.as_completed(futures):
            sym = futures[fut]
            try:
                results_by_symbol[sym] = fut.result()
            except Exception as exc:
                import traceback as _tb
                emit("ERROR", symbol=sym, message=str(exc), traceback=_tb.format_exc())

    # Merge in original symbol order
    article_rows: list = []
    event_fact_rows: list = []
    all_event_facts: list = []
    warnings: list = []

    for sym in symbols:
        res = results_by_symbol.get(sym)
        if not res:
            continue
        article_rows.extend(res.article_rows)
        warnings.extend(res.warnings)
        for event_fact, row in res.event_facts:
            all_event_facts.append(event_fact)
            event_fact_rows.append(row)

    # ── Propagation (serial — needs all facts) ────────────────────────────────
    emit("PROPAGATION", message="Computing cross-ticker propagation…")
    propagation_facts = build_propagation_facts(all_event_facts, symbols)
    emit("PROPAGATION_DONE", count=len(propagation_facts),
         message=f"{len(propagation_facts)} propagation fact(s) computed")

    # ── Scoring ───────────────────────────────────────────────────────────────
    prop_by_target: dict[str, list] = {}
    for pf in propagation_facts:
        prop_by_target.setdefault(pf["target_symbol"], []).append(pf)

    direct_by_symbol: dict[str, list] = {}
    for ef in all_event_facts:
        direct_by_symbol.setdefault(ef["symbol"], []).append(ef)

    score_rows: list = []
    for sym in symbols:
        res = results_by_symbol.get(sym)
        d_facts = direct_by_symbol.get(sym, [])
        p_facts = prop_by_target.get(sym, [])
        price_summary = res.price_summary if res else {"symbol": sym, "name": sym}
        score = summarize_symbol(
            sym,
            {"name": next((f.get("entity_name", sym) for f in d_facts), price_summary.get("name", sym)),
             "close_series": []},
            d_facts, p_facts,
        )
        score["run_id"] = run_id
        score["watchlist"] = watchlist_name
        score_rows.append(score)
        emit("TICKER_SCORE", **score)

    score_rows.sort(key=lambda r: abs(float(r["total_score"])), reverse=True)

    # ── Sector alerts ─────────────────────────────────────────────────────────
    sector_alerts = build_sector_alerts(all_event_facts, propagation_facts)
    if sector_alerts:
        emit("SECTOR_ALERTS", alerts=sector_alerts,
             message=f"{len(sector_alerts)} sector alert(s)")

    # ── Write JSONL ───────────────────────────────────────────────────────────
    prop_rows = [{**pf, "run_id": run_id, "watchlist": watchlist_name} for pf in propagation_facts]
    sector_rows = [{**sa, "run_id": run_id, "watchlist": watchlist_name} for sa in sector_alerts]

    write_jsonl(run_dir / "articles_raw.jsonl", article_rows)
    write_jsonl(run_dir / "event_facts.jsonl", event_fact_rows)
    write_jsonl(run_dir / "propagation_facts.jsonl", prop_rows)
    write_jsonl(run_dir / "sector_alerts.jsonl", sector_rows)
    write_jsonl(run_dir / "signal_outputs.jsonl", score_rows)

    summary = {
        "run_id": run_id, "watchlist": watchlist_name, "symbols": symbols,
        "extractor_mode": "gemini" if gemini_key else "keyword_rules",
        "article_count": len(article_rows),
        "event_fact_count": len(event_fact_rows),
        "propagation_fact_count": len(propagation_facts),
        "signal_count": len(score_rows),
        "sector_alert_count": len(sector_alerts),
        "top_longs":  [r["symbol"] for r in score_rows if r["signal"] == "long"][:3],
        "top_shorts": [r["symbol"] for r in score_rows if r["signal"] == "short"][:3],
        "warnings": warnings,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    emit("SUMMARY", **summary, message=f"Run {run_id} complete")
    emit("PIPELINE_DONE",
         message=(
             f"Scan complete — {len(score_rows)} scored, "
             f"{sum(1 for r in score_rows if r['signal']=='long')} long, "
             f"{sum(1 for r in score_rows if r['signal']=='short')} short, "
             f"{sum(1 for r in score_rows if r['signal']=='neutral')} neutral. "
             f"{len(propagation_facts)} propagation facts."
         ))

except Exception as exc:
    import traceback
    emit("ERROR", message=str(exc), traceback=traceback.format_exc())
    sys.exit(1)
