import assert from "node:assert/strict";
import { SEEDED_AGENTS } from "@darkpool/shared";
import { startAgentRuntime } from "./index.js";
import { startMockAxlNode } from "./mock-axl-node.js";
import { runNegotiation } from "./negotiation.js";
import { loadSettlementAddresses, resolveTokenAddress } from "./settlement.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const [aggressive, conservative] = SEEDED_AGENTS;

  const axlA = await startMockAxlNode({
    peerId: "smoke4-agent-a",
    port: 19202,
    knownPeers: [{ peerId: "smoke4-agent-b", apiUrl: "http://127.0.0.1:19212" }]
  });
  const axlB = await startMockAxlNode({
    peerId: "smoke4-agent-b",
    port: 19212,
    knownPeers: [{ peerId: "smoke4-agent-a", apiUrl: "http://127.0.0.1:19202" }]
  });

  const profileA = { ...aggressive, id: "smoke4-agent-a", peerId: "smoke4-agent-a", status: "online" as const };
  const profileB = { ...conservative, id: "smoke4-agent-b", peerId: "smoke4-agent-b", status: "online" as const };

  const agentA = await startAgentRuntime({
    profile: profileA,
    axlBaseUrl: axlA.apiUrl,
    axlTransport: "mock",
    mcpPort: 19302,
    privateKeySeed: "phase4-agent-a-seed",
    settlementAutoSubmit: false
  });
  const agentB = await startAgentRuntime({
    profile: profileB,
    axlBaseUrl: axlB.apiUrl,
    axlTransport: "mock",
    mcpPort: 19312,
    privateKeySeed: "phase4-agent-b-seed",
    settlementAutoSubmit: false
  });

  await wait(200);

  const addresses = await loadSettlementAddresses();
  const sellToken = resolveTokenAddress("mWETH", addresses);
  const buyToken = resolveTokenAddress("mUSDC", addresses);

  const outcome = await runNegotiation(
    { axlClient: agentA.axlClient, signer: agentA.signer, settlement: agentA.settlement, tee: agentA.tee },
    {
      initiator: agentA.profile,
      counterpartyPeerId: agentB.profile.peerId,
      pair: "mWETH/mUSDC",
      sellToken,
      buyToken,
      sellAmount: "2",
      referencePrice: 3000
    }
  );

  assert.ok(outcome.rounds >= 1, "at least one negotiation round expected");
  assert.ok(outcome.messages.length >= 2, "expected quote + decision messages");

  if (outcome.accepted) {
    assert.ok(outcome.orderA && outcome.orderB, "accepted outcome must carry signed orders");
    assert.notEqual(outcome.orderA!.orderHash, outcome.orderB!.orderHash);
    assert.equal(outcome.orderA!.order.sellToken.toLowerCase(), outcome.orderB!.order.buyToken.toLowerCase());
    assert.equal(outcome.orderA!.order.buyAmount, outcome.orderB!.order.sellAmount);
  }

  console.log("✓ phase4 negotiation outcome", {
    accepted: outcome.accepted,
    rounds: outcome.rounds,
    messages: outcome.messages.length,
    finalRationale: outcome.finalRationale
  });

  await agentA.close();
  await agentB.close();
  await axlA.close();
  await axlB.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
