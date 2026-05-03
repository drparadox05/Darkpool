import { randomUUID } from "node:crypto";
import type { A2AEnvelope, AxlTopology, McpRegisterRequest, McpToolResult } from "@darkpool/shared";
import { fetchJson } from "./http.js";

export type AxlTransport = "mock" | "gensyn";

export type AxlClientOptions = {
  baseUrl: string;
  peerId: string;
  transport?: AxlTransport;
  routerUrl?: string;
};

export class AxlClient {
  readonly baseUrl: string;
  readonly peerId: string;
  readonly transport: AxlTransport;
  readonly routerUrl?: string;

  constructor(options: AxlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.peerId = options.peerId;
    this.transport = options.transport ?? "mock";
    this.routerUrl = options.routerUrl?.replace(/\/$/, "");
  }

  async topology(): Promise<AxlTopology> {
    const topology = await fetchJson<unknown>(`${this.baseUrl}/topology`);
    return normalizeTopology(topology, this.peerId, this.baseUrl);
  }

  async registerMcp(request: McpRegisterRequest): Promise<{ ok: true; service: string }> {
    if (this.transport === "gensyn") {
      if (!this.routerUrl) {
        throw new Error("Gensyn AXL transport requires AXL_ROUTER_URL, usually http://127.0.0.1:9003.");
      }

      const endpoint = request.endpoint ?? `${request.callbackUrl.replace(/\/$/, "")}/mcp`;
      await fetchJson(`${this.routerUrl}/register`, {
        method: "POST",
        body: JSON.stringify({ service: request.service, endpoint })
      });

      return { ok: true, service: request.service };
    }

    return fetchJson(`${this.baseUrl}/mcp/register`, {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  async deregisterMcp(service: string): Promise<void> {
    if (this.transport !== "gensyn" || !this.routerUrl) {
      return;
    }

    const response = await fetch(`${this.routerUrl}/register/${encodeURIComponent(service)}`, { method: "DELETE" });

    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${this.routerUrl}/register/${service}`);
    }
  }

  async callTool<T>(toPeerId: string, service: string, tool: string, input: unknown): Promise<T> {
    if (this.transport === "gensyn") {
      const response = await fetchJson<JsonRpcResponse>(`${this.baseUrl}/mcp/${encodeURIComponent(toPeerId)}/${encodeURIComponent(service)}`, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: randomUUID(),
          params: {
            name: tool,
            arguments: input
          }
        })
      });

      if (response.error) {
        throw new Error(response.error.message ?? `Tool call failed: ${service}/${tool}`);
      }

      return decodeMcpResult<T>(response.result);
    }

    const envelope: A2AEnvelope = {
      id: randomUUID(),
      from: this.peerId,
      to: toPeerId,
      service,
      tool,
      payload: input,
      timestamp: new Date().toISOString()
    };

    const response = await fetchJson<McpToolResult>(`${this.baseUrl}/a2a/${encodeURIComponent(toPeerId)}`, {
      method: "POST",
      body: JSON.stringify(envelope)
    });

    if (!response.ok) {
      throw new Error(response.error ?? `Tool call failed: ${service}/${tool}`);
    }

    return response.result as T;
  }
}

type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function normalizeTopology(topology: unknown, peerId: string, baseUrl: string): AxlTopology {
  if (isRecord(topology) && isRecord(topology.self) && Array.isArray(topology.peers)) {
    return topology as AxlTopology;
  }

  if (isRecord(topology)) {
    const selfPeerId = typeof topology.our_public_key === "string" ? topology.our_public_key : peerId;
    return {
      self: { peerId: selfPeerId, apiUrl: baseUrl },
      peers: normalizePeers(topology.peers)
    };
  }

  return { self: { peerId, apiUrl: baseUrl }, peers: [] };
}

function normalizePeers(peers: unknown): AxlTopology["peers"] {
  if (!Array.isArray(peers)) {
    return [];
  }

  return peers
    .map((peer) => {
      if (typeof peer === "string") {
        return { peerId: peer, apiUrl: "" };
      }

      if (!isRecord(peer)) {
        return null;
      }

      const peerId =
        getString(peer.peerId) ??
        getString(peer.peer_id) ??
        getString(peer.public_key) ??
        getString(peer.publicKey) ??
        getString(peer.key) ??
        getString(peer.id);

      if (!peerId) {
        return null;
      }

      return {
        peerId,
        apiUrl: getString(peer.apiUrl) ?? getString(peer.url) ?? ""
      };
    })
    .filter((peer): peer is AxlTopology["peers"][number] => peer !== null);
}

function decodeMcpResult<T>(result: unknown): T {
  if (isRecord(result)) {
    if ("structuredContent" in result) {
      return result.structuredContent as T;
    }

    if (Array.isArray(result.content)) {
      const textPart = result.content.find((part) => isRecord(part) && typeof part.text === "string");

      if (isRecord(textPart) && typeof textPart.text === "string") {
        try {
          return JSON.parse(textPart.text) as T;
        } catch {
          return textPart.text as T;
        }
      }
    }
  }

  return result as T;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
