import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { queryFreshSignals } from "@/lib/clickhouse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Load root .env.local into process.env
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

const encoder = new TextEncoder();
function sse(obj: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const symbols: string[] =
    body.symbols?.length ? body.symbols
    : (body.topic ?? "").trim().split(/[\s,]+/).filter(Boolean);
  const force: boolean    = body.force === true;
  // Preset name passed by the frontend so Python stores the right watchlist key
  const watchlist: string = (body.watchlist ?? "").trim() || "custom";

  const stream = new ReadableStream({
    async start(controller) {
      // ── Cache check ──────────────────────────────────────────────────────
      if (!force) {
        const cached = await queryFreshSignals(symbols);
        if (cached) {
          const ts = new Date().toISOString();
          controller.enqueue(sse({ step: "CACHE_HIT", ts, symbols,
            message: `Cache hit — ${cached.length} signals from ClickHouse` }));
          for (const row of cached) {
            controller.enqueue(sse({ step: "TICKER_SCORE", ts, from_cache: true, ...row }));
          }
          controller.enqueue(sse({ step: "SUMMARY", ts, symbols, signal_count: cached.length }));
          controller.enqueue(sse({ step: "PIPELINE_DONE", ts,
            message: `Served ${cached.length} cached signals` }));
          controller.close();
          return;
        }
      }

      // ── Live scan ────────────────────────────────────────────────────────
      const root = path.join(process.cwd(), "..");
      const venvPython = process.platform === "win32"
        ? path.join(root, "venv", "Scripts", "python.exe")
        : path.join(root, "venv", "bin", "python3");
      const backendVenv = process.platform === "win32"
        ? path.join(root, "backend", "venv", "Scripts", "python.exe")
        : path.join(root, "backend", "venv", "bin", "python3");
      const pythonBin = fs.existsSync(venvPython) ? venvPython
        : fs.existsSync(backendVenv) ? backendVenv
        : (process.platform === "win32" ? "python" : "python3");

      // Pass --watchlist so Python stores the correct name in signal_cache
      const child = spawn(
        pythonBin,
        [path.join(root, "run_strategy.py"), "--watchlist", watchlist, ...symbols],
        { cwd: root, env: { ...process.env } },
      );

      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) controller.enqueue(sse({ step: "STDERR", message: msg }));
      });
      child.on("close", (code) => {
        if (buf.trim()) controller.enqueue(encoder.encode(`data: ${buf.trim()}\n\n`));
        controller.enqueue(sse({ step: "STREAM_END", exitCode: code }));
        controller.close();
      });
      child.on("error", (err) => {
        controller.enqueue(sse({ step: "PROCESS_ERROR", message: err.message }));
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
