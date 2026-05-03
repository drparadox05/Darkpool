import { SEEDED_AGENTS } from "@darkpool/shared";
import { startAgentRuntime } from "./index.js";
import { startMockAxlNode } from "./mock-axl-node.js";

async function main(): Promise<void> {
  const nodeA = await startMockAxlNode({
    peerId: "smoke-agent-a",
    port: 19002,
    knownPeers: [{ peerId: "smoke-agent-b", apiUrl: "http://127.0.0.1:19012" }]
  });
  const nodeB = await startMockAxlNode({
    peerId: "smoke-agent-b",
    port: 19012,
    knownPeers: [{ peerId: "smoke-agent-a", apiUrl: "http://127.0.0.1:19002" }]
  });
  const agentA = await startAgentRuntime({
    profile: { ...SEEDED_AGENTS[0], id: "smoke-agent-a", peerId: "smoke-agent-a", status: "online" },
    axlBaseUrl: nodeA.apiUrl,
    axlTransport: "mock",
    settlementAutoSubmit: false,
    mcpPort: 19102
  });
  const agentB = await startAgentRuntime({
    profile: { ...SEEDED_AGENTS[1], id: "smoke-agent-b", peerId: "smoke-agent-b", status: "online" },
    axlBaseUrl: nodeB.apiUrl,
    axlTransport: "mock",
    settlementAutoSubmit: false,
    mcpPort: 19112
  });

  try {
    const topology = await agentA.axlClient.topology();
    const result = await agentA.axlClient.callTool<{ pong: boolean; from: string }>("smoke-agent-b", "darkpool", "ping", {
      message: "smoke-test",
      pair: "mWETH/mUSDC"
    });

    if (!result.pong) {
      throw new Error("Expected pong=true from remote darkpool/ping");
    }

    console.log("✓ topology", topology);
    console.log("✓ darkpool/ping", result);
  } finally {
    await agentA.close();
    await agentB.close();
    await nodeA.close();
    await nodeB.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
