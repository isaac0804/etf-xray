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
    from prometheux_support import (
        has_prometheux_config, evaluate_vadalog_program,
        get_vadalog_status, is_no_active_compute_error,
    )
    import subprocess as _subprocess
except ImportError as e:
    emit("ERROR", message=f"Import failed: {e}")
    sys.exit(1)

RESULTS_PER_SYMBOL = 8
SNIPPET_MAX_CHARS  = 400
PARALLEL_WORKERS   = 6   # I/O bound — more threads than CPUs is fine
CH_DB              = os.environ.get("CLICKHOUSE_DATABASE", "etf_xray")

# ── ClickHouse (optional — degrades gracefully if unavailable) ────────────────

_ch_client = None

def _get_ch():
    global _ch_client
    if _ch_client is not None:
        return _ch_client
    try:
        import clickhouse_connect
        host  = os.environ.get("CLICKHOUSE_HOST", "localhost")
        port  = int(os.environ.get("CLICKHOUSE_PORT", "8123"))
        _ch_client = clickhouse_connect.get_client(
            host=host, port=port,
            username=os.environ.get("CLICKHOUSE_USER", "default"),
            password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
            secure=port in (8443, 8444),
            connect_timeout=3, send_receive_timeout=5,
        )
        return _ch_client
    except Exception as exc:
        err(f"ClickHouse unavailable: {exc}")
        return None

def _ensure_schema(ch) -> None:
    ch.command(f"CREATE DATABASE IF NOT EXISTS `{CH_DB}`")
    ch.command(f"""
        CREATE TABLE IF NOT EXISTS `{CH_DB}`.signal_cache (
            symbol               String,
            watchlist            String,
            run_ts               DateTime64(3, 'UTC'),
            signal               String,
            risk_level           String,
            total_score          Float64,
            direct_score         Float64,
            propagated_score     Float64,
            price_change_pct     Nullable(Float64),
            event_count          UInt16,
            propagation_count    UInt16,
            strongest_event_type String,
            top_driver_titles    Array(String),
            top_driver_urls      Array(String),
            explanation          String,
            rules_fired          Array(String),
            sector               String,
            region               String,
            name                 String,
            run_id               String,
            prometheux_backend   String,
            prometheux_flags     Array(String)
        ) ENGINE = ReplacingMergeTree(run_ts)
        ORDER BY (symbol, watchlist)
    """)

def write_to_clickhouse(score_rows: list, watchlist_name: str, run_id: str) -> None:
    ch = _get_ch()
    if not ch:
        return
    try:
        _ensure_schema(ch)
        now = datetime.now(timezone.utc).replace(tzinfo=None)  # ClickHouse expects naive UTC
        data = []
        cols = [
            "symbol", "watchlist", "run_ts", "signal", "risk_level",
            "total_score", "direct_score", "propagated_score", "price_change_pct",
            "event_count", "propagation_count", "strongest_event_type",
            "top_driver_titles", "top_driver_urls", "explanation",
            "rules_fired", "sector", "region", "name", "run_id",
            "prometheux_backend", "prometheux_flags",
        ]
        for r in score_rows:
            data.append([
                r.get("symbol", ""),
                watchlist_name,
                now,
                r.get("signal", "neutral"),
                r.get("risk_level", "LOW"),
                float(r.get("total_score", 0.0)),
                float(r.get("direct_score", 0.0)),
                float(r.get("propagated_score", 0.0)),
                r.get("price_change_pct"),
                int(r.get("event_count", 0)),
                int(r.get("propagation_count", 0)),
                r.get("strongest_event_type", ""),
                list(r.get("top_driver_titles", [])),
                list(r.get("top_driver_urls", [])),
                r.get("explanation", ""),
                list(r.get("rules_fired", [])),
                r.get("sector", ""),
                r.get("region", ""),
                r.get("name", ""),
                run_id,
                r.get("prometheux_backend", "disabled"),
                list(r.get("prometheux_flags", [])),
            ])
        ch.insert(f"`{CH_DB}`.signal_cache", data, column_names=cols)
        emit("CACHE_WRITE", count=len(data), message=f"Wrote {len(data)} signals to ClickHouse cache")
    except Exception as exc:
        err(f"ClickHouse write failed: {exc}")

# ── Replace curl-based call_gemini with native urllib ─────────────────────────

def _call_gemini_native(api_key: str, prompt: str, model: str | None = None) -> dict:
    candidates = _ask_gemini.get_model_candidates(model)
    last_error: urllib.error.HTTPError | None = None
    for model_name in candidates:
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
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
                if isinstance(data, dict):
                    data["_model_used"] = model_name
                return data
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in (429, 503):  # quota / overload — try next candidate
                continue
            raise
    if last_error is not None:
        raise last_error
    raise RuntimeError("No Gemini models available to try.")

