"use client";

import { ArrowRightLeft, CheckCircle2, Cpu, Database, ShieldCheck } from "lucide-react";
import type { NegotiationMessage, WsEvent } from "@darkpool/shared";
import { useWsFeed, type LiveFeedStatus } from "../lib/use-ws-feed";

type LiveTapeProps = {
  fallback?: NegotiationMessage[];
};

const STATUS_LABELS: Record<LiveFeedStatus, string> = {
  idle: "Live feed not configured",
  connecting: "Connecting to WS hub...",
  open: "Live",
  closed: "Reconnecting...",
  error: "Reconnecting after error..."
};

export function LiveTape({ fallback = [] }: LiveTapeProps) {
  const { status, events, url } = useWsFeed();
  const negotiationMessages = events.filter((event) => event.kind === "negotiation:message").map((event) => event.payload as NegotiationMessage);
  const eventsToShow = negotiationMessages.length > 0 ? negotiationMessages : fallback;
  const isLive = status === "open" && events.length > 0;
  const lastSettlement = [...events].reverse().find((event) => event.kind === "settlement:signed" || event.kind === "settlement:simulated" || event.kind === "settlement:submitted");
  const lastCompute = [...events].reverse().find((event) => event.kind === "0g:compute");
  const lastStorage = [...events].reverse().find((event) => event.kind === "0g:storage");

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/70 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Live A2A</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Negotiation tape</h2>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${isLive ? "border border-emerald-300/30 bg-emerald-300/10 text-emerald-100" : "border border-white/10 bg-white/[0.03] text-slate-300"}`}
        >
          <span className="relative flex h-2 w-2">
            {isLive ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"></span> : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${isLive ? "bg-emerald-400" : "bg-slate-500"}`}></span>
          </span>
          {STATUS_LABELS[status]}
        </span>
      </div>

      {url ? null : (
        <p className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-xs text-amber-100/90">
          Live tape is not configured. Start the WS hub (<code className="font-mono text-amber-100">pnpm ws-hub</code>) plus a real agent runtime to stream negotiation events here.
        </p>
      )}

      <div className="mt-6 space-y-4">
        {eventsToShow.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300">
            No negotiation events yet. Start the WS hub and request a quote or negotiation to stream real events here.
          </div>
        ) : null}

        {eventsToShow.map((message) => (
          <article key={message.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="font-mono text-cyan-200">{message.from}</span>
              <ArrowRightLeft size={14} />
              <span className="font-mono text-violet-200">{message.to}</span>
              <span className="ml-auto rounded-full bg-white/10 px-2 py-1 uppercase text-slate-300">{message.kind}</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-200">{message.rationale}</p>
            {message.offer ? (
              <div className="mt-4 grid gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-emerald-100/70">Sell</p>
                  <p className="mt-1 font-semibold text-white">{message.offer.sellAmount} {truncateAddress(message.offer.sellToken)}</p>
                </div>
                <div>
                  <p className="text-emerald-100/70">Buy</p>
                  <p className="mt-1 font-semibold text-white">{message.offer.buyAmount} {truncateAddress(message.offer.buyToken)}</p>
                </div>
                <div>
                  <p className="text-emerald-100/70">Expires</p>
                  <p className="mt-1 font-semibold text-white">{message.offer.expiresAt}</p>
                </div>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} />
          Real flow: `getQuote` → `proposeSwap` → `acceptSwap` → `signSettlement` flowing through the configured AXL/MCP transport.
        </div>
        {lastSettlement ? (
          <div className="flex items-center gap-2 text-emerald-50/90">
            <ShieldCheck size={18} />
            <span>
              Latest settlement event: <span className="font-mono">{lastSettlement.kind}</span>
              {describeSettlementPayload(lastSettlement)}
            </span>
          </div>
        ) : null}
        {lastCompute ? (
          <div className="flex items-center gap-2 text-cyan-50/90">
            <Cpu size={18} />
            <span>Latest 0G Compute event:{describeZeroGComputePayload(lastCompute)}</span>
          </div>
        ) : null}
        {lastStorage ? (
          <div className="flex items-center gap-2 text-cyan-50/90">
            <Database size={18} />
            <span>Latest 0G Storage event:{describeZeroGStoragePayload(lastStorage)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function truncateAddress(token: string): string {
  if (token.startsWith("0x") && token.length > 12) {
    return `${token.slice(0, 6)}…${token.slice(-4)}`;
  }
  return token;
}

function describeSettlementPayload(event: WsEvent): string {
  if (typeof event.payload !== "object" || event.payload === null) {
    return "";
  }

  const payload = event.payload as Record<string, unknown>;
  const orderHash = typeof payload.orderHash === "string" ? payload.orderHash : undefined;

  if (orderHash) {
    return ` (orderHash ${orderHash.slice(0, 10)}…)`;
  }

  if (typeof payload.note === "string") {
    return ` — ${payload.note}`;
  }

  return "";
}

function describeZeroGComputePayload(event: WsEvent): string {
  if (typeof event.payload !== "object" || event.payload === null) {
    return "";
  }

  const payload = event.payload as Record<string, unknown>;
  const provider = typeof payload.provider === "string" ? payload.provider : "0g";
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;

  return ` ${provider}${model ? ` · ${model}` : ""}${requestId ? ` · request ${requestId.slice(0, 10)}…` : ""}`;
}

function describeZeroGStoragePayload(event: WsEvent): string {
  if (typeof event.payload !== "object" || event.payload === null) {
    return "";
  }

  const payload = event.payload as Record<string, unknown>;
  const stage = typeof payload.stage === "string" ? payload.stage : event.kind;
  const rootHash = typeof payload.rootHash === "string" ? payload.rootHash : undefined;
  const txHash = typeof payload.txHash === "string" ? payload.txHash : undefined;

  return ` ${stage}${rootHash ? ` · root ${rootHash.slice(0, 10)}…` : ""}${txHash ? ` · tx ${txHash.slice(0, 10)}…` : ""}`;
}
