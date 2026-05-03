import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  NegotiationMessage,
  Offer,
  ProposeSwapInput,
  ProposeSwapOutput,
  QuoteToolInput,
  QuoteToolOutput,
  SignedSwapOrder,
  AcceptSwapInput,
  AcceptSwapOutput
} from "@darkpool/shared";
import type { AxlClient } from "./axl-client.js";
import { newNonce } from "./darkpool-tools.js";
import type { SettlementClient, SettlementSigner } from "./settlement.js";
import type { WsTee } from "./ws-tee.js";

export type NegotiationParams = {
  initiator: AgentProfile;
  counterpartyPeerId: string;
  pair: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  referencePrice?: number;
  expiryMinutes?: number;
  maxRounds?: number;
};

export type NegotiationDeps = {
  axlClient: AxlClient;
  signer: SettlementSigner;
  settlement: SettlementClient;
  tee: WsTee;
};

export type NegotiationOutcome = {
  accepted: boolean;
  rounds: number;
  messages: NegotiationMessage[];
  orderA?: SignedSwapOrder;
  orderB?: SignedSwapOrder;
  finalRationale: string;
};

export async function runNegotiation(deps: NegotiationDeps, params: NegotiationParams): Promise<NegotiationOutcome> {
  const maxRounds = params.maxRounds ?? 3;
  const expiryMinutes = params.expiryMinutes ?? 10;
  const messages: NegotiationMessage[] = [];

  deps.tee.publish("negotiation:started", {
    initiator: params.initiator.ensName,
    counterparty: params.counterpartyPeerId,
    pair: params.pair,
    sellAmount: params.sellAmount
  });

  const quoteInput: QuoteToolInput = {
    pair: params.pair,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
    referencePrice: params.referencePrice,
    counterpartyAddress: deps.signer.address
  };

  let peerQuote = await deps.axlClient.callTool<QuoteToolOutput>(params.counterpartyPeerId, "darkpool", "getQuote", quoteInput);

  recordMessage(deps, messages, {
    from: params.counterpartyPeerId,
    to: params.initiator.peerId,
    kind: "quote",
    rationale: peerQuote.rationale,
    offer: peerQuote.offer
  });

  let round = 1;
  let currentExpectation = peerQuote.offer;
  let currentPeerNonce = peerQuote.nonce;

  while (round <= maxRounds) {
    const expiryUnix = BigInt(Math.floor(Date.now() / 1000) + expiryMinutes * 60).toString();

    const orderForInitiator: SignedSwapOrder["order"] = {
      maker: deps.signer.address,
      taker: peerQuote.agentAddress,
      sellToken: currentExpectation.buyToken,
      buyToken: currentExpectation.sellToken,
      sellAmount: currentExpectation.buyAmount,
      buyAmount: currentExpectation.sellAmount,
      expiry: expiryUnix,
      nonce: newNonce()
    };

    const signedInitiatorOrder = await deps.signer.signOrder(orderForInitiator, deps.settlement.domain());

    deps.tee.publish("settlement:signed", {
      agent: params.initiator.ensName,
      orderHash: signedInitiatorOrder.orderHash,
      role: "maker"
    });

    const proposeInput: ProposeSwapInput = {
      signedOrder: signedInitiatorOrder,
      expectation: currentExpectation,
      round
    };

    const proposeResult = await deps.axlClient.callTool<ProposeSwapOutput>(params.counterpartyPeerId, "darkpool", "proposeSwap", proposeInput);

    recordMessage(deps, messages, {
      from: params.counterpartyPeerId,
      to: params.initiator.peerId,
      kind: proposeResult.decision === "accept" ? "accept" : proposeResult.decision === "counter" ? "counter" : "reject",
      rationale: proposeResult.rationale,
      offer: proposeResult.counterOffer
    });

    if (proposeResult.decision === "accept" && proposeResult.counterSignedOrder) {
      const acceptInput: AcceptSwapInput = {
        orderA: signedInitiatorOrder,
        orderB: proposeResult.counterSignedOrder
      };

      const acceptResult = await deps.axlClient.callTool<AcceptSwapOutput>(
        params.counterpartyPeerId,
        "darkpool",
        "acceptSwap",
        acceptInput
      );

      recordMessage(deps, messages, {
        from: params.counterpartyPeerId,
        to: params.initiator.peerId,
        kind: acceptResult.accepted ? "settlement" : "reject",
        rationale: acceptResult.rationale,
        offer: proposeResult.counterOffer
      });

      deps.tee.publish("negotiation:completed", {
        rounds: round,
        accepted: acceptResult.accepted,
        orderHashes: { a: signedInitiatorOrder.orderHash, b: proposeResult.counterSignedOrder.orderHash }
      });

      if (acceptResult.accepted && deps.settlement.canSubmit()) {
        try {
          const receipt = await deps.settlement.submit(signedInitiatorOrder, proposeResult.counterSignedOrder);

          if (receipt) {
            deps.tee.publish("settlement:submitted", {
              transactionHash: receipt.transactionHash,
              orderHashes: receipt.orderHashes
            });
            deps.tee.publish("settlement:confirmed", {
              transactionHash: receipt.transactionHash,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed,
              orderHashes: receipt.orderHashes
            });
          } else {
            deps.tee.publish("settlement:simulated", {
              note: "Settlement client has no connected submitter; atomic settlement simulated with verified signatures."
            });
          }
        } catch (error) {
          deps.tee.publish("settlement:failed", {
            error: error instanceof Error ? error.message : String(error),
            orderHashes: { a: signedInitiatorOrder.orderHash, b: proposeResult.counterSignedOrder.orderHash }
          });
          throw error;
        }
      } else if (acceptResult.accepted) {
        deps.tee.publish("settlement:simulated", {
          note: "No RPC submitter configured; atomic settlement simulated with verified signatures."
        });
      }

      return {
        accepted: acceptResult.accepted,
        rounds: round,
        messages,
        orderA: signedInitiatorOrder,
        orderB: proposeResult.counterSignedOrder,
        finalRationale: acceptResult.rationale
      };
    }

    if (proposeResult.decision === "counter" && proposeResult.counterOffer) {
      currentExpectation = proposeResult.counterOffer;
      currentPeerNonce = newNonce();
      round += 1;
      continue;
    }

    deps.tee.publish("negotiation:completed", { rounds: round, accepted: false });

    return {
      accepted: false,
      rounds: round,
      messages,
      finalRationale: proposeResult.rationale
    };
  }

  deps.tee.publish("negotiation:completed", { rounds: maxRounds, accepted: false });

  return {
    accepted: false,
    rounds: maxRounds,
    messages,
    finalRationale: `Exhausted ${maxRounds} rounds without acceptance. Latest peer nonce ${currentPeerNonce}.`
  };
}

function recordMessage(
  deps: NegotiationDeps,
  messages: NegotiationMessage[],
  details: { from: string; to: string; kind: NegotiationMessage["kind"]; rationale: string; offer?: Offer }
): NegotiationMessage {
  const message: NegotiationMessage = {
    id: randomUUID(),
    from: details.from,
    to: details.to,
    kind: details.kind,
    rationale: details.rationale,
    offer: details.offer,
    timestamp: new Date().toISOString()
  };

  messages.push(message);
  deps.tee.publish("negotiation:message", message);
  return message;
}
