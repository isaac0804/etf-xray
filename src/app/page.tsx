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

const SIG = {
  long:    { fg: "#26a69a", bg: "rgba(38,166,154,0.10)", border: "rgba(38,166,154,0.30)" },
  short:   { fg: "#ef5350", bg: "rgba(239,83,80,0.10)",  border: "rgba(239,83,80,0.30)"  },
  neutral: { fg: "#4e5263", bg: "transparent",            border: "#2a2e39"               },
};

const RISK_COLOR: Record<string, string> = {
  HIGH: "#ef5350", HIGH_POSITIVE: "#26a69a",
  MEDIUM: "#f59e0b", MEDIUM_POSITIVE: "#7dd3a8",
};

const EVENT_LABEL: Record<string, string> = {
  regulatory_probe: "Regulatory probe",
  earnings_miss:    "Earnings miss",
  earnings_beat:    "Earnings beat",
  supply_disruption:"Supply disruption",
  macro_theme:      "Macro headwinds",
  partnership:      "Partnership",
  capex:            "Capex signal",
  demand_signal:    "Demand signal",
  other:            "Market event",
};
const fmtEvent = (t?: string) =>
  t ? (EVENT_LABEL[t] ?? t.replace(/_/g, " ")) : "—";

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
  const up = pct >= 0;
  const color = up ? "#26a69a" : "#ef5350";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid #1e2230" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#d1d4dc" }}>{symbol}</div>
        <div style={{ fontSize: 10, fontFamily: "monospace", color: "#787b86", marginTop: 1 }}>
          {data ? `$${data.price.toFixed(2)}` : "—"}
        </div>
      </div>
      {data && <Sparkline series={data.series} color={color} />}
      <div style={{ textAlign: "right", minWidth: 44, flexShrink: 0 }}>
        {data ? (
          <span style={{ fontSize: 11, fontWeight: 600, fontFamily: "monospace", color }}>
            {up ? "+" : ""}{pct.toFixed(2)}%
          </span>
        ) : <span style={{ fontSize: 11, color: "#2a2e39" }}>—</span>}
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
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{ width: 52, height: 3, background: "#2a2e39", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: fg, borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: fg, minWidth: 48 }}>
          {score > 0 ? "+" : ""}{score.toFixed(3)}
        </span>
      </div>
      {riskColor && riskLevel !== "LOW" && (
        <div style={{ marginTop: 3, fontSize: 9, fontWeight: 700, color: riskColor, letterSpacing: "0.06em" }}>
          {riskLevel?.replace("_POSITIVE", "+") ?? ""}
        </div>
      )}
    </div>
  );
}

// ── Signal row (expandable) ───────────────────────────────────────────────────

