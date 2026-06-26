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

interface LogEntry {
  id: number;
  step: string;
  message?: string;
  ts?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WATCHLIST = ["QQQ", "SMH", "LIT", "SPY", "XLK", "ARKK", "XLE", "IBB", "GLD", "TLT"];

const STEP_COLORS: Record<string, string> = {
  BRIEF_START: "text-slate-400",
  TOPIC:       "text-blue-300",
  TAVILY:      "text-sky-300",
  YAHOO:       "text-cyan-300",
  ALPHA:       "text-violet-300",
  BRIEF:       "text-green-300",
  WARNINGS:    "text-amber-400",
  BRIEF_DONE:  "text-green-400",
  ERROR:       "text-red-400",
  STDERR:      "text-red-400",
};

const STEP_ICONS: Record<string, string> = {
  BRIEF_START: "◈",
  TOPIC:       "◎",
  TAVILY:      "⊙",
  YAHOO:       "↯",
  ALPHA:       "◌",
  BRIEF:       "✦",
  WARNINGS:    "!",
  BRIEF_DONE:  "✓",
  ERROR:       "✕",
  STDERR:      "✕",
};

// ── Tiny sparkline ────────────────────────────────────────────────────────────

function Sparkline({ series }: { series: { close: number }[] }) {
  const vals = series.map((s) => s.close).filter(Boolean);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 80, h = 28;
  const pts = vals
    .map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} className="opacity-80">
      <polyline points={pts} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth="1.5" />
    </svg>
  );
}

// ── Ticker card ───────────────────────────────────────────────────────────────

