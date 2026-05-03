"use client";

import { Loader2, Wallet } from "lucide-react";
import { useWallet } from "../lib/app-context";

export function WalletButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { address, isConnecting, error, connect } = useWallet();
  const sizing = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";

  if (address) {
    return (
      <button
        type="button"
        onClick={connect}
        title={`Connected ${address}. Click to switch account.`}
        className={`group inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-300/10 ${sizing} font-mono font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-300/15`}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"></span>
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
        </span>
        {shortAddress(address)}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={connect}
        disabled={isConnecting}
        className={`inline-flex items-center gap-2 rounded-full bg-cyan-300 ${sizing} font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
        {isConnecting ? "Connecting..." : "Connect wallet"}
      </button>
      {error ? <p className="max-w-[260px] text-right text-[11px] text-rose-200">{error}</p> : null}
    </div>
  );
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
