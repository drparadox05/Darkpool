import { NextResponse } from "next/server";
import { loadRootEnv } from "../../../lib/server-env";
import { callMcpTool } from "../../../lib/mcp-call";
import type { ProposeErrorResponse, ProposeRequest, ProposeResponse } from "../../../lib/trader-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  loadRootEnv();

  try {
    const body = (await request.json()) as Partial<ProposeRequest>;
    const validationError = validateProposeRequest(body);

    if (validationError) {
      return NextResponse.json<ProposeErrorResponse>({ ok: false, error: validationError }, { status: 400 });
    }

    const payload = body as ProposeRequest;
    const callResult = await callMcpTool<ProposeResponse["result"]>({
      peerId: payload.counterpartyPeerId,
      service: "darkpool",
      tool: "proposeSwap",
      args: {
        signedOrder: payload.signedOrder,
        expectation: payload.expectation,
        round: payload.round ?? 1
      },
      errorPrefix: "AXL propose failed"
    });

    if (!callResult.ok) {
      return NextResponse.json<ProposeErrorResponse>({ ok: false, error: callResult.error }, { status: callResult.status });
    }

    return NextResponse.json<ProposeResponse>({
      ok: true,
      requestedAt: new Date().toISOString(),
      counterpartyPeerId: payload.counterpartyPeerId,
      result: callResult.result
    });
  } catch (error) {
    return NextResponse.json<ProposeErrorResponse>({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function validateProposeRequest(body: Partial<ProposeRequest>): string | null {
  if (!body.counterpartyPeerId || typeof body.counterpartyPeerId !== "string") {
    return "counterpartyPeerId is required.";
  }

  if (!body.signedOrder || typeof body.signedOrder !== "object") {
    return "signedOrder is required.";
  }

  if (!body.expectation || typeof body.expectation !== "object") {
    return "expectation is required.";
  }

  if (body.round !== undefined && typeof body.round !== "number") {
    return "round must be a number when provided.";
  }

  return null;
}
