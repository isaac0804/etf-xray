import { createClient, type ClickHouseClient } from "@clickhouse/client";

const DB = process.env.CLICKHOUSE_DATABASE ?? "etf_xray";

let _client: ClickHouseClient | null = null;

function getClient(): ClickHouseClient {
  if (_client) return _client;
  const host   = process.env.CLICKHOUSE_HOST ?? "localhost";
  const port   = parseInt(process.env.CLICKHOUSE_PORT ?? "8123");
  const proto  = port === 8443 || port === 8444 ? "https" : "http";
  _client = createClient({
    url:      `${proto}://${host}:${port}`,
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    // No database: connect to default; queries use fully-qualified names
    // so the client works before etf_xray DB is created by the first Python scan
    request_timeout: 5000,
  });
  return _client;
}

export interface CachedSignal {
  symbol: string;
  name: string;
  sector: string;
  region: string;
  signal: string;
  risk_level: string;
  total_score: number;
  direct_score: number;
  propagated_score: number;
  price_change_pct: number | null;
  event_count: number;
  propagation_count: number;
  strongest_event_type: string;
  top_driver_titles: string[];
  top_driver_urls: string[];
  explanation: string;
  rules_fired: string[];
  run_id: string;
}

/** Returns fresh signals (< maxAgeSecs) for all requested symbols, or null if any is missing. */
export async function queryFreshSignals(
  symbols: string[],
  maxAgeSecs = 1800,
): Promise<CachedSignal[] | null> {
  if (!symbols.length) return null;
  const client = getClient();

  // Safe: symbols are always uppercase alphanumeric
  const inList = symbols.map((s) => `'${s.replace(/[^A-Z0-9.]/g, "")}'`).join(", ");

  try {
    const rs = await client.query({
      query: `
        SELECT
          symbol, name, sector, region, signal, risk_level,
          total_score, direct_score, propagated_score, price_change_pct,
          event_count, propagation_count, strongest_event_type,
          top_driver_titles, top_driver_urls, explanation, rules_fired, run_id
        FROM ${DB}.signal_cache FINAL
        WHERE symbol IN (${inList})
          AND run_ts > now() - INTERVAL ${maxAgeSecs} SECOND
        ORDER BY symbol
      `,
      format: "JSONEachRow",
    });

    const rows = await rs.json<CachedSignal>();
    if (rows.length < symbols.length) return null; // some symbols missing
    return rows;
  } catch {
    return null; // ClickHouse unavailable — fall through to live scan
  }
}
