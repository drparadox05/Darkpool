"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TraderStatus } from "./trader-types";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
};

type WindowWithEthereum = Window & { ethereum?: EthereumProvider };

export type WalletState = {
  address: string | null;
  isConnecting: boolean;
  error: string | null;
  hasInjectedProvider: boolean;
  connect: () => Promise<void>;
};

export type StatusState = {
  status: TraderStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

type AppContextValue = {
  wallet: WalletState;
  status: StatusState;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const wallet = useWalletState();
  const status = useStatusState();
  const value = useMemo<AppContextValue>(() => ({ wallet, status }), [wallet, status]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(AppContext);

  if (!ctx) {
    throw new Error("useWallet must be used within AppProvider");
  }

  return ctx.wallet;
}

export function useStatus(): StatusState {
  const ctx = useContext(AppContext);

  if (!ctx) {
    throw new Error("useStatus must be used within AppProvider");
  }

  return ctx.status;
}

function useWalletState(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInjectedProvider, setHasInjectedProvider] = useState(false);

  useEffect(() => {
    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      return;
    }

    setHasInjectedProvider(true);

    ethereum
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (Array.isArray(accounts) && typeof accounts[0] === "string") {
          setAddress(accounts[0]);
        }
      })
      .catch(() => undefined);

    const handleAccountsChanged = (...args: unknown[]) => {
      const next = args[0];

      if (Array.isArray(next)) {
        setAddress(typeof next[0] === "string" ? next[0] : null);
      }
    };

    ethereum.on?.("accountsChanged", handleAccountsChanged);

    return () => {
      ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      setError("No injected wallet found. Install MetaMask or Rabby and reload.");
      return;
    }

    setIsConnecting(true);

    try {
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      setAddress(typeof accounts[0] === "string" ? accounts[0] : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsConnecting(false);
    }
  }, []);

  return useMemo(
    () => ({ address, isConnecting, error, hasInjectedProvider, connect }),
    [address, isConnecting, error, hasInjectedProvider, connect]
  );
}

function useStatusState(): StatusState {
  const [status, setStatus] = useState<TraderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return inFlight.current;
    }

    setLoading(true);
    setError(null);

    const task = (async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const next = (await response.json()) as TraderStatus;
        setStatus(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = task;
    return task;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh();
    }, 15_000);

    return () => window.clearInterval(interval);
  }, [refresh]);

  return useMemo(() => ({ status, loading, error, refresh }), [status, loading, error, refresh]);
}
