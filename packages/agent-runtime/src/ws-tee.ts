import type { WsEvent, WsEventKind } from "@darkpool/shared";
import { fetchJson } from "./http.js";

export type WsTee = {
  publish(kind: WsEventKind, payload: unknown): void;
  close(): Promise<void>;
};

export type WsTeeOptions = {
  url?: string;
  agentId: string;
  ensName?: string;
};

export function createWsTee(options: WsTeeOptions): WsTee {
  const url = options.url?.trim();

  if (!url) {
    return { publish() {}, async close() {} };
  }

  const publishUrl = url.endsWith("/publish") ? url : `${url.replace(/\/$/, "")}/publish`;
  const pending = new Set<Promise<unknown>>();

  return {
    publish(kind, payload) {
      const event: WsEvent = {
        kind,
        agentId: options.agentId,
        ensName: options.ensName,
        timestamp: new Date().toISOString(),
        payload
      };

      const task = fetchJson(publishUrl, {
        method: "POST",
        body: JSON.stringify(event)
      }).catch(() => undefined);

      pending.add(task);
      task.finally(() => pending.delete(task));
    },
    async close() {
      await Promise.allSettled([...pending]);
    }
  };
}
