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
    macro_score Float64 DEFAULT 0,
    direction_score Float64 DEFAULT 0,
    total_score Float64,
    signal_strength Float64,
    conviction Float64,
    agent_confidence Float64 DEFAULT 0,
    historical_support Float64 DEFAULT 0.5,
    price_change_pct Nullable(Float64),
    session_move_pct Nullable(Float64),
    price_confirmation String,
    event_count UInt16,
    propagation_count UInt16,
    source_diversity UInt8,
    dominant_event_type String,
    dominant_theme String DEFAULT 'other',
    rules_fired Array(String),
    top_driver_titles Array(String),
    reasoning_backend String DEFAULT '',
    evaluation_backend String DEFAULT '',
    cache_hit_count UInt16 DEFAULT 0,
    similar_event_count UInt32 DEFAULT 0,
    evaluation_summary String DEFAULT '',
    signal_horizon String DEFAULT 'short_term',
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
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS macro_score Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS direction_score Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS agent_confidence Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS historical_support Float64;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS dominant_theme String;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS reasoning_backend String;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS evaluation_backend String;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS cache_hit_count UInt16;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS similar_event_count UInt32;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS evaluation_summary String;
ALTER TABLE signal_outputs ADD COLUMN IF NOT EXISTS signal_horizon String;


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


CREATE TABLE IF NOT EXISTS evaluation_snapshots
(
    run_id String,
    watchlist String,
    symbol String,
    ingested_at DateTime DEFAULT now(),
    similar_event_count UInt32,
    cache_hit_count UInt16,
    avg_past_total_score Nullable(Float64),
    historical_support Float64,
    confidence_adjustment Float64,
    supporting_event_types Array(String),
    summary String,
    backend String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, ingested_at);


CREATE TABLE IF NOT EXISTS agent_runs
(
    run_id String,
    watchlist String,
    symbol String,
    agent_name String,
    stage_index UInt8,
    ingested_at DateTime DEFAULT now(),
    status String,
    backend String,
    payload_json String,
    notes String
)
ENGINE = MergeTree
ORDER BY (run_id, symbol, stage_index, ingested_at);
