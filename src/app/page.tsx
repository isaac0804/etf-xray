"use client";

import { useState, useRef, useCallback, useEffect } from "react";

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
  explanation: string;
  run_id?: string;
}

interface LogEntry {
  id: number;
  step: string;
  message?: string;
  ts?: string;
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
  long:    { fg: "#26a69a", bg: "rgba(38,166,154,0.10)", border: "rgba(38,166,154,0.35)" },
  short:   { fg: "#ef5350", bg: "rgba(239,83,80,0.10)",  border: "rgba(239,83,80,0.35)"  },
  neutral: { fg: "#787b86", bg: "transparent",            border: "#2a2e39"               },
};

const STEP_META: Record<string, { label: string; color: string }> = {
  PIPELINE_START:   { label: "Init",    color: "#787b86" },
  SYMBOLS_RESOLVED: { label: "Symbols", color: "#2962ff" },
  TAVILY_FETCH:     { label: "Tavily",  color: "#f59e0b" },
  TAVILY_DONE:      { label: "Tavily",  color: "#f59e0b" },
  GEMINI_EXTRACT:   { label: "Gemini",  color: "#818cf8" },
  GEMINI_DONE:      { label: "Gemini",  color: "#818cf8" },
  KEYWORDS_DONE:    { label: "Rules",   color: "#818cf8" },
  PROPAGATION:      { label: "Prop",    color: "#f59e0b" },
  PROPAGATION_DONE: { label: "Prop",    color: "#f59e0b" },
  SECTOR_ALERTS:    { label: "Sector",  color: "#a78bfa" },
  PIPELINE_DONE:    { label: "Done",    color: "#26a69a" },
  ERROR:            { label: "Error",   color: "#ef5350" },
  STDERR:           { label: "Stderr",  color: "#ef5350" },
};

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

