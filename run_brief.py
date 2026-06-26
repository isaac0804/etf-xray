"""
Thin wrapper around etf_brief.py that:
  1. Loads credentials from .env.local (our monorepo convention) and also
     writes them into os.environ so her scripts see them via ENV_PATH/.env.
  2. Captures etf_brief output and re-emits each section as a JSON-lines
     event so the Next.js SSE stream can parse and render it live.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Load .env.local into os.environ ───────────────────────────────────────────
ROOT = Path(__file__).parent
env_local = ROOT / ".env.local"
if env_local.exists():
    for raw in env_local.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if k and k not in os.environ:
            os.environ[k] = v

# Also write a .env so her load_dotenv(ENV_PATH) call finds them
env_file = ROOT / ".env"
lines = []
for key in ("TAVILY_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
            "ALPHA_VANTAGE_API_KEY", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
            "CLICKHOUSE_PASSWORD", "CLICKHOUSE_PORT"):
    val = os.environ.get(key, "")
    if val:
        lines.append(f"{key}={val}")
env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

# ── Now invoke her logic directly ─────────────────────────────────────────────
import io
import contextlib

# Patch sys.argv so etf_brief.main() picks up our topic argument
topic = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "QQQ SMH LIT"

def emit(step: str, **kwargs):
    print(json.dumps({"step": step, "ts": datetime.now(timezone.utc).isoformat(), **kwargs}),
          flush=True)

emit("BRIEF_START", topic=topic)

try:
    # Monkey-patch print so we can capture etf_brief's output line by line
    import builtins
    _original_print = builtins.print
    current_section = {"name": "INFO"}

    SECTION_PATTERNS = {
        r"Tight ETF Brief":    "BRIEF",
        r"Tavily answer":      "TAVILY",
        r"Yahoo Finance":      "YAHOO",
        r"Alpha Vantage":      "ALPHA",
        r"Source warnings":    "WARNINGS",
        r"^Topic:":            "TOPIC",
    }

    def capturing_print(*args, file=None, **kwargs):
        text = " ".join(str(a) for a in args)
        if file and file is not sys.stdout:
            _original_print(*args, file=file, **kwargs)
            return
        for pattern, section in SECTION_PATTERNS.items():
            if re.search(pattern, text, re.IGNORECASE):
                current_section["name"] = section
                return
        stripped = text.strip("-").strip()
        if stripped:
            emit(current_section["name"], message=stripped)

    builtins.print = capturing_print

    # Redirect stderr to suppress internal warnings from her scripts
    import etf_brief
    with contextlib.redirect_stderr(io.StringIO()):
        sys.argv = ["etf_brief.py", topic]
        result = etf_brief.main(sys.argv[1:])

    builtins.print = _original_print
    emit("BRIEF_DONE", exit_code=result or 0)

except Exception as exc:
    try:
        builtins.print = _original_print
    except Exception:
        pass
    emit("ERROR", message=str(exc))
    sys.exit(1)
