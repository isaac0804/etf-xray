"""
Thin wrapper around event_strategy.py that:
  1. Loads .env.local into os.environ and writes a .env for her load_dotenv calls
  2. Invokes event_strategy.run_pipeline() directly
  3. Streams each stage as a JSON-lines event so the Next.js SSE route can parse live
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

# Write .env so her load_dotenv(ENV_PATH) calls succeed
env_out = ROOT / ".env"
keys = ("TAVILY_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
        "ALPHA_VANTAGE_API_KEY", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
        "CLICKHOUSE_PASSWORD", "CLICKHOUSE_PORT")
env_out.write_text(
    "\n".join(f"{k}={os.environ.get(k, '')}" for k in keys if os.environ.get(k, "")) + "\n",
    encoding="utf-8",
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def emit(step: str, **kwargs):
    print(json.dumps({"step": step, "ts": datetime.now(timezone.utc).isoformat(), **kwargs}),
          flush=True)

# ── Patch event_strategy to stream progress ───────────────────────────────────

import builtins
_orig_print = builtins.print

STEP_MAP = {
    "Run ID":       "RUN_START",
    "Watchlist":    "WATCHLIST",
    "Extractor":    "EXTRACTOR",
    "Output dir":   "OUTPUT_DIR",
    "Signals":      None,          # section header — skip
    "-------":      None,
    "Warnings":     None,
    "--------":     None,
}

def streaming_print(*args, file=None, **kwargs):
    if file and file is not sys.stdout:
        _orig_print(*args, file=file, **kwargs)
        return
    text = " ".join(str(a) for a in args).strip()
    if not text:
        return
    for prefix, step in STEP_MAP.items():
        if text.startswith(prefix):
            if step:
                emit(step, message=text)
            return
    # Signal line: "NVDA   long   score=+0.82  move=-3.27%  events=3  top=earnings_beat"
    emit("SIGNAL_LINE", message=text)

builtins.print = streaming_print

# ── Run ───────────────────────────────────────────────────────────────────────

symbols_arg = sys.argv[1:] if len(sys.argv) > 1 else []

emit("PIPELINE_START", message=f"Starting scan for: {' '.join(symbols_arg) or 'mag7'}")

try:
    import event_strategy
    from watchlists import resolve_symbols

    watchlist_name, symbols = resolve_symbols(symbols_arg, None)
    emit("SYMBOLS_RESOLVED", symbols=symbols, watchlist=watchlist_name)

    # Monkey-patch per-symbol progress inside the pipeline
    _orig_run = event_strategy.run_pipeline

    def instrumented_run(watchlist_name, symbols, results_per_symbol, raw):
        import event_strategy as es
        from market_data import fetch_yahoo_chart, summarize_yahoo_chart
        from search_tavily import call_tavily

        _orig_call_tavily = es.call_tavily

        def tracked_tavily(key, query, **kw):
            symbol_guess = query.split('"')[1] if '"' in query else query[:10]
            emit("TAVILY_FETCH", message=f"Fetching news: {symbol_guess}")
            result = _orig_call_tavily(key, query, **kw)
            count = len(result.get("results", []))
            emit("TAVILY_DONE", message=f"{count} articles retrieved")
            return result

        es.call_tavily = tracked_tavily

        _orig_gemini = es.extract_events_with_gemini

        def tracked_gemini(symbol, price_summary, articles, gemini_key):
            emit("GEMINI_EXTRACT", message=f"Gemini extracting events for {symbol}…")
            result = _orig_gemini(symbol, price_summary, articles, gemini_key)
            emit("GEMINI_DONE", message=f"{len(result)} event(s) extracted for {symbol}")
            return result

        es.extract_events_with_gemini = tracked_gemini

        code = _orig_run(watchlist_name, symbols, results_per_symbol, raw=True)
        return code

    # Run with raw=True so we get JSON output, then re-emit structured
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        builtins.print = _orig_print  # restore for raw JSON capture
        event_strategy.run_pipeline(watchlist_name, symbols,
                                     event_strategy.DEFAULT_RESULTS_PER_SYMBOL, raw=True)

    builtins.print = streaming_print

    raw_output = buf.getvalue().strip()
    if raw_output:
        try:
            data = json.loads(raw_output)
            summary = data.get("summary", {})
            scores  = data.get("scores", [])
            emit("SUMMARY", **summary)
            for score in scores:
                emit("TICKER_SCORE", **score)
            emit("PIPELINE_DONE", message=f"Scan complete. {len(scores)} ticker(s) scored.")
        except json.JSONDecodeError:
            emit("PIPELINE_DONE", message=raw_output[:200])

except Exception as exc:
    builtins.print = _orig_print
    emit("ERROR", message=str(exc))
    sys.exit(1)

builtins.print = _orig_print