function WatchlistRow({ symbol, onToggle }: { symbol: string; onToggle: () => void }) {
  const [data, setData] = useState<PriceData | null>(null);

  useEffect(() => {
    fetch(`/api/price?symbol=${symbol}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => null);
  }, [symbol]);

  const pct = data ? parseFloat(data.change_pct ?? "0") : 0;
  const up = pct >= 0;
  const color = up ? "#26a69a" : "#ef5350";

  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        padding: "7px 12px", textAlign: "left", border: "none",
        background: "transparent", cursor: "pointer",
        borderBottom: "1px solid #1e2230",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#1e2436")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#d1d4dc", letterSpacing: "0.01em" }}>
          {symbol}
        </div>
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
        ) : (
          <span style={{ fontSize: 11, color: "#2a2e39" }}>—</span>
        )}
      </div>
    </button>
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score, signal }: { score: number; signal: string }) {
  const pct = Math.min((Math.abs(score) / 1.2) * 100, 100);
  const color = SIG[signal as keyof typeof SIG]?.fg ?? "#787b86";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <div style={{ width: 56, height: 3, background: "#2a2e39", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: "monospace", color, minWidth: 50 }}>
        {score > 0 ? "+" : ""}{score.toFixed(3)}
      </span>
    </div>
  );
}

// ── Signal row (expandable) ───────────────────────────────────────────────────

function SignalRow({ score, rank }: { score: TickerScore; rank: number }) {
  const [open, setOpen] = useState(false);
  const { fg, bg, border } = SIG[score.signal];
  const pct = score.price_change_pct;
  const pctColor = pct != null ? (pct >= 0 ? "#26a69a" : "#ef5350") : "#787b86";

  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        style={{
          borderBottom: "1px solid #1e2230",
          cursor: "pointer",
          background: open ? "#1a1f30" : "transparent",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "#1e2230"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        <td style={{ padding: "10px 8px 10px 16px", fontSize: 10, color: "#3a4060", width: 28, fontFamily: "monospace" }}>
          {rank}
        </td>
        <td style={{ padding: "10px 12px", minWidth: 110 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#d1d4dc", letterSpacing: "0.02em" }}>
            {score.symbol}
          </div>
          <div style={{ fontSize: 10, color: "#787b86", marginTop: 2, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {score.name}
          </div>
        </td>
        <td style={{ padding: "10px 12px", width: 82 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
            padding: "3px 7px", borderRadius: 3,
            color: fg, background: bg, border: `1px solid ${border}`,
          }}>
            {score.signal}
          </span>
        </td>
        <td style={{ padding: "10px 12px", width: 130 }}>
          <ScoreBar score={score.total_score} signal={score.signal} />
        </td>
        <td style={{ padding: "10px 12px", width: 170 }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#9c9cf8" }}>
            {score.strongest_event_type || "—"}
          </span>
          <div style={{ fontSize: 10, color: "#787b86", marginTop: 2, display: "flex", gap: 6 }}>
            <span>{score.event_count} direct</span>
            {(score.propagation_count ?? 0) > 0 && (
              <span style={{ color: "#f59e0b" }}>+{score.propagation_count} prop</span>
            )}
          </div>
        </td>
        <td style={{ padding: "10px 12px", width: 76 }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 600, color: pctColor }}>
            {pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
          </span>
        </td>
        <td style={{ padding: "10px 12px" }}>
          <div style={{ fontSize: 11, color: "#787b86", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
            {score.top_driver_titles[0] ?? "—"}
          </div>
        </td>
        <td style={{ padding: "10px 12px 10px 4px", width: 20, fontSize: 9, color: "#787b86" }}>
          {open ? "▲" : "▼"}
        </td>
      </tr>

      {open && (
        <tr style={{ background: "#161b28", borderBottom: "1px solid #1e2230" }}>
          <td colSpan={8} style={{ padding: "14px 20px 14px 56px" }}>
            <p style={{ fontSize: 12, color: "#b2b5be", lineHeight: 1.7, marginBottom: 10 }}>
              {score.explanation}
            </p>

            {/* Score breakdown */}
            <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 11, fontFamily: "monospace" }}>
              <span style={{ color: "#787b86" }}>
                direct <span style={{ color: fg }}>{(score.direct_score ?? 0) > 0 ? "+" : ""}{(score.direct_score ?? 0).toFixed(3)}</span>
              </span>
              {(score.propagation_count ?? 0) > 0 && (
                <span style={{ color: "#787b86" }}>
                  propagated <span style={{ color: "#f59e0b" }}>{(score.propagated_score ?? 0) > 0 ? "+" : ""}{(score.propagated_score ?? 0).toFixed(3)}</span>
                </span>
              )}
              {score.risk_level && (
                <span style={{ color: "#787b86" }}>
                  risk <span style={{ color: score.risk_level.includes("HIGH") ? "#ef5350" : score.risk_level.includes("MEDIUM") ? "#f59e0b" : "#787b86" }}>
                    {score.risk_level}
                  </span>
                </span>
              )}
              {score.sector && <span style={{ color: "#3a4060" }}>{score.sector}</span>}
            </div>

            {/* Rules fired */}
            {score.rules_fired && score.rules_fired.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {score.rules_fired.map((r) => (
                  <span key={r} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "rgba(109,40,217,0.15)", color: "#a78bfa", border: "1px solid rgba(109,40,217,0.3)", fontFamily: "monospace" }}>
                    {r}
                  </span>
                ))}
              </div>
            )}

            {/* Top articles */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {score.top_driver_titles.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#2962ff", fontSize: 10, flexShrink: 0, marginTop: 1 }}>▸</span>
                  <span style={{ fontSize: 11, color: "#787b86", lineHeight: 1.5 }}>{t}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Activity entry ────────────────────────────────────────────────────────────

function ActivityEntry({ entry }: { entry: LogEntry }) {
  const skip = ["TICKER_SCORE", "SUMMARY", "YAHOO_FETCH", "SYMBOL_START"].includes(entry.step);
  if (skip || !entry.message) return null;
  const meta = STEP_META[entry.step] ?? { label: entry.step, color: "#787b86" };
  const time = entry.ts
    ? new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "";
  return (
    <div style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #1a1f2e" }}>
      <span style={{ fontSize: 10, fontWeight: 600, width: 44, flexShrink: 0, color: meta.color }}>
        {meta.label}
      </span>
      <p style={{ fontSize: 10, color: "#787b86", flex: 1, lineHeight: 1.55 }}>{entry.message}</p>
      {time && (
        <span style={{ fontSize: 9, color: "#2a2e39", flexShrink: 0, fontFamily: "monospace" }}>
          {time}
        </span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [preset, setPreset]     = useState("mag7");
  const [symbols, setSymbols]   = useState<string[]>(PRESETS.mag7);
  const [scores, setScores]     = useState<TickerScore[]>([]);
  const [logs, setLogs]         = useState<LogEntry[]>([]);
  const [running, setRunning]   = useState(false);
  const [runId, setRunId]       = useState("");
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const idRef     = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const addLog = useCallback((raw: Record<string, unknown>) => {
    setLogs((prev) => [
      ...prev,
      {
        id: idRef.current++,
        step: String(raw.step ?? "INFO"),
        message: raw.message as string | undefined,
        ts: raw.ts as string | undefined,
      },
    ]);
  }, []);

  const pickPreset = (name: string) => { setPreset(name); setSymbols(PRESETS[name]); };
  const toggleSym  = (sym: string) =>
    setSymbols((prev) => prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]);

  const scan = useCallback(async () => {
    if (running || !symbols.length) return;
    setRunning(true); setLogs([]); setScores([]); setRunId("");
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
              setScores((prev) =>
                [...prev, p as unknown as TickerScore].sort(
                  (a, b) => Math.abs(b.total_score) - Math.abs(a.total_score)
                )
              );
            }
            if (p.step === "SUMMARY" && p.run_id) setRunId(String(p.run_id));
          } catch { /* skip */ }
        }
      }
      setLastScan(new Date());
    } catch (e) {
      addLog({ step: "ERROR", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, symbols, addLog]);

  const longs    = scores.filter((s) => s.signal === "long").length;
  const shorts   = scores.filter((s) => s.signal === "short").length;
  const neutrals = scores.filter((s) => s.signal === "neutral").length;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
      background: "#131722", color: "#d1d4dc",
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    }}>

      {/* ── Top bar ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px", height: 48,
        background: "#1e222d", borderBottom: "1px solid #2a2e39", flexShrink: 0, gap: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#d1d4dc", letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
            Signal Monitor
          </span>
          <span style={{ width: 1, height: 16, background: "#2a2e39" }} />
          <nav style={{ display: "flex", gap: 2 }}>
            {Object.keys(PRESETS).map((name) => (
              <button key={name} onClick={() => pickPreset(name)} style={{
                fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 4,
                border: "none", cursor: "pointer",
                background: preset === name ? "#2962ff" : "transparent",
                color: preset === name ? "#fff" : "#787b86",
              }}>
                {name}
              </button>
            ))}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11 }}>
          {scores.length > 0 && (
            <div style={{ display: "flex", gap: 12 }}>
              {longs   > 0 && <span style={{ color: "#26a69a" }}>▲ {longs} long</span>}
              {shorts  > 0 && <span style={{ color: "#ef5350" }}>▼ {shorts} short</span>}
              {neutrals > 0 && <span style={{ color: "#787b86" }}>{neutrals} neutral</span>}
            </div>
          )}
          {runId && (
            <span style={{ fontSize: 10, color: "#3a4060", fontFamily: "monospace" }}>
              run/{runId.slice(0, 8)}
            </span>
          )}
          {lastScan && !running && (
            <span style={{ color: "#787b86" }}>
              Updated {lastScan.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          )}
          {running && (
            <span style={{ color: "#2962ff", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2962ff", animation: "pulse 1s infinite" }} />
              Scanning {symbols.length} tickers…
            </span>
          )}
          <button
            onClick={scan}
            disabled={running || !symbols.length}
            style={{
              fontSize: 11, fontWeight: 600, padding: "5px 16px", borderRadius: 4, border: "none",
              cursor: running || !symbols.length ? "not-allowed" : "pointer",
              background: running || !symbols.length ? "#252836" : "#2962ff",
              color: running || !symbols.length ? "#3a3f50" : "#fff",
              minWidth: 72,
            }}
          >
            {running ? "Scanning…" : "Scan"}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Left: Watchlist ── */}
        <aside style={{
          width: 196, flexShrink: 0, display: "flex", flexDirection: "column",
          overflow: "hidden", background: "#1a1f2e", borderRight: "1px solid #2a2e39",
        }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #2a2e39", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#787b86" }}>
              Watchlist
            </span>
            <span style={{ fontSize: 10, color: "#787b86" }}>{symbols.length}</span>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {symbols.map((sym) => (
              <WatchlistRow key={sym} symbol={sym} onToggle={() => toggleSym(sym)} />
            ))}
          </div>
          <div style={{ padding: "8px 12px", borderTop: "1px solid #2a2e39" }}>
            <div style={{ fontSize: 10, color: "#3a4060", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
              Thresholds
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#26a69a" }}>● Long</span>
                <span style={{ color: "#3a4060", fontFamily: "monospace" }}>≥ +0.35</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#ef5350" }}>● Short</span>
                <span style={{ color: "#3a4060", fontFamily: "monospace" }}>≤ −0.35</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Center: Signal table ── */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "7px 16px", borderBottom: "1px solid #2a2e39", background: "#131722", flexShrink: 0, display: "flex", alignItems: "center", gap: 8, minHeight: 34 }}>
            <span style={{ fontSize: 11, color: "#787b86" }}>Signal Output</span>
            {scores.length > 0 && (
              <>
                <span style={{ color: "#2a2e39" }}>·</span>
                <span style={{ fontSize: 11, color: "#2962ff" }}>{scores.length} scored</span>
                <span style={{ color: "#2a2e39" }}>·</span>
                <span style={{ fontSize: 11, color: "#787b86" }}>sorted by |score|</span>
              </>
            )}
          </div>

          {scores.length === 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <span style={{ fontSize: 32, color: "#2a2e39" }}>◈</span>
              <p style={{ fontSize: 12, color: "#3a4060", textAlign: "center", lineHeight: 1.7 }}>
                Choose a preset and click <span style={{ color: "#2962ff" }}>Scan</span><br />
                Signal rows appear here, sorted by conviction score
              </p>
            </div>
          ) : (
            <div style={{ overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#1a1f2e", borderBottom: "2px solid #2a2e39", position: "sticky", top: 0, zIndex: 1 }}>
                    {["#", "Symbol", "Signal", "Score", "Top Event", "Δ Today", "Top Article", ""].map((h, i) => (
                      <th key={i} style={{
                        padding: i === 0 ? "8px 8px 8px 16px" : "8px 12px",
                        textAlign: "left", fontSize: 10, fontWeight: 600,
                        textTransform: "uppercase", letterSpacing: "0.07em", color: "#787b86",
                        whiteSpace: "nowrap", userSelect: "none",
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s, i) => (
                    <SignalRow key={s.symbol} score={s} rank={i + 1} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>

        {/* ── Right: Activity + Prometheux ── */}
        <aside style={{
          width: 252, flexShrink: 0, display: "flex", flexDirection: "column",
          overflow: "hidden", background: "#1a1f2e", borderLeft: "1px solid #2a2e39",
        }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #2a2e39", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#787b86" }}>
              Pipeline
            </span>
            {running && (
              <span style={{ fontSize: 10, color: "#2962ff", display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#2962ff", animation: "pulse 1s infinite" }} />
                Live
              </span>
            )}
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: "6px 12px" }}>
            {logs.length === 0 ? (
              <p style={{ fontSize: 11, color: "#2a2e39", textAlign: "center", marginTop: 32 }}>
                Activity streams here during scan
              </p>
            ) : (
              <>
                {logs.map((e) => <ActivityEntry key={e.id} entry={e} />)}
                <div ref={logEndRef} />
              </>
            )}
          </div>

          {/* Prometheux */}
          <div style={{ borderTop: "1px solid #2a2e39", padding: "10px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#5b21b6", marginBottom: 7 }}>
              Prometheux · Vadalog
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: "#3a4060" }}>
              <div>◻ Score decay (t ≥ 2d)</div>
              <div>◻ Concentration guardrails</div>
              <div>◻ Macro override signals</div>
              <div>◻ Cross-ticker propagation</div>
            </div>
            <div style={{ marginTop: 8, fontSize: 10, color: "#4c2b8a" }}>Deterministic engine — wiring in</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
