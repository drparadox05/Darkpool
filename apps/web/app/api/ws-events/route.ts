import type { WsEvent } from "@darkpool/shared";
import { NextResponse } from "next/server";
import { loadRootEnv } from "../../../lib/server-env";

export const dynamic = "force-dynamic";

const DEFAULT_WS_HUB_URL = "http://127.0.0.1:8787";

type WsEventsResponse = {
  events?: WsEvent[];
};

export async function GET() {
  loadRootEnv();

  try {
    const wsUrl = normalizeWsHubUrl(process.env.WS_HUB_URL || DEFAULT_WS_HUB_URL);
    const response = await fetch(`${wsUrl}/events`, { cache: "no-store" });
    const payload = (await response.json()) as WsEventsResponse;

    if (!response.ok) {
      return NextResponse.json({ ok: false, events: [], error: `HTTP ${response.status} ${response.statusText}` }, { status: 502 });
    }

    return NextResponse.json({ ok: true, events: Array.isArray(payload.events) ? payload.events : [] });
  } catch (error) {
    return NextResponse.json({ ok: false, events: [], error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

function normalizeWsHubUrl(url: string): string {
  const stripped = url.replace(/\/$/, "");
  return stripped.endsWith("/publish") ? stripped.slice(0, -"/publish".length) : stripped;
}
