CREATE TABLE IF NOT EXISTS etf_probe_runs
(
    ts DateTime DEFAULT now(),
    topic String,
    tavily_query String,
    tavily_answer String,
    gemini_brief String,
    result_count UInt16,
    raw_tavily_json String
)
ENGINE = MergeTree
ORDER BY (ts, topic);


CREATE TABLE IF NOT EXISTS etf_probe_results
(
    ts DateTime DEFAULT now(),
    topic String,
    rank UInt8,
    title String,
    url String,
    domain String,
    score Float64,
    snippet String
)
ENGINE = MergeTree
ORDER BY (topic, rank, ts);
