import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

const rootEnvPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(rootEnvPath)) {
  fs.readFileSync(rootEnvPath, "utf8").split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

const nextConfig: NextConfig = {};
export default nextConfig;
