import { randomBytes } from "node:crypto";
import { TypedDataEncoder, verifyTypedData } from "ethers";
import {
  type AcceptSwapInput,
  type AcceptSwapOutput,
  type AgentProfile,
  type BrainMemoryEvent,
  type ComputeResponse,
  type ProposeSwapInput,
  type ProposeSwapOutput,
  type QuoteToolInput,
  type QuoteToolOutput,
  type SignedSwapOrder,
  type SignSettlementInput,
  type SignSettlementOutput
} from "@darkpool/shared";
import type { ToolRegistration } from "./mcp-server.js";
import type { AgentStrategy } from "./strategy.js";
import { SWAP_ORDER_TYPES, type SettlementClient, type SettlementSigner } from "./settlement.js";
import type { WsTee } from "./ws-tee.js";

export type DarkpoolToolDeps = {
  profile: AgentProfile;
  strategy: AgentStrategy;
  signer: SettlementSigner;
  settlement: SettlementClient;
  tee: WsTee;
  persistMemoryEvent?: (event: BrainMemoryEvent) => Promise<void>;
};

export function createDarkpoolTools(deps: DarkpoolToolDeps): ToolRegistration[] {
  return [
    createGetQuoteTool(deps),
    createProposeSwapTool(deps),
    createAcceptSwapTool(deps),
    createSignSettlementTool(deps)
  ];
}

export function createGetQuoteTool(deps: DarkpoolToolDeps): ToolRegistration {
  return {
    definition: {
      name: "getQuote",
      description: "Return a signed draft quote for the requested pair.",
      inputSchema: {
        type: "object",
        required: ["pair", "sellToken", "buyToken", "sellAmount"],
        properties: {
          pair: { type: "string" },
          sellToken: { type: "string" },
          buyToken: { type: "string" },
          sellAmount: { type: "string" },
          referencePrice: { type: "number" },
          counterpartyAddress: { type: "string" }
        }
      }
    },
    handler: async (rawInput): Promise<QuoteToolOutput> => {
      const input = rawInput as QuoteToolInput;
      const quote = await deps.strategy.draftQuote({
        pair: input.pair,
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmount: input.sellAmount,
        referencePrice: input.referencePrice
      });
      publishComputeEvent(deps, "quote", quote.compute);
      await deps.persistMemoryEvent?.({
        timestamp: new Date().toISOString(),
        kind: "negotiation",
        content: `Quoted ${quote.sellAmount} ${quote.sellToken} for ${quote.buyAmount} ${quote.buyToken} using ${quote.compute?.provider ?? "unknown"} compute request ${quote.compute?.requestId ?? "n/a"}.`
      });

      return {
        offer: {
          sellToken: quote.sellToken,
          buyToken: quote.buyToken,
          sellAmount: quote.sellAmount,
          buyAmount: quote.buyAmount,
          expiresAt: quote.expiresAt
        },
        confidence: quote.confidence,
        rationale: quote.rationale,
        agentEns: deps.profile.ensName,
        agentAddress: deps.signer.address,
        nonce: newNonce(),
        compute: quote.compute
      };
    }
  };
}

