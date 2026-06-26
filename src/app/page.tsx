"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PriceData {
  price: number;
  change_pct: string;
  series: { close: number }[];
}

interface TickerScore {
  symbol: string;
  name: string;
  sector?: string;
  region?: string;
  signal: "long" | "short" | "neutral";
  risk_level?: string;
  total_score: number;
  direct_score?: number;
  propagated_score?: number;
  price_change_pct: number | null;
  event_count: number;
  propagation_count?: number;
  strongest_event_type?: string;
  rules_fired?: string[];
  top_driver_titles: string[];
  top_driver_urls?: string[];
  explanation: string;
  from_cache?: boolean;
  run_id?: string;
}

interface LogEntry {
  id: number;
  step: string;
  message?: string;
  ts?: string;
}

// ── Event-centric types ───────────────────────────────────────────────────────

interface EventFact {
  symbol: string;
  event_type: string;
  macro_theme: string;
  direction: "up" | "down" | "neutral";
  severity_label: "low" | "medium" | "high";
  severity_score: number;
  confidence: number;
  sentiment_score: number;
  base_event_score: number;
  article_title: string;
  source_url: string;
  summary: string;
  time_horizon: string;
  region: string;
  extractor: string;
  run_id?: string;
}

interface PropagationFact {
  source_symbol: string;
  target_symbol: string;
  event_type: string;
  macro_theme: string;
  impact_direction: "up" | "down" | "neutral";
  impact_score: number;
  relationship: string;
  edge_strength: number;
  article_title: string;
  source_url: string;
  run_id?: string;
}

interface EventGroup {
  event_type: string;
  macro_theme: string;
  direction: "up" | "down" | "neutral" | "mixed";
  direct_tickers: { symbol: string; base_event_score: number; severity_label: string }[];
  propagated_tickers: { symbol: string; target_symbol: string; impact_score: number; relationship: string; source_symbol: string }[];
  facts: EventFact[];
  total_impact: number;
  max_severity: "low" | "medium" | "high";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRESETS: Record<string, string[]> = {
  mag7:    ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"],
  semis:   ["NVDA", "AMD", "AVGO", "QCOM", "MU", "TSM", "INTC"],
  energy:  ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX"],
  banks:   ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW"],
  indices: ["SPY", "QQQ", "IWM", "SMH", "XLK", "LIT", "GLD"],
};

// Ticker → company domain for Clearbit logo lookup
const TICKER_DOMAIN: Record<string, string> = {
  // Mag 7
  AAPL:  "apple.com",
  MSFT:  "microsoft.com",
  NVDA:  "nvidia.com",
  AMZN:  "amazon.com",
  META:  "meta.com",
  GOOGL: "google.com",
  TSLA:  "tesla.com",
  // Semis
  AMD:   "amd.com",
  AVGO:  "broadcom.com",
  QCOM:  "qualcomm.com",
  MU:    "micron.com",
  TSM:   "tsmc.com",
  INTC:  "intel.com",
  ASML:  "asml.com",
  AMAT:  "appliedmaterials.com",
  // Energy
  XOM:   "exxonmobil.com",
  CVX:   "chevron.com",
  COP:   "conocophillips.com",
  SLB:   "slb.com",
  EOG:   "eogresources.com",
  MPC:   "marathonpetroleum.com",
  PSX:   "phillips66.com",
  // Banks
  JPM:   "jpmorganchase.com",
  BAC:   "bankofamerica.com",
  WFC:   "wellsfargo.com",
  C:     "citi.com",
  GS:    "goldmansachs.com",
  MS:    "morganstanley.com",
  SCHW:  "schwab.com",
  // Indices / ETFs — use issuer domains
  SPY:   "ssga.com",
  QQQ:   "invesco.com",
  IWM:   "ishares.com",
  SMH:   "vaneck.com",
  XLK:   "ssga.com",
  LIT:   "globalxetfs.com",
  GLD:   "ssga.com",
};

// Signal colors — these stay the same in both themes (semantic green/red)
const SIG = {
  long:    { fg: "#26a69a", bg: "rgba(38,166,154,0.10)", border: "rgba(38,166,154,0.30)" },
  short:   { fg: "#ef5350", bg: "rgba(239,83,80,0.10)",  border: "rgba(239,83,80,0.30)"  },
  neutral: { fg: "var(--fg-muted)", bg: "transparent",   border: "var(--border-strong)"  },
};

const RISK_COLOR: Record<string, string> = {
  HIGH: "#ef5350", HIGH_POSITIVE: "#26a69a",
  MEDIUM: "#f59e0b", MEDIUM_POSITIVE: "#7dd3a8",
};

const EVENT_LABEL: Record<string, string> = {
  regulatory_probe:  "Regulatory probe",
  earnings_miss:     "Earnings miss",
  earnings_beat:     "Earnings beat",
  supply_disruption: "Supply disruption",
  guidance_raise:    "Guidance raise",
  guidance_cut:      "Guidance cut",
  analyst_upgrade:   "Analyst upgrade",
  analyst_downgrade: "Analyst downgrade",
  mna:               "M&A",
  product_launch:    "Product launch",
  macro_theme:       "Macro headwinds",
  partnership:       "Partnership",
  capex:             "Capex signal",
  demand_signal:     "Demand signal",
  other:             "Market event",
};
const fmtEvent = (t?: string) =>
  t ? (EVENT_LABEL[t] ?? t.replace(/_/g, " ")) : "—";

// Semantic direction / theme colors — same hex in both themes (they are signal colors)
const DIR_COLOR: Record<string, string> = {
  up: "#26a69a", down: "#ef5350", neutral: "var(--fg-muted)", mixed: "#f59e0b",
};
const THEME_COLOR: Record<string, string> = {
  geopolitical_risk: "#ef5350", supply_chain: "#f59e0b", earnings: "#26a69a",
  sell_side: "#818cf8", innovation: "#34d399", regulation: "#ef5350",
  strategic_activity: "#7dd3a8", demand: "#60a5fa", other: "var(--fg-muted)",
};

// ── Ticker logo ───────────────────────────────────────────────────────────────

// Stable hue per ticker so the fallback initial always has the same color
function tickerHue(sym: string): number {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % 360;
  return h;
}

function TickerLogo({ symbol, size = 24 }: { symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const domain = TICKER_DOMAIN[symbol];
  // Google's S2 favicon service — reliable, free, no key, returns real logos at 64px
  const src = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    : null;
  const hue = tickerHue(symbol);

  useEffect(() => { setFailed(false); }, [symbol]);

  const fallback = (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `hsl(${hue},45%,28%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.round(size * 0.42), fontWeight: 700, color: `hsl(${hue},60%,75%)`,
      userSelect: "none",
    }}>
      {symbol[0]}
    </div>
  );

  if (!src || failed) return fallback;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={symbol}
      width={size}
      height={size}
      style={{ borderRadius: "50%", flexShrink: 0, objectFit: "contain",
               background: "var(--bg-panel)", display: "block" }}
      onError={() => setFailed(true)}
    />
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ series, color, w = 60, h = 20 }: {
  series: { close: number }[]; color: string; w?: number; h?: number;
}) {
  const vals = series.map((s) => s.close).filter(Boolean);
  if (vals.length < 2) return <div style={{ width: w, height: h }} />;
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
  const pts = vals
    .map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / range) * (h - 3) - 1.5}`)
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── Watchlist row ─────────────────────────────────────────────────────────────

function WatchlistRow({ symbol }: { symbol: string }) {
  const [data, setData] = useState<PriceData | null>(null);
  useEffect(() => {
    fetch(`/api/price?symbol=${symbol}`).then((r) => r.json()).then(setData).catch(() => null);
  }, [symbol]);
  const pct = data ? parseFloat(data.change_pct ?? "0") : 0;
  const up  = pct >= 0;
  const color = up ? "#26a69a" : "#ef5350";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
      borderRadius: 10,
      background: "var(--glass-2)",
      border: "1px solid var(--glass-border)",
      transition: "background 0.15s, box-shadow 0.15s",
    }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--glass-3)";
        e.currentTarget.style.boxShadow = "var(--glass-shadow)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--glass-2)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <TickerLogo symbol={symbol} size={26} />
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {symbol}
        </div>
        <div style={{ fontSize: 10, fontFamily: "monospace", color: "var(--fg-watchlist-price)", marginTop: 1 }}>
          {data ? `$${data.price.toFixed(2)}` : "—"}
        </div>
      </div>
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        {data
          ? <Sparkline series={data.series} color={color} w={52} h={18} />
          : <div style={{ width: 52, height: 18 }} />
        }
        {data ? (
          <span style={{ fontSize: 10, fontWeight: 600, fontFamily: "monospace", color, lineHeight: 1 }}>
            {up ? "+" : ""}{pct.toFixed(2)}%
          </span>
        ) : (
          <span style={{ fontSize: 10, color: "var(--fg-watchlist-dash)" }}>—</span>
        )}
      </div>
    </div>
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score, signal, riskLevel }: { score: number; signal: string; riskLevel?: string }) {
  const pct = Math.min((Math.abs(score) / 1.2) * 100, 100);
  const { fg } = SIG[signal as keyof typeof SIG] ?? SIG.neutral;
  const riskColor = riskLevel ? RISK_COLOR[riskLevel] : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <div style={{ width: 52, height: 3, background: "var(--fg-score-bar-track)", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: fg, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: "monospace", color: fg, minWidth: 52 }}>
        {score > 0 ? "+" : ""}{score.toFixed(3)}
      </span>
      {riskColor && riskLevel !== "LOW" && (
        <span style={{ fontSize: 9, fontWeight: 700, color: riskColor, letterSpacing: "0.06em" }}>
          {riskLevel?.replace("_POSITIVE", "+") ?? ""}
        </span>
      )}
    </div>
  );
}

