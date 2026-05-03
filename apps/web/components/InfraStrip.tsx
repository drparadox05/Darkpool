"use client";

import { Cable, Cpu, Database, Loader2, Radio, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import type { ComponentType } from "react";
import { useStatus } from "../lib/app-context";
import { useWsFeed } from "../lib/use-ws-feed";
import type { TraderStatus } from "../lib/trader-types";

type IndicatorState = "ok" | "warn" | "down" | "loading";

type Indicator = {
  key: string;
  label: string;
  value: string;
  state: IndicatorState;
  Icon: ComponentType<{ size?: number; className?: string }>;
};

const STATE_STYLES: Record<IndicatorState, { dot: string; text: string; border: string; halo: string }> = {
  ok: { dot: "bg-emerald-400", text: "text-emerald-100", border: "border-emerald-300/30", halo: "bg-emerald-400/60" },
  warn: { dot: "bg-amber-400", text: "text-amber-100", border: "border-amber-300/30", halo: "bg-amber-400/60" },
  down: { dot: "bg-rose-400", text: "text-rose-100", border: "border-rose-300/30", halo: "bg-rose-400/60" },
  loading: { dot: "bg-slate-500", text: "text-slate-300", border: "border-white/10", halo: "bg-slate-400/40" }
};

export function InfraStrip() {
  const { status, loading, error, refresh } = useStatus();
  const wsFeed = useWsFeed();
  const indicators = buildIndicators(status, loading, wsFeed.status);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Live infrastructure</p>
          <p className="mt-1 text-sm text-slate-300">AXL/MCP · 0G Compute · 0G Storage · Galileo</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh infrastructure status"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-slate-200 transition hover:bg-white/10 disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error ? <p className="mt-3 text-xs text-rose-200">{error}</p> : null}

      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {indicators.map((indicator) => {
          const styles = STATE_STYLES[indicator.state];
          return (
            <li
              key={indicator.key}
              className={`flex items-center gap-3 rounded-xl border ${styles.border} bg-white/[0.02] px-3 py-2.5`}
            >
              <span className="relative flex h-2 w-2 flex-shrink-0">
                {indicator.state !== "loading" ? (
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${styles.halo} opacity-50`}></span>
                ) : null}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${styles.dot}`}></span>
              </span>
              <indicator.Icon size={14} className="flex-shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">{indicator.label}</p>
                <p className={`truncate text-sm font-medium ${styles.text}`}>{indicator.value}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function buildIndicators(status: TraderStatus | null, loading: boolean, wsStatus: string): Indicator[] {
  if (!status && loading) {
    return [
      { key: "axl", label: "Gensyn AXL", value: "Checking...", state: "loading", Icon: Cable },
      { key: "mcp", label: "MCP router", value: "Checking...", state: "loading", Icon: Wifi },
      { key: "compute", label: "0G Compute", value: "Checking...", state: "loading", Icon: Cpu },
      { key: "storage", label: "0G Storage", value: "Checking...", state: "loading", Icon: Database },
      { key: "chain", label: "Galileo chain", value: "Checking...", state: "loading", Icon: ShieldCheck },
      { key: "tape", label: "Live tape", value: "Checking...", state: "loading", Icon: Radio }
    ];
  }

  const axlState: IndicatorState = status?.axl.ok ? "ok" : "down";
  const routerState: IndicatorState = status?.router.ok ? "ok" : "warn";
  const computeState: IndicatorState = status?.zeroG.compute.ok ? "ok" : "warn";
  const storageState: IndicatorState = status?.zeroG.storage.ok ? "ok" : "warn";
  const chainState: IndicatorState = status?.zeroG.chain.ok ? "ok" : "warn";
  const tapeState: IndicatorState = wsStatus === "open" ? "ok" : wsStatus === "connecting" ? "loading" : "warn";
  const isMockAxl = status?.axl.transport === "mock";

  return [
    {
      key: "axl",
      label: isMockAxl ? "Mock AXL" : "Gensyn AXL",
      value: status?.axl.ok ? `${status.axl.peers.length} peer${status.axl.peers.length === 1 ? "" : "s"}` : "Offline",
      state: axlState,
      Icon: Cable
    },
    {
      key: "mcp",
      label: isMockAxl ? "MCP bridge" : "MCP router",
      value: status?.router.ok ? (isMockAxl ? "Mock direct" : `${status.router.services.length} service${status.router.services.length === 1 ? "" : "s"}`) : "Offline",
      state: routerState,
      Icon: Wifi
    },
    {
      key: "compute",
      label: "0G Compute",
      value: status?.zeroG.compute.ok ? status.zeroG.compute.model ?? "Live" : status?.zeroG.compute.provider ?? "Not live",
      state: computeState,
      Icon: Cpu
    },
    {
      key: "storage",
      label: "0G Storage",
      value: status?.zeroG.storage.ok ? shortRootHash(status.zeroG.storage.rootHash) ?? "Live" : status?.zeroG.storage.provider ?? "Not live",
      state: storageState,
      Icon: Database
    },
    {
      key: "chain",
      label: "Galileo",
      value: status?.settlement.chainId ? `Chain ${status.settlement.chainId}` : "Missing",
      state: chainState,
      Icon: ShieldCheck
    },
    {
      key: "tape",
      label: "Live tape",
      value: wsStatus === "open" ? "Streaming" : wsStatus === "connecting" ? "Connecting..." : "Idle",
      state: tapeState,
      Icon: Radio
    }
  ];
}

function shortRootHash(rootHash: string | undefined): string | undefined {
  if (!rootHash) {
    return undefined;
  }

  return rootHash.length > 12 ? `${rootHash.slice(0, 6)}…${rootHash.slice(-4)}` : rootHash;
}
