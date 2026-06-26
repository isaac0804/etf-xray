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

// ── Event card (news-feed style) ──────────────────────────────────────────────

const DIR_COLOR: Record<string, string> = { up: "#26a69a", down: "#ef5350", neutral: "#4e5263", mixed: "#f59e0b" };
const THEME_COLOR: Record<string, string> = {
  geopolitical_risk: "#ef5350", supply_chain: "#f59e0b", earnings: "#26a69a",
  sell_side: "#818cf8", innovation: "#34d399", regulation: "#ef5350",
  strategic_activity: "#7dd3a8", demand: "#60a5fa", other: "#4e5263",
};

function EventCard({ group }: { group: EventGroup }) {
  const [expanded, setExpanded] = useState(false);
  const dirColor   = DIR_COLOR[group.direction] ?? "#4e5263";
  const themeColor = THEME_COLOR[group.macro_theme] ?? "#4e5263";
  const isNeg      = group.total_impact < 0;
  const topFact    = group.facts[0];
  const allTickers = [
    ...group.direct_tickers.map((t) => t.symbol),
    ...group.propagated_tickers.slice(0, 3).map((t) => t.target_symbol),
  ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);

  const domain = topFact?.source_url
    ? (() => { try { return new URL(topFact.source_url).hostname.replace(/^www\./, ""); } catch { return ""; } })()
    : "";

  // Clean up "Keyword fallback" summaries — don't show them
  const summary = topFact?.summary && !topFact.summary.toLowerCase().includes("keyword fallback")
    ? topFact.summary : null;

  return (
    <div style={{ borderBottom: "1px solid #161b28" }}>

      {/* ── Main card ── */}
      <div
        style={{
          padding: "18px 24px 16px",
          cursor: "pointer",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#0f1420")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Category line */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
            color: dirColor,
          }}>
            {fmtEvent(group.event_type)}
          </span>
          <span style={{ fontSize: 10, color: themeColor, opacity: 0.75 }}>
            · {group.macro_theme.replace(/_/g, " ")}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, fontFamily: "monospace", fontWeight: 600, color: dirColor }}>
            {group.total_impact > 0 ? "+" : ""}{group.total_impact.toFixed(3)}
          </span>
        </div>

        {/* Headline */}
        {topFact?.article_title && (
          topFact.source_url ? (
            <a
              href={topFact.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 15, fontWeight: 600, color: "#d4d8e2", lineHeight: 1.45,
                textDecoration: "none", display: "block", marginBottom: summary ? 8 : 12,
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#ffffff")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#d4d8e2")}
            >
              {topFact.article_title}
            </a>
          ) : (
            <span style={{
              fontSize: 15, fontWeight: 600, color: "#d4d8e2", lineHeight: 1.45,
              display: "block", marginBottom: summary ? 8 : 12,
            }}>
              {topFact.article_title}
            </span>
          )
        )}

        {/* Summary */}
        {summary && (
          <p style={{ fontSize: 13, color: "#6b7590", lineHeight: 1.65, margin: "0 0 12px" }}>
            {summary}
          </p>
        )}

        {/* Footer: domain · tickers */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {domain && (
            <span style={{ fontSize: 11, color: "#3a4060" }}>{domain}</span>
          )}
          {domain && allTickers.length > 0 && (
            <span style={{ fontSize: 10, color: "#252a3a" }}>·</span>
          )}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {allTickers.map((sym, i) => {
              const isProp = !group.direct_tickers.find((t) => t.symbol === sym);
              return (
                <span key={sym} style={{
                  fontSize: 11, fontWeight: 700, fontFamily: "monospace",
                  padding: "2px 7px", borderRadius: 3,
                  background: isProp
                    ? "rgba(245,158,11,0.07)"
                    : isNeg ? "rgba(239,83,80,0.08)" : "rgba(38,166,154,0.08)",
                  color: isProp
                    ? "#8a6020"
                    : isNeg ? "#d06060" : "#4aada5",
                  border: `1px solid ${isProp ? "rgba(245,158,11,0.12)" : isNeg ? "rgba(239,83,80,0.15)" : "rgba(38,166,154,0.15)"}`,
                }}>
                  {i > 0 && isProp && !group.direct_tickers.find((t) => t.symbol === allTickers[i - 1]) ? "" : ""}
                  {sym}
                </span>
              );
            })}
          </div>
          {(group.propagated_tickers.length > 0 || group.facts.length > 1) && (
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#2a3050" }}>
              {expanded ? "▲" : "▼"}
            </span>
          )}
        </div>
      </div>

      {/* ── Expanded: other sources + contagion ── */}
      {expanded && (
        <div style={{ padding: "0 24px 16px", borderTop: "1px solid #161b28" }}>

          {/* Other articles for this event type */}
          {group.facts.length > 1 && (
            <div style={{ paddingTop: 14, marginBottom: group.propagated_tickers.length > 0 ? 14 : 0 }}>
              {group.facts.slice(1).map((f, i) => {
                const fDomain = f.source_url
                  ? (() => { try { return new URL(f.source_url).hostname.replace(/^www\./, ""); } catch { return ""; } })()
                  : "";
                const fSummary = f.summary && !f.summary.toLowerCase().includes("keyword fallback") ? f.summary : null;
                return (
                  <div key={i} style={{
                    paddingTop: i > 0 ? 12 : 0,
                    marginTop: i > 0 ? 12 : 0,
                    borderTop: i > 0 ? "1px solid #161b28" : "none",
                  }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isNeg ? "#c05050" : "#3a9090", fontFamily: "monospace" }}>
                        {f.symbol}
                      </span>
                      {fDomain && <span style={{ fontSize: 10, color: "#2e3450" }}>{fDomain}</span>}
                    </div>
                    {f.source_url ? (
                      <a href={f.source_url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 13, color: "#8090b0", lineHeight: 1.5, textDecoration: "none", display: "block" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#b0c0d8")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#8090b0")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.article_title}
                      </a>
                    ) : (
                      <span style={{ fontSize: 13, color: "#8090b0", lineHeight: 1.5, display: "block" }}>
                        {f.article_title}
                      </span>
                    )}
                    {fSummary && (
                      <p style={{ fontSize: 12, color: "#4a5268", lineHeight: 1.6, margin: "4px 0 0" }}>{fSummary}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Contagion ripple */}
          {group.propagated_tickers.length > 0 && (
            <div style={{ paddingTop: 14, borderTop: group.facts.length > 1 ? "1px solid #161b28" : "none" }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#2a3050", marginBottom: 10 }}>
                Contagion
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {group.propagated_tickers.map((t, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#5570a0", fontFamily: "monospace", minWidth: 40 }}>{t.source_symbol}</span>
                    <span style={{ fontSize: 10, color: "#252a3a" }}>→</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#8a6020", fontFamily: "monospace", minWidth: 40 }}>{t.target_symbol}</span>
                    <span style={{ fontSize: 11, color: "#3a4060", flex: 1 }}>{t.relationship.replace(/_/g, " ")}</span>
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

  // Per-preset client-side caches (persist within session)
  const sessionCache      = useRef<Map<string, TickerScore[]>>(new Map());
  const sessionEventFacts = useRef<Map<string, EventFact[]>>(new Map());
  const sessionPropFacts  = useRef<Map<string, PropagationFact[]>>(new Map());

  // Per-preset scan status for tab indicators
  const [presetStatus, setPresetStatus] = useState<Record<string, "idle" | "scanning" | "done">>(
    () => Object.fromEntries(Object.keys(PRESETS).map((k) => [k, "idle"]))
  );

  // Ref so async scan callbacks always see the currently-active tab
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

  // Core scan — works for any preset, updates UI only when that preset is active
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
        body: JSON.stringify({ symbols: syms, force }),
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
              batchScores.push(p as unknown as TickerScore);
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

  // On mount: scan every preset sequentially (ClickHouse cache makes stale-hits instant)
  const didScanAll = useRef(false);
  useEffect(() => {
    if (didScanAll.current) return;
    didScanAll.current = true;
    (async () => {
      for (const [name, syms] of Object.entries(PRESETS)) {
        await scanPreset(name, syms);
      }
    })();
  // scanPreset is stable (addLog has [] deps); only run once on mount
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
      if (!grouped.has(key)) {
        grouped.set(key, { facts: [], macro_themes: [], directions: [], direct: new Map(), propagated: [] });
      }
      const g = grouped.get(key)!;
      g.facts.push(ef);
      g.macro_themes.push(ef.macro_theme);
      g.directions.push(ef.direction);
      // Merge per-symbol: keep highest |score| fact
      const existing = g.direct.get(ef.symbol);
      if (!existing || Math.abs(ef.base_event_score) > Math.abs(existing.base_event_score)) {
        g.direct.set(ef.symbol, { base_event_score: ef.base_event_score, severity_label: ef.severity_label });
      }
    }

    for (const pf of propFacts) {
      const key = pf.event_type;
      if (grouped.has(key)) {
        grouped.get(key)!.propagated.push(pf);
      }
    }

    const groups: EventGroup[] = [];
    for (const [event_type, g] of grouped.entries()) {
      // dominant macro_theme
      const themeCounts: Record<string, number> = {};
      for (const t of g.macro_themes) themeCounts[t] = (themeCounts[t] ?? 0) + 1;
      const macro_theme = Object.entries(themeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";

      // direction
      const ups   = g.directions.filter((d) => d === "up").length;
      const downs = g.directions.filter((d) => d === "down").length;
      const direction: EventGroup["direction"] =
        ups > 0 && downs === 0 ? "up"
        : downs > 0 && ups === 0 ? "down"
        : ups > 0 && downs > 0 ? "mixed"
        : "neutral";

      // severity
      const sevOrder = { high: 2, medium: 1, low: 0 };
      const max_severity: EventGroup["max_severity"] = g.facts.reduce<EventGroup["max_severity"]>((best, f) => {
        return (sevOrder[f.severity_label as keyof typeof sevOrder] ?? 0) > (sevOrder[best] ?? 0)
          ? (f.severity_label as EventGroup["max_severity"])
          : best;
      }, "low");

      // total impact = sum of direct scores + sum of propagated impact_scores
      const directSum = Array.from(g.direct.values()).reduce((s, v) => s + v.base_event_score, 0);
      const propSum   = g.propagated.reduce((s, p) => s + p.impact_score, 0);
      const total_impact = directSum + propSum;

      // sort direct tickers by |score| desc
      const direct_tickers = Array.from(g.direct.entries())
        .map(([symbol, v]) => ({ symbol, ...v }))
        .sort((a, b) => Math.abs(b.base_event_score) - Math.abs(a.base_event_score));

      // deduplicate propagated by target_symbol (keep highest |impact_score|)
      const propByTarget = new Map<string, PropagationFact>();
      for (const pf of g.propagated) {
        const ex = propByTarget.get(pf.target_symbol);
        if (!ex || Math.abs(pf.impact_score) > Math.abs(ex.impact_score)) {
          propByTarget.set(pf.target_symbol, pf);
        }
      }
      const propagated_tickers = Array.from(propByTarget.values())
        .map((pf) => ({ symbol: pf.target_symbol, target_symbol: pf.target_symbol, impact_score: pf.impact_score, relationship: pf.relationship, source_symbol: pf.source_symbol }))
        .sort((a, b) => Math.abs(b.impact_score) - Math.abs(a.impact_score));

      // sort facts by |score| desc
      const facts = [...g.facts].sort((a, b) => Math.abs(b.base_event_score) - Math.abs(a.base_event_score));

      groups.push({ event_type, macro_theme, direction, direct_tickers, propagated_tickers, facts, total_impact, max_severity });
    }

    return groups.sort((a, b) => Math.abs(b.total_impact) - Math.abs(a.total_impact));
  }, [eventFacts, propFacts]);

  const filteredGroups = useMemo(() => {
    if (evtFilter === "all") return eventGroups;
    return eventGroups.filter((g) =>
      evtFilter === "up"   ? (g.direction === "up"   || (g.direction === "mixed" && g.total_impact > 0)) :
      evtFilter === "down" ? (g.direction === "down" || (g.direction === "mixed" && g.total_impact < 0)) :
      true
    );
  }, [eventGroups, evtFilter]);

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
            {Object.keys(PRESETS).map((name) => {
              const st = presetStatus[name];
              return (
                <button key={name} onClick={() => pickPreset(name)} style={{
                  fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 4,
                  border: "none", cursor: "pointer",
                  background: preset === name ? "#2962ff" : "transparent",
                  color: preset === name ? "#fff" : st === "done" ? "#787b86" : "#4e5263",
                  transition: "color 0.1s, background 0.1s",
                  display: "flex", alignItems: "center", gap: 4,
                }}>
                  {name}
                  {st === "scanning" && (
                    <span className="pulse-dot" style={{ width: 4, height: 4, borderRadius: "50%", background: preset === name ? "#fff" : "#2962ff", display: "inline-block" }} />
                  )}
                  {st === "done" && name !== preset && (
                    <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#26a69a", display: "inline-block" }} />
                  )}
                </button>
              );
            })}
          </nav>

          {/* View toggle */}
          <span style={{ width: 1, height: 14, background: "#2a2e39" }} />
          <div style={{ display: "flex", gap: 1, background: "#0e1220", borderRadius: 5, padding: 2 }}>
            {(["ticker", "event"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} style={{
                fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 3,
                border: "none", cursor: "pointer",
                background: view === v ? "#1e2a44" : "transparent",
                color: view === v ? "#d1d4dc" : "#4e5263",
                transition: "all 0.1s",
              }}>
                {v === "ticker" ? "Ticker" : "Event"}
              </button>
            ))}
          </div>
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
          <button
            onClick={() => scanPreset(preset, symbols, true)}
            disabled={running || Object.values(presetStatus).some((s) => s === "scanning")}
            style={{
              fontSize: 11, fontWeight: 600, padding: "5px 18px", borderRadius: 4, border: "none",
              cursor: running ? "not-allowed" : "pointer",
              background: running ? "#252836" : "#1e3a6e",
              color: running ? "#3a3f50" : "#7aabff",
            }}
            title="Force a fresh scan for the current tab, bypassing cache"
          >
            {running ? "Scanning…" : "↺ Rescan"}
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

        {/* ── Main content area ── */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {view === "ticker" ? (
            /* ── Ticker view ── */
            <>
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
                    {presetStatus[preset] === "scanning" ? "Scanning…" : "Loading…"}
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
            </>
          ) : (
            /* ── Event view ── */
            <>
              {/* Sub-header */}
              <div style={{ padding: "6px 16px", borderBottom: "1px solid #1e2230", background: "#131722", flexShrink: 0, display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}>
                <span style={{ fontSize: 10, color: "#3a4060", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 }}>Event Feed</span>
                {eventGroups.length > 0 && (
                  <>
                    <span style={{ color: "#1e2230" }}>·</span>
                    <span style={{ fontSize: 10, color: "#2962ff" }}>{eventGroups.length} events</span>
                    <span style={{ color: "#1e2230" }}>·</span>
                    <span style={{ fontSize: 10, color: "#787b86" }}>{eventFacts.length} facts</span>
                    {propFacts.length > 0 && (
                      <>
                        <span style={{ color: "#1e2230" }}>·</span>
                        <span style={{ fontSize: 10, color: "#f59e0b" }}>{propFacts.length} contagion</span>
                      </>
                    )}
                  </>
                )}
                {/* Direction filter */}
                <div style={{ marginLeft: "auto", display: "flex", gap: 2, background: "#0e1220", borderRadius: 4, padding: 2 }}>
                  {(["all", "up", "down"] as const).map((f) => (
                    <button key={f} onClick={() => setEvtFilter(f)} style={{
                      fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 3,
                      border: "none", cursor: "pointer",
                      background: evtFilter === f ? "#1e2a44" : "transparent",
                      color: evtFilter === f
                        ? (f === "up" ? "#26a69a" : f === "down" ? "#ef5350" : "#d1d4dc")
                        : "#4e5263",
                    }}>
                      {f === "all" ? "All" : f === "up" ? "↑ Positive" : "↓ Negative"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Card feed */}
              {eventGroups.length === 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
                  <span style={{ fontSize: 28, color: "#1e2230" }}>◈</span>
                  <p style={{ fontSize: 11, color: "#2a2e39", textAlign: "center", lineHeight: 1.8 }}>
                    {running ? "Collecting events…" : "Scan to see market events and their cross-ticker impact"}
                  </p>
                </div>
              ) : (
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {filteredGroups.map((g) => (
                    <EventCard key={g.event_type} group={g} />
                  ))}
                </div>
              )}
            </>
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
