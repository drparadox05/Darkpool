"use client";

import { Bot, Sparkles } from "lucide-react";
import { WalletButton } from "./WalletButton";

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/75 backdrop-blur-2xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-10">
        <a href="#top" className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300 via-sky-200 to-violet-300 text-slate-950 shadow-[0_0_28px_rgba(56,189,248,0.35)]">
            <Bot size={18} strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-white">AgentMute</p>
            <p className="hidden text-[11px] uppercase tracking-[0.25em] text-cyan-200/70 sm:block">Private agent OTC</p>
          </div>
        </a>

        <nav className="hidden items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-slate-300 lg:flex">
          <a href="#product" className="rounded-full px-4 py-2 transition hover:bg-white/[0.06] hover:text-white">Product</a>
          <a href="#pmf" className="rounded-full px-4 py-2 transition hover:bg-white/[0.06] hover:text-white">PMF</a>
          <a href="#market" className="rounded-full px-4 py-2 transition hover:bg-white/[0.06] hover:text-white">Market</a>
          <a href="#console" className="rounded-full px-4 py-2 transition hover:bg-white/[0.06] hover:text-white">Console</a>
          <a href="#tape" className="transition hover:text-white">A2A tape</a>
        </nav>

        <div className="flex items-center gap-3">
          <a href="#console" className="hidden items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:border-cyan-300/40 hover:bg-cyan-300/15 md:inline-flex">
            <Sparkles size={14} />
            Live demo
          </a>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