// ── Price chart (fetches on demand, SVG area + crosshair) ─────────────────────

type ChartRange = "1mo" | "3mo" | "6mo" | "1y";

interface ChartPoint { date: string; close: number }
interface ChartData  { series: ChartPoint[]; price: number; change_pct: string | null }

function PriceChart({ symbol, color }: { symbol: string; color: string }) {
  const [range, setRange]   = useState<ChartRange>("3mo");
  const [data, setData]     = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover]   = useState<{ x: number; y: number; point: ChartPoint } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetch(`/api/price?symbol=${symbol}&range=${range}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [symbol, range]);

  const W = 520, H = 140, PL = 52, PR = 12, PT = 12, PB = 28;
  const IW = W - PL - PR, IH = H - PT - PB;

  const points = data?.series?.filter((p) => p.close) ?? [];

  // Compute scale
  const closes = points.map((p) => p.close);
  const minV   = closes.length ? Math.min(...closes) : 0;
  const maxV   = closes.length ? Math.max(...closes) : 1;
  const padV   = (maxV - minV) * 0.08 || 1;
  const lo = minV - padV, hi = maxV + padV;

  const cx = (i: number) => PL + (i / Math.max(points.length - 1, 1)) * IW;
  const cy = (v: number) => PT + IH - ((v - lo) / (hi - lo)) * IH;

  const polyline = points.map((p, i) => `${cx(i)},${cy(p.close)}`).join(" ");
  const area = points.length
    ? `M${cx(0)},${cy(points[0].close)} ` +
      points.slice(1).map((p, i) => `L${cx(i + 1)},${cy(p.close)}`).join(" ") +
      ` L${cx(points.length - 1)},${PT + IH} L${cx(0)},${PT + IH} Z`
    : "";

  // Y-axis ticks
  const yTicks = 4;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    lo + ((hi - lo) * i) / yTicks
  );

  // X-axis labels (first and last, plus a couple in between)
  const xLabelIdxs = points.length > 1
    ? [0, Math.floor(points.length / 3), Math.floor((2 * points.length) / 3), points.length - 1]
        .filter((v, i, a) => a.indexOf(v) === i)
    : [];

  const isUp = (data?.change_pct ? parseFloat(data.change_pct) : 0) >= 0;

  // Mouse move handler for crosshair
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!points.length || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    // Find nearest point
    const idx  = Math.max(0, Math.min(points.length - 1, Math.round((mx - PL) / IW * (points.length - 1))));
    const pt   = points[idx];
    setHover({ x: cx(idx), y: cy(pt.close), point: pt });
  };

  return (
    <div style={{ padding: "16px 0 4px" }} onClick={(e) => e.stopPropagation()}>

      {/* Range selector */}
      <div style={{ display: "flex", gap: 2, marginBottom: 10, paddingLeft: PL }}>
        {(["1mo", "3mo", "6mo", "1y"] as ChartRange[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} style={{
            fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 3,
            border: "none", cursor: "pointer",
            background: range === r ? color + "22" : "transparent",
            color: range === r ? color : "var(--fg-muted)",
            transition: "all 0.1s",
          }}>
            {r}
          </button>
        ))}
        {hover && (
          <span style={{ marginLeft: "auto", marginRight: PR, fontSize: 11, fontFamily: "monospace", color: "var(--fg)" }}>
            {hover.point.date} &nbsp;
            <strong style={{ color }}>${hover.point.close.toFixed(2)}</strong>
          </span>
        )}
      </div>

      {/* SVG chart */}
      {loading ? (
        <div style={{ width: W, height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Loading…</span>
        </div>
      ) : points.length < 2 ? (
        <div style={{ width: W, height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>No data</span>
        </div>
      ) : (
        <svg
          ref={svgRef}
          width={W} height={H}
          style={{ display: "block", overflow: "visible", cursor: "crosshair" }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* Grid lines */}
          {yTickVals.map((v, i) => (
            <line key={i}
              x1={PL} x2={PL + IW} y1={cy(v)} y2={cy(v)}
              stroke="var(--border)" strokeWidth="1" />
          ))}

          {/* Area fill */}
          <defs>
            <linearGradient id={`grad-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0.01" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#grad-${symbol})`} />

          {/* Line */}
          <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />

          {/* Y-axis labels */}
          {yTickVals.map((v, i) => (
            <text key={i}
              x={PL - 6} y={cy(v) + 3.5}
              textAnchor="end" fontSize="9" fill="var(--fg-muted)" fontFamily="monospace">
              {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}
            </text>
          ))}

          {/* X-axis labels */}
          {xLabelIdxs.map((idx) => (
            <text key={idx}
              x={cx(idx)} y={H - 6}
              textAnchor="middle" fontSize="9" fill="var(--fg-muted)" fontFamily="monospace">
              {points[idx].date.slice(5)}
            </text>
          ))}

          {/* Baseline */}
          <line x1={PL} x2={PL + IW} y1={PT + IH} y2={PT + IH}
            stroke="var(--border-strong)" strokeWidth="1" />
          <line x1={PL} x2={PL} y1={PT} y2={PT + IH}
            stroke="var(--border-strong)" strokeWidth="1" />

          {/* Crosshair */}
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={PT} y2={PT + IH}
                stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <line x1={PL} x2={PL + IW} y1={hover.y} y2={hover.y}
                stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
              <circle cx={hover.x} cy={hover.y} r="3.5" fill={color} stroke="var(--bg)" strokeWidth="1.5" />
            </>
          )}
        </svg>
      )}
    </div>
  );
}