function TickerCard({
  symbol,
  selected,
  onClick,
}: {
  symbol: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [data, setData] = useState<PriceData | null>(null);

  useEffect(() => {
    fetch(`/api/price?symbol=${symbol}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => null);
  }, [symbol]);

  const up = data ? parseFloat(data.change_pct ?? "0") >= 0 : null;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl p-3 transition-all border"
      style={{
        background: selected ? "rgba(37,99,235,0.15)" : "rgba(15,23,42,0.6)",
        borderColor: selected ? "#3b82f6" : "#1e293b",
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-bold text-slate-100">{symbol}</span>
        {data && (
          <span
            className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
            style={{
              background: up ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
              color: up ? "#10b981" : "#ef4444",
            }}
          >
            {up ? "+" : ""}{data.change_pct}%
          </span>
        )}
      </div>
      {data ? (
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-base font-mono font-semibold text-slate-100">
              ${data.price?.toFixed(2)}
            </p>
            <p className="text-[10px] text-slate-500">{data.currency}</p>
          </div>
          <Sparkline series={data.series} />
        </div>
      ) : (
        <div className="h-10 flex items-center">
          <span className="text-[10px] text-slate-600">Loading…</span>
        </div>
      )}
    </button>
  );
}

// ── Brief log line ────────────────────────────────────────────────────────────

function LogLine({ entry }: { entry: LogEntry }) {
  const color = STEP_COLORS[entry.step] ?? "text-slate-400";
  const icon  = STEP_ICONS[entry.step]  ?? "·";
  if (!entry.message) return null;
  return (
    <div className="log-entry flex items-start gap-2 py-1.5 border-b border-slate-800/40 last:border-0">
      <span className={`text-xs font-mono shrink-0 mt-0.5 ${color}`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
            {entry.step}
          </span>
          {entry.ts && (
            <span className="text-[9px] text-slate-600 font-mono">
              {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap">
          {entry.message}
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [selected, setSelected]   = useState<string[]>(["QQQ", "SMH"]);
  const [logs, setLogs]           = useState<LogEntry[]>([]);
  const [brief, setBrief]         = useState<string>("");
  const [running, setRunning]     = useState(false);
  const [customQuery, setCustomQuery] = useState("");
  const logIdRef  = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const toggleTicker = (sym: string) =>
    setSelected((prev) =>
      prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym]
    );

  const addLog = useCallback((raw: Record<string, unknown>) => {
    setLogs((prev) => [
      ...prev,
      {
        id:      logIdRef.current++,
        step:    String(raw.step ?? "INFO"),
        message: raw.message as string | undefined,
        ts:      raw.ts as string | undefined,
      },
    ]);
    if (raw.step === "BRIEF") {
      setBrief((prev) => (prev ? prev + "\n" + String(raw.message) : String(raw.message)));
    }
  }, []);

  const runScan = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setLogs([]);
    setBrief("");

    const topic = customQuery.trim() || selected.join(" ");

    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
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
          try { addLog(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch (e) {
      addLog({ step: "ERROR", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, selected, customQuery, addLog]);

  const hasBrief = brief.length > 0;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0f1e" }}>
      {/* Header */}
      <header
        className="border-b sticky top-0 z-10"
        style={{ background: "rgba(13,21,38,0.92)", borderColor: "#1e293b", backdropFilter: "blur(8px)" }}
      >
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-sm font-bold text-slate-100 tracking-tight">ETF X-Ray — Event Monitor</h1>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Tavily Web Intelligence · Gemini Analysis · Yahoo Finance · ClickHouse
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span>{selected.length} ticker{selected.length !== 1 ? "s" : ""} selected</span>
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

      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 py-5 grid grid-cols-1 lg:grid-cols-[260px_1fr_320px] gap-4">

        {/* ── LEFT: Watchlist ── */}
        <section className="flex flex-col gap-2">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Watchlist — click to select
          </h2>
          <div className="overflow-y-auto space-y-2" style={{ maxHeight: "calc(100vh - 110px)" }}>
            {WATCHLIST.map((sym) => (
              <TickerCard
                key={sym}
                symbol={sym}
                selected={selected.includes(sym)}
                onClick={() => toggleTicker(sym)}
              />
            ))}
          </div>
        </section>

        {/* ── MIDDLE: Activity log ── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Live Intelligence Feed
          </h2>

          {/* Custom query or use selected tickers */}
          <div
            className="rounded-xl p-3 flex gap-2 items-center"
            style={{ border: "1px solid #1e293b", background: "rgba(15,23,42,0.6)" }}
          >
            <label className="text-[10px] text-slate-500 shrink-0">Topic</label>
            <input
              className="flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder-slate-600"
              value={customQuery}
              onChange={(e) => setCustomQuery(e.target.value)}
              placeholder={`Leave blank to scan: ${selected.join(", ") || "select tickers →"}`}
              disabled={running}
            />
          </div>

          <button
            onClick={runScan}
            disabled={running || selected.length === 0}
            className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
            style={
              running || selected.length === 0
                ? { background: "#1e293b", color: "#475569", cursor: "not-allowed" }
                : { background: "#2563eb", color: "#fff", cursor: "pointer" }
            }
          >
            {running ? "Scanning…" : `Scan ${customQuery.trim() || selected.join(" + ")}`}
          </button>

          <div
            className="flex-1 overflow-y-auto rounded-xl p-3"
            style={{
              border: "1px solid #1e293b",
              background: "rgba(15,23,42,0.4)",
              minHeight: "300px",
              maxHeight: "calc(100vh - 250px)",
            }}
          >
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-2"
                style={{ color: "#334155" }}>
                <span className="text-3xl">◈</span>
                <p className="text-xs text-center max-w-xs">
                  Select tickers from the watchlist, then click Scan.<br />
                  Tavily fetches live news, Gemini synthesises the brief.
                </p>
              </div>
            ) : (
              <>
                {logs.map((e) => <LogLine key={e.id} entry={e} />)}
                <div ref={logEndRef} />
              </>
            )}
          </div>
        </section>

        {/* ── RIGHT: Gemini Brief ── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Gemini ETF Brief
          </h2>

          <div
            className="flex-1 rounded-xl p-4 overflow-y-auto"
            style={{
              border: `1px solid ${hasBrief ? "rgba(99,102,241,0.4)" : "#1e293b"}`,
              background: hasBrief ? "rgba(49,46,129,0.12)" : "rgba(15,23,42,0.3)",
              minHeight: "300px",
              maxHeight: "calc(100vh - 130px)",
            }}
          >
            {hasBrief ? (
              <div>
                <p className="text-[10px] text-indigo-400 font-semibold uppercase tracking-wider mb-3">
                  ✦ AI-Generated Brief
                </p>
                <p className="text-[12px] text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {brief}
                </p>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-2"
                style={{ color: "#334155" }}>
                <span className="text-3xl">✦</span>
                <p className="text-xs text-center max-w-xs">
                  Gemini&apos;s synthesised ETF brief will appear here after the scan completes.
                </p>
              </div>
            )}
          </div>

          {/* Future: Prometheux risk rules panel placeholder */}
          <div
            className="rounded-xl p-3"
            style={{ border: "1px dashed #1e293b", background: "rgba(15,23,42,0.2)" }}
          >
            <p className="text-[10px] text-slate-600 font-semibold uppercase tracking-wider">
              Prometheux Risk Rules
            </p>
            <p className="text-[10px] text-slate-700 mt-1">
              Vadalog concentration &amp; hedge logic — wiring in later today
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