function SignalRow({ score, rank }: { score: TickerScore; rank: number }) {
  const [open, setOpen] = useState(false);
  const { fg, bg, border } = SIG[score.signal];
  const pct = score.price_change_pct;
  const pctColor = pct != null ? (pct >= 0 ? "#26a69a" : "#ef5350") : "#787b86";
  const hasProp = (score.propagation_count ?? 0) > 0;

  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        style={{ borderBottom: "1px solid #1e2230", cursor: "pointer", background: open ? "#171c2b" : "transparent", transition: "background 0.1s" }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "#1b2030"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        {/* # */}
        <td style={{ padding: "11px 8px 11px 16px", fontSize: 10, color: "#3a4060", width: 24, fontFamily: "monospace" }}>
          {rank}
        </td>

        {/* Symbol */}
        <td style={{ padding: "11px 14px 11px 8px", minWidth: 120 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#d1d4dc", letterSpacing: "0.02em" }}>
            {score.symbol}
            {score.from_cache && (
              <span style={{ marginLeft: 6, fontSize: 9, color: "#3a5080", fontWeight: 400, fontFamily: "monospace" }}>cached</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "#4e5263", marginTop: 2, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {score.name || score.symbol}
          </div>
        </td>

        {/* Signal */}
        <td style={{ padding: "11px 12px", width: 76 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", padding: "3px 7px", borderRadius: 3, color: fg, background: bg, border: `1px solid ${border}` }}>
            {score.signal}
          </span>
        </td>

        {/* Score + Risk */}
        <td style={{ padding: "11px 12px", width: 120 }}>
          <ScoreBar score={score.total_score} signal={score.signal} riskLevel={score.risk_level} />
        </td>

        {/* Headline */}
        <td style={{ padding: "11px 12px" }}>
          <div style={{ fontSize: 11, color: "#5a6180", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 380 }}>
            {score.top_driver_titles[0] ?? "—"}
          </div>
          {hasProp && (
            <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 2 }}>
              ↓ contagion
            </div>
          )}
        </td>

        {/* Δ Today */}
        <td style={{ padding: "11px 12px 11px 4px", width: 68, textAlign: "right" }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 600, color: pctColor }}>
            {pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
          </span>
        </td>

        {/* Expander */}
        <td style={{ padding: "11px 12px 11px 4px", width: 16, fontSize: 9, color: "#2a2e39", textAlign: "center" }}>
          {open ? "▲" : "▼"}
        </td>
      </tr>

      {open && (
        <tr style={{ background: "#12172280", borderBottom: "1px solid #1e2230" }}>
          <td colSpan={7} style={{ padding: "12px 16px 14px 58px" }}>

            {/* Articles */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: hasProp || (score.direct_score !== undefined) ? 10 : 0 }}>
              {score.top_driver_titles.slice(0, 3).map((title, i) => {
                const url = score.top_driver_urls?.[i];
                return (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: "#2962ff", fontSize: 10, flexShrink: 0, marginTop: 2 }}>▸</span>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: "#6b7fb0", lineHeight: 1.5, textDecoration: "none" }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#9fb8d8")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#6b7fb0")}
                      >{title}</a>
                    ) : (
                      <span style={{ fontSize: 11, color: "#6b7fb0", lineHeight: 1.5 }}>{title}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Score breakdown + propagation */}
            <div style={{ display: "flex", gap: 20, fontSize: 11, fontFamily: "monospace", color: "#3a4060" }}>
              {score.direct_score !== undefined && (
                <span>
                  direct <span style={{ color: fg }}>{(score.direct_score ?? 0) >= 0 ? "+" : ""}{(score.direct_score ?? 0).toFixed(3)}</span>
                </span>
              )}
              {hasProp && (
                <span>
                  contagion <span style={{ color: "#f59e0b" }}>{(score.propagated_score ?? 0) >= 0 ? "+" : ""}{(score.propagated_score ?? 0).toFixed(3)}</span>
                </span>
              )}
              {score.strongest_event_type && (
                <span style={{ color: "#4e5263" }}>{fmtEvent(score.strongest_event_type)}</span>
              )}
            </div>

          </td>
        </tr>
      )}
    </>
  );
}

// ── Activity entry (milestones only) ─────────────────────────────────────────

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
  const color = COLOR[entry.step] ?? "#787b86";
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
    <div className="log-entry" style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #151a28" }}>
      <span style={{ fontSize: 10, fontWeight: 700, width: 44, flexShrink: 0, color }}>{label}</span>
      <p style={{ fontSize: 10, color: "#5a6180", flex: 1, lineHeight: 1.55 }}>{entry.message}</p>
      {time && <span style={{ fontSize: 9, color: "#2a2e39", flexShrink: 0, fontFamily: "monospace" }}>{time}</span>}
    </div>
  );
}

// ── Event group row ───────────────────────────────────────────────────────────

const SEV_COLOR: Record<string, string> = { high: "#ef5350", medium: "#f59e0b", low: "#4e5263" };
const DIR_ICON: Record<string, string>  = { up: "↑", down: "↓", neutral: "→", mixed: "↕" };
const DIR_COLOR: Record<string, string> = { up: "#26a69a", down: "#ef5350", neutral: "#4e5263", mixed: "#f59e0b" };
const THEME_COLOR: Record<string, string> = {
  geopolitical_risk: "#ef5350", supply_chain: "#f59e0b", earnings: "#26a69a",
  sell_side: "#818cf8", innovation: "#34d399", regulation: "#ef5350",
  strategic_activity: "#7dd3a8", demand: "#60a5fa", other: "#4e5263",
};

function EventGroupRow({ group, rank }: { group: EventGroup; rank: number }) {
  const [open, setOpen] = useState(false);
  const dirColor = DIR_COLOR[group.direction] ?? "#4e5263";
  const dirIcon  = DIR_ICON[group.direction]  ?? "→";
  const sevColor = SEV_COLOR[group.max_severity] ?? "#4e5263";
  const themeColor = THEME_COLOR[group.macro_theme] ?? "#4e5263";
  const totalAbs = Math.abs(group.total_impact);
  const barPct   = Math.min((totalAbs / 1.5) * 100, 100);
  const allTickers = [
    ...group.direct_tickers.map((t) => t.symbol),
    ...group.propagated_tickers.map((t) => t.target_symbol),
  ].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        style={{
          borderBottom: "1px solid #1e2230", cursor: "pointer",
          background: open ? "#171c2b" : "transparent", transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "#1b2030"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        {/* # */}
        <td style={{ padding: "11px 8px 11px 16px", fontSize: 10, color: "#3a4060", width: 24, fontFamily: "monospace" }}>
          {rank}
        </td>

        {/* Event type */}
        <td style={{ padding: "11px 14px 11px 8px", minWidth: 180 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#d1d4dc" }}>
            {fmtEvent(group.event_type)}
          </div>
          <div style={{ marginTop: 3, display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: themeColor }}>
              {group.macro_theme.replace(/_/g, " ")}
            </span>
          </div>
        </td>

        {/* Direction + Severity */}
        <td style={{ padding: "11px 12px", width: 90 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 16, lineHeight: 1, color: dirColor, fontWeight: 700 }}>{dirIcon}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: sevColor, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {group.max_severity}
            </span>
          </div>
        </td>

        {/* Impact bar */}
        <td style={{ padding: "11px 12px", width: 130 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 52, height: 3, background: "#2a2e39", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
              <div style={{ width: `${barPct}%`, height: "100%", background: dirColor, borderRadius: 2 }} />
            </div>
            <span style={{ fontSize: 11, fontFamily: "monospace", color: dirColor, minWidth: 48 }}>
              {group.total_impact > 0 ? "+" : ""}{group.total_impact.toFixed(3)}
            </span>
          </div>
        </td>

        {/* Affected tickers */}
        <td style={{ padding: "11px 12px" }}>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {group.direct_tickers.slice(0, 5).map((t) => (
              <span key={t.symbol} style={{
                fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                background: "rgba(41,98,255,0.12)", color: "#6b8fff",
                border: "1px solid rgba(41,98,255,0.25)", fontFamily: "monospace",
              }}>
                {t.symbol}
              </span>
            ))}
            {group.propagated_tickers.slice(0, 4).map((t) => (
              <span key={`p-${t.target_symbol}`} style={{
                fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 3,
                background: "rgba(245,158,11,0.10)", color: "#a07020",
                border: "1px solid rgba(245,158,11,0.20)", fontFamily: "monospace",
              }}>
                ↳{t.target_symbol}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 9, color: "#3a4060", marginTop: 3 }}>
            {group.direct_tickers.length} direct
            {group.propagated_tickers.length > 0 && ` · ${group.propagated_tickers.length} propagated`}
          </div>
        </td>

        {/* Headline */}
        <td style={{ padding: "11px 12px" }}>
          <div style={{ fontSize: 11, color: "#5a6180", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
            {group.facts[0]?.article_title ?? "—"}
          </div>
        </td>

        {/* Expander */}
        <td style={{ padding: "11px 12px 11px 4px", width: 16, fontSize: 9, color: "#2a2e39", textAlign: "center" }}>
          {open ? "▲" : "▼"}
        </td>
      </tr>

      {open && (
        <tr style={{ background: "#12172280", borderBottom: "1px solid #1e2230" }}>
          <td colSpan={7} style={{ padding: "14px 16px 16px 58px" }}>

            {/* Direct impact section */}
            {group.direct_tickers.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060", marginBottom: 7 }}>
                  Direct impact
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {group.direct_tickers.map((t) => (
                    <div key={t.symbol} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#6b8fff", fontFamily: "monospace", minWidth: 50 }}>
                        {t.symbol}
                      </span>
                      <span style={{ fontSize: 10, color: SEV_COLOR[t.severity_label] ?? "#4e5263", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {t.severity_label}
                      </span>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: t.base_event_score >= 0 ? "#26a69a" : "#ef5350" }}>
                        {t.base_event_score >= 0 ? "+" : ""}{t.base_event_score.toFixed(3)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Propagation section */}
            {group.propagated_tickers.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060", marginBottom: 7 }}>
                  Propagation ripple
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {group.propagated_tickers.map((t, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 10, color: "#a07020", fontFamily: "monospace", minWidth: 14 }}>↳</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#c8a040", fontFamily: "monospace", minWidth: 50 }}>
                        {t.target_symbol}
                      </span>
                      <span style={{ fontSize: 10, color: "#4e5263" }}>
                        via <span style={{ color: "#6b8fff" }}>{t.source_symbol}</span>
                      </span>
                      <span style={{ fontSize: 10, color: "#4e5263" }}>
                        {t.relationship.replace(/_/g, " ")}
                      </span>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: t.impact_score >= 0 ? "#26a69a" : "#ef5350", marginLeft: "auto" }}>
                        {t.impact_score >= 0 ? "+" : ""}{t.impact_score.toFixed(3)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Source articles */}
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060", marginBottom: 7 }}>
                Sources
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {group.facts.slice(0, 4).map((f, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 9, color: "#2962ff", fontFamily: "monospace", flexShrink: 0, marginTop: 2 }}>{f.symbol}</span>
                    {f.source_url ? (
                      <a href={f.source_url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: "#6b7fb0", lineHeight: 1.5, textDecoration: "none" }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#9fb8d8")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#6b7fb0")}
                      >
                        {f.article_title || f.source_url}
                      </a>
                    ) : (
                      <span style={{ fontSize: 11, color: "#6b7fb0", lineHeight: 1.5 }}>{f.article_title}</span>
                    )}
                    {f.summary && (
                      <span style={{ fontSize: 10, color: "#3a4060", marginLeft: "auto", flexShrink: 0, maxWidth: 240, textAlign: "right" }}>
                        {f.summary.length > 80 ? f.summary.slice(0, 80) + "…" : f.summary}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [preset, setPreset]       = useState("mag7");
  const [symbols, setSymbols]     = useState<string[]>(PRESETS.mag7);
  const [scores, setScores]       = useState<TickerScore[]>([]);
  const [logs, setLogs]           = useState<LogEntry[]>([]);
  const [running, setRunning]     = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [lastScan, setLastScan]   = useState<Date | null>(null);
  const [runId, setRunId]         = useState("");

  // Per-preset client-side cache (persists within session)
  const sessionCache = useRef<Map<string, TickerScore[]>>(new Map());

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
    setPreset(name);
    setSymbols(PRESETS[name]);
    // Restore from session cache if available
    const cached = sessionCache.current.get(name);
    if (cached) {
      setScores(cached);
      setFromCache(true);
    } else {
      setScores([]);
      setFromCache(false);
    }
    setLogs([]);
    setRunId("");
    setLastScan(null);
  };

  const scan = useCallback(async () => {
    if (running || !symbols.length) return;
    setRunning(true); setLogs([]); setScores([]); setRunId(""); setFromCache(false);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const batchScores: TickerScore[] = [];

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
            addLog(p);
            if (p.step === "TICKER_SCORE") {
              const ts = p as unknown as TickerScore;
              batchScores.push(ts);
              setScores([...batchScores].sort((a, b) => Math.abs(b.total_score) - Math.abs(a.total_score)));
            }
            if (p.step === "CACHE_HIT") setFromCache(true);
            if (p.step === "SUMMARY" && p.run_id) setRunId(String(p.run_id));
          } catch { /* skip */ }
        }
      }

      // Save to session cache keyed by preset
      sessionCache.current.set(preset, [...batchScores].sort((a, b) => Math.abs(b.total_score) - Math.abs(a.total_score)));
      setLastScan(new Date());
    } catch (e) {
      addLog({ step: "ERROR", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, symbols, addLog, preset]);

  const longs    = scores.filter((s) => s.signal === "long").length;
  const shorts   = scores.filter((s) => s.signal === "short").length;
  const neutrals = scores.filter((s) => s.signal === "neutral").length;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
      background: "#131722", color: "#d1d4dc",
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    }}>

      {/* ── Header ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px", height: 44,
        background: "#1a1f2e", borderBottom: "1px solid #2a2e39", flexShrink: 0, gap: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#d1d4dc", letterSpacing: "-0.01em" }}>
            Signal Monitor
          </span>
          <span style={{ width: 1, height: 14, background: "#2a2e39" }} />
          <nav style={{ display: "flex", gap: 1 }}>
            {Object.keys(PRESETS).map((name) => (
              <button key={name} onClick={() => pickPreset(name)} style={{
                fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 4,
                border: "none", cursor: "pointer",
                background: preset === name ? "#2962ff" : "transparent",
                color: preset === name ? "#fff" : "#787b86",
                transition: "color 0.1s, background 0.1s",
              }}>
                {name}
                {sessionCache.current.has(name) && name !== preset && (
                  <span style={{ marginLeft: 4, width: 4, height: 4, borderRadius: "50%", background: "#26a69a", display: "inline-block", verticalAlign: "middle" }} />
                )}
              </button>
            ))}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11 }}>
          {scores.length > 0 && !running && (
            <div style={{ display: "flex", gap: 10 }}>
              {longs    > 0 && <span style={{ color: "#26a69a" }}>▲ {longs}</span>}
              {shorts   > 0 && <span style={{ color: "#ef5350" }}>▼ {shorts}</span>}
              {neutrals > 0 && <span style={{ color: "#4e5263" }}>{neutrals} neutral</span>}
            </div>
          )}
          {fromCache && !running && (
            <span style={{ fontSize: 10, color: "#26a69a", fontFamily: "monospace" }}>● cached</span>
          )}
          {lastScan && !running && (
            <span style={{ color: "#4e5263" }}>
              {lastScan.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          )}
          {running && (
            <span style={{ color: "#2962ff", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#2962ff", animation: "pulse 1s infinite" }} />
              Scanning…
            </span>
          )}
          <button onClick={scan} disabled={running || !symbols.length} style={{
            fontSize: 11, fontWeight: 600, padding: "5px 18px", borderRadius: 4, border: "none",
            cursor: running || !symbols.length ? "not-allowed" : "pointer",
            background: running || !symbols.length ? "#252836" : "#2962ff",
            color: running || !symbols.length ? "#3a3f50" : "#fff",
          }}>
            {running ? "Scanning…" : "Scan"}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Watchlist ── */}
        <aside style={{ width: 188, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "#161b28", borderRight: "1px solid #1e2230" }}>
          <div style={{ padding: "7px 12px", borderBottom: "1px solid #1e2230", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060" }}>Watchlist</span>
            <span style={{ fontSize: 10, color: "#3a4060" }}>{symbols.length}</span>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {symbols.map((sym) => <WatchlistRow key={sym} symbol={sym} />)}
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid #1e2230" }}>
            <div style={{ fontSize: 9, color: "#2a2e39", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Thresholds</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#26a69a" }}>● Long</span>
                <span style={{ color: "#2a2e39", fontFamily: "monospace" }}>≥ +0.55</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#ef5350" }}>● Short</span>
                <span style={{ color: "#2a2e39", fontFamily: "monospace" }}>≤ −0.55</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Signal table ── */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "6px 16px", borderBottom: "1px solid #1e2230", background: "#131722", flexShrink: 0, display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
            <span style={{ fontSize: 10, color: "#3a4060", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 }}>Signal Output</span>
            {scores.length > 0 && (
              <>
                <span style={{ color: "#1e2230" }}>·</span>
                <span style={{ fontSize: 10, color: "#2962ff" }}>{scores.length} scored</span>
              </>
            )}
          </div>

          {scores.length === 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <span style={{ fontSize: 28, color: "#1e2230" }}>◈</span>
              <p style={{ fontSize: 11, color: "#2a2e39", textAlign: "center", lineHeight: 1.8 }}>
                Choose a preset and click <span style={{ color: "#2962ff" }}>Scan</span>
              </p>
            </div>
          ) : (
            <div style={{ overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#161b28", borderBottom: "2px solid #1e2230", position: "sticky", top: 0, zIndex: 1 }}>
                    {["#", "Symbol", "Signal", "Score", "Headline", "Δ Today", ""].map((h, i) => (
                      <th key={i} style={{
                        padding: i === 0 ? "7px 8px 7px 16px" : "7px 12px",
                        textAlign: i === 5 ? "right" : "left",
                        fontSize: 9, fontWeight: 700,
                        textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060",
                        whiteSpace: "nowrap", userSelect: "none",
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s, i) => <SignalRow key={s.symbol} score={s} rank={i + 1} />)}
                </tbody>
              </table>
            </div>
          )}
        </main>

        {/* ── Pipeline ── */}
        <aside style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "#161b28", borderLeft: "1px solid #1e2230" }}>
          <div style={{ padding: "7px 12px", borderBottom: "1px solid #1e2230", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#3a4060" }}>Pipeline</span>
            {running && (
              <span style={{ fontSize: 9, color: "#2962ff", display: "flex", alignItems: "center", gap: 4 }}>
                <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "#2962ff", display: "inline-block" }} />
                Live
              </span>
            )}
          </div>

          {/* Summary */}
          {scores.length > 0 && !running && (
            <div style={{ padding: "8px 12px", borderBottom: "1px solid #1e2230", display: "flex", gap: 10, fontSize: 10 }}>
              {longs    > 0 && <span style={{ color: "#26a69a" }}>▲ {longs} long</span>}
              {shorts   > 0 && <span style={{ color: "#ef5350" }}>▼ {shorts} short</span>}
              {neutrals > 0 && <span style={{ color: "#4e5263" }}>{neutrals} neutral</span>}
              {fromCache && <span style={{ color: "#26a69a", marginLeft: "auto" }}>cached</span>}
            </div>
          )}

          <div style={{ overflowY: "auto", flex: 1, padding: "6px 12px" }}>
            {logs.length === 0 ? (
              <p style={{ fontSize: 10, color: "#1e2230", textAlign: "center", marginTop: 28 }}>—</p>
            ) : (
              <>
                {logs.map((e) => <ActivityEntry key={e.id} entry={e} />)}
                <div ref={logEndRef} />
              </>
            )}
          </div>

          {/* Prometheux */}
          <div style={{ borderTop: "1px solid #1e2230", padding: "10px 12px" }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#4c1d95", marginBottom: 6 }}>
              Prometheux · Vadalog
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: "#2a2e39" }}>
              <div>◻ Score decay (t ≥ 2d)</div>
              <div>◻ Concentration guardrails</div>
              <div>◻ Macro override signals</div>
              <div>◻ Cross-ticker propagation</div>
            </div>
          </div>
        </aside>

      </div>
    </div>
  );
}
