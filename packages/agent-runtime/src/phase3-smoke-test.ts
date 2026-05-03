import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SEEDED_AGENTS, type NegotiationMessage } from "@darkpool/shared";
import { BrainStore, createSeedBrain } from "./brain-store.js";
import { LocalDeterministicComputeClient } from "./compute-client.js";
import { createAgentStrategy } from "./strategy.js";

async function main(): Promise<void> {
  const profile = SEEDED_AGENTS[0];
  const brain = createSeedBrain(profile);
  const brainStore = new BrainStore({
    provider: "local",
    localDir: resolve(process.cwd(), "../../.darkpool-storage/phase3-smoke"),
    passphrase: "phase3-smoke-passphrase"
  });

  const receipt = await brainStore.saveBrain(brain);
  const loadedBrain = await brainStore.loadBrain(receipt.rootHash);

  assert.equal(loadedBrain.agentId, profile.id);
  assert.equal(loadedBrain.ensName, profile.ensName);
  assert.equal(loadedBrain.systemPrompt, brain.systemPrompt);

  const computeClient = new LocalDeterministicComputeClient();
  const strategy = createAgentStrategy({ profile, brain: loadedBrain, computeClient });
  const quote = await strategy.draftQuote({
    pair: "mWETH/mUSDC",
    sellToken: "mWETH",
    buyToken: "mUSDC",
    sellAmount: "2",
    referencePrice: 3000
  });

  assert.equal(quote.sellToken, "mWETH");
  assert.equal(quote.buyToken, "mUSDC");
  assert.ok(Number(quote.buyAmount) > 0);
  assert.match(quote.rationale, /local-compute/);

  const history: NegotiationMessage[] = [
    {
      id: "phase3-message-1",
      from: "agent-b",
      to: "agent-a",
      kind: "quote",
      rationale: "Initial local quote",
      offer: quote,
      timestamp: new Date().toISOString()
    }
  ];
  const counter = await strategy.draftCounter({ history, targetPair: "mWETH/mUSDC" });

  assert.ok(Number(counter.buyAmount) >= Number(quote.buyAmount));
  assert.match(counter.rationale, /minProfitBps/);

  console.log("✓ encrypted brain round-trip", receipt);
  console.log("✓ loaded brain", { agentId: loadedBrain.agentId, ensName: loadedBrain.ensName, role: loadedBrain.role });
  console.log("✓ draft quote", quote);
  console.log("✓ draft counter", counter);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
