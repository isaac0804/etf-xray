CREATE TABLE IF NOT EXISTS articles_raw
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    tavily_query String,
    tavily_answer String,
    title String,
    url String,
    domain String,
    rank UInt8,
    source_score Float64,
    snippet String,
    raw_json String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, rank, ingested_at);


CREATE TABLE IF NOT EXISTS events_extracted
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    article_title String,
    source_url String,
    event_type String,
    direction Int8,
    severity Float64,
    relevance Float64,
    confidence Float64,
    horizon String,
    source_score Float64,
    event_score Float64,
    rationale String,
    extractor String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, event_type, ingested_at);


CREATE TABLE IF NOT EXISTS ticker_scores
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    name String,
    signal String,
    total_score Float64,
    price_change_pct Nullable(Float64),
    event_count UInt16,
    strongest_event_type String,
    strongest_event_score Float64,
    explanation String,
    top_driver_titles Array(String)
)
ENGINE = MergeTree
ORDER BY (run_id, total_score, symbol, ingested_at);
