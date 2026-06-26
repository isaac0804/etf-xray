import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

const rootEnv = path.join(process.cwd(), "..", ".env.local");
if (fs.existsSync(rootEnv)) {
  fs.readFileSync(rootEnv, "utf8").split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

// Allowed range/interval combos
const RANGE_INTERVAL: Record<string, string> = {
  "5d":  "1d",
  "1mo": "1d",
  "3mo": "1d",
  "6mo": "1wk",
  "1y":  "1wk",
  "2y":  "1mo",
};

export async function GET(req: NextRequest) {
  const symbol   = req.nextUrl.searchParams.get("symbol") ?? "QQQ";
  const range    = req.nextUrl.searchParams.get("range") ?? "5d";
  const interval = RANGE_INTERVAL[range] ?? "1d";

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return NextResponse.json({ error: "No data" }, { status: 404 });

    const meta       = result.meta ?? {};
    const closes: number[]     = result.indicators?.quote?.[0]?.close ?? [];
    const timestamps: number[] = result.timestamp ?? [];

    return NextResponse.json({
      symbol,
      range,
      currency: meta.currency,
      price:    meta.regularMarketPrice,
      prev_close: meta.chartPreviousClose,
      change_pct: meta.chartPreviousClose
        ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2)
        : null,
      series: timestamps.map((t, i) => ({
        date:  new Date(t * 1000).toISOString().slice(0, 10),
        close: closes[i] ?? null,
      })).filter((p) => p.close !== null),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
