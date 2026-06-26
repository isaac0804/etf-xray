import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Load root .env.local into process.env at startup
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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  // Accept either {symbols: ["NVDA","AMD"]} or legacy {topic: "NVDA AMD"}
  const symbols: string[] =
    body.symbols?.length ? body.symbols
    : (body.topic ?? "").trim().split(/[\s,]+/).filter(Boolean);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const root = path.join(process.cwd(), "..");
      const venvPython = process.platform === "win32"
        ? path.join(root, "venv", "Scripts", "python.exe")
        : path.join(root, "venv", "bin", "python3");
      const backendVenv = process.platform === "win32"
        ? path.join(root, "backend", "venv", "Scripts", "python.exe")
        : path.join(root, "backend", "venv", "bin", "python3");
      const systemPython = process.platform === "win32" ? "python" : "python3";
      const pythonBin = fs.existsSync(venvPython) ? venvPython
        : fs.existsSync(backendVenv) ? backendVenv
        : systemPython;

      const child = spawn(pythonBin, [path.join(root, "run_strategy.py"), ...symbols], {
        cwd: root,
        env: { ...process.env },
      });

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
        if (msg) controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ step: "STDERR", message: msg })}\n\n`
        ));
      });
      child.on("close", (code) => {
        if (buf.trim()) controller.enqueue(encoder.encode(`data: ${buf.trim()}\n\n`));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ step: "STREAM_END", exitCode: code })}\n\n`
        ));
        controller.close();
      });
      child.on("error", (err) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ step: "PROCESS_ERROR", message: err.message })}\n\n`
        ));
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
