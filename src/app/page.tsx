"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PriceData {
  symbol: string;
  price: number;
  prev_close: number;
  change_pct: string;
  currency: string;
  series: { date: string; close: number }[];
}

interface TickerScore {
  symbol: string;
  name: string;
  signal: "long" | "short" | "neutral";
  total_score: number;
  price_change_pct: number | null;
  event_count: number;
  strongest_event_type: string;
  strongest_event_score: number;
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

const PRESET_WATCHLISTS: Record<string, string[]> = {
  mag7:    ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"],
  semis:   ["NVDA", "AMD", "AVGO", "QCOM", "MU", "TSM", "INTC"],
  energy:  ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX"],
  banks:   ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW"],
  indices: ["SPY", "QQQ", "IWM", "SMH", "XLK", "LIT", "GLD"],
};

const SIGNAL_STYLE = {
  long:    { bg: "rgba(16,185,129,0.12)", border: "#065f46", badge: "bg-emerald-900/60 text-emerald-300", dot: "bg-emerald-400" },
  short:   { bg: "rgba(239,68,68,0.10)",  border: "#7f1d1d", badge: "bg-red-900/60 text-red-300",     dot: "bg-red-400"     },
  neutral: { bg: "rgba(100,116,139,0.08)",border: "#1e293b", badge: "bg-slate-800 text-slate-400",    dot: "bg-slate-500"   },
};

const STEP_META: Record<string, { label: string; color: string }> = {
  PIPELINE_START:   { label: "Pipeline",   color: "text-slate-400"  },
  SYMBOLS_RESOLVED: { label: "Symbols",    color: "text-blue-400"   },
  TAVILY_FETCH:     { label: "Tavily",     color: "text-sky-400"    },
  TAVILY_DONE:      { label: "Tavily",     color: "text-sky-300"    },
  GEMINI_EXTRACT:   { label: "Gemini",     color: "text-violet-400" },
  GEMINI_DONE:      { label: "Gemini",     color: "text-violet-300" },
  SUMMARY:          { label: "Summary",    color: "text-blue-300"   },
  TICKER_SCORE:     { label: "Score",      color: "text-green-400"  },
  PIPELINE_DONE:    { label: "Done",       color: "text-green-400"  },
  ERROR:            { label: "Error",      color: "text-red-400"    },
  STDERR:           { label: "Stderr",     color: "text-red-400"    },
  SIGNAL_LINE:      { label: "Signal",     color: "text-cyan-300"   },
};

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ series }: { series: { close: number }[] }) {
  const vals = series.map((s) => s.close).filter(Boolean);
  if (vals.length < 2) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const w = 72, h = 24;
  const pts = vals.map((v, i) =>
    `${(i / (vals.length - 1)) * w},${h - ((v - min) / range) * h}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} className="opacity-70">
      <polyline points={pts} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth="1.5" />
    </svg>
  );
}

// ── Ticker pill (watchlist) ───────────────────────────────────────────────────

function TickerPill({ symbol, selected, onClick }: { symbol: string; selected: boolean; onClick: () => void }) {
  const [price, setPrice] = useState<{ change_pct: string; price: number; series: { close: number }[] } | null>(null);

  useEffect(() => {
    fetch(`/api/price?symbol=${symbol}`).then(r => r.json()).then(setPrice).catch(() => null);
  }, [symbol]);

  const up = price ? parseFloat(price.change_pct ?? "0") >= 0 : null;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg p-2.5 transition-all border"
      style={{
        background: selected ? "rgba(37,99,235,0.15)" : "rgba(15,23,42,0.5)",
        borderColor: selected ? "#3b82f6" : "#1e293b",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200">{symbol}</span>
        {price && (
          <span className="text-[10px] font-mono" style={{ color: up ? "#10b981" : "#ef4444" }}>
            {up ? "+" : ""}{price.change_pct}%
          </span>
        )}
      </div>
      {price && (
        <div className="flex items-end justify-between mt-1">
          <span className="text-[10px] text-slate-500 font-mono">${price.price?.toFixed(2)}</span>
          <Sparkline series={price.series} />
        </div>
      )}
    </button>
  );
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({ score }: { score: TickerScore }) {
  const style = SIGNAL_STYLE[score.signal];
  const absScore = Math.abs(score.total_score);

  return (
    <div
      className="rounded-xl border p-4 space-y-2"
      style={{ background: style.bg, borderColor: style.border }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-slate-100">{score.symbol}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${style.badge}`}>
          {score.signal}
        </span>
        {score.price_change_pct !== null && (
          <span className="ml-auto text-[10px] font-mono"
            style={{ color: (score.price_change_pct ?? 0) >= 0 ? "#10b981" : "#ef4444" }}>
            {(score.price_change_pct ?? 0) >= 0 ? "+" : ""}{score.price_change_pct?.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Score bar */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-500 w-10 shrink-0">Score</span>
        <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(absScore * 100, 100)}%`,
              background: score.signal === "long" ? "#10b981" : score.signal === "short" ? "#ef4444" : "#475569",
            }}
          />
        </div>
        <span className="text-[10px] font-mono text-slate-300 w-12 text-right shrink-0">
          {score.total_score > 0 ? "+" : ""}{score.total_score.toFixed(3)}
        </span>
      </div>

      {/* Top event */}
      {score.strongest_event_type && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 w-10 shrink-0">Event</span>
          <span className="text-[10px] font-mono text-violet-300 bg-violet-950/40 px-1.5 py-0.5 rounded">
            {score.strongest_event_type}
          </span>
          <span className="text-[10px] text-slate-500">{score.event_count} event{score.event_count !== 1 ? "s" : ""}</span>
        </div>
      )}

      {/* Explanation */}
      <p className="text-[11px] text-slate-400 leading-relaxed">{score.explanation}</p>

      {/* Top drivers */}
      {score.top_driver_titles.length > 0 && (
        <div className="space-y-0.5 pt-1 border-t border-slate-800/60">
          {score.top_driver_titles.slice(0, 2).map((title, i) => (
            <p key={i} className="text-[10px] text-slate-600 truncate">· {title}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Activity log line ─────────────────────────────────────────────────────────

function LogLine({ entry }: { entry: LogEntry }) {
  const meta = STEP_META[entry.step] ?? { label: entry.step, color: "text-slate-500" };
  if (!entry.message || entry.step === "TICKER_SCORE" || entry.step === "SUMMARY") return null;
  return (
    <div className="log-entry flex items-start gap-2 py-1 border-b border-slate-800/30 last:border-0">
      <span className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 w-20 ${meta.color}`}>
        {meta.label}
      </span>
      <p className="text-[11px] text-slate-300 leading-relaxed flex-1">{entry.message}</p>
      {entry.ts && (
        <span className="text-[9px] text-slate-700 font-mono shrink-0">
          {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
        </span>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [activeList, setActiveList] = useState<string>("mag7");
  const [selected, setSelected]     = useState<string[]>(PRESET_WATCHLISTS.mag7);
  const [scores, setScores]         = useState<TickerScore[]>([]);
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const [running, setRunning]       = useState(false);
  const [runId, setRunId]           = useState<string>("");
  const logIdRef  = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((raw: Record<string, unknown>) => {
    setLogs(prev => [...prev, {
      id:      logIdRef.current++,
      step:    String(raw.step ?? "INFO"),
      message: raw.message as string | undefined,
      ts:      raw.ts as string | undefined,
    }]);
  }, []);

  const selectPreset = (name: string) => {
    setActiveList(name);
    setSelected(PRESET_WATCHLISTS[name]);
  };

  const toggleSymbol = (sym: string) =>
    setSelected(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);

  const runScan = useCallback(async () => {
    if (running || selected.length === 0) return;
    setRunning(true);
    setLogs([]);
    setScores([]);
    setRunId("");

    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: selected }),
      });
      if (!res.body) throw new Error("No stream");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const line = chunk.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            addLog(parsed);
            if (parsed.step === "TICKER_SCORE") {
              setScores(prev => {
                const next = [...prev, parsed as unknown as TickerScore];
                return next.sort((a, b) => Math.abs(b.total_score) - Math.abs(a.total_score));
              });
            }
            if (parsed.step === "SUMMARY" && parsed.run_id) {
              setRunId(String(parsed.run_id));
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      addLog({ step: "ERROR", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, selected, addLog]);

  const longCount    = scores.filter(s => s.signal === "long").length;
  const shortCount   = scores.filter(s => s.signal === "short").length;
  const neutralCount = scores.filter(s => s.signal === "neutral").length;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0f1e" }}>
      {/* Header */}
      <header className="border-b sticky top-0 z-10"
        style={{ background: "rgba(13,21,38,0.92)", borderColor: "#1e293b", backdropFilter: "blur(8px)" }}>
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-sm font-bold text-slate-100 tracking-tight">ETF X-Ray — Event Signal Monitor</h1>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Tavily · Gemini Event Extraction · Keyword Rules · ClickHouse
            </p>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            {scores.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-emerald-400">{longCount} long</span>
                <span className="text-red-400">{shortCount} short</span>
                <span className="text-slate-500">{neutralCount} neutral</span>
              </div>
            )}
            {runId && <span className="text-slate-600 font-mono text-[10px]">run/{runId.slice(0, 8)}</span>}
            {running && (
              <span className="flex items-center gap-1.5 text-blue-400">
                <svg className="spinner w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"
                    strokeDasharray="50" strokeDashoffset="15" />
                </svg>
                Scanning…
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 py-4 grid grid-cols-1 lg:grid-cols-[220px_1fr_300px] gap-4">

        {/* ── LEFT: Watchlist selector ── */}
        <section className="flex flex-col gap-3">
          {/* Preset tabs */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Preset</p>
            <div className="flex flex-wrap gap-1">
              {Object.keys(PRESET_WATCHLISTS).map(name => (
                <button key={name} onClick={() => selectPreset(name)}
                  className="text-[10px] px-2 py-1 rounded-lg font-semibold uppercase tracking-wide transition-all"
                  style={{
                    background: activeList === name ? "#2563eb" : "rgba(30,41,59,0.8)",
                    color: activeList === name ? "#fff" : "#64748b",
                  }}>
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* Tickers */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Tickers — click to toggle
            </p>
            <div className="overflow-y-auto space-y-1.5" style={{ maxHeight: "calc(100vh - 160px)" }}>
              {selected.map(sym => (
                <TickerPill key={sym} symbol={sym} selected={true} onClick={() => toggleSymbol(sym)} />
              ))}
            </div>
          </div>

          {/* Scan button */}
          <button onClick={runScan} disabled={running || selected.length === 0}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all mt-auto"
            style={running || selected.length === 0
              ? { background: "#1e293b", color: "#475569", cursor: "not-allowed" }
              : { background: "#2563eb", color: "#fff", cursor: "pointer" }}>
            {running ? "Scanning…" : `Scan ${selected.length} ticker${selected.length !== 1 ? "s" : ""}`}
          </button>
        </section>

        {/* ── MIDDLE: Signal cards ── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Signal Output
            {scores.length > 0 && <span className="ml-2 text-slate-600 normal-case font-normal">sorted by absolute score</span>}
          </h2>

          {scores.length === 0 ? (
            <div className="flex-1 rounded-xl border flex flex-col items-center justify-center gap-2 py-20"
              style={{ borderColor: "#1e293b", background: "rgba(15,23,42,0.3)", color: "#334155" }}>
              <span className="text-3xl">◈</span>
              <p className="text-xs text-center max-w-xs">
                Select a watchlist preset and click Scan.<br />
                Signal cards appear here ranked by conviction score.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 overflow-y-auto"
              style={{ maxHeight: "calc(100vh - 120px)" }}>
              {scores.map(score => <SignalCard key={score.symbol} score={score} />)}
            </div>
          )}
        </section>

        {/* ── RIGHT: Activity log ── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Pipeline Activity</h2>

          <div className="flex-1 overflow-y-auto rounded-xl p-3"
            style={{
              border: "1px solid #1e293b",
              background: "rgba(15,23,42,0.4)",
              maxHeight: "calc(100vh - 120px)",
              minHeight: "200px",
            }}>
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-2"
                style={{ color: "#334155" }}>
                <p className="text-xs text-center">Pipeline activity streams here live</p>
              </div>
            ) : (
              <>
                {logs.map(e => <LogLine key={e.id} entry={e} />)}
                <div ref={logEndRef} />
              </>
            )}
          </div>

          {/* Prometheux placeholder */}
          <div className="rounded-xl p-3 space-y-1"
            style={{ border: "1px dashed #1e293b", background: "rgba(109,40,217,0.05)" }}>
            <p className="text-[10px] text-purple-600 font-semibold uppercase tracking-wider">
              Prometheux Vadalog Rules
            </p>
            <p className="text-[10px] text-slate-700 leading-relaxed">
              Deterministic signal rules fire here — wiring in later today.
              <br/>Score thresholds · decay · concentration guards
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