_event_strategy.call_gemini = _call_gemini_native

# ── Prometheux Vadalog reasoning ──────────────────────────────────────────────

def vadalog_quote(value) -> str:
    """Escape a scalar for inline Vadalog fact emission."""
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def build_prometheux_program(event_facts: list, propagation_facts: list) -> str:
    """Build a compact Vadalog program for deterministic market-event flags."""
    lines = [
        '% Auto-generated by News2Signal SSE pipeline.',
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
            + ",".join([
                vadalog_quote(fact.get("symbol", "")),
                vadalog_quote(fact.get("event_type", "other")),
                vadalog_quote(fact.get("severity_label", "low")),
                f"{float(fact.get('confidence', 0.0) or 0.0):.6f}",
                f"{float(fact.get('sentiment_score', 0.0) or 0.0):.6f}",
            ])
            + ")."
        )
    for fact in propagation_facts:
        lines.append(
            "propagation_fact("
            + ",".join([
                vadalog_quote(fact.get("source_symbol", "")),
                vadalog_quote(fact.get("target_symbol", "")),
                vadalog_quote(fact.get("event_type", "other")),
                f"{float(fact.get('impact_score', 0.0) or 0.0):.6f}",
            ])
            + ")."
        )
    lines.extend([
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
    ])
    return "\n".join(lines)


def parse_prometheux_flags(response: dict) -> dict:
    """Extract symbol -> set[flag] from a Vadalog evaluate response."""
    data = response.get("data", response)
    if not isinstance(data, dict):
        return {}
    result_set = data.get("resultSet", {})
    if not isinstance(result_set, dict):
        return {}
    flags: dict = {}
    for output_name, rows in result_set.items():
        if not isinstance(output_name, str) or not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, list) or not row:
                continue
            symbol = str(row[0]).strip()
            if symbol:
                flags.setdefault(symbol, set()).add(output_name)
    return flags


def run_prometheux_reasoning(event_facts: list, propagation_facts: list, warnings: list) -> tuple:
    """
    Run the Prometheux Vadalog reasoning step.
    Returns (backend_used: str, flags: dict[symbol -> set[str]], note: str).
    Degrades gracefully — never raises.
    """
    if not has_prometheux_config():
        return "disabled", {}, "Prometheux credentials unavailable."

    emit("PROMETHEUX_START", message="Checking Prometheux Vadalog engine status…")
    try:
        status = get_vadalog_status()
        engine_state = str(status.get("data", {}).get("status", "unknown"))
        if engine_state != "ready":
            emit("PROMETHEUX_SKIP", reason=f"engine_state={engine_state}",
                 message=f"Vadalog engine not ready ({engine_state}); using local rules.")
            return "status_only", {}, f"Vadalog engine status is {engine_state}."
    except Exception as exc:
        w = f"Prometheux status check failed: {exc}"
        warnings.append(w)
        emit("PROMETHEUX_SKIP", reason="status_check_failed", message=w)
        return "status_failed", {}, w

    program = build_prometheux_program(event_facts, propagation_facts)
    emit("PROMETHEUX_EVAL", facts=len(event_facts), propagation=len(propagation_facts),
         message=f"Submitting Vadalog program ({len(event_facts)} facts, {len(propagation_facts)} propagation facts)…")
    try:
        response = evaluate_vadalog_program(program)
        flags = parse_prometheux_flags(response)
        flagged_count = sum(len(v) for v in flags.values())
        emit("PROMETHEUX_DONE", backend="prometheux_vadalog", flagged_symbols=list(flags.keys()),
             message=f"Prometheux returned {flagged_count} flag(s) across {len(flags)} symbol(s).")
        return "prometheux_vadalog", flags, "Prometheux Vadalog evaluation succeeded."
    except _subprocess.CalledProcessError as exc:
        if is_no_active_compute_error(exc):
            emit("PROMETHEUX_SKIP", reason="no_active_compute",
                 message="Prometheux compute not active; local rules used.")
            return "prometheux_no_compute", {}, "Prometheux compute is not active."
        w = f"Prometheux evaluation failed: {exc}"
        warnings.append(w)
        emit("PROMETHEUX_SKIP", reason="eval_error", message=w)
        return "prometheux_error", {}, w
    except Exception as exc:
        w = f"Prometheux evaluation failed: {exc}"
        warnings.append(w)
        emit("PROMETHEUX_SKIP", reason="eval_error", message=w)
        return "prometheux_error", {}, w



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

# Parse --watchlist <name> from argv; remaining args are symbols
_argv = sys.argv[1:]
_forced_watchlist: str | None = None
if "--watchlist" in _argv:
    _idx = _argv.index("--watchlist")
    if _idx + 1 < len(_argv):
        _forced_watchlist = _argv[_idx + 1]
        _argv = _argv[:_idx] + _argv[_idx + 2:]

