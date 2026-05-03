"use client";

import { useEffect, useRef, useState } from "react";
import type { WsEvent } from "@darkpool/shared";

export type LiveFeedStatus = "idle" | "connecting" | "open" | "closed" | "error";

export type UseWsFeedResult = {
  status: LiveFeedStatus;
  events: WsEvent[];
  url: string | null;
};

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL ?? "";
const DEFAULT_EVENTS_URL = "/api/ws-events";

type WsEventsResponse = {
  ok?: boolean;
  events?: WsEvent[];
};

export function useWsFeed(historyLimit = 200, url: string = DEFAULT_URL, eventsUrl: string = DEFAULT_EVENTS_URL): UseWsFeedResult {
  const [status, setStatus] = useState<LiveFeedStatus>(url || eventsUrl ? "connecting" : "idle");
  const [events, setEvents] = useState<WsEvent[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url && !eventsUrl) {
      setStatus("idle");
      return;
    }

    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const mergeEvents = (nextEvents: WsEvent[]) => {
      setEvents((prev) => {
        const merged = [...prev, ...nextEvents];
        const deduped = new Map<string, WsEvent>();

        for (const item of merged) {
          deduped.set(`${item.kind}:${item.agentId}:${item.timestamp}:${JSON.stringify(item.payload)}`, item);
        }

        const next = [...deduped.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (next.length > historyLimit) {
          next.splice(0, next.length - historyLimit);
        }

        return next;
      });
    };

    const pollEvents = async () => {
      if (!eventsUrl || stopped) {
        return;
      }

      try {
        const response = await fetch(eventsUrl, { cache: "no-store" });
        const parsed = (await response.json()) as WsEventsResponse;

        if (!response.ok || parsed.ok === false) {
          throw new Error("WS history endpoint is unavailable.");
        }

        if (!stopped) {
          mergeEvents(Array.isArray(parsed.events) ? parsed.events : []);
          setStatus("open");
        }
      } catch {
        if (!stopped && !url) {
          setStatus("error");
        }
      }
    };

    if (eventsUrl) {
      void pollEvents();
      pollTimer = setInterval(() => void pollEvents(), 2000);
    }

    const connect = () => {
      if (stopped || !url) {
        return;
      }

      try {
        if (!eventsUrl) {
          setStatus("connecting");
        }
        const socket = new WebSocket(url);
        socketRef.current = socket;
        connectTimer = setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) {
            socket.close();
          }
        }, 4000);

        socket.onopen = () => {
          if (!stopped) {
            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
            setStatus("open");
          }
        };

        socket.onmessage = (event) => {
          try {
            const parsed = JSON.parse(typeof event.data === "string" ? event.data : "") as WsEvent;
            mergeEvents([parsed]);
          } catch {
            // ignore malformed messages
          }
        };

        socket.onerror = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }

          if (!stopped) {
            if (!eventsUrl) {
              setStatus("error");
            }
          }
        };

        socket.onclose = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }

          if (!stopped) {
            if (!eventsUrl) {
              setStatus("closed");
            }
            retryTimer = setTimeout(connect, 1500);
          }
        };
      } catch {
        if (!stopped) {
          if (!eventsUrl) {
            setStatus("error");
          }
          retryTimer = setTimeout(connect, 2000);
        }
      }
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (connectTimer) {
        clearTimeout(connectTimer);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      socketRef.current?.close();
    };
  }, [url, eventsUrl, historyLimit]);

  return { status, events, url: url || eventsUrl || null };
}
