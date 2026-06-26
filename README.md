# News2Signal

Generic event-driven signal engine for a hackathon build.

It now follows an explicit 4-agent flow:

- `Retrieval Agent`: `Gemini` plans the query and `Tavily` retrieves recent market-moving articles
- `Extraction Agent`: `Gemini` converts articles into structured event facts, with keyword fallback when quota is tight
- `Reasoning Agent`: deterministic direct / propagation / macro scorers run first, and `Prometheux` is attempted as the rule engine when compute is available
- `Evaluation Agent`: `ClickHouse` provides cache/history/replay support before the final deterministic aggregator emits the signal

## What It Does

- scans a watchlist such as `mag7`, `semis`, `energy`, or `banks`
- produces `event_facts`, `propagation_facts`, `signal_outputs`, and `sector_alerts`
- emits explainable `long / short / neutral` ticker signals
- emits sector-level contagion alerts when multiple names are affected

## Setup

Put your keys in [`.env`](/Users/jc/coding/news2signal/.env):

```bash
TAVILY_API_KEY="tvly-..."
GEMINI_API_KEY="AIza..."
GEMINI_MODEL="gemini-3.5-flash"
ALPHA_VANTAGE_API_KEY=""
PMTX_TOKEN="eyJ..."
JARVISPY_URL="https://api.prometheux.ai/jarvispy/your-org/your-user"
```

Notes:

- `Tavily` is required for the main pipeline.
- `Gemini` is optional in practice because the pipeline falls back automatically.
- `Yahoo Finance` needs no key for the price snapshot endpoint used here.
- `Alpha Vantage` is optional utility data, not the main event-strategy source.
- `Prometheux` now uses the documented JarvisPy base URL shape.
- If `JARVISPY_URL` is blank or left as the root host, `probe_prometheux.py` can derive the correct `jarvispy/{org}/{user}` path from the JWT claims inside `PMTX_TOKEN`.
- `ClickHouse` sync works when the connection settings are present in `.env`.
- If `Prometheux` compute is not active, the reasoning agent falls back to local deterministic rules and records that backend choice.

## Main Run

Run on a preset watchlist:

```bash
cd /Users/jc/coding/news2signal
python3 event_strategy.py --watchlist semis --results 2
```

Run on custom symbols:

```bash
cd /Users/jc/coding/news2signal
python3 event_strategy.py TSM NVDA AMD --results 2
```

Print raw JSON summary:

```bash
cd /Users/jc/coding/news2signal
python3 event_strategy.py TSM NVDA AMD --results 2 --raw
```

Run and sync directly to ClickHouse:

```bash
cd /Users/jc/coding/news2signal
python3 event_strategy.py TSM NVDA AMD --results 2 --sync-clickhouse
```

## Smoke Tests

Component-level check:

```bash
cd /Users/jc/coding/news2signal
python3 smoke_test.py
```

Full small-universe test:

```bash
cd /Users/jc/coding/news2signal
python3 smoke_test.py --full
```

The smoke test verifies:

- Tavily key is present
- Gemini key is present
- Yahoo Finance returns a price snapshot
- Tavily returns search results
- Gemini works or gracefully reports quota exhaustion
- Prometheux returns the current platform role when `PMTX_TOKEN` is present
- the deterministic propagation graph works
- the full pipeline runs end-to-end

## Output Files

Each run writes a folder under:

[`runs/`](/Users/jc/coding/news2signal/runs)

with files such as:

- `articles_raw.jsonl`
- `event_facts.jsonl`
- `propagation_facts.jsonl`
- `signal_outputs.jsonl`
- `sector_alerts.jsonl`
- `evaluation_snapshots.jsonl`
- `agent_runs.jsonl`
- `summary.json`

Compatibility aliases are also written:

- `events_extracted.jsonl`
- `ticker_scores.jsonl`

## ClickHouse

The schema lives in:

[`clickhouse_schema.sql`](/Users/jc/coding/news2signal/clickhouse_schema.sql)

Main tables:

- `articles_raw`
- `event_facts`
- `propagation_facts`
- `signal_outputs`
- `sector_alerts`
- `evaluation_snapshots`
- `agent_runs`

Import shape is `JSONEachRow`, for example:

```bash
clickhouse-client --query="INSERT INTO signal_outputs FORMAT JSONEachRow" < runs/<run_id>/signal_outputs.jsonl
```

You can also sync a completed run with:

```bash
cd /Users/jc/coding/news2signal
python3 sync_clickhouse.py
```

or a specific run id:

```bash
cd /Users/jc/coding/news2signal
python3 sync_clickhouse.py 1d0d8e25b02b1ac9
```

## Strategy Logic

The active scoring stack is:

1. `Tavily` retrieves article candidates.
2. `article_filters.py` keeps higher-quality event pages and rejects quote/profile noise.
3. `Gemini` extracts facts with fields like:
   - `event_type`
   - `severity_score`
   - `sentiment_score`
   - `macro_theme`
   - `affected_sectors`
4. If Gemini is unavailable, keyword rules generate the same kind of facts.
5. `propagation_graph.py` maps upstream events into downstream ticker impacts.
6. The reasoning layer splits the score into:
   - direct impact
   - propagation impact
   - macro/theme impact
7. `ClickHouse` contributes:
   - cache hits for repeated article URLs
   - similar-event replay support
   - confidence adjustments
8. A deterministic aggregator emits:
   - final ticker signals
   - confidence / conviction
   - sector contagion alerts

## Prometheux Fit

The local deterministic rules remain the reliable fallback when Prometheux
compute is not active.

`Prometheux` is the natural upgrade for:

- event ontology
- article -> entity -> sector relationships
- dependency reasoning
- rule execution and traceability
- explanation paths from source event to final signal

The current build already attempts the platform Vadalog path first and records
the reasoning backend per run.

There is an illustrative rules file here:

[`prometheux_rules.vadalog`](/Users/jc/coding/news2signal/prometheux_rules.vadalog)

There is also a live platform probe here:

[`probe_prometheux.py`](/Users/jc/coding/news2signal/probe_prometheux.py)

## Utility Probes

Tavily:

```bash
cd /Users/jc/coding/news2signal
python3 search_tavily.py "Latest market-moving headlines for NVDA stock"
```

Gemini:

```bash
cd /Users/jc/coding/news2signal
python3 ask_gemini.py "Reply with exactly: GEMINI_OK"
```

Yahoo Finance:

```bash
cd /Users/jc/coding/news2signal
python3 probe_yahoo_finance.py NVDA
```

Alpha Vantage:

```bash
cd /Users/jc/coding/news2signal
python3 probe_alpha_vantage.py QQQ
```

Prometheux:

```bash
cd /Users/jc/coding/news2signal
python3 probe_prometheux.py
```
