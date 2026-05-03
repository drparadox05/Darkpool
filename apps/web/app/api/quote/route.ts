import { NextResponse } from "next/server";
import { loadRootEnv } from "../../../lib/server-env";
import { callMcpTool } from "../../../lib/mcp-call";
import type { QuoteErrorResponse, QuoteRequest, QuoteResponse } from "../../../lib/trader-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  loadRootEnv();

  try {
    const body = (await request.json()) as Partial<QuoteRequest>;
    const validationError = validateQuoteRequest(body);

    if (validationError) {
      return NextResponse.json<QuoteErrorResponse>({ ok: false, error: validationError }, { status: 400 });
    }

    const payload = body as QuoteRequest;
    const callResult = await callMcpTool<QuoteResponse["quote"]>({
      peerId: payload.counterpartyPeerId,
      service: "darkpool",
      tool: "getQuote",
      args: {
        pair: payload.pair,
        sellToken: payload.sellToken,
        buyToken: payload.buyToken,
        sellAmount: payload.sellAmount,
        referencePrice: payload.referencePrice,
        counterpartyAddress: payload.counterpartyAddress
      },
      errorPrefix: "AXL quote failed"
    });

    if (!callResult.ok) {
      return NextResponse.json<QuoteErrorResponse>({ ok: false, error: callResult.error }, { status: callResult.status });
    }

    return NextResponse.json<QuoteResponse>({
      ok: true,
      requestedAt: new Date().toISOString(),
      counterpartyPeerId: payload.counterpartyPeerId,
      quote: callResult.result
    });
  } catch (error) {
    return NextResponse.json<QuoteErrorResponse>({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function validateQuoteRequest(body: Partial<QuoteRequest>): string | null {
  if (!body.counterpartyPeerId || typeof body.counterpartyPeerId !== "string") {
    return "counterpartyPeerId is required.";
  }

  if (!body.pair || typeof body.pair !== "string") {
    return "pair is required.";
  }

  if (!body.sellToken || typeof body.sellToken !== "string") {
    return "sellToken is required.";
  }

  if (!body.buyToken || typeof body.buyToken !== "string") {
    return "buyToken is required.";
  }

  if (!body.sellAmount || typeof body.sellAmount !== "string") {
    return "sellAmount is required.";
  }

  if (body.referencePrice !== undefined && typeof body.referencePrice !== "number") {
    return "referencePrice must be a number when provided.";
  }

  return null;
}
