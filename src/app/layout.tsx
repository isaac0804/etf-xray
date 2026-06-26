import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ETF X-Ray | Event Monitor",
  description: "Per-ticker ETF event monitor — Tavily + Gemini + Yahoo Finance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
