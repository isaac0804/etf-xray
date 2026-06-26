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
    quality_score Float64,
    kept Bool,
    filter_reason String,
    snippet String,
    raw_json String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, rank, ingested_at);


CREATE TABLE IF NOT EXISTS event_facts
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    article_title String,
    source_url String,
    entity_name String,
    event_type String,
    severity_label String,
    severity_score Float64,
    confidence Float64,
    sentiment_score Float64,
    direction String,
    time_horizon String,
    macro_theme String,
    region String,
    affected_sectors Array(String),
    source_score Float64,
    quality_score Float64,
    base_event_score Float64,
    summary String,
    extractor String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, event_type, ingested_at);


CREATE TABLE IF NOT EXISTS propagation_facts
(
    run_id String,
    watchlist String,
    source_symbol String,
    target_symbol String,
    ingested_at DateTime DEFAULT now(),
    event_type String,
    macro_theme String,
    impact_direction String,
    impact_score Float64,
    relationship String,
    edge_strength Float64,
    source_url String,
    article_title String,
    target_sector String,
    target_region String,
    reason String
)
ENGINE = MergeTree
ORDER BY (run_id, source_symbol, target_symbol, ingested_at);


CREATE TABLE IF NOT EXISTS signal_outputs
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    name String,
    sector String,
    region String,
    signal String,
    risk_level String,
    direct_score Float64,
    propagated_score Float64,
    total_score Float64,
    signal_strength Float64,
    conviction Float64,
    price_change_pct Nullable(Float64),
    session_move_pct Nullable(Float64),
    price_confirmation String,
    event_count UInt16,
    propagation_count UInt16,
    source_diversity UInt8,
    dominant_event_type String,
    rules_fired Array(String),
    top_driver_titles Array(String),
    explanation String
)
ENGINE = MergeTree
ORDER BY (run_id, total_score, symbol, ingested_at);

ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS signal_strength Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS conviction Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS session_move_pct Nullable(Float64);
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS price_confirmation String;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS source_diversity UInt8;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS dominant_event_type String;


CREATE TABLE IF NOT EXISTS sector_alerts
(
    run_id String,
    watchlist String,
    sector String,
    ingested_at DateTime DEFAULT now(),
    macro_theme String,
    score Float64,
    alert_level String,
    affected_symbols Array(String),
    driver_event_types Array(String),
    explanation String
)
ENGINE = MergeTree
ORDER BY (run_id, sector, score, ingested_at);
