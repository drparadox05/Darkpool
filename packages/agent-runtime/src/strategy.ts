import type { AgentBrainDocument, AgentProfile, DraftCounterInput, DraftQuote, DraftQuoteInput, NegotiationMessage, Offer } from "@darkpool/shared";
import type { ComputeClient } from "./compute-client.js";

export type AgentStrategyOptions = {
  profile: AgentProfile;
  brain: AgentBrainDocument;
  computeClient: ComputeClient;
};

export class AgentStrategy {
  private readonly profile: AgentProfile;
  private readonly brain: AgentBrainDocument;
  private readonly computeClient: ComputeClient;

  constructor(options: AgentStrategyOptions) {
    this.profile = options.profile;
    this.brain = options.brain;
    this.computeClient = options.computeClient;
  }

  async draftQuote(input: DraftQuoteInput): Promise<DraftQuote> {
    const completion = await this.computeClient.complete({
      messages: [
        { role: "system", content: this.brain.systemPrompt },
        {
          role: "user",
          content: `Draft quote for ${input.pair}: sell ${input.sellAmount} ${input.sellToken}, buy ${input.buyToken}, referencePrice=${input.referencePrice ?? "unknown"}. Risk=${this.brain.strategy.riskTolerance}.`
        }
      ],
      temperature: this.brain.strategy.riskTolerance === "high" ? 0.7 : 0.2,
      maxTokens: 256
    });

    const buyAmount = estimateBuyAmount(input.sellAmount, input.referencePrice, this.brain.strategy.maxSlippageBps);

    return {
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount,
      buyAmount,
      expiresAt: expiryFromNow(120),
      confidence: confidenceForRisk(this.brain.strategy.riskTolerance),
      rationale: `${this.profile.ensName} drafted a ${this.brain.strategy.riskTolerance}-risk quote. ${completion.content}`,
      compute: completion
    };
  }

  async draftCounter(input: DraftCounterInput): Promise<DraftQuote> {
    const latestOffer = findLatestOffer(input.history);

    if (!latestOffer) {
      return this.draftQuote({
        pair: input.targetPair,
        sellToken: input.targetPair.split("/")[0] ?? "mWETH",
        buyToken: input.targetPair.split("/")[1] ?? "mUSDC",
        sellAmount: "1",
        referencePrice: 1
      });
    }

    const completion = await this.computeClient.complete({
      messages: [
        { role: "system", content: this.brain.systemPrompt },
        { role: "user", content: `Draft counter for ${input.targetPair} from latest offer ${JSON.stringify(latestOffer)}.` }
      ],
      temperature: 0.3,
      maxTokens: 256
    });

    return {
      ...latestOffer,
      buyAmount: improveAmount(latestOffer.buyAmount, this.brain.strategy.minProfitBps),
      expiresAt: expiryFromNow(120),
      confidence: confidenceForRisk(this.brain.strategy.riskTolerance) - 0.05,
      rationale: `${this.profile.ensName} countered using minProfitBps=${this.brain.strategy.minProfitBps}. ${completion.content}`,
      compute: completion
    };
  }
}

export function createAgentStrategy(options: AgentStrategyOptions): AgentStrategy {
  return new AgentStrategy(options);
}

function findLatestOffer(history: NegotiationMessage[]): Offer | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const offer = history[index]?.offer;

    if (offer) {
      return offer;
    }
  }

  return undefined;
}

function estimateBuyAmount(sellAmount: string, referencePrice = 1, maxSlippageBps: number): string {
  const numericSellAmount = Number(sellAmount);

  if (!Number.isFinite(numericSellAmount)) {
    return sellAmount;
  }

  const slippageMultiplier = 1 - maxSlippageBps / 10_000;
  return trimDecimal(numericSellAmount * referencePrice * slippageMultiplier);
}

function improveAmount(amount: string, minProfitBps: number): string {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return amount;
  }

  return trimDecimal(numericAmount * (1 + minProfitBps / 10_000));
}

function confidenceForRisk(riskTolerance: AgentBrainDocument["strategy"]["riskTolerance"]): number {
  if (riskTolerance === "low") {
    return 0.72;
  }

  if (riskTolerance === "high") {
    return 0.61;
  }

  return 0.67;
}

function expiryFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function trimDecimal(value: number): string {
  return Number(value.toFixed(8)).toString();
}