export function createProposeSwapTool(deps: DarkpoolToolDeps): ToolRegistration {
  return {
    definition: {
      name: "proposeSwap",
      description: "Accept, counter, or reject a signed swap order from a peer.",
      inputSchema: {
        type: "object",
        required: ["signedOrder", "expectation", "round"],
        properties: {
          signedOrder: { type: "object" },
          expectation: { type: "object" },
          round: { type: "number" }
        }
      }
    },
    handler: async (rawInput): Promise<ProposeSwapOutput> => {
      const input = rawInput as ProposeSwapInput;
      const domain = deps.settlement.domain();

      try {
        verifySignedOrder(input.signedOrder, domain);
      } catch (error) {
        return {
          decision: "reject",
          rationale: `Invalid signature: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      const makerCounterToCounterparty = {
        sellToken: input.signedOrder.order.buyToken,
        buyToken: input.signedOrder.order.sellToken,
        sellAmount: input.signedOrder.order.buyAmount,
        buyAmount: input.signedOrder.order.sellAmount,
        expiresAt: new Date(Number(input.signedOrder.order.expiry) * 1000).toISOString()
      };

      const acceptable = decideAcceptance({
        expectation: input.expectation,
        makerProposedForUs: makerCounterToCounterparty,
        round: input.round,
        maxSlippageBps: getMaxSlippageBps(deps)
      });

      if (acceptable.ok) {
        const counterOrder: SignedSwapOrder["order"] = {
          maker: deps.signer.address,
          taker: input.signedOrder.order.maker,
          sellToken: makerCounterToCounterparty.sellToken,
          buyToken: makerCounterToCounterparty.buyToken,
          sellAmount: makerCounterToCounterparty.sellAmount,
          buyAmount: makerCounterToCounterparty.buyAmount,
          expiry: input.signedOrder.order.expiry,
          nonce: newNonce()
        };

        const signed = await deps.signer.signOrder(counterOrder, domain);
        deps.tee.publish("settlement:signed", {
          agent: deps.profile.ensName,
          orderHash: signed.orderHash,
          role: "taker"
        });

        return {
          decision: "accept",
          rationale: acceptable.rationale,
          counterSignedOrder: signed
        };
      }

      if (input.round >= (acceptable.maxRounds ?? 3)) {
        return {
          decision: "reject",
          rationale: `Round ${input.round}: ${acceptable.rationale}`
        };
      }

      const counterQuote = await deps.strategy.draftCounter({
        history: [
          {
            id: `negotiation-${input.round}`,
            from: input.signedOrder.signerAddress,
            to: deps.signer.address,
            kind: "quote",
            rationale: "peer proposed",
            offer: {
              sellToken: input.signedOrder.order.sellToken,
              buyToken: input.signedOrder.order.buyToken,
              sellAmount: input.signedOrder.order.sellAmount,
              buyAmount: input.signedOrder.order.buyAmount,
              expiresAt: new Date(Number(input.signedOrder.order.expiry) * 1000).toISOString()
            },
            timestamp: new Date().toISOString()
          }
        ],
        targetPair: `${input.signedOrder.order.sellToken}/${input.signedOrder.order.buyToken}`
      });
      publishComputeEvent(deps, "counter", counterQuote.compute);
      await deps.persistMemoryEvent?.({
        timestamp: new Date().toISOString(),
        kind: "negotiation",
        content: `Countered with ${counterQuote.sellAmount} ${counterQuote.sellToken} for ${counterQuote.buyAmount} ${counterQuote.buyToken} using ${counterQuote.compute?.provider ?? "unknown"} compute request ${counterQuote.compute?.requestId ?? "n/a"}.`
      });

      return {
        decision: "counter",
        rationale: `${acceptable.rationale} Proposing counter.`,
        counterOffer: {
          sellToken: counterQuote.sellToken,
          buyToken: counterQuote.buyToken,
          sellAmount: counterQuote.sellAmount,
          buyAmount: counterQuote.buyAmount,
          expiresAt: counterQuote.expiresAt
        },
        compute: counterQuote.compute
      };
    }
  };
}

export function createAcceptSwapTool(deps: DarkpoolToolDeps): ToolRegistration {
  return {
    definition: {
      name: "acceptSwap",
      description: "Confirm that two complementary signed orders are acceptable.",
      inputSchema: {
        type: "object",
        required: ["orderA", "orderB"],
        properties: {
          orderA: { type: "object" },
          orderB: { type: "object" }
        }
      }
    },
    handler: async (rawInput): Promise<AcceptSwapOutput> => {
      const input = rawInput as AcceptSwapInput;
      const domain = deps.settlement.domain();

      try {
        verifySignedOrder(input.orderA, domain);
        verifySignedOrder(input.orderB, domain);
      } catch (error) {
        return {
          accepted: false,
          rationale: `Invalid signature: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      const mismatch = detectOrderMismatch(input.orderA, input.orderB);

      if (mismatch) {
        return { accepted: false, rationale: mismatch };
      }

      await deps.persistMemoryEvent?.({
        timestamp: new Date().toISOString(),
        kind: "negotiation",
        content: `Verified complementary signed orders ${input.orderA.orderHash} and ${input.orderB.orderHash}.`
      });

      return { accepted: true, rationale: "Complementary signed orders verified." };
    }
  };
}

export function createSignSettlementTool(deps: DarkpoolToolDeps): ToolRegistration {
  return {
    definition: {
      name: "signSettlement",
      description: "Sign an EIP-712 SwapOrder for on-chain settlement submission.",
      inputSchema: {
        type: "object",
        required: ["order"],
        properties: {
          order: { type: "object" }
        }
      }
    },
    handler: async (rawInput): Promise<SignSettlementOutput> => {
      const input = rawInput as SignSettlementInput;
      const signed = await deps.signer.signOrder(input.order, deps.settlement.domain());
      deps.tee.publish("settlement:signed", {
        agent: deps.profile.ensName,
        orderHash: signed.orderHash
      });
      await deps.persistMemoryEvent?.({
        timestamp: new Date().toISOString(),
        kind: "settlement",
        content: `Signed settlement order ${signed.orderHash} for ${input.order.sellAmount} ${input.order.sellToken} into ${input.order.buyAmount} ${input.order.buyToken}.`
      });
      return signed;
    }
  };
}

export function newNonce(): string {
  return BigInt(`0x${randomBytes(8).toString("hex")}`).toString();
}

export function verifySignedOrder(signed: SignedSwapOrder, domain: ReturnType<SettlementClient["domain"]>): void {
  const recovered = verifyTypedData(domain, SWAP_ORDER_TYPES, signed.order, signed.signature);

  if (recovered.toLowerCase() !== signed.signerAddress.toLowerCase()) {
    throw new Error(`Signature does not match signerAddress ${signed.signerAddress} (recovered ${recovered})`);
  }

  const expectedHash = TypedDataEncoder.hash(domain, SWAP_ORDER_TYPES, signed.order);

  if (expectedHash !== signed.orderHash) {
    throw new Error(`Order hash mismatch (expected ${expectedHash}, got ${signed.orderHash})`);
  }
}

function decideAcceptance(options: {
  expectation: { sellToken: string; buyToken: string; sellAmount: string; buyAmount: string };
  makerProposedForUs: { sellToken: string; buyToken: string; sellAmount: string; buyAmount: string };
  round: number;
  maxSlippageBps: number;
  maxRounds?: number;
}): { ok: boolean; rationale: string; maxRounds?: number } {
  const expectation = options.expectation;
  const proposal = options.makerProposedForUs;

  if (
    expectation.sellToken.toLowerCase() !== proposal.sellToken.toLowerCase() ||
    expectation.buyToken.toLowerCase() !== proposal.buyToken.toLowerCase()
  ) {
    return { ok: false, rationale: "token pair does not match expectation" };
  }

  const expectedSellAmount = Number(expectation.sellAmount);
  const offeredSellAmount = Number(proposal.sellAmount);
  const expectedBuyAmount = Number(expectation.buyAmount);
  const offeredBuyAmount = Number(proposal.buyAmount);

  if (!Number.isFinite(offeredSellAmount) || !Number.isFinite(offeredBuyAmount)) {
    return { ok: false, rationale: "proposal amounts are not numeric" };
  }

  if (offeredSellAmount + 1e-9 < expectedSellAmount) {
    return { ok: false, rationale: "offered sellAmount below expectation" };
  }

  const slippageBps = expectedBuyAmount === 0 ? 0 : ((expectedBuyAmount - offeredBuyAmount) / expectedBuyAmount) * 10_000;

  if (slippageBps > options.maxSlippageBps) {
    return {
      ok: false,
      rationale: `counter required: slippage ${slippageBps.toFixed(1)}bps > ${options.maxSlippageBps}bps`
    };
  }

  return { ok: true, rationale: `accepting at slippage ${slippageBps.toFixed(1)}bps (round ${options.round})` };
}

function detectOrderMismatch(orderA: SignedSwapOrder, orderB: SignedSwapOrder): string | null {
  if (orderA.order.sellToken.toLowerCase() !== orderB.order.buyToken.toLowerCase()) {
    return "orderA.sellToken != orderB.buyToken";
  }

  if (orderA.order.buyToken.toLowerCase() !== orderB.order.sellToken.toLowerCase()) {
    return "orderA.buyToken != orderB.sellToken";
  }

  if (orderA.order.sellAmount !== orderB.order.buyAmount) {
    return "orderA.sellAmount != orderB.buyAmount";
  }

  if (orderA.order.buyAmount !== orderB.order.sellAmount) {
    return "orderA.buyAmount != orderB.sellAmount";
  }

  if (orderA.order.maker.toLowerCase() !== orderB.order.taker.toLowerCase()) {
    return "orderA.maker != orderB.taker";
  }

  if (orderA.order.taker.toLowerCase() !== orderB.order.maker.toLowerCase()) {
    return "orderA.taker != orderB.maker";
  }

  return null;
}

function getMaxSlippageBps(deps: DarkpoolToolDeps): number {
  const maxSlippageBps = deps.profile.role === "aggressive" ? 120 : deps.profile.role === "conservative" ? 45 : 80;

  return maxSlippageBps;
}

function publishComputeEvent(deps: DarkpoolToolDeps, stage: "quote" | "counter", compute: ComputeResponse | undefined): void {
  if (!compute) {
    return;
  }

  const verifyResponses = process.env.ZEROG_COMPUTE_VERIFY_RESPONSES !== "false";
  const serviceProviderAddress = process.env.ZEROG_COMPUTE_PROVIDER_ADDRESS;

  deps.tee.publish("0g:compute", {
    stage,
    agent: deps.profile.ensName,
    provider: compute.provider,
    model: compute.model,
    requestId: compute.requestId,
    serviceProviderAddress,
    verifyResponses,
    contentPreview: compute.content.slice(0, 240)
  });
}
