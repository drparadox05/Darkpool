import { SEEDED_AGENTS } from "@darkpool/shared";
import { startAgentRuntime, type RunningAgentRuntime } from "./index.js";
import { startMockAxlNode, type RunningMockAxlNode } from "./mock-axl-node.js";
import { runNegotiation } from "./negotiation.js";
import { loadSettlementAddresses, resolveTokenAddress } from "./settlement.js";
import { startWsHub } from "./ws-hub.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Slot = {
  peerId: string;
  role: "aggressive" | "conservative" | "arbitrageur";
  axlPort: number;
  mcpPort: number;
};

const SLOTS: Slot[] = [
  { peerId: "agent-a", role: "aggressive", axlPort: 9002, mcpPort: 9102 },
  { peerId: "agent-b", role: "conservative", axlPort: 9012, mcpPort: 9112 },
  { peerId: "agent-c", role: "arbitrageur", axlPort: 9022, mcpPort: 9122 }
];

async function main(): Promise<void> {
  const wsHubPort = Number(process.env.WS_HUB_PORT ?? "8787");
  const hub = await startWsHub({ port: wsHubPort });
  process.env.WS_HUB_URL = hub.publishUrl;

  const nodes: RunningMockAxlNode[] = [];
  const agents: RunningAgentRuntime[] = [];

  for (let index = 0; index < SLOTS.length; index += 1) {
    const slot = SLOTS[index];
    const peers = SLOTS.filter((_, other) => other !== index).map((peer) => ({
      peerId: peer.peerId,
      apiUrl: `http://127.0.0.1:${peer.axlPort}`
    }));

    const node = await startMockAxlNode({
      peerId: slot.peerId,
      port: slot.axlPort,
      knownPeers: peers
    });
    nodes.push(node);
  }

  for (const slot of SLOTS) {
    const baseProfile = SEEDED_AGENTS.find((agent) => agent.role === slot.role) ?? SEEDED_AGENTS[0];
    const agent = await startAgentRuntime({
      profile: { ...baseProfile, id: slot.peerId, peerId: slot.peerId, status: "online" },
      axlBaseUrl: `http://127.0.0.1:${slot.axlPort}`,
      axlTransport: "mock",
      settlementAutoSubmit: false,
      mcpPort: slot.mcpPort,
      privateKeySeed: `phase4-${slot.peerId}-seed`
    });
    agents.push(agent);
  }

  await wait(500);

  const addresses = await loadSettlementAddresses();
  const pairs: Array<{ initiator: RunningAgentRuntime; counterparty: RunningAgentRuntime; pair: string; sellToken: string; buyToken: string; sellAmount: string; referencePrice: number }> = [
    { initiator: agents[0], counterparty: agents[1], pair: "mWETH/mUSDC", sellToken: resolveTokenAddress("mWETH", addresses), buyToken: resolveTokenAddress("mUSDC", addresses), sellAmount: "2", referencePrice: 3000 },
    { initiator: agents[2], counterparty: agents[0], pair: "mDAI/mUSDC", sellToken: resolveTokenAddress("mDAI", addresses), buyToken: resolveTokenAddress("mUSDC", addresses), sellAmount: "5000", referencePrice: 1 }
  ];

  console.log(`[demo] WS hub ready at ${hub.wsUrl}. Open the Next.js dashboard to see live negotiation messages.`);

  for (const scenario of pairs) {
    try {
      const outcome = await runNegotiation(
        {
          axlClient: scenario.initiator.axlClient,
          signer: scenario.initiator.signer,
          settlement: scenario.initiator.settlement,
          tee: scenario.initiator.tee
        },
        {
          initiator: scenario.initiator.profile,
          counterpartyPeerId: scenario.counterparty.profile.peerId,
          pair: scenario.pair,
          sellToken: scenario.sellToken,
          buyToken: scenario.buyToken,
          sellAmount: scenario.sellAmount,
          referencePrice: scenario.referencePrice
        }
      );

      console.log(`[demo] ${scenario.initiator.profile.ensName} → ${scenario.counterparty.profile.ensName} on ${scenario.pair}:`, {
        accepted: outcome.accepted,
        rounds: outcome.rounds,
        rationale: outcome.finalRationale
      });
    } catch (error) {
      console.error(`[demo] negotiation failed on ${scenario.pair}:`, error);
    }

    await wait(750);
  }

  console.log("[demo] negotiation cycle done. Keep the process running to stream health and replay events. Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[demo] shutting down...");
    for (const agent of agents) {
      await agent.close();
    }
    for (const node of nodes) {
      await node.close();
    }
    await hub.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
