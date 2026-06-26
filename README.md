# Tavily Mini ETF Probe

Tiny CLI to test whether Tavily alone can answer ETF/QIS-style questions well
enough for a hackathon MVP.

## What it does

- Calls Tavily Search directly over HTTP
- Calls Gemini directly over REST
- Calls Yahoo Finance's public chart endpoint for no-key price snapshots
- Calls Alpha Vantage for ETF holdings, sectors, and fallback price data
- Uses the `finance` topic by default
- Prints Tavily's answer plus the top result snippets
- Can tighten broad Tavily output into a short ETF brief

## Setup

1. Get a Tavily API key from [Tavily](https://app.tavily.com/).
2. Get a Gemini API key from Google AI Studio.
   The hackathon doc says to log into the temporary account, import the project
   if needed, then open AI Studio API keys and copy or create the key.
3. Put both keys in [`.env`](/Users/jc/coding/tavily-mini-etf/.env):

```bash
TAVILY_API_KEY="tvly-..."
GEMINI_API_KEY="AIza..."
GEMINI_MODEL="gemini-3.5-flash"
ALPHA_VANTAGE_API_KEY=""
```

Alternative: export it in your shell:

```bash
export TAVILY_API_KEY="tvly-..."
export GEMINI_API_KEY="AIza..."
export ALPHA_VANTAGE_API_KEY="..."
```

## Run

Default ETF-themed query:

```bash
python3 search_tavily.py
```

Custom query:

```bash
python3 search_tavily.py "What are the latest disclosed top holdings of QQQ and SPY?"
```

Raw JSON:

```bash
python3 search_tavily.py --raw "Why did QQQ move this week?"
```

Gemini-only sanity check:

```bash
python3 ask_gemini.py "Explain why concentration risk matters in QQQ."
```

Tiny Tavily -> Gemini ETF brief:

```bash
python3 etf_brief.py "QQQ and SPY"
```

Yahoo Finance price snapshot:

```bash
python3 probe_yahoo_finance.py QQQ
```

Alpha Vantage ETF profile:

```bash
python3 probe_alpha_vantage.py QQQ
```

Alpha Vantage daily prices:

```bash
python3 probe_alpha_vantage.py --daily IBM
```

## Simplest API Shape

If you want to sanity-check Tavily without the Python wrapper, the core request is:

```bash
curl -sS https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "tvly-...",
    "query": "What are the top holdings of QQQ?",
    "topic": "finance",
    "search_depth": "basic",
    "max_results": 3,
    "include_answer": true
  }'
```

The current official Gemini docs use the `generateContent` endpoint with an
`x-goog-api-key` header. The minimal shape is:

```bash
curl --fail-with-body -sS \
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent' \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {"text": "Explain why concentration risk matters in QQQ."}
        ]
      }
    ]
  }'
```

Yahoo Finance in this project uses the public chart endpoint, which currently
works without an API key when called with browser-style headers:

```bash
curl -sS \
  'https://query2.finance.yahoo.com/v8/finance/chart/QQQ?range=5d&interval=1d' \
  -H 'User-Agent: Mozilla/5.0' \
  -H 'Accept: application/json'
```

Alpha Vantage uses its official `ETF_PROFILE` endpoint for ETF holdings and
sector weights. The docs currently show a working `demo` example for `QQQ`, so
you can test the project without your own key for that narrow case:

```bash
curl -sS \
  'https://www.alphavantage.co/query?function=ETF_PROFILE&symbol=QQQ&apikey=demo'
```

For broader or repeated usage, add your own `ALPHA_VANTAGE_API_KEY`.

## ClickHouse Cloud

Best tiny use: treat ClickHouse as a fast cache and analytics layer for this
demo, not as a full market-data platform.

In 5 hours, the best sponsor-friendly use is:

- store each Tavily/Gemini run
- store each returned search result as its own row
- query which ETFs, domains, and concentration themes show up most often

The starter schema is in [clickhouse_schema.sql](/Users/jc/coding/tavily-mini-etf/clickhouse_schema.sql).

Why this is a good fit:

- ClickHouse Cloud is positioned by ClickHouse as a fully managed way to build
  real-time analytics and AI-powered data apps
- the Cloud page highlights the SQL console, import wizard, and ClickPipes, so
  it is well-suited to quick demo analytics rather than heavy infra work

For this project, I would not spend hackathon time building a deep ingestion
stack unless the rest is already working.

## Why this exists

Before we touch any non-sponsor market-data API, this lets us answer one question
fast:

`Can Tavily alone get us enough ETF explanation data for a tiny demo?`

If the answer is "not really", then the smallest upgrade path is:

- keep Tavily for sponsor-aligned retrieval
- use Gemini to compress and structure the answer
- use Yahoo Finance for no-key price context
- use Alpha Vantage for ETF holdings and sector structure
