# News2Signal

Tiny event-driven signal engine for a hackathon build.

It uses:

- `Tavily` to retrieve recent market-moving news
- `Gemini` to extract structured events when a key is available
- deterministic Python rules as a fallback extractor and scorer
- `Yahoo Finance` for quick no-key price snapshots
- `ClickHouse` as the storage/analytics layer via JSONEachRow-ready outputs

## What it does

- scans a watchlist such as `mag7`, `semis`, `energy`, or `banks`
- retrieves recent articles for each symbol
- extracts event types like `earnings_miss`, `guidance_cut`, or `regulatory_probe`
- scores each symbol into `long`, `short`, or `neutral`
- writes run outputs to local JSONL files ready for ClickHouse import

## Setup

Put your keys in [`.env`](/Users/jc/coding/news2signal/.env):

```bash
TAVILY_API_KEY="tvly-..."
GEMINI_API_KEY="AIza..."
GEMINI_MODEL="gemini-3.5-flash"
ALPHA_VANTAGE_API_KEY=""
```

Notes:

- `Tavily` is required for the main pipeline.
- `Gemini` is optional. If missing, the engine falls back to deterministic keyword rules.
- `Yahoo Finance` needs no key for the chart endpoint used here.
- `Alpha Vantage` is optional utility data, not critical path for the event strategy.

## Main Run

Run the generic event strategy on a preset watchlist:

```bash
python3 event_strategy.py --watchlist mag7
```

Run it on custom symbols:

```bash
python3 event_strategy.py NVDA AMD AVGO
```

Limit Tavily results per symbol:

```bash
python3 event_strategy.py --watchlist semis --results 3
```

Print raw JSON summary:

```bash
python3 event_strategy.py --watchlist mag7 --raw
```

Run a one-command smoke test:

```bash
python3 smoke_test.py
```

Run the smoke test plus a full one-symbol pipeline:

```bash
python3 smoke_test.py --full
```

## Output

Each run writes files under:

[`runs/`](/Users/jc/coding/news2signal/runs)

with a random run id, including:

- `articles_raw.jsonl`
- `events_extracted.jsonl`
- `ticker_scores.jsonl`
- `summary.json`

These files are already shaped for easy ClickHouse ingestion.

## ClickHouse

Create the tables with:

[`clickhouse_schema.sql`](/Users/jc/coding/news2signal/clickhouse_schema.sql)

Then import each run file with `JSONEachRow`, for example:

```sql
INSERT INTO articles_raw FORMAT JSONEachRow
```

```sql
INSERT INTO events_extracted FORMAT JSONEachRow
```

```sql
INSERT INTO ticker_scores FORMAT JSONEachRow
```

If you use `clickhouse-client`, the shell pattern is typically:

```bash
clickhouse-client --query="INSERT INTO ticker_scores FORMAT JSONEachRow" < runs/<run_id>/ticker_scores.jsonl
```

## Preset Watchlists

- `mag7`
- `semis`
- `energy`
- `banks`
- `indices`

The preset definitions live in [watchlists.py](/Users/jc/coding/news2signal/watchlists.py).

## Strategy Logic

The pipeline is intentionally simple and explainable:

1. `Tavily` retrieves recent articles per symbol.
2. `Gemini` extracts structured events into strict JSON when available.
3. If Gemini is unavailable, deterministic keyword rules classify the headlines.
4. Each event gets a score:

```text
score =
direction
* event_type_multiplier
* severity
* relevance
* confidence
* source_score
```

5. Symbol scores are summed and turned into:

- `long` if score >= `0.75`
- `short` if score <= `-0.75`
- `neutral` otherwise

## Prometheux Fit

This repo currently implements the deterministic layer in plain Python because
that is the fastest path in a hackathon.

`Prometheux` would be the natural upgrade for:

- event taxonomy and ontology
- article -> company -> sector relationships
- deduplication of repeated stories
- rule enforcement such as confidence thresholds
- traceability from final signal back to source article and rule

In other words:

- `Gemini` says what likely happened
- `Prometheux` would formalize what that means
- `ClickHouse` stores the event stream and signals

## Utility Probes

Tavily:

```bash
python3 search_tavily.py "Latest market-moving headlines for NVDA stock"
```

Gemini:

```bash
python3 ask_gemini.py "Is recent NVDA news flow bullish or bearish?"
```

Yahoo Finance:

```bash
python3 probe_yahoo_finance.py NVDA
```

Alpha Vantage:

```bash
python3 probe_alpha_vantage.py QQQ
```