// ── Signal row (expandable) ───────────────────────────────────────────────────

function SignalRow({ score, rank }: { score: TickerScore; rank: number }) {
  const [open, setOpen] = useState(false);
  const { fg, bg, border } = SIG[score.signal];
  const pct = score.price_change_pct;
  const pctColor = pct != null ? (pct >= 0 ? "#26a69a" : "#ef5350") : "var(--fg-muted)";
  const hasProp  = (score.propagation_count ?? 0) > 0;
  const chartColor = score.signal === "long" ? "#26a69a" : score.signal === "short" ? "#ef5350" : "#829cff";

  return (
    <div className={`card-in glass-card${open ? " glass-card-open" : ""}`}
      style={{ borderRadius: 14 }}
    >
      {/* ── Collapsed row ── */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
          cursor: "pointer",
        }}
      >
        {/* Rank */}
        <span style={{ fontSize: 10, color: "var(--fg-rank)", width: 20, flexShrink: 0, fontFamily: "monospace", textAlign: "center" }}>
          {rank}
        </span>

        {/* Logo + symbol */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: 170, flexShrink: 0 }}>
          <TickerLogo symbol={score.symbol} size={32} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", letterSpacing: "0.01em" }}>
              {score.symbol}
              {score.from_cache && (
                <span style={{ marginLeft: 6, fontSize: 9, color: "var(--fg-cached-tag)", fontWeight: 400, fontFamily: "monospace" }}>cached</span>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-name)", marginTop: 1, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {score.name || score.symbol}
            </div>
          </div>
        </div>

        {/* Signal badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em",
          padding: "4px 0", borderRadius: 20, textAlign: "center",
          width: 64, flexShrink: 0,
          color: fg, background: bg, border: `1px solid ${border}`,
        }}>
          {score.signal}
        </span>

        {/* Score bar */}
        <div style={{ flex: 1 }}>
          <ScoreBar score={score.total_score} signal={score.signal} riskLevel={score.risk_level} />
        </div>

        {/* Δ Today */}
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: 68 }}>
          <span style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 700, color: pctColor }}>
            {pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
          </span>
          {hasProp && (
            <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 2 }}>contagion</div>
          )}
        </div>

        {/* Expand chevron */}
        <span style={{ fontSize: 10, color: "var(--fg-muted)", flexShrink: 0, marginLeft: 4 }}>
          {open ? "▲" : "▼"}
        </span>
      </div>

      {/* ── Expanded panel ── */}
      {open && (
        <div style={{
          borderTop: "1px solid var(--glass-border)",
          padding: "4px 20px 20px",
        }}>
          <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>

            {/* Left: chart */}
            <div style={{ flexShrink: 0 }}>
              <PriceChart symbol={score.symbol} color={chartColor} />
            </div>

            {/* Right: info panel */}
            <div style={{ flex: 1, minWidth: 0, paddingTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Stats grid */}
              <div style={{ display: "flex", gap: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--glass-border)" }}>
                {[
                  { label: "Signal",    value: score.signal.toUpperCase(), color: fg },
                  { label: "Score",     value: `${score.total_score > 0 ? "+" : ""}${score.total_score.toFixed(3)}`, color: fg },
                  { label: "Direct",    value: `${(score.direct_score ?? 0) >= 0 ? "+" : ""}${(score.direct_score ?? 0).toFixed(3)}`, color: fg },
                  { label: "Contagion", value: hasProp ? `${(score.propagated_score ?? 0) >= 0 ? "+" : ""}${(score.propagated_score ?? 0).toFixed(3)}` : "—", color: hasProp ? "#f59e0b" : "var(--fg-muted)" },
                  { label: "Events",    value: String(score.event_count), color: "var(--fg)" },
                  { label: "Risk",      value: score.risk_level?.replace("_POSITIVE", "+") ?? "LOW", color: score.risk_level ? (RISK_COLOR[score.risk_level] ?? "var(--fg-muted)") : "var(--fg-muted)" },
                ].map((stat, i, arr) => (
                  <div key={stat.label} style={{
                    flex: 1, padding: "10px 12px",
                    borderRight: i < arr.length - 1 ? "1px solid var(--glass-border)" : "none",
                    background: "var(--glass-1)",
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--fg-muted)", marginBottom: 5 }}>
                      {stat.label}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: stat.color }}>
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Tag pills */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {score.sector && (
                  <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 20, background: "var(--glass-1)", color: "var(--fg-muted)", border: "1px solid var(--glass-border)" }}>
                    {score.sector}
                  </span>
                )}
                {score.region && (
                  <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 20, background: "var(--glass-1)", color: "var(--fg-muted)", border: "1px solid var(--glass-border)" }}>
                    {score.region}
                  </span>
                )}
                {score.strongest_event_type && (
                  <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 20, background: bg, color: fg, border: `1px solid ${border}` }}>
                    {fmtEvent(score.strongest_event_type)}
                  </span>
                )}

              </div>

              {/* Driver articles */}
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--fg-muted)", marginBottom: 8 }}>
                  Drivers
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {score.top_driver_titles.slice(0, 3).map((title, i) => {
                    const url = score.top_driver_urls?.[i];
                    return (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ color: "#829cff", fontSize: 10, flexShrink: 0, marginTop: 2 }}>▸</span>
                        {url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 12, color: "var(--fg-source)", lineHeight: 1.55, textDecoration: "none" }}
                            onClick={(e) => e.stopPropagation()}
                            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-source-h)")}
                            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-source)")}
                          >{title}</a>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--fg-source)", lineHeight: 1.55 }}>{title}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Explanation */}
              {score.explanation && (
                <p style={{ fontSize: 11, color: "var(--fg-summary)", lineHeight: 1.65, margin: 0, fontStyle: "italic" }}>
                  {score.explanation}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Activity entry ────────────────────────────────────────────────────────────

const MILESTONE_STEPS = new Set([
  "PIPELINE_START", "SYMBOLS_RESOLVED", "CACHE_HIT",
  "PROPAGATION_DONE", "SECTOR_ALERTS", "PIPELINE_DONE", "ERROR",
]);

function ActivityEntry({ entry }: { entry: LogEntry }) {
  if (!MILESTONE_STEPS.has(entry.step) || !entry.message) return null;
  const COLOR: Record<string, string> = {
    PIPELINE_START:   "#2962ff",
    SYMBOLS_RESOLVED: "#2962ff",
    CACHE_HIT:        "#26a69a",
    PROPAGATION_DONE: "#f59e0b",
    SECTOR_ALERTS:    "#a78bfa",
    PIPELINE_DONE:    "#26a69a",
    ERROR:            "#ef5350",
  };
  const color = COLOR[entry.step] ?? "var(--fg-dim)";
  const label = entry.step === "SYMBOLS_RESOLVED" ? "Symbols"
    : entry.step === "PROPAGATION_DONE" ? "Prop"
    : entry.step === "SECTOR_ALERTS" ? "Sector"
    : entry.step === "PIPELINE_DONE" ? "Done"
    : entry.step === "CACHE_HIT" ? "Cache"
    : entry.step === "ERROR" ? "Error"
    : "Init";
  const time = entry.ts
    ? new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "";
  return (
    <div className="log-entry" style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border-dim)" }}>
      <span style={{ fontSize: 10, fontWeight: 700, width: 44, flexShrink: 0, color }}>{label}</span>
      <p style={{ fontSize: 10, color: "var(--fg-log)", flex: 1, lineHeight: 1.55 }}>{entry.message}</p>
      {time && <span style={{ fontSize: 9, color: "var(--fg-log-time)", flexShrink: 0, fontFamily: "monospace" }}>{time}</span>}
    </div>
  );
}

// ── OG image cache + batch fetcher ────────────────────────────────────────────

const _ogCache = new Map<string, string | null>();

function useOgImages(urls: string[]): Map<string, string | null> {
  const [results, setResults] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    if (!urls.length) return;
    const missing = urls.filter((u) => u && !_ogCache.has(u));
    if (!missing.length) {
      // All cached — just snapshot the cache values
      setResults(new Map(urls.map((u) => [u, _ogCache.get(u) ?? null])));
      return;
    }
    // Fire all missing fetches in parallel
    Promise.all(
      missing.map((u) =>
        fetch(`/api/og?url=${encodeURIComponent(u)}`)
          .then((r) => (r.ok ? r.json() : { image: null }))
          .then(({ image }: { image: string | null }) => {
            _ogCache.set(u, image ?? null);
            return [u, image ?? null] as [string, string | null];
          })
          .catch(() => {
            _ogCache.set(u, null);
            return [u, null] as [string, string | null];
          })
      )
    ).then((pairs) => {
      setResults(new Map([
        ...urls.map((u) => [u, _ogCache.get(u) ?? null] as [string, string | null]),
        ...pairs,
      ]));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join(",")]);

  return results;
}

// ── Event card (news-feed style) ──────────────────────────────────────────────

function EventCard({ group }: { group: EventGroup }) {
  const [expanded, setExpanded] = useState(false);
  const dirColor   = DIR_COLOR[group.direction] ?? "var(--fg-muted)";
  const themeColor = THEME_COLOR[group.macro_theme] ?? "var(--fg-muted)";
  const isNeg      = group.total_impact < 0;

  // Collect all article URLs for batch OG image fetch
  const allUrls = group.facts.map((f) => f.source_url).filter(Boolean);
  const ogImages = useOgImages(allUrls);

  const topFact = group.facts[0];
  const topImg  = topFact?.source_url ? (ogImages.get(topFact.source_url) ?? null) : null;

  const domain = topFact?.source_url
    ? (() => { try { return new URL(topFact.source_url).hostname.replace(/^www\./, ""); } catch { return ""; } })()
    : "";

  const summary = topFact?.summary && !topFact.summary.toLowerCase().includes("keyword fallback")
    ? topFact.summary : null;

  const directTickers = group.direct_tickers.slice(0, 5);
  const propTickers   = group.propagated_tickers.slice(0, 3);
  const hasMore       = group.facts.length > 1 || group.propagated_tickers.length > 0;

  return (
    <div className="card-in glass-card" style={{
      border: "1px solid var(--border)",
      transition: "box-shadow 0.15s",
    }}>

      {/* ── Main card ── */}
      <div
        style={{ padding: "16px 18px", cursor: hasMore ? "pointer" : "default" }}
        onMouseEnter={(e) => { if (hasMore) e.currentTarget.style.background = "var(--glass-3)"; }}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        onClick={() => hasMore && setExpanded((v) => !v)}
      >
        {/* Row 1 — category + score (PRIMARY meta) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{
            fontSize: 10, fontWeight: 800, textTransform: "uppercase",
            letterSpacing: "0.09em", color: dirColor,
          }}>
            {fmtEvent(group.event_type)}
          </span>
          <span style={{ fontSize: 10, color: themeColor, opacity: 0.7, fontWeight: 500 }}>
            {group.macro_theme.replace(/_/g, " ")}
          </span>
          {/* Score — right next to category, not floating */}
          <span style={{
            marginLeft: 8,
            fontSize: 12, fontFamily: "monospace", fontWeight: 700, color: dirColor,
            background: isNeg ? "var(--bg-ticker-neg)" : "var(--bg-ticker-pos)",
            border: `1px solid ${isNeg ? "var(--border-ticker-neg)" : "var(--border-ticker-pos)"}`,
            padding: "1px 7px", borderRadius: 4,
          }}>
            {group.total_impact > 0 ? "+" : ""}{group.total_impact.toFixed(3)}
          </span>
        </div>

        {/* Row 2 — headline + thumbnail (PRIMARY content) */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {topFact?.article_title && (
              topFact.source_url ? (
                <a href={topFact.source_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-headline)", lineHeight: 1.4, textDecoration: "none", display: "block", marginBottom: 6 }}
                  onClick={(e) => e.stopPropagation()}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-link-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-headline)")}
                >
                  {topFact.article_title}
                </a>
              ) : (
                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-headline)", lineHeight: 1.4, display: "block", marginBottom: 6 }}>
                  {topFact.article_title}
                </span>
              )
            )}

            {/* Row 3 — summary (SECONDARY content) */}
            {summary && (
              <p style={{ fontSize: 13, color: "var(--fg-summary)", lineHeight: 1.6, margin: "0 0 10px" }}>
                {summary}
              </p>
            )}

            {/* Row 4 — footer meta (TERTIARY) */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {/* Source */}
              {domain && (
                <span style={{ fontSize: 11, color: "var(--fg-domain)", fontWeight: 500 }}>{domain}</span>
              )}
              {domain && (directTickers.length > 0 || propTickers.length > 0) && (
                <span style={{ color: "var(--border-strong)", fontSize: 12 }}>·</span>
              )}
              {/* Direct tickers */}
              {directTickers.map((t, i) => (
                <span key={`d-${t.symbol}-${i}`} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 11, fontWeight: 700, fontFamily: "monospace",
                  padding: "2px 7px 2px 3px", borderRadius: 4,
                  background: isNeg ? "var(--bg-ticker-neg)" : "var(--bg-ticker-pos)",
                  color: isNeg ? "var(--fg-ticker-dir-isNeg-color)" : "var(--fg-ticker-dir-isPos-color)",
                  border: `1px solid ${isNeg ? "var(--border-ticker-neg)" : "var(--border-ticker-pos)"}`,
                }}>
                  <TickerLogo symbol={t.symbol} size={14} />
                  {t.symbol}
                </span>
              ))}
              {/* Propagated tickers — visually distinct/dimmer */}
              {propTickers.map((t, i) => (
                <span key={`p-${t.target_symbol}-${i}`} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 11, fontWeight: 600, fontFamily: "monospace",
                  padding: "2px 7px 2px 3px", borderRadius: 4,
                  background: "var(--bg-ticker-prop)",
                  color: "var(--fg-ticker-prop-color)",
                  border: "1px solid var(--border-ticker-prop)",
                  opacity: 0.8,
                }}>
                  <TickerLogo symbol={t.target_symbol} size={14} />
                  {t.target_symbol}
                </span>
              ))}
              {/* Expand toggle */}
              {hasMore && (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--fg-muted)", userSelect: "none" }}>
                  {expanded ? "▲ less" : "▼ more"}
                </span>
              )}
            </div>
          </div>

          {/* Thumbnail — only if image loaded */}
          {topImg && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={topImg}
              alt=""
              style={{
                width: 100, height: 68, objectFit: "cover", borderRadius: 6,
                flexShrink: 0, border: "1px solid var(--border)",
              }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--glass-border)", background: "var(--glass-1)" }}>

          {/* Other articles — each is a clear sub-item */}
          {group.facts.slice(1).map((f, i) => {
            const fDomain = f.source_url
              ? (() => { try { return new URL(f.source_url).hostname.replace(/^www\./, ""); } catch { return ""; } })()
              : "";
            const fSummary = f.summary && !f.summary.toLowerCase().includes("keyword fallback") ? f.summary : null;
            const fImg = f.source_url ? (ogImages.get(f.source_url) ?? null) : null;

            return (
              <div key={i} style={{
                display: "flex", gap: 12, padding: "12px 18px",
                borderTop: i > 0 ? "1px solid var(--border)" : "none",
                alignItems: "flex-start",
              }}>
                {/* Ticker + domain */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, flexShrink: 0, width: 80, paddingTop: 1 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 800, fontFamily: "monospace",
                    color: isNeg ? "var(--fg-ticker-dir-isNeg-color)" : "var(--fg-ticker-dir-isPos-color)",
                  }}>
                    {f.symbol}
                  </span>
                  {fDomain && (
                    <span style={{ fontSize: 9, color: "var(--fg-domain)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {fDomain}
                    </span>
                  )}
                </div>
                {/* Headline + summary */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {f.source_url ? (
                    <a href={f.source_url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-link)", lineHeight: 1.45, textDecoration: "none", display: "block" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg-link-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg-link)")}
                      onClick={(e) => e.stopPropagation()}
                    >{f.article_title}</a>
                  ) : (
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-link)", lineHeight: 1.45, display: "block" }}>{f.article_title}</span>
                  )}
                  {fSummary && (
                    <p style={{ fontSize: 12, color: "var(--fg-summary)", lineHeight: 1.55, margin: "4px 0 0" }}>{fSummary}</p>
                  )}
                </div>
                {/* Mini thumbnail */}
                {fImg && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fImg} alt="" style={{ width: 64, height: 44, objectFit: "cover", borderRadius: 4, flexShrink: 0, border: "1px solid var(--border)" }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                )}
              </div>
            );
          })}

          {/* Contagion */}
          {group.propagated_tickers.length > 0 && (
            <div style={{
              padding: "10px 18px 12px",
              borderTop: "1px solid var(--glass-border)",
              background: "rgba(99,60,255,0.04)",
            }}>
              <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--fg-muted)", marginBottom: 8 }}>
                Contagion ripple
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {group.propagated_tickers.map((t, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-contagion-src)", fontFamily: "monospace", minWidth: 40 }}>{t.source_symbol}</span>
                    <span style={{ fontSize: 11, color: "var(--fg-sep)" }}>→</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-contagion-tgt)", fontFamily: "monospace", minWidth: 40 }}>{t.target_symbol}</span>
                    <span style={{ fontSize: 11, color: "var(--fg-contagion-rel)", flex: 1 }}>{t.relationship.replace(/_/g, " ")}</span>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: t.impact_score >= 0 ? "#26a69a" : "#ef5350" }}>
                      {t.impact_score >= 0 ? "+" : ""}{t.impact_score.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [preset, setPreset]         = useState("mag7");
  const [symbols, setSymbols]       = useState<string[]>(PRESETS.mag7);
  const [scores, setScores]         = useState<TickerScore[]>([]);
  const [eventFacts, setEventFacts] = useState<EventFact[]>([]);
  const [propFacts, setPropFacts]   = useState<PropagationFact[]>([]);
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const [running, setRunning]       = useState(false);
  const [fromCache, setFromCache]   = useState(false);
  const [lastScan, setLastScan]     = useState<Date | null>(null);
  const [runId, setRunId]           = useState("");
  const [view, setView]             = useState<"ticker" | "event">("ticker");
  const [evtFilter, setEvtFilter]   = useState<"all" | "up" | "down">("all");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      // Set synchronously so CSS variables update on this frame, not the next
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  // Ensure the attribute is set on first mount (SSR sends no attribute)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-preset client-side caches
  const sessionCache      = useRef<Map<string, TickerScore[]>>(new Map());
  const sessionEventFacts = useRef<Map<string, EventFact[]>>(new Map());
  const sessionPropFacts  = useRef<Map<string, PropagationFact[]>>(new Map());

  const [presetStatus, setPresetStatus] = useState<Record<string, "idle" | "scanning" | "done">>(
    () => Object.fromEntries(Object.keys(PRESETS).map((k) => [k, "idle"]))
  );

  const presetRef = useRef(preset);
  useEffect(() => { presetRef.current = preset; }, [preset]);

  const idRef     = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const addLog = useCallback((raw: Record<string, unknown>) => {
    setLogs((prev) => [...prev, {
      id: idRef.current++,
      step: String(raw.step ?? "INFO"),
      message: raw.message as string | undefined,
      ts: raw.ts as string | undefined,
    }]);
  }, []);

  const pickPreset = (name: string) => {
    presetRef.current = name;
    setPreset(name);
    setSymbols(PRESETS[name]);
    setLogs([]); setRunId("");
    const cached = sessionCache.current.get(name);
    if (cached) {
      setScores(cached);
      setEventFacts(sessionEventFacts.current.get(name) ?? []);
      setPropFacts(sessionPropFacts.current.get(name) ?? []);
      setFromCache(true);
    } else {
      setScores([]); setEventFacts([]); setPropFacts([]); setFromCache(false);
    }
    setLastScan(null);
  };

  const scanPreset = useCallback(async (name: string, syms: string[], force = false) => {
    const isActive = () => presetRef.current === name;
    setPresetStatus((p) => ({ ...p, [name]: "scanning" }));
    if (isActive()) {
      setRunning(true); setLogs([]); setScores([]); setEventFacts([]);
      setPropFacts([]); setRunId(""); setFromCache(false);
    }
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: syms, watchlist: name, force }),
      });
      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buf      = "";
      const batchScores: TickerScore[]     = [];
      const batchEF:     EventFact[]       = [];
      const batchPF:     PropagationFact[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const p = JSON.parse(line) as Record<string, unknown>;
            if (isActive()) addLog(p);
            if (p.step === "TICKER_SCORE") {
              const ts = p as unknown as TickerScore;
              // Deduplicate by symbol — keep latest
              const idx = batchScores.findIndex((s) => s.symbol === ts.symbol);
              if (idx >= 0) batchScores[idx] = ts; else batchScores.push(ts);
              if (isActive()) setScores([...batchScores].sort((a, b) => Math.abs(b.total_score) - Math.abs(a.total_score)));
            }
            if (p.step === "EVENT_FACT") {
              batchEF.push(p as unknown as EventFact);
              if (isActive()) setEventFacts([...batchEF]);
            }
            if (p.step === "PROPAGATION_FACT") {
              batchPF.push(p as unknown as PropagationFact);
              if (isActive()) setPropFacts([...batchPF]);
            }
            if (p.step === "CACHE_HIT" && isActive()) setFromCache(true);
            if (p.step === "SUMMARY" && p.run_id && isActive()) setRunId(String(p.run_id));
          } catch { /* skip */ }
        }
      }

      const sortedScores = [...batchScores].sort((a, b) => Math.abs(b.total_score) - Math.abs(a.total_score));
      sessionCache.current.set(name, sortedScores);
      sessionEventFacts.current.set(name, batchEF);
      sessionPropFacts.current.set(name, batchPF);
      if (isActive()) {
        setScores(sortedScores); setEventFacts(batchEF); setPropFacts(batchPF);
        setLastScan(new Date());
      }
      setPresetStatus((p) => ({ ...p, [name]: "done" }));
    } catch (e) {
      if (isActive()) addLog({ step: "ERROR", message: String(e) });
      setPresetStatus((p) => ({ ...p, [name]: "idle" }));
    } finally {
      if (isActive()) setRunning(false);
    }
  }, [addLog]);

  const didScanAll = useRef(false);
  useEffect(() => {
    if (didScanAll.current) return;
    didScanAll.current = true;
    (async () => {
      for (const [name, syms] of Object.entries(PRESETS)) {
        await scanPreset(name, syms);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Build event groups ─────────────────────────────────────────────────────

  const eventGroups = useMemo<EventGroup[]>(() => {
    const grouped = new Map<string, {
      facts: EventFact[];
      macro_themes: string[];
      directions: string[];
      direct: Map<string, { base_event_score: number; severity_label: string }>;
      propagated: PropagationFact[];
    }>();

    for (const ef of eventFacts) {
      const key = ef.event_type;
      if (!grouped.has(key)) grouped.set(key, { facts: [], macro_themes: [], directions: [], direct: new Map(), propagated: [] });
      const g = grouped.get(key)!;
      g.facts.push(ef);
      g.macro_themes.push(ef.macro_theme);
      g.directions.push(ef.direction);
      const existing = g.direct.get(ef.symbol);
      if (!existing || Math.abs(ef.base_event_score) > Math.abs(existing.base_event_score)) {
        g.direct.set(ef.symbol, { base_event_score: ef.base_event_score, severity_label: ef.severity_label });
      }
    }
    for (const pf of propFacts) {
      if (grouped.has(pf.event_type)) grouped.get(pf.event_type)!.propagated.push(pf);
    }

    const groups: EventGroup[] = [];
    for (const [event_type, g] of grouped.entries()) {
      const themeCounts: Record<string, number> = {};
      for (const t of g.macro_themes) themeCounts[t] = (themeCounts[t] ?? 0) + 1;
      const macro_theme = Object.entries(themeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";

      const ups   = g.directions.filter((d) => d === "up").length;
      const downs = g.directions.filter((d) => d === "down").length;
      const direction: EventGroup["direction"] =
        ups > 0 && downs === 0 ? "up" : downs > 0 && ups === 0 ? "down" : ups > 0 && downs > 0 ? "mixed" : "neutral";

      const sevOrder = { high: 2, medium: 1, low: 0 };
      const max_severity: EventGroup["max_severity"] = g.facts.reduce<EventGroup["max_severity"]>((best, f) => {
        return (sevOrder[f.severity_label as keyof typeof sevOrder] ?? 0) > (sevOrder[best] ?? 0) ? (f.severity_label as EventGroup["max_severity"]) : best;
      }, "low");

      const directSum    = Array.from(g.direct.values()).reduce((s, v) => s + v.base_event_score, 0);
      const propSum      = g.propagated.reduce((s, p) => s + p.impact_score, 0);
      const total_impact = directSum + propSum;

      const direct_tickers = Array.from(g.direct.entries())
        .map(([symbol, v]) => ({ symbol, ...v }))
        .sort((a, b) => Math.abs(b.base_event_score) - Math.abs(a.base_event_score));

      const propByTarget = new Map<string, PropagationFact>();
      for (const pf of g.propagated) {
        const ex = propByTarget.get(pf.target_symbol);
        if (!ex || Math.abs(pf.impact_score) > Math.abs(ex.impact_score)) propByTarget.set(pf.target_symbol, pf);
      }
      const propagated_tickers = Array.from(propByTarget.values())
        .map((pf) => ({ symbol: pf.target_symbol, target_symbol: pf.target_symbol, impact_score: pf.impact_score, relationship: pf.relationship, source_symbol: pf.source_symbol }))
        .sort((a, b) => Math.abs(b.impact_score) - Math.abs(a.impact_score));

      const facts = [...g.facts].sort((a, b) => Math.abs(b.base_event_score) - Math.abs(a.base_event_score));
      groups.push({ event_type, macro_theme, direction, direct_tickers, propagated_tickers, facts, total_impact, max_severity });
    }
    return groups.sort((a, b) => Math.abs(b.total_impact) - Math.abs(a.total_impact));
  }, [eventFacts, propFacts]);

  const filteredGroups = useMemo(() => {
    if (evtFilter === "all") return eventGroups;
    return eventGroups.filter((g) =>
      evtFilter === "up"   ? (g.direction === "up"   || (g.direction === "mixed" && g.total_impact > 0)) :
      evtFilter === "down" ? (g.direction === "down" || (g.direction === "mixed" && g.total_impact < 0)) : true
    );
  }, [eventGroups, evtFilter]);

  const longs    = scores.filter((s) => s.signal === "long").length;
  const shorts   = scores.filter((s) => s.signal === "short").length;
  const neutrals = scores.filter((s) => s.signal === "neutral").length;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
      background: "var(--bg-gradient)", backgroundAttachment: "fixed",
      color: "var(--fg)",
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    }}>

      {/* ── Header ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", height: 52,
        background: "var(--bg-header)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid var(--glass-border)",
        flexShrink: 0, gap: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--fg)", letterSpacing: "-0.02em" }}>
            Signal Monitor
          </span>
          <span style={{ width: 1, height: 16, background: "var(--glass-border-strong)" }} />

          {/* Preset tabs */}
          <nav style={{ display: "flex", gap: 2 }}>
            {Object.keys(PRESETS).map((name) => {
              const st = presetStatus[name];
              const isActive = preset === name;
              return (
                <button key={name} onClick={() => pickPreset(name)} style={{
                  fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 8,
                  border: isActive ? "1px solid rgba(99,60,255,0.4)" : "1px solid transparent",
                  cursor: "pointer",
                  background: isActive ? "rgba(99,60,255,0.25)" : "transparent",
                  color: isActive ? "#c8b8ff" : st === "done" ? "var(--fg-dim)" : "var(--fg-muted)",
                  transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 5,
                  backdropFilter: isActive ? "blur(8px)" : "none",
                }}>
                  {name}
                  {st === "scanning" && (
                    <span className="pulse-dot" style={{ width: 4, height: 4, borderRadius: "50%", background: isActive ? "#c8b8ff" : "#6340ff", display: "inline-block" }} />
                  )}
                  {st === "done" && !isActive && (
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#26a69a", display: "inline-block" }} />
                  )}
                </button>
              );
            })}
          </nav>

          <span style={{ width: 1, height: 16, background: "var(--glass-border-strong)" }} />

          {/* View toggle */}
          <div style={{
            display: "flex", gap: 2, padding: 3, borderRadius: 10,
            background: "var(--bg-input)",
            border: "1px solid var(--glass-border)",
          }}>
            {(["ticker", "event"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} style={{
                fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 7,
                border: "none", cursor: "pointer",
                background: view === v ? "rgba(99,60,255,0.25)" : "transparent",
                color: view === v ? "#c8b8ff" : "var(--fg-muted)",
                transition: "all 0.15s",
              }}>
                {v === "ticker" ? "Ticker" : "Event"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11 }}>
          {scores.length > 0 && !running && (
            <div style={{ display: "flex", gap: 10 }}>
              {longs    > 0 && <span style={{ color: "#26a69a", fontWeight: 600 }}>▲ {longs}</span>}
              {shorts   > 0 && <span style={{ color: "#ef5350", fontWeight: 600 }}>▼ {shorts}</span>}
              {neutrals > 0 && <span style={{ color: "var(--fg-muted)" }}>{neutrals} neutral</span>}
            </div>
          )}
          {fromCache && !running && (
            <span style={{ fontSize: 10, color: "var(--fg-cached)", fontFamily: "monospace" }}>● cached</span>
          )}
          {lastScan && !running && (
            <span style={{ color: "var(--fg-muted)" }}>
              {lastScan.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          )}
          {running && (
            <span style={{ color: "#829cff", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#829cff", animation: "pulse 1s infinite" }} />
              Scanning…
            </span>
          )}

          {/* Rescan all */}
          <button
            onClick={() => {
              (async () => {
                for (const [name, syms] of Object.entries(PRESETS)) {
                  await scanPreset(name, syms, true);
                }
              })();
            }}
            disabled={Object.values(presetStatus).some((s) => s === "scanning")}
            style={{
              fontSize: 11, fontWeight: 600, padding: "6px 16px", borderRadius: 8,
              border: "1px solid rgba(99,60,255,0.35)",
              cursor: Object.values(presetStatus).some((s) => s === "scanning") ? "not-allowed" : "pointer",
              background: Object.values(presetStatus).some((s) => s === "scanning") ? "rgba(255,255,255,0.04)" : "rgba(99,60,255,0.20)",
              color: Object.values(presetStatus).some((s) => s === "scanning") ? "var(--fg-muted)" : "#c8b8ff",
              backdropFilter: "blur(8px)",
              transition: "all 0.15s",
            }}
          >
            {Object.values(presetStatus).some((s) => s === "scanning") ? "Scanning…" : "↺ Rescan All"}
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            style={{
              fontSize: 15, lineHeight: 1, padding: "5px 9px", borderRadius: 8,
              border: "1px solid var(--glass-border-strong)", cursor: "pointer",
              background: "var(--bg-input)", color: "var(--fg-dim)",
              backdropFilter: "blur(8px)",
              transition: "all 0.15s",
            }}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", gap: 0 }}>

        {/* ── Watchlist sidebar ── */}
        <aside style={{
          width: 200, flexShrink: 0, display: "flex", flexDirection: "column",
          overflow: "hidden",
          background: "var(--glass-1)",
          backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          borderRight: "1px solid var(--glass-border)",
        }}>
          <div style={{ padding: "10px 14px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-section-label)" }}>Watchlist</span>
            <span style={{ fontSize: 10, color: "var(--fg-muted)", fontFamily: "monospace" }}>{symbols.length}</span>
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: "4px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
            {symbols.map((sym, i) => <WatchlistRow key={`${sym}-${i}`} symbol={sym} />)}
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--glass-border)" }}>
            <div style={{ fontSize: 9, color: "var(--fg-threshold)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Thresholds</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#26a69a" }}>● Long</span>
                <span style={{ color: "var(--fg-threshold)", fontFamily: "monospace" }}>≥ +0.55</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#ef5350" }}>● Short</span>
                <span style={{ color: "var(--fg-threshold)", fontFamily: "monospace" }}>≤ −0.55</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Main ── */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {view === "ticker" ? (
            <>
              <div style={{
                padding: "8px 20px", flexShrink: 0,
                display: "flex", alignItems: "center", gap: 8, minHeight: 36,
                borderBottom: "1px solid var(--glass-border)",
              }}>
                <span style={{ fontSize: 10, color: "var(--fg-section-label)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Signal Output</span>
                {scores.length > 0 && (
                  <>
                    <span style={{ color: "var(--fg-ghost)" }}>·</span>
                    <span style={{ fontSize: 10, color: "#829cff" }}>{scores.length} scored</span>
                  </>
                )}
              </div>

              {scores.length === 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                  <span style={{ fontSize: 32, color: "var(--fg-ghost)" }}>◈</span>
                  <p style={{ fontSize: 12, color: "var(--fg-muted)", textAlign: "center", lineHeight: 1.8 }}>
                    {presetStatus[preset] === "scanning" ? "Scanning…" : "Loading…"}
                  </p>
                </div>
              ) : (
                <div style={{ overflowY: "auto", flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {scores.map((s, i) => <SignalRow key={`${s.symbol}-${i}`} score={s} rank={i + 1} />)}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{
                padding: "8px 20px", flexShrink: 0,
                display: "flex", alignItems: "center", gap: 10, minHeight: 36,
                borderBottom: "1px solid var(--glass-border)",
              }}>
                <span style={{ fontSize: 10, color: "var(--fg-section-label)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Event Feed</span>
                {eventGroups.length > 0 && (
                  <>
                    <span style={{ color: "var(--fg-ghost)" }}>·</span>
                    <span style={{ fontSize: 10, color: "#829cff" }}>{eventGroups.length} events</span>
                    <span style={{ color: "var(--fg-ghost)" }}>·</span>
                    <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>{eventFacts.length} facts</span>
                    {propFacts.length > 0 && (
                      <>
                        <span style={{ color: "var(--fg-ghost)" }}>·</span>
                        <span style={{ fontSize: 10, color: "#f59e0b" }}>{propFacts.length} contagion</span>
                      </>
                    )}
                  </>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 2, padding: 3, borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--glass-border)" }}>
                  {(["all", "up", "down"] as const).map((f) => (
                    <button key={f} onClick={() => setEvtFilter(f)} style={{
                      fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 6,
                      border: "none", cursor: "pointer",
                      background: evtFilter === f ? "rgba(99,60,255,0.25)" : "transparent",
                      color: evtFilter === f
                        ? (f === "up" ? "#26a69a" : f === "down" ? "#ef5350" : "#c8b8ff")
                        : "var(--fg-muted)",
                      transition: "all 0.15s",
                    }}>
                      {f === "all" ? "All" : f === "up" ? "↑ Positive" : "↓ Negative"}
                    </button>
                  ))}
                </div>
              </div>

              {eventGroups.length === 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                  <span style={{ fontSize: 32, color: "var(--fg-ghost)" }}>◈</span>
                  <p style={{ fontSize: 12, color: "var(--fg-muted)", textAlign: "center", lineHeight: 1.8 }}>
                    {running ? "Collecting events…" : "Scan to see market events and their cross-ticker impact"}
                  </p>
                </div>
              ) : (
                <div style={{ overflowY: "auto", flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {filteredGroups.map((g, i) => <EventCard key={`${g.event_type}-${i}`} group={g} />)}
                </div>
              )}
            </>
          )}
        </main>

      </div>
    </div>
  );
}
