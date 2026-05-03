import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { A2AEnvelope, AxlPeer, McpRegisterRequest, McpToolCall, McpToolResult } from "@darkpool/shared";
import { fetchJson, readJson, sendJson } from "./http.js";

export type MockAxlNodeOptions = {
  peerId: string;
  port: number;
  knownPeers?: AxlPeer[];
};

export type RunningMockAxlNode = {
  peerId: string;
  apiUrl: string;
  server: Server;
  close: () => Promise<void>;
};

export async function startMockAxlNode(options: MockAxlNodeOptions): Promise<RunningMockAxlNode> {
  const apiUrl = `http://127.0.0.1:${options.port}`;
  const knownPeers = new Map((options.knownPeers ?? []).map((peer) => [peer.peerId, peer]));
  const services = new Map<string, McpRegisterRequest>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", apiUrl);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, peerId: options.peerId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/topology") {
        sendJson(res, 200, {
          self: { peerId: options.peerId, apiUrl },
          peers: [...knownPeers.values()]
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp/register") {
        const body = await readJson<McpRegisterRequest>(req);
        services.set(body.service, body);
        sendJson(res, 200, { ok: true, service: body.service });
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/a2a/")) {
        const targetPeerId = decodeURIComponent(url.pathname.slice("/a2a/".length));
        const envelope = await readJson<A2AEnvelope>(req);

        if (targetPeerId !== options.peerId) {
          const peer = knownPeers.get(targetPeerId);

          if (!peer) {
            sendJson(res, 404, { id: envelope.id, ok: false, error: `Unknown peer ${targetPeerId}` });
            return;
          }

          const result = await fetchJson<McpToolResult>(`${peer.apiUrl.replace(/\/$/, "")}/a2a/${encodeURIComponent(targetPeerId)}`, {
            method: "POST",
            body: JSON.stringify(envelope)
          });
          sendJson(res, 200, result);
          return;
        }

        const service = services.get(envelope.service);

        if (!service) {
          sendJson(res, 404, { id: envelope.id, ok: false, error: `Service not registered: ${envelope.service}` });
          return;
        }

        const call: McpToolCall = {
          id: envelope.id,
          service: envelope.service,
          tool: envelope.tool,
          input: envelope.payload,
          from: envelope.from,
          to: envelope.to
        };
        const result = await fetchJson<McpToolResult>(`${service.callbackUrl.replace(/\/$/, "")}/tools/call`, {
          method: "POST",
          body: JSON.stringify(call)
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${url.pathname}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(options.port, resolveListen));

  return {
    peerId: options.peerId,
    apiUrl,
    server,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
  };
}

function parseKnownPeers(raw: string | undefined): AxlPeer[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [peerId, apiUrl] = entry.split("=");
      return { peerId, apiUrl };
    })
    .filter((peer) => Boolean(peer.peerId && peer.apiUrl));
}

async function main(): Promise<void> {
  const peerId = process.env.AXL_PEER_ID ?? "agent-a";
  const port = Number(process.env.AXL_API_PORT ?? "9002");
  const node = await startMockAxlNode({ peerId, port, knownPeers: parseKnownPeers(process.env.AXL_BOOTSTRAP_PEERS) });
  console.log(`[axl:${peerId}] listening on ${node.apiUrl}`);

  const shutdown = async () => {
    await node.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