symbols_arg = _argv
emit("PIPELINE_START", message=f"Starting scan for: {' '.join(symbols_arg) or 'mag7'}")

try:
    load_dotenv(ENV_PATH)

    tavily_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not tavily_key:
        emit("ERROR", message="TAVILY_API_KEY not set")
        sys.exit(1)

    gemini_key = get_api_key()

    watchlist_name, symbols = resolve_symbols(symbols_arg, None)
    # If the frontend passed --watchlist <name>, use that as the stored key
    # (resolve_symbols returns "custom" when explicit symbols are given)
    if _forced_watchlist:
        watchlist_name = _forced_watchlist
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

    # ── Prometheux Vadalog reasoning (runs after all facts are collected) ────────
    emit("PROPAGATION", message="Computing cross-ticker propagation…")
    propagation_facts = build_propagation_facts(all_event_facts, symbols)
    emit("PROPAGATION_DONE", count=len(propagation_facts),
         message=f"{len(propagation_facts)} propagation fact(s) computed")

    pmtx_backend, pmtx_flags, pmtx_note = run_prometheux_reasoning(
        all_event_facts, propagation_facts, warnings
    )

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
        score = summarize_symbol(sym, price_summary, d_facts, p_facts)
        score["run_id"] = run_id
        score["watchlist"] = watchlist_name

        # ── Apply Prometheux flags ────────────────────────────────────────────
        sym_flags = pmtx_flags.get(sym, set())
        score["prometheux_backend"] = pmtx_backend
        score["prometheux_flags"] = sorted(sym_flags)
        if sym_flags:
            rules = list(score.get("rules_fired", []))
            for flag in sorted(sym_flags):
                rules.append(f"prometheux_{flag}")
            score["rules_fired"] = rules
            # Cap score magnitude when Prometheux marks low_signal
            if "low_signal" in sym_flags:
                capped = min(abs(float(score.get("total_score", 0.0))), 0.35)
                score["total_score"] = capped if float(score.get("total_score", 0.0)) >= 0 else -capped

        # dominant_event_type is now returned by summarize_symbol; alias for cache compat
        score["strongest_event_type"] = score.get("dominant_event_type", "")
        # top_driver_urls not returned by summarize_symbol — compute from raw facts
        top_direct_sorted = sorted(d_facts, key=lambda f: abs(float(f.get("base_event_score", 0.0) or 0.0)), reverse=True)
        score["top_driver_urls"] = [f.get("source_url", "") for f in top_direct_sorted[:3]]

        score_rows.append(score)
        emit("TICKER_SCORE", **score)

    score_rows.sort(key=lambda r: abs(float(r["total_score"])), reverse=True)

    # ── Emit individual event facts for event-centric view ────────────────────
    for ef in all_event_facts:
        emit("EVENT_FACT",
             symbol=ef.get("symbol", ""),
             event_type=ef.get("event_type", "other"),
             macro_theme=ef.get("macro_theme", "other"),
             direction=ef.get("direction", "neutral"),
             severity_label=ef.get("severity_label", "low"),
             severity_score=round(float(ef.get("severity_score", 0.0)), 4),
             confidence=round(float(ef.get("confidence", 0.0)), 4),
             sentiment_score=round(float(ef.get("sentiment_score", 0.0)), 4),
             base_event_score=round(float(ef.get("base_event_score", 0.0)), 6),
             article_title=ef.get("article_title", ""),
             source_url=ef.get("source_url", ""),
             summary=ef.get("summary", ""),
             time_horizon=ef.get("time_horizon", "short_term"),
             region=ef.get("region", "Global"),
             extractor=ef.get("extractor", ""),
             run_id=run_id)

    # ── Emit propagation facts for event-centric view ─────────────────────────
    for pf in propagation_facts:
        emit("PROPAGATION_FACT",
             source_symbol=pf.get("source_symbol", ""),
             target_symbol=pf.get("target_symbol", ""),
             event_type=pf.get("event_type", "other"),
             macro_theme=pf.get("macro_theme", "other"),
             impact_direction=pf.get("impact_direction", "neutral"),
             impact_score=round(float(pf.get("impact_score", 0.0)), 6),
             relationship=pf.get("relationship", ""),
             edge_strength=round(float(pf.get("edge_strength", 0.0)), 4),
             article_title=pf.get("article_title", ""),
             source_url=pf.get("source_url", ""),
             run_id=run_id)

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

    # Persist to ClickHouse cache (non-blocking — errors are logged, not fatal)
    write_to_clickhouse(score_rows, watchlist_name, run_id)

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
