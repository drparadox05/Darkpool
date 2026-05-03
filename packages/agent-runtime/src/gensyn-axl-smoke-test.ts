import { SEEDED_AGENTS } from "@darkpool/shared";
import { startAgentRuntime } from "./index.js";
import { runGensynAxlPreflight } from "./gensyn-axl-preflight.js";

async function main(): Promise<void> {
  await runGensynAxlPreflight();

  const profile = {
    ...SEEDED_AGENTS[0],
    id: process.env.AGENT_ID ?? "gensyn-agent",
    peerId: process.env.AXL_PEER_ID ?? process.env.AGENT_ID ?? "gensyn-agent",
    ensName: process.env.AGENT_ENS ?? SEEDED_AGENTS[0].ensName,
    status: "online" as const
  };

  const runtime = await startAgentRuntime({
    profile,
    axlBaseUrl: process.env.AXL_API_URL ?? "http://127.0.0.1:9002",
    axlTransport: "gensyn",
    axlRouterUrl: process.env.AXL_ROUTER_URL ?? "http://127.0.0.1:9003",
    mcpPort: Number(process.env.MCP_PORT ?? "9102"),
    callbackUrl: process.env.MCP_CALLBACK_URL
  });

  try {
    const topology = await runtime.axlClient.topology();
    console.log("✓ Gensyn AXL topology", topology);
    console.log("✓ darkpool MCP registered with Gensyn AXL router");

    const targetPeerId = process.env.GENSYN_AXL_PING_PEER_ID ?? process.env.INITIATE_PING_TO;

    if (targetPeerId) {
      const result = await runtime.axlClient.callTool(targetPeerId, "darkpool", "ping", {
        message: `hello from ${profile.ensName}`,
        pair: profile.pairs[0]
      });
      console.log("✓ remote darkpool/ping over Gensyn AXL", result);
    } else {
      console.log("ℹ set GENSYN_AXL_PING_PEER_ID=<remote-public-key> to test a remote tool call");
    }
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
