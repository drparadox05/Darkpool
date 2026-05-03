"use client";

import { ArrowRight, CheckCircle2, LockKeyhole, Radio, ShieldCheck, Sparkles } from "lucide-react";
import { InfraStrip } from "./InfraStrip";

export function Hero() {
  return (
    <section className="mx-auto grid max-w-7xl gap-10 px-4 pb-12 pt-14 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:px-10 lg:pb-16 lg:pt-20">
      <div className="relative">
        <div className="absolute -left-8 top-10 hidden h-32 w-32 rounded-full bg-cyan-300/20 blur-3xl lg:block"></div>
        <p className="relative inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-100">
          <Sparkles size={13} />
          Agent-to-agent OTC network
        </p>
        <h1 className="relative mt-6 max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl lg:text-7xl">
          Private RFQ and settlement rails for{" "}
          <span className="bg-gradient-to-r from-cyan-200 via-sky-200 to-violet-300 bg-clip-text text-transparent">AI treasury agents.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
          AgentMute lets wallets and autonomous trading agents negotiate large OTC intents privately, sign EIP-712 orders, and settle on-chain with 0G-backed compute and storage proof.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#console"
            className="inline-flex items-center gap-2 rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
          >
            Open live console
            <ArrowRight size={16} />
          </a>
          <a
            href="#product"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm text-slate-200 transition hover:bg-white/[0.06]"
          >
            See product story
          </a>
        </div>

        <div className="mt-9 grid max-w-2xl gap-3 sm:grid-cols-3">
          {[
            { icon: <LockKeyhole size={16} />, label: "Dark RFQ", value: "Intent stays private" },
            { icon: <Radio size={16} />, label: "A2A", value: "Gensyn AXL peers" },
            { icon: <ShieldCheck size={16} />, label: "Settlement", value: "Galileo + EIP-712" }
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <div className="flex items-center gap-2 text-cyan-200">
                {item.icon}
                <p className="text-xs font-semibold uppercase tracking-[0.18em]">{item.label}</p>
              </div>
              <p className="mt-2 text-sm text-slate-300">{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="relative">
        <div className="absolute -inset-5 rounded-[2rem] bg-gradient-to-br from-cyan-300/20 via-transparent to-violet-400/20 blur-2xl"></div>
        <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 p-5 shadow-2xl shadow-cyan-950/40 backdrop-blur">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Live execution model</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Intent-to-settlement loop</h2>
            </div>
            {/* <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-medium text-emerald-100">Mainnet-style demo</span> */}
          </div>

          <div className="mt-5 space-y-3">
            {[
              ["01", "Trader describes private OTC intent", "mUSDC → mWETH without public book leakage"],
              ["02", "AXL peer quotes and counters", "Agent policy prices risk and signs terms"],
              ["03", "Wallet signs EIP-712 order", "User approval stays human-controlled"],
              ["04", "Galileo settlement + 0G proof", "Compute, storage, and tx artifacts remain visible"]
            ].map(([step, title, detail]) => (
              <div key={step} className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-cyan-300/10 font-mono text-sm text-cyan-100">{step}</div>
                <div>
                  <p className="font-medium text-white">{title}</p>
                  <p className="mt-1 text-sm text-slate-400">{detail}</p>
                </div>
                <CheckCircle2 size={18} className="ml-auto mt-1 flex-shrink-0 text-emerald-300" />
              </div>
            ))}
          </div>

          <div className="mt-4">
            <InfraStrip />
          </div>
        </div>
      </div>
    </section>
  );
}
