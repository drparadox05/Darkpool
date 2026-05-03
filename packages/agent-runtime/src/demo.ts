import { SEEDED_AGENTS } from "@darkpool/shared";
import { startAgentRuntime } from "./index.js";
import { startMockAxlNode } from "./mock-axl-node.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const nodeA = await startMockAxlNode({
    peerId: "agent-a",
    port: Number(process.env.AXL_A_PORT ?? "9002"),
    knownPeers: [{ peerId: "agent-b", apiUrl: `http://127.0.0.1:${process.env.AXL_B_PORT ?? "9012"}` }]
  });
  const nodeB = await startMockAxlNode({
    peerId: "agent-b",
    port: Number(process.env.AXL_B_PORT ?? "9012"),
    knownPeers: [{ peerId: "agent-a", apiUrl: `http://127.0.0.1:${process.env.AXL_A_PORT ?? "9002"}` }]
  });

  const agentA = await startAgentRuntime({
    profile: { ...SEEDED_AGENTS[0], status: "online" },
    axlBaseUrl: nodeA.apiUrl,
    axlTransport: "mock",
    settlementAutoSubmit: false,
    mcpPort: Number(process.env.MCP_A_PORT ?? "9102")
  });
  const agentB = await startAgentRuntime({
    profile: { ...SEEDED_AGENTS[1], status: "online" },
    axlBaseUrl: nodeB.apiUrl,
    axlTransport: "mock",
    settlementAutoSubmit: false,
    mcpPort: Number(process.env.MCP_B_PORT ?? "9112")
  });

  await wait(250);

  const topology = await agentA.axlClient.topology();
  const result = await agentA.axlClient.callTool("agent-b", "darkpool", "ping", {
    message: "Phase 1 hello world over A2A",
    pair: "mWETH/mUSDC"
  });

  console.log("[demo] topology", topology);
  console.log("[demo] A2A darkpool/ping", result);
  console.log("[demo] running. Press Ctrl+C to stop.");

  const shutdown = async () => {
    await agentA.close();
    await agentB.close();
    await nodeA.close();
    await nodeB.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
