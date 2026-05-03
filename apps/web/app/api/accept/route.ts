import { NextResponse } from "next/server";
import { loadRootEnv } from "../../../lib/server-env";
import { callMcpTool } from "../../../lib/mcp-call";
import type { AcceptErrorResponse, AcceptRequest, AcceptResponse } from "../../../lib/trader-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  loadRootEnv();

  try {
    const body = (await request.json()) as Partial<AcceptRequest>;
    const validationError = validateAcceptRequest(body);

    if (validationError) {
      return NextResponse.json<AcceptErrorResponse>({ ok: false, error: validationError }, { status: 400 });
    }

    const payload = body as AcceptRequest;
    const callResult = await callMcpTool<AcceptResponse["result"]>({
      peerId: payload.counterpartyPeerId,
      service: "darkpool",
      tool: "acceptSwap",
      args: {
        orderA: payload.orderA,
        orderB: payload.orderB
      },
      errorPrefix: "AXL accept failed"
    });

    if (!callResult.ok) {
      return NextResponse.json<AcceptErrorResponse>({ ok: false, error: callResult.error }, { status: callResult.status });
    }

    return NextResponse.json<AcceptResponse>({
      ok: true,
      requestedAt: new Date().toISOString(),
      counterpartyPeerId: payload.counterpartyPeerId,
      result: callResult.result
    });
  } catch (error) {
    return NextResponse.json<AcceptErrorResponse>({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function validateAcceptRequest(body: Partial<AcceptRequest>): string | null {
  if (!body.counterpartyPeerId || typeof body.counterpartyPeerId !== "string") {
    return "counterpartyPeerId is required.";
  }

  if (!body.orderA || typeof body.orderA !== "object") {
    return "orderA is required.";
  }

  if (!body.orderB || typeof body.orderB !== "object") {
    return "orderB is required.";
  }

  return null;
}
